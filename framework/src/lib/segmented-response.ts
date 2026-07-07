/**
 * Server-side multi-segment response driver.
 *
 * Stays open for up to `KEEPALIVE_MS` of idle after each segment
 * when the request is a live subscription — `?live=1`, set by the
 * client's `<LivePageHeartbeat>` long-poll — or when a render called
 * `markConnectionLive()` (the chat's `ChunkSlot`). Within that window,
 * any `refreshSelector` activity wakes the driver, re-runs the render,
 * and emits the next segment delimited by a `next` marker. If the
 * window elapses with no activity, the response closes.
 *
 * One-shot requests — every navigation, every targeted refetch
 * (including `reload({selector, streaming: true})`), action responses —
 * emit one segment and close. `?streaming=1` alone is a CLIENT commit-
 * mode flag (progressive reveal vs atomic swap); it does NOT hold the
 * connection open. Holding open is a server subscription concern,
 * gated only on `?live=1` / `markConnectionLive`, so a targeted
 * streaming refetch returns its segment and closes instead of parking
 * for the full keepalive.
 *
 * Wire shape per segment matches `wrapStreamWithFpTrailer` exactly —
 * one Flight document, optional fp-trailer entry, no other markers
 * within the segment. Segments are joined by `next`-tagged delimiters.
 *
 * Cached-fp bookkeeping between segments: after each render commits
 * its snapshot store, the driver promotes the per-segment emitted fps
 * into the request's `cachedFingerprints` so the next segment's
 * fp-skip path treats those fps as "client has these." Without this,
 * a tagged invalidation that only changed one partial would still
 * cause every OTHER partial to re-emit on every segment.
 */

import {
	_captureCommitHandle,
	_createConnectionLiveProbe,
	_getAttachStatement,
	_getCachedOverride,
	_runWithWarmRenderScope,
	_runWithWarmRequestScope,
	_setCachedOverride,
	_setConnectionSession,
	_setFoldExclusionIds,
	getRequest,
	getScope,
	setRequest,
} from "../runtime/context.ts";
import {
	_currentTs,
	_onNextBump,
	_pendingInvalidationSelectors,
	_registryEpoch,
} from "../runtime/invalidation-registry.ts";
import { getSessionId, SESSION_COOKIE } from "../runtime/session.ts";
import { UNACKED_DELIVERY_WINDOW as PROTOCOL_UNACKED_DELIVERY_WINDOW } from "./channel-protocol.ts";
import {
	_closeConnectionSession,
	_openConnectionSession,
	_peekConnectionSession,
	_recordDelivery,
	type ConnectionSession,
	capOverrideSet,
	type PendingFlip,
	takeConnectionFlips,
	takeConnectionFrameNavs,
	takeConnectionNavigation,
} from "./connection-session.ts";
import { renderToReadableStream } from "./flight-runtime.ts";
import { wrapStreamWithFpTrailer } from "./fp-trailer.ts";
import {
	buildMarker,
	type FpUpdatesPayload,
	TAG_CONNECTION_ID,
	TAG_DELIVERY_SEQ,
	TAG_LANES_OPEN,
	TAG_MUX_LIVE,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
	TAG_SEQ_VOID,
	TAG_UPSTREAM_APPLIED,
} from "./fp-trailer-marker.ts";
import {
	computeRouteKey,
	parseCachedTokens,
	partialFromSnapshot,
} from "./partial.tsx";
import type { PartialSnapshot } from "./partial-registry.ts";
import {
	_readSnapshotsForRoute,
	effectiveExpiresAt,
	enterRequestRegistry,
	lookupPartial,
} from "./partial-registry.ts";
import {
	enterPartialState,
	type PartialRequestState,
} from "./partial-request-state.ts";
import { muxEndFrame, muxFrame } from "./parton-mux.ts";
import {
	_routeHasMatchingBump,
	_routeMatchingBumpIds,
	_routeMatchingSelectorIds,
} from "./segment-relevance.ts";
import { _getWarmProjector, type WarmCandidate } from "./warm-projection.ts";

/** How long the driver holds the response open after each segment.
 *  Bumped to 20s — long enough that most realtime updates land
 *  without a reconnect, short enough that idle connections don't
 *  pile up. */
const DEFAULT_KEEPALIVE_MS = 20_000;

/** Active keepalive window. Mutable only through `_setKeepaliveMs`:
 *  the soak benchmark parks thousands of in-process connections for
 *  longer than the production window, and an idle connection closing
 *  mid-measurement would silently shrink the held set under it.
 *  Production code never changes this. */
let KEEPALIVE_MS = DEFAULT_KEEPALIVE_MS;

/** Test/bench-visible keepalive override. Call with no argument to
 *  restore the default. */
export function _setKeepaliveMs(ms?: number): void {
	KEEPALIVE_MS = ms ?? DEFAULT_KEEPALIVE_MS;
}

/**
 * Max delivery seqs in flight past the client's cumulative ack before
 * the driver stops OPENING lanes (dirty ids coalesce; the latest state
 * renders when an ack frees the window). One of the two lane-opening
 * gates — the other is the response stream's own `desiredSize`
 * pull-gate, which parks enqueues byte-wise; the window bounds what
 * the byte gate can't see: deliveries the kernel already swallowed but
 * the client never committed (a torn downstream, a frozen proxy
 * buffer).
 *
 * The default is the protocol's `UNACKED_DELIVERY_WINDOW` (64) because
 * both quantities it bounds stay inside the soak budget (bench/README
 * § soak — ~20KB/connection is the mirror's planning number): the
 * per-seq `pendingDeliveries` records are a few `(id,fp)` pairs each
 * (~100–200B), so a full window pends ~10KB. The client acks LAZILY —
 * the watermark is a passenger on envelopes other statements justify,
 * and self-drives a flush only when its unacked count crosses
 * `ACK_FLUSH_THRESHOLD` (half this window; [[channel-client]]) — so
 * under sustained lane traffic the unacked count saws between zero and
 * ~half the window plus one RTT of deliveries: 2× headroom by
 * construction. Only a client that stopped committing what the kernel
 * swallowed fills it.
 */
const DEFAULT_UNACKED_DELIVERY_WINDOW = PROTOCOL_UNACKED_DELIVERY_WINDOW;

let UNACKED_DELIVERY_WINDOW = DEFAULT_UNACKED_DELIVERY_WINDOW;

/** Test/bench-visible window override (the soak bench's in-process
 *  reader never acks; measuring held connections needs the window out
 *  of the way). Call with no argument to restore the default. */
export function _setUnackedDeliveryWindow(count?: number): void {
	UNACKED_DELIVERY_WINDOW = count ?? DEFAULT_UNACKED_DELIVERY_WINDOW;
}

/**
 * How long after the connection's FIRST delivery-seq'd emission settles
 * the driver waits for the client's first `ack` before marking the
 * connection degraded (never-acked) and closing instead of holding.
 *
 * Why a deadline at all (the no-heuristics bar): the failure this
 * kills is a blocked `/__parton/*` POST path (ad-blocker, corporate
 * proxy) — an upstream that emits NO signal whatsoever, whose absence
 * only time can bound. And an ack-less envelope is not evidence of a
 * non-acking client: the ack piggybacks on the rAF-coalesced flush, so
 * any single envelope can legitimately predate the commit it would
 * have acked — counting them is a coincidence proxy. The deadline is
 * anchored at delivered-settle — the protocol milestone that STARTS
 * the client's ack obligation — so it measures exactly that obligation
 * window, never connection age.
 *
 * 5s is an order of magnitude above the worst legitimate first-ack
 * path (RTT + decode + one rAF), and equals the heartbeat cadence, so
 * a degraded connection closes before the client's next fire would
 * stack a second held stream.
 */
const DEFAULT_FIRST_ACK_DEADLINE_MS = 5_000;

let FIRST_ACK_DEADLINE_MS = DEFAULT_FIRST_ACK_DEADLINE_MS;

/** Test/bench-visible deadline override (the soak bench and the
 *  in-process rsc harness never ack — their held connections must not
 *  degrade under measurement). Call with no argument to restore. */
export function _setFirstAckDeadlineMs(ms?: number): void {
	FIRST_ACK_DEADLINE_MS = ms ?? DEFAULT_FIRST_ACK_DEADLINE_MS;
}

/**
 * Cadence of the whole-tree reconcile a long-lived lanes connection
 * emits on its own stream — the scheduled backstop for lane-relevance
 * false-negatives (a dependency the label/constraint surface doesn't
 * capture misses its lane; the next full segment heals it). An IDLE
 * connection needs none: the keepalive closes it within 20s and the
 * reopened connection's first segment is always whole-tree — this
 * cadence exists for connections that steady wake traffic keeps alive
 * indefinitely, which the reopen cycle can no longer reconcile.
 *
 * Anchored at the last full segment (connection open, an honored
 * catch-up anchor, or the previous reconcile) and evaluated at wakes —
 * no standing timer: a connection quiet long enough to drift past the
 * cadence without a wake is closed by the keepalive first.
 *
 * 30s: the reconcile costs one whole-route fp-skip pass (~a warm tick)
 * and ~zero wire bytes when nothing was missed, so the bound is CPU
 * cadence, not bytes — 1/30Hz per held connection is negligible next
 * to the soak's wake-filter tax — while healing latency stays in the
 * class the retired reopen cycle provided (20s keepalive + 5s tick).
 */
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

let RECONCILE_INTERVAL_MS = DEFAULT_RECONCILE_INTERVAL_MS;

/** Test-visible reconcile-cadence override. Call with no argument to
 *  restore the default. */
export function _setReconcileIntervalMs(ms?: number): void {
	RECONCILE_INTERVAL_MS = ms ?? DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Max parton renders one warm pass may run — the bound on speculative
 * work per telemetry statement (a pass runs at most once per
 * statement, at the park after it arrives). Each warm render costs
 * about one lane render's CPU while shipping ZERO bytes, so the cap
 * keeps a pass at roughly one wake's worth of lane work: speculation
 * may never crowd out the renders clients are actually waiting on. A
 * scroll that genuinely needs more warming states fresh telemetry as
 * it moves, and each new statement is a new pass.
 *
 * 8 covers the deepest honest projection in tree: the website world's
 * viewport sweeps at most ~2 chunk rows/columns per horizon at WASD
 * speed (~6 chunks), and projections beyond the cap are the ones most
 * likely to be superseded before they're reached.
 */
const DEFAULT_MAX_WARM_PER_PARK = 8;

let MAX_WARM_PER_PARK = DEFAULT_MAX_WARM_PER_PARK;

/** Test-visible warm-cap override. Call with no argument to restore
 *  the default. */
export function _setMaxWarmPerPark(count?: number): void {
	MAX_WARM_PER_PARK = count ?? DEFAULT_MAX_WARM_PER_PARK;
}

/**
 * The response stream's demand signal — the real backpressure wake.
 * The driver stops pumping renderer output while the controller's
 * `desiredSize` sits at or below zero (the queue is at its high-water
 * mark: bytes enqueued now buffer server-side for as long as the
 * reader stalls) and resumes on the consumer's next `pull`. `cancel`
 * flips `cancelled`, releasing parked pumps — a torn consumer is the
 * explicit signal that no pull is ever coming.
 */
export interface SegmentedResponseDemand {
	cancelled: boolean;
	/** Resolves on the response stream's next `pull` or on cancel. */
	pulled: () => Promise<void>;
}

/**
 * Build the segmented response stream around the drive loop, wiring
 * the stream's own `pull` / `cancel` callbacks as the driver's demand
 * signal. The drive starts synchronously (inside the caller's request
 * ALS scope) but is not awaited from `start` — the streams machinery
 * only fires `pull` once `start` settles, and the pull callback IS
 * the demand wake.
 */
export function createSegmentedResponse(
	renderSegment: () => ReadableStream<Uint8Array>,
	onSegmentEnd?: () => void,
): ReadableStream<Uint8Array> {
	let pullWaiters: Array<() => void> = [];
	const releasePulls = (): void => {
		const waiters = pullWaiters;
		pullWaiters = [];
		for (const resolve of waiters) resolve();
	};
	const demand: SegmentedResponseDemand = {
		cancelled: false,
		pulled: () =>
			new Promise<void>((resolve) => {
				pullWaiters.push(resolve);
			}),
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			void driveSegmentedResponse(
				controller,
				renderSegment,
				onSegmentEnd,
				demand,
			).then(
				() => {
					try {
						controller.close();
					} catch {}
				},
				(err) => {
					try {
						controller.error(err);
					} catch {}
				},
			);
		},
		pull() {
			releasePulls();
		},
		cancel() {
			demand.cancelled = true;
			releasePulls();
		},
	});
}

/**
 * Run a render-emit loop on the provided response controller. Calls
 * `renderSegment()` once, pipes its bytes through to the controller,
 * checks `connectionLive`, and either closes or waits for the next
 * `refreshSelector` and loops.
 *
 * `renderSegment` is invoked once per segment and returns the Flight
 * stream (already wrapped with the fp-trailer). The driver pipes its
 * bytes to the controller; the caller is responsible for whatever
 * setup needs to happen between segments (e.g. updating cached fps
 * from the snapshot store via `onSegmentEnd`).
 *
 * The driver always emits at least one segment. Subsequent segments
 * are gated on `markConnectionLive` having been called during the
 * just-rendered segment.
 *
 * `demand` (when provided — `createSegmentedResponse` always does)
 * pull-gates every renderer-output enqueue; without it the driver
 * pumps at render pace, which is only safe for an in-process consumer
 * that reads as fast as the driver writes.
 */
export async function driveSegmentedResponse(
	controller: ReadableStreamDefaultController<Uint8Array>,
	renderSegment: () => ReadableStream<Uint8Array>,
	onSegmentEnd?: () => void,
	demand?: SegmentedResponseDemand,
): Promise<void> {
	// Pre-encode the `next` delimiter and the `settled` milestone — same
	// bytes every time, so build each once.
	const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0);
	const settledMarker = buildMarker(TAG_SEGMENT_SETTLED, 0);

	// A live subscription gets a connection session — the per-connection
	// state slot channel envelopes address, under a SERVER-MINTED id.
	// Opened BEFORE the first segment renders so an envelope can land at
	// any point of the connection's lifetime, and so the first
	// whole-tree segment already reads the client's measured set (the
	// session seeds from the request's `?visible=` param). Closed when
	// the drive loop exits: an envelope for a closed session gets a
	// `404`, the client transport's explicit fall-back signal.
	const session = openLiveConnectionSession();
	try {
		await driveSegments();
	} finally {
		if (session) {
			_setConnectionSession(null);
			_closeConnectionSession(session.id);
		}
	}

	async function driveSegments(): Promise<void> {
		const lastTs = _currentTs();

		// Live catch-up: the attach presents the document's registry
		// anchor (the statement's `since`, minted into the SSR trailing
		// comment). The document IS the page state as of that point, so
		// re-rendering the whole route here would only re-ship bytes the
		// client already holds — skip the initial segment entirely and
		// open straight into lanes anchored at the document's timestamp:
		// the first wake lanes exactly what bumped or expired after the
		// document rendered. Honored only when the anchor's epoch names
		// THIS registry timeline (a restart or clear starts a new one),
		// the route still has snapshots (an HMR dispose wipes them), and
		// the statement carries no intent (a `__force` overlay or a
		// frame statement needs the full render's covering pass);
		// otherwise fall through to the full initial render.
		const catchUpTs = liveCatchupTs();
		if (catchUpTs !== null && session !== null) {
			installCatchupCachedOverride();
			linkOverrideToSession(session);
			controller.enqueue(buildMarker(TAG_LANES_OPEN, 0));
			enqueueConnectionId(controller, session.id);
			await driveLaneStream(
				controller,
				catchUpTs,
				settledMarker,
				session,
				demand,
				renderSegment,
			);
			return;
		}

		// The server-minted connection id, ahead of the first segment's
		// Flight rows — an ENTRY, so the splitter surfaces it and keeps
		// the body flowing. Shipping it FIRST means the client transport
		// can address the session before the whole-tree render has even
		// drained; the id's existence proves the session is open (it was
		// minted at session open, above).
		if (session !== null) {
			enqueueConnectionId(controller, session.id);
		}

		// A live connection's payload segment is a DELIVERY: mint its
		// per-connection seq and ship it as an entry ahead of the Flight
		// rows, so the client holds the seq before the segment can
		// commit (commit time is when it records — and acks — it).
		// One-shot responses have no session and carry no seqs.
		let deliverySeq: number | null = null;
		if (session !== null) {
			deliverySeq = ++session.deliverySeq;
			controller.enqueue(
				segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq),
			);
		}

		const flightStream = renderSegment();
		const reader = flightStream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					// Pull-gated: a chunk is only enqueued once the consumer
					// has room for it. Not reading the NEXT chunk until then
					// propagates the wait into the Flight stream itself
					// (whose renderer paces on its own desiredSize).
					await waitForDemand(controller, demand);
					controller.enqueue(value);
				}
			}
		} finally {
			reader.releaseLock();
		}

		// The render for this segment has fully drained — its body bytes and
		// the `fp`/`url` trailers are all on the wire. Emit the `settled`
		// milestone so the client knows the iteration is complete: from this
		// point the connection is parked (held open awaiting the next bump),
		// and an abort can cancel the reader WITHOUT tearing a mid-render
		// body. The client's cooperative abort gates on this marker — see
		// `SegmentIterator` in `fp-trailer-split.ts`.
		controller.enqueue(settledMarker);

		// The delivery is fully on the wire — the client's ack
		// obligation starts here (the never-acked degrade deadline's
		// anchor).
		if (session !== null && deliverySeq !== null) {
			session.firstDeliverySettledAt ??= Date.now();
		}

		if (onSegmentEnd) onSegmentEnd();

		// One-shot render (no connection session — an in-process drive
		// without an attach statement): one segment, close.
		if (session === null) return;

		// The attach's connection: after the initial whole-tree segment,
		// the connection switches to per-parton lanes — each wake renders
		// only the partons the bump / expiresAt boundary actually
		// touched, and their payloads interleave as independent `mux`
		// frames, so one parton's slow Suspense boundary never
		// head-of-line-blocks another parton's next update. Relevance
		// false-negatives (a dependency the label/dep surface doesn't
		// capture) are reconciled by the next whole-tree render: the
		// keepalive close forces the heartbeat to reattach, and the
		// reattached connection's first segment is always whole-tree.
		//
		// Promote into the optimistic layer AND capture the same walk
		// as the delivery's holdings record — what this segment carried
		// becomes acked evidence when the client commits it.
		const tokens: Array<readonly [string, string, string]> = [];
		promoteSnapshotsToCachedOverride(undefined, (id, mk, fp) =>
			tokens.push([id, mk, fp]),
		);
		// PartialRoot installed the override during this render; link it to
		// the session so the channel endpoint can evict client-reported drops.
		linkOverrideToSession(session);
		if (deliverySeq !== null) {
			_recordDelivery(session, deliverySeq, tokens, session.consumedNavSeq);
		}
		controller.enqueue(nextMarker);
		controller.enqueue(buildMarker(TAG_LANES_OPEN, 0));
		await driveLaneStream(
			controller,
			lastTs,
			settledMarker,
			session,
			demand,
			renderSegment,
		);
	}
}

/**
 * Park until the consumer can take another chunk. `desiredSize <= 0`
 * means the stream's queue is at or past its high-water mark; the
 * stream's `pull` callback resolves the wait — the real demand
 * signal, no timers. A cancelled demand or an errored stream
 * (`desiredSize === null`) falls through so the caller's enqueue
 * surfaces the teardown.
 */
async function waitForDemand(
	controller: ReadableStreamDefaultController<Uint8Array>,
	demand: SegmentedResponseDemand | undefined,
): Promise<void> {
	if (!demand) return;
	while (
		!demand.cancelled &&
		controller.desiredSize !== null &&
		controller.desiredSize <= 0
	) {
		await demand.pulled();
	}
}

/**
 * Resolve the attach's live catch-up anchor — the statement's `since`
 * (the document's registry anchor the heartbeat's first fire presents;
 * see [[channel-protocol]]'s `AttachStatement`). Returns the anchor
 * timestamp when it is honorable: the epoch names the CURRENT registry
 * timeline, the route still has snapshots to lane from, and the
 * statement carries no frame intent (an attach-with-intent frame
 * statement needs the full render as its covering pass — its targets
 * may not have route snapshots to lane from yet). `null` otherwise —
 * the caller falls through to the full initial render (over-fetch,
 * never stale). A `__force` overlay does NOT refuse the anchor: forced
 * targets lane EXPLICIT the moment the region opens, on either path.
 */
function liveCatchupTs(): number | null {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return null;
	}
	const statement = _getAttachStatement();
	if (statement === null) return null;
	if ((statement.frames?.length ?? 0) > 0) return null;
	const since = statement.since ?? null;
	if (since === null) return null;
	if (since.epoch !== _registryEpoch()) return null;
	const routeKey = computeRouteKey(request.url);
	if (_readSnapshotsForRoute(scope, routeKey).size === 0) return null;
	return since.ts;
}

/** The attach statement's one-shot `__force` overlay — the selector a
 *  pre-establishment refetch folded into the statement's URL. Read off
 *  the statement (the entry strips it from request state before any
 *  render); `null` when the statement carries none. */
function attachForceSelector(): string | null {
	const statement = _getAttachStatement();
	if (statement === null) return null;
	try {
		return new URL(statement.url, "http://parton.local").searchParams.get(
			"__force",
		);
	} catch {
		return null;
	}
}

/**
 * Install the connection's cached override from the attach statement's
 * manifest. On the full-render path PartialRoot does this during the
 * initial segment; the catch-up path skips that render, and without an
 * override the flip machinery would treat the client as holding
 * nothing — every flip-in would re-render and DROP the parked fiber
 * (drop-on-drift) instead of confirming it. The manifest is the
 * client's own attestation, so skips against it are truthful. Catch-up
 * requires an anchor, and the anchor rides only the attach body, so
 * the statement is always present here.
 */
function installCatchupCachedOverride(): void {
	const parsed = parseCachedTokens(_getAttachStatement()?.cached ?? null);
	_setCachedOverride({
		fingerprints: parsed.fingerprints,
		matchKeys: parsed.matchKeys,
		slots: parsed.slots,
	});
}

/** Link the connection's optimistic override — the object the driver's
 *  renders promote into (`_getCachedOverride()` in this request scope) —
 *  onto the session, so the channel endpoint (a SEPARATE request scope)
 *  can evict a client-reported dropped delivery's promotions from the
 *  very same object. Called once the driver has installed the override
 *  (the cold render's first promote, or the catch-up install). The
 *  override identity is stable for the connection's lifetime, so the
 *  link is a one-shot reference, not a per-segment refresh. */
function linkOverrideToSession(session: ConnectionSession): void {
	session.cachedOverride = _getCachedOverride();
}

/**
 * Open the connection session for the active request when it carries
 * an attach statement — the ONE live-subscription signal — under a
 * SERVER-MINTED connection id (never a client-chosen URL param — that
 * shape invites fixation and leaks the addressable token into access
 * logs; the id ships downstream as the stream's `conn` entry instead).
 * Seeds the visible set from the statement's `visible`, with `null` as
 * the pre-measurement state, and binds the attach's scope + session
 * identity (what every channel envelope must re-present — see
 * `handleChannelPost` in `connection-session.ts`). Every attach binds
 * its OWN request's identity, which makes it the explicit rebind
 * point: a session cookie minted mid-connection starts working the
 * moment the next attach presents it. The session is
 * stamped onto the request's ALS store so the cull gate and
 * `evalDepKeys` read it for the connection's whole lifetime. Returns
 * `null` for statement-less renders — no envelope can address those,
 * so no session is needed and the drive is one segment.
 */
function openLiveConnectionSession(): ConnectionSession | null {
	let request: Request;
	try {
		request = getRequest();
	} catch {
		return null;
	}
	const statement = _getAttachStatement();
	if (statement === null) return null;
	const seed: ReadonlySet<string> | null =
		statement.visible === null ? null : new Set(statement.visible);
	const session = _openConnectionSession(crypto.randomUUID(), seed, {
		scope: getScope(),
		sessionId: getSessionId() ?? "",
		// The statement's upstream watermark — what the client last heard
		// applied — anchors the new session's `applied` marker on the
		// page-lifetime envelope timeline (see [[channel-protocol]]).
		applied: statement?.applied ?? 0,
	});
	// The route this connection renders — what an action's consequence
	// reservation resolves the route snapshots through (the driver isn't
	// on the stack there). Moved by the driver at a window-navigation
	// consume.
	session.routeKey = computeRouteKey(request.url);
	_setConnectionSession(session);
	return session;
}

/** Frame the server-minted connection id as a `conn` entry — the
 *  establishment handshake the client's channel transport keys every
 *  upstream envelope on. Emitted once per connection. */
function enqueueConnectionId(
	controller: ReadableStreamDefaultController<Uint8Array>,
	id: string,
): void {
	const body = new TextEncoder().encode(id);
	controller.enqueue(buildMarker(TAG_CONNECTION_ID, body.byteLength));
	controller.enqueue(body);
}

/** A payload segment's delivery-seq `seq` entry bytes — body is
 *  `<seq> <asof>` (the lane form prefixes the parton id; the client
 *  tells them apart by the newline). `asof` is the navigation point
 *  the segment renders as-of (`session.consumedNavSeq`). Emitted ahead
 *  of the segment's Flight rows so the client holds seq AND as-of
 *  before the commit-or-drop decision. */
function segmentDeliverySeqEntry(seq: number, asOf: number): Uint8Array {
	const body = new TextEncoder().encode(`${seq} ${asOf}`);
	const marker = buildMarker(TAG_DELIVERY_SEQ, body.byteLength);
	const out = new Uint8Array(marker.byteLength + body.byteLength);
	out.set(marker, 0);
	out.set(body, marker.byteLength);
	return out;
}

/** A lane delivery's `seq` entry bytes —
 *  `<parton-id>\n<seq> <asof>[ nav=<n>]`, the mux frames' id-first
 *  shape, framed for the lanes region (one buffer: the lane driver's
 *  `enqueue` is all-or-nothing per chunk). Written immediately BEFORE
 *  the lane's `muxend`, so the client's per-parton seq queue holds the
 *  value before the lane body closes and its decode — then commit —
 *  can complete. As-of at drain equals as-of at render: a navigation
 *  tears open lanes before it applies, so no lane ever drains across a
 *  consume. `nav=<n>` flags a lane spawned by a FRAME url statement
 *  with that statement's seq — the client's correlation for the frame
 *  fire's milestones. */
function laneDeliverySeqEntry(
	partonId: string,
	seq: number,
	asOf: number,
	navSeq?: number,
): Uint8Array {
	return idFirstEntry(TAG_DELIVERY_SEQ, partonId, seq, asOf, navSeq);
}

/** A producer lane's early delivery announcement — the `muxlive`
 *  frame: same id-first body as the lane `seq` entry, written the
 *  moment the lane's render declares itself a producer
 *  (`markConnectionLive()`), so the client holds seq + as-of while the
 *  body is still streaming and can commit progressively. A producer
 *  lane writes NO drain-time `seq` entry — this announcement IS its
 *  delivery; `muxend` at producer resolve closes the body. */
function muxLiveEntry(
	partonId: string,
	seq: number,
	asOf: number,
	navSeq?: number,
): Uint8Array {
	return idFirstEntry(TAG_MUX_LIVE, partonId, seq, asOf, navSeq);
}

function idFirstEntry(
	tag: string,
	partonId: string,
	seq: number,
	asOf: number,
	navSeq?: number,
): Uint8Array {
	const flags = navSeq !== undefined ? ` nav=${navSeq}` : "";
	const body = new TextEncoder().encode(`${partonId}\n${seq} ${asOf}${flags}`);
	const marker = buildMarker(tag, body.byteLength);
	const out = new Uint8Array(marker.byteLength + body.byteLength);
	out.set(marker, 0);
	out.set(body, marker.byteLength);
	return out;
}

/** A `seqvoid` entry — space-separated delivery seqs that were
 *  assigned ahead of a render (an action's consequence reservation)
 *  but whose lane was skipped. The client counts each PROCESSED so
 *  the contiguous ack watermark passes them. */
function seqVoidEntry(seqs: readonly number[]): Uint8Array {
	const body = new TextEncoder().encode(seqs.join(" "));
	const marker = buildMarker(TAG_SEQ_VOID, body.byteLength);
	const out = new Uint8Array(marker.byteLength + body.byteLength);
	out.set(marker, 0);
	out.set(body, marker.byteLength);
	return out;
}

/** The `applied` marker bytes — the cumulative upstream-seq-applied
 *  announcement (body: decimal watermark). */
function upstreamAppliedEntry(applied: number): Uint8Array {
	const body = new TextEncoder().encode(String(applied));
	const marker = buildMarker(TAG_UPSTREAM_APPLIED, body.byteLength);
	const out = new Uint8Array(marker.byteLength + body.byteLength);
	out.set(marker, 0);
	out.set(body, marker.byteLength);
	return out;
}

/** One open lane: a parton whose payload is currently rendering and
 *  framing onto the connection. */
interface LaneRuntime {
	/** A wake touched this parton while its lane was open. One lane per
	 *  parton id keeps the wire unambiguous (the client keys open bodies
	 *  by id), so the pump re-renders once the current payload drains
	 *  instead of opening a second lane. */
	dirty: boolean;
	done: Promise<void>;
	/** Cancels the pump's CURRENT render reader — the navigation tear's
	 *  reach into a pump parked on a suspended render (a read on a
	 *  loader-blocked Flight stream has no other check point). Set per
	 *  render iteration while its reader is held; `null` between. */
	abortRead: (() => void) | null;
	/** A `cancel` statement named this lane's scope: the pump winds the
	 *  CURRENT iteration down (closing the open body with a `muxend` so
	 *  the client's decode settles and the same id can reopen) and
	 *  exits — the superseding frame statement's covering lane renders
	 *  fresh. */
	cancelled: boolean;
	/** The current iteration's render declared itself a PRODUCER
	 *  (`markConnectionLive()` inside the lane — see `muxLiveEntry`).
	 *  Its body streams until the producer resolves; the drive-loop
	 *  exit aborts producer reads (an unbounded await must not hold the
	 *  wind-down). */
	producer: boolean;
	/** The current iteration renders an EXPLICIT force whose content
	 *  has not drained. A navigation tear catching it re-forces the id
	 *  after the reopen — the force was never satisfied, and the torn
	 *  body's replacement lanes as-of the new statement (a silent
	 *  restatement must not lose a disjoint target's refetch). Cleared
	 *  at drain; a `cancel` is a deliberate supersede and never
	 *  re-forces. */
	forced: boolean;
}

/**
 * Per-parton emit loop for a live subscription. Each wake renders only
 * the partons the bump / expiresAt boundary touched — through the same
 * snapshot-reconstruction path a `?partials=` refetch uses — and frames
 * each render's bytes as an independent `mux` lane, interleaved as the
 * renders produce them. A fast parton's payload closes on the wire
 * while a slow sibling is still suspended; the slow sibling gates
 * nothing.
 *
 * Isolation: concurrent lane renders share one request context. That
 * is safe for the registry because every write is a complete snapshot
 * merged by id (the same invariant that lets `<Cache>` splice several
 * hole renders concurrently), and each wake re-enters a fresh registry
 * pass so descendant folds read the latest committed canonical rather
 * than the initial segment's memoized view. Each lane's
 * `wrapStreamWithFpTrailer` commits at its own flush and emits
 * `{from,to}` fp updates scoped to the LANE'S OWN SUBTREE — the only
 * snapshots this render could have moved. Ancestors' fold drift is not
 * healed here (an honest ancestor fold needs every descendant's
 * contribution, a route-wide pass) — it rides the next whole-tree
 * segment; until then the ancestor over-fetches on its next render,
 * never serves stale.
 *
 * The `settled` milestone is written at quiesce (every lane drained),
 * marking a safe abort point; mid-lane aborts are also safe client-side
 * because a torn lane rejects only its own un-committed decode.
 *
 * Bump and expiry wakes skip PARKED partons — ids whose own snapshot,
 * or a cullable ancestor's, is outside the session's measured visible
 * set (`isParkedOnConnection`). A parked parton's client copy is a
 * hidden Activity slot; streaming lanes at it burns render + wire on
 * pixels nobody sees, and on a world-sized route it never stops: every
 * parton the client EVER scrolled past keeps its snapshot, so without
 * the skip the connection lane-renders all of them at full invalidation
 * rate, forever. Staleness is impossible: the flip-in revalidation
 * re-renders the returning state fresh (its fp folds every bump that
 * landed while parked, so it can't false-skip).
 *
 * Navigation outranks every wake: a channel envelope's `url` frame
 * latches on the session, and the driver — at wait entry or preempting
 * whatever arm won — tears the open lanes, applies the URL to the
 * connection's request state (the `setRequest` seam server-side
 * navigation uses), and answers with one full payload segment for the
 * new state before reopening the lanes region (`handleNavigation`). A
 * newer frame landing mid-render supersedes the in-flight navigation
 * render (`emitNavSegment`'s abort seam — the shape the explicit
 * cancel frame kind will reuse).
 *
 * Visibility flips are the fourth wake: a channel envelope's `visible`
 * frame updates the connection session's set and queues each flipped
 * id with the frame's OWN statement about it, and the driver lanes
 * exactly the ids whose standing statement is an in-flip — with the
 * cull gate (and the fp fold's store-and-reread) reading the session's
 * CURRENT set. A
 * flipped id's fps are dropped from the cached override first: a
 * visibility fp CYCLES between the same two values (in ↔ out), so a
 * stale override entry would fp-skip a re-entry to a placeholder whose
 * client-side cache slot now holds the other state's body. Same rule as
 * an explicit `?partials=` target — a flip must re-render, never
 * match-and-skip.
 */
async function driveLaneStream(
	controller: ReadableStreamDefaultController<Uint8Array>,
	sinceTs: number,
	settledMarker: Uint8Array,
	session: ConnectionSession | null,
	demand: SegmentedResponseDemand | undefined,
	renderFullSegment: () => ReadableStream<Uint8Array>,
): Promise<void> {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return;
	}
	// Mutable: a consumed url frame moves the connection's request state,
	// and every per-wake read below (snapshots, expiry scan, registry
	// re-entry) must follow it to the new route.
	let routeKey = computeRouteKey(request.url);
	const lanes = new Map<string, LaneRuntime>();
	const openLaneIds = new Set<string>();
	// Ids whose NEXT lane renders EXPLICIT (the lane state's
	// explicitIds) — a url statement's `__force` targets: fp-skip and
	// the defer gate both yield, exactly as for a discrete `?partials=`
	// target. Consumed at lane start (one-shot — the render satisfies
	// the force).
	const forcedLaneIds = new Set<string>();
	// Frame-nav correlation flags: id → the FRAME url statement's seq
	// whose consume spawned that id's next lane. One-shot — consumed at
	// the covering iteration; ships as the ` nav=<n>` token on its
	// delivery announcement (the client resolves the frame fire's
	// milestones off it).
	const laneNavSeqs = new Map<string, number>();
	let closed = false;

	// ── Consequence-seq bookkeeping ──
	// An action's reservation (`_reserveActionConsequences`) assigns a
	// delivery seq to a consequence lane BEFORE the bump wakes this
	// driver; the pump takes an id's assignment at iteration start. A
	// skip path that drops the id must VOID the assignment instead —
	// an assigned seq that never reaches the wire would wedge the
	// client's contiguous ack watermark (and hold its overlay gates)
	// forever.
	const takeAssignedSeq = (id: string): number | null => {
		if (session === null) return null;
		const seq = session.assignedLaneSeqs.get(id);
		if (seq === undefined) return null;
		session.assignedLaneSeqs.delete(id);
		return seq;
	};
	const voidAssigned = (id: string): void => {
		if (session === null) return;
		const seq = session.assignedLaneSeqs.get(id);
		if (seq === undefined) return;
		session.assignedLaneSeqs.delete(id);
		session.voidSeqs.add(seq);
	};
	// Flush pending voids as one `seqvoid` entry. Entries interleave
	// anywhere on the wire (payload segments and lanes region alike),
	// so any emission point serves.
	const announceVoidSeqs = (): void => {
		if (session === null || session.voidSeqs.size === 0) return;
		const seqs = [...session.voidSeqs];
		session.voidSeqs.clear();
		enqueue(seqVoidEntry(seqs));
	};

	// Stop release for pumps parked at the demand gate when the wake
	// loop exits: flushing the waiters lets each parked pump re-check
	// `stopping` and wind down instead of holding the drive open for a
	// pull that may never come. Mid-lane winding down is client-safe —
	// a torn lane rejects only its own un-committed decode. A waiter
	// SET rather than one long-lived promise: each park's entry is
	// removed when it releases (the wake-arm release invariant — a
	// reaction on a promise that only settles at connection teardown
	// would accumulate per park for the connection's lifetime).
	let stopping = false;
	const gateWaiters = new Set<() => void>();

	// Navigation lane tear. A consumed url frame ends the lanes region
	// with a `next` delimiter, and no mux frame may follow it — so every
	// open lane winds down FIRST: the flag turns each pump's next check
	// point into an exit (no muxend, no seq entry — the client's region
	// exit errors the torn body, rejecting only that lane's un-committed
	// decode; a PRODUCER body, whose earlier bytes may have committed
	// progressively, is closed cleanly there instead), `abortRead`
	// breaks pumps parked on a suspended render, and the gate release
	// frees pumps parked on demand. The torn lanes' content is obsolete
	// by definition — it renders the route the client just left.
	let tearingLanesForNav = false;
	const tearLanesForNavigation = async (): Promise<void> => {
		if (lanes.size === 0) return;
		tearingLanesForNav = true;
		for (const runtime of lanes.values()) runtime.abortRead?.();
		for (const release of [...gateWaiters]) release();
		await Promise.allSettled([...lanes.values()].map((l) => l.done));
		tearingLanesForNav = false;
	};

	// The cancel arm — a `cancel` statement's reach into the scope's
	// open lane renders, fired synchronously at envelope apply
	// (`cancelListeners`). Scope membership is the frame's narrowing:
	// the lane's parton belongs to the scope when its id or a label
	// matches the scope name, or its snapshot's frame path opens with
	// it (nested frames cancel with their root). The cancelled pump
	// winds its CURRENT iteration down — closing the open body with a
	// `muxend` so the client's decode settles and the same id can
	// reopen — and exits; the superseding statement's covering lane
	// renders fresh.
	const cancelScopeLanes = (cancelScope: string): void => {
		if (lanes.size === 0) return;
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		for (const [id, runtime] of lanes) {
			const snap = snapshots.get(id);
			const inScope =
				id === cancelScope ||
				(snap?.labels.includes(cancelScope) ?? false) ||
				snap?.framePath[0] === cancelScope;
			if (!inScope) continue;
			runtime.cancelled = true;
			runtime.forced = false;
			runtime.abortRead?.();
		}
		for (const release of [...gateWaiters]) release();
	};

	// Lane-output demand gate. Parks while the consumer's queue is
	// full; the stream's pull releases it. Returns false when the lane
	// must wind down instead of enqueue: the consumer cancelled (the
	// explicit no-pull-is-coming signal — also marks the connection
	// closed so the wake loop exits at its next wake), or the wake
	// loop exited while this pump was parked with the queue still
	// full. A pump caught by `stopping` with room in the queue still
	// delivers — only a consumer that stopped pulling gets its lane
	// tail torn.
	const awaitDemand = async (runtime?: LaneRuntime): Promise<boolean> => {
		if (!demand) return runtime?.cancelled !== true;
		while (
			!stopping &&
			!tearingLanesForNav &&
			runtime?.cancelled !== true &&
			!demand.cancelled &&
			controller.desiredSize !== null &&
			controller.desiredSize <= 0
		) {
			await new Promise<void>((resolve) => {
				const release = (): void => {
					gateWaiters.delete(release);
					resolve();
				};
				gateWaiters.add(release);
				void demand.pulled().then(release);
			});
		}
		if (demand.cancelled) {
			closed = true;
			return false;
		}
		if (runtime?.cancelled === true) return false;
		return !(
			stopping &&
			controller.desiredSize !== null &&
			controller.desiredSize <= 0
		);
	};

	// Lane-drained wake arm. A drained lane's fresh snapshot carries its
	// next `expiresAt`; the wake re-arms the wait so the deadline is
	// re-read from the committed snapshot instead of starving behind
	// the open-lane expiry exclusion. A latch plus a DISPOSABLE listener
	// set (the flipWakes shape) rather than a promise: a promise
	// reaction only frees when its promise settles, so arming each
	// re-arm iteration with `.then` on a park-lived promise accretes
	// one reaction (retaining its whole wake race) per idle wake — the
	// wake-arm release invariant. A drain landing while the driver is
	// busy sets the latch, which the next wait entry (and the wait's
	// own re-arm loop) consumes without parking.
	let laneDrainedPending = false;
	const laneDrainedWakes = new Set<() => void>();
	const noteLaneDrained = (): void => {
		laneDrainedPending = true;
		for (const wake of [...laneDrainedWakes]) wake();
	};

	const enqueue = (bytes: Uint8Array): boolean => {
		if (closed) return false;
		try {
			controller.enqueue(bytes);
			return true;
		} catch {
			// The client tore the connection (navigate-away). Stop producing;
			// in-flight lane renders drain into the void and their commits
			// still land server-side (the registry stays warm for the
			// heartbeat's reopened connection).
			closed = true;
			return false;
		}
	};

	const startLane = (id: string): void => {
		const open = lanes.get(id);
		if (open) {
			open.dirty = true;
			return;
		}
		const runtime: LaneRuntime = {
			dirty: false,
			done: Promise.resolve(),
			abortRead: null,
			cancelled: false,
			producer: false,
			forced: false,
		};
		lanes.set(id, runtime);
		openLaneIds.add(id);
		runtime.done = pumpLane(id, runtime);
	};

	const pumpLane = async (id: string, runtime: LaneRuntime): Promise<void> => {
		// Lane renders bypass PartialRoot, so the request-state ALS the
		// spec wrapper's skip path consults never flows here on its own.
		// Enter a lane-scoped state backed by the connection's cached
		// override MAPS (live references — promotes and trailer heals
		// between renders are visible to every subsequent pass), so a
		// lane render can fp-skip like any other: an unchanged parton
		// answers with its placeholder (for a culling flip, the
		// confirmation that restores the parked copy with zero bytes)
		// instead of re-shipping identical bytes. No override (the
		// connection never carried `?cached=`) → no state → every lane
		// renders fresh, exactly as a cold client would be served.
		const laneOverride = _getCachedOverride();
		// A forced lane (a url statement's `__force` target) renders
		// EXPLICIT: `explicitForces` bypasses the fp-skip verdict and the
		// defer gate renders the body — the refetch contract on the lane
		// path. One-shot: the force is consumed here; re-lanes of the same
		// parton skip and defer as usual.
		const forced = forcedLaneIds.delete(id);
		runtime.forced = forced;
		if (laneOverride || forced) {
			enterPartialState({
				requestedIds: null,
				isPartialRefetch: true,
				cachedFingerprints: laneOverride?.fingerprints ?? new Map(),
				cachedMatchKeys: laneOverride?.matchKeys ?? new Map(),
				// The mirror's ACKED layer — client-proven holdings the
				// verdict falls back to on an optimistic miss (an fp the
				// per-id cap evicted from the override but the client
				// verifiably committed).
				ackedFingerprints: session?.ackedFps ?? null,
				explicitIds: forced ? new Set([id]) : new Set(),
				seenIds: new Set(),
			});
		}
		try {
			while (!closed && !tearingLanesForNav && !runtime.cancelled) {
				runtime.dirty = false;
				runtime.producer = false;
				const snap = lookupPartial(id);
				if (!snap) {
					// An assigned consequence seq for a parton that no longer
					// snapshots can never emit — void it.
					voidAssigned(id);
					break;
				}
				// A consequence seq assigned ahead of this render (an action's
				// reservation) — the iteration's delivery seq. Taken at
				// ITERATION START so a write landing mid-render assigns a
				// FRESH seq for the next iteration (this render's content
				// predates it).
				const assignedSeq = takeAssignedSeq(id);
				// The frame-nav correlation flag for a lane this iteration
				// covers — one-shot, rides the delivery announcement.
				const navSeq = laneNavSeqs.get(id);
				laneNavSeqs.delete(id);
				// This render is one DELIVERY: the fps it establishes on the
				// client — subtree promotions at drain plus any trailer heals
				// during the flush — become acked holdings when the client
				// commits it. Captured per iteration.
				const carried: Array<readonly [string, string, string]> = [];
				// The trailer heals this iteration's flush emitted, folded into
				// the mirror AFTER the drain promote establishes each rendered
				// id's slot (below) — so the warm `to` fp joins the slot holding
				// its cold `from` (the client's `_applyFpUpdates` rule) instead
				// of landing slotless and un-evictable by a later variant.
				const laneHeals: FpUpdatesPayload = {};
				// Per-iteration producer attribution: the render runs inside a
				// nested probe scope so `markConnectionLive()` marks THIS lane
				// (lane renders share one request store — the store-level flag
				// can't attribute across concurrent pumps).
				const probe = _createConnectionLiveProbe();
				// The seq announced on the wire this iteration — a producer
				// lane announces EARLY (`muxlive`, the moment the render marks
				// live) so the client commits progressively; a normal lane
				// announces at drain, just before its `muxend`.
				let announcedSeq: number | null = null;
				let bufferUntilDrain =
					runtime.forced &&
					navSeq === undefined &&
					session?.consumedNavStreaming !== true;
				const bufferedFrames: Uint8Array[] = [];
				const flushBufferedFrames = async (): Promise<boolean> => {
					if (bufferedFrames.length === 0) {
						bufferUntilDrain = false;
						return true;
					}
					for (const frame of bufferedFrames) {
						if (!(await awaitDemand(runtime))) return false;
						if (!enqueue(frame)) return false;
					}
					bufferedFrames.length = 0;
					bufferUntilDrain = false;
					return true;
				};
				// A window-force lane (a selector nav's `__force` target, not a
				// frame lane — those carry a `navSeq`) announces its delivery seq
				// EARLY: a plain seq entry before the body, so the client holds it
				// at root-ready and can commit progressively when the covering nav
				// asked for streaming (matching the whole-tree segment). It stays a
				// NORMAL (non-`muxlive`) delivery — the client buffers it by
				// default; only the streaming-preferred branch commits root-ready.
				// Frame lanes and producers keep their own `muxlive` announcement:
				// setting the seq here would suppress it (`maybeAnnounceProducer`
				// gates on `announcedSeq`).
				if (
					runtime.forced &&
					navSeq === undefined &&
					session?.consumedNavStreaming === true
				) {
					announcedSeq = assignedSeq ?? ++session.deliverySeq;
					if (
						!enqueue(
							laneDeliverySeqEntry(id, announcedSeq, session.consumedNavSeq, navSeq),
						)
					)
						return;
				}
				let wroteBytes = false;
				const maybeAnnounceProducer = async (): Promise<boolean> => {
					if (announcedSeq !== null || session === null) return true;
					if (!wroteBytes || !probe.live()) return true;
					runtime.producer = true;
					if (bufferUntilDrain && !(await flushBufferedFrames())) return false;
					announcedSeq = assignedSeq ?? ++session.deliverySeq;
					return enqueue(
						muxLiveEntry(id, announcedSeq, session.consumedNavSeq, navSeq),
					);
				};
				const runIteration = async (): Promise<"drained" | "torn" | "closed"> => {
					const flight = renderToReadableStream(partialFromSnapshot(id, snap));
					// A lane is a single parton's render — its flush already fires
					// at that parton's completion, and lanes run concurrently (the
					// one-sink-per-request settle slot doesn't model that), so
					// settle-time emission is off here.
					const wrapped = wrapStreamWithFpTrailer(
						flight,
						_captureCommitHandle(),
						{
							incremental: false,
							// A lane's trailer heals only its own subtree — see
							// `flushScopeId`. Without the scope, every lane frame on a
							// many-parton route re-computes and re-ships the standing
							// drift of every route snapshot: O(route) hashing per
							// frame, and the same multi-KB fp payload duplicated onto
							// every frame of the stream.
							flushScopeId: id,
							// Stash this lane's warm heals; they fold into the mirror
							// (and this delivery's holdings) AFTER the drain promote
							// below, so each `to` joins the slot the promote just
							// established for its `from`. Folding here — before the
							// slot exists — would land `to` slotless, un-evictable by
							// a later sibling variant (the return-toggle stale-body
							// class). The fold still lands before the next lane's skip
							// check, so it tracks the same drift the client heals.
							onUpdates: (updates) => {
								Object.assign(laneHeals, updates);
							},
						},
					);
					const reader = wrapped.getReader();
					// The navigation tear's / cancel's reach into a read parked on
					// a suspended render — cancelling settles the pending read so
					// the pump can observe the tear and wind down.
					runtime.abortRead = () => void reader.cancel().catch(() => {});
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							if (tearingLanesForNav || runtime.cancelled) {
								await reader.cancel().catch(() => {});
								return "torn";
							}
							if (value && value.byteLength > 0) {
								// Pull-gated: park before the enqueue while the consumer's
								// queue is full. Not reading the NEXT chunk until then
								// propagates the wait into the lane's Flight stream, so a
								// stalled reader holds at most one frame per lane
								// server-side instead of every wake's full payload.
								if (bufferUntilDrain) {
									bufferedFrames.push(muxFrame(id, value));
								} else {
									if (
										!(await awaitDemand(runtime)) ||
										tearingLanesForNav ||
										runtime.cancelled
									) {
										await reader.cancel().catch(() => {});
										return runtime.cancelled || tearingLanesForNav
											? "torn"
											: "closed";
									}
									if (!enqueue(muxFrame(id, value))) {
										await reader.cancel().catch(() => {});
										return "closed";
									}
								}
								wroteBytes = true;
							}
							// Producer announcement — checked at every pump step so
							// the mark lands on the wire before the render's producer
							// await stalls the body.
							if (!(await maybeAnnounceProducer())) {
								await reader.cancel().catch(() => {});
								return "closed";
							}
						}
					} finally {
						runtime.abortRead = null;
						reader.releaseLock();
					}
					if (tearingLanesForNav || runtime.cancelled) return "torn";
					return "drained";
				};
				let outcome: "drained" | "torn" | "closed";
				try {
					outcome = await probe.run(runIteration);
				} catch {
					// A cancelled suspended render can reject its reader instead
					// of resolving it done — same wind-down as an observed tear
					// (the assigned-seq void below must still run).
					outcome = "torn";
				}
				if (outcome !== "drained") {
					// Torn. A CANCELLED iteration on a CONTINUING region closes
					// its open client body with a `muxend` — the decode settles
					// (a producer body's progressive commit keeps its fallback
					// until the covering render replaces it) and the same id can
					// reopen for the superseding statement's lane. A navigation
					// tear writes nothing: the region exit is what rejects (or,
					// for producer bodies, cleanly closes) those bodies. Either
					// way an assigned-but-unannounced consequence seq is voided —
					// the client's watermark must be able to pass it.
					if (
						runtime.cancelled &&
						!tearingLanesForNav &&
						wroteBytes &&
						!closed
					) {
						enqueue(muxEndFrame(id));
					}
					if (assignedSeq !== null && announcedSeq === null) {
						session?.voidSeqs.add(assignedSeq);
					}
					return;
				}
				if (!(await awaitDemand(runtime))) {
					if (runtime.cancelled && wroteBytes && !closed) {
						enqueue(muxEndFrame(id));
					}
					if (assignedSeq !== null && announcedSeq === null) {
						session?.voidSeqs.add(assignedSeq);
					}
					return;
				}
				if (!(await flushBufferedFrames())) {
					if (assignedSeq !== null && announcedSeq === null) {
						session?.voidSeqs.add(assignedSeq);
					}
					return;
				}
				// The delivery announcement precedes the `muxend` on the wire,
				// so the client's per-parton seq queue holds it before the lane
				// body closes — its decode, then commit, then ack all follow. A
				// producer lane announced at flag time (`muxlive`); its muxend
				// at producer resolve is the body's only remaining frame.
				let deliverySeq: number | null = announcedSeq;
				if (session !== null && deliverySeq === null) {
					deliverySeq = assignedSeq ?? ++session.deliverySeq;
					if (
						!enqueue(
							laneDeliverySeqEntry(id, deliverySeq, session.consumedNavSeq, navSeq),
						)
					)
						return;
				}
				if (!enqueue(muxEndFrame(id))) return;
				// The delivery is fully on the wire — the connection's first
				// settled delivery anchors the never-acked degrade deadline.
				if (session !== null) session.firstDeliverySettledAt ??= Date.now();
				// The lane's snapshots just committed (the per-lane fp-trailer
				// wrap commits at flush). Promote the fresh emittedFps into the
				// request's cached override so this parton's next lane render —
				// and every other lane's descendants — fp-skip against them.
				// Scoped to the lane's subtree: only those snapshots are fresh
				// from this render; walking the whole route map per drain is
				// O(route) churn for entries the drain didn't touch. The same
				// walk records the delivery's holdings — one pass, no second
				// walk per drain.
				promoteSnapshotsToCachedOverride(id, (tid, mk, fp) =>
					carried.push([tid, mk, fp]),
				);
				// The flush's warm heals fold in NOW, after the slots exist: the
				// `to` fp joins the slot holding its `from` (dropping when the
				// slot fp-skipped away), then rides this delivery's holdings so
				// the acked layer folds it under the same matchKey.
				promoteFpUpdatesToCachedOverride(laneHeals, (tid, mk, fp) =>
					carried.push([tid, mk, fp]),
				);
				if (session !== null && deliverySeq !== null) {
					_recordDelivery(session, deliverySeq, carried, session.consumedNavSeq);
				}
				// The force is satisfied — its content drained.
				runtime.forced = false;
				if (!runtime.dirty) return;
			}
		} finally {
			lanes.delete(id);
			openLaneIds.delete(id);
			// No quiesce marker while tearing for a navigation: the torn
			// lanes' client bodies are still open (deliberately — the region
			// exit is what rejects them), so "every lane drained" would be a
			// false statement; the navigation segment's own `settled` follows.
			if (!closed && !tearingLanesForNav && lanes.size === 0)
				enqueue(settledMarker);
			noteLaneDrained();
		}
	};

	// In-flips whose ids had no route snapshot when their report arrived
	// — a report racing the render that first materializes its parton (a
	// chunk reported in-view while its bigChunk's flip-in lane is still
	// streaming). Deferred, never dropped: the client reports each flip
	// exactly once (the IntersectionObserver only fires on change), so a
	// dropped flip would leave that parton stale until the next
	// whole-tree reconciliation. Re-checked against fresh snapshots on
	// every subsequent wake — the materializing lane's own drain is a
	// wake — and resolved ids lane like any other flip. Each entry keeps
	// its statement's seq, so only a NEWER statement about the id can
	// supersede it (an explicit out-flip cancels the wait; a fresh
	// in-flip re-arms it with fresh cached tokens). Ids that never
	// materialize linger harmlessly until the connection closes.
	const deferredFlips = new Map<string, number>();

	// Keepalive anchored at the last USEFUL activity (a lane started, a
	// flip processed) — not re-armed per wake. Bump wakes whose touched
	// set comes up empty (all matches parked) loop without shipping a
	// byte, and a torn connection is only detectable at enqueue time —
	// re-arming per wake would let steady bump traffic hold a fully-
	// parked, possibly torn connection open FOREVER, each wake
	// re-scanning the route (the zombie-connection leak: every refresh
	// tears one, they accumulate, the server pegs). A healthy client's
	// connection closing idle is the normal contract — the heartbeat's
	// next tick reopens it.
	let idleDeadline = Date.now() + KEEPALIVE_MS;

	let since = sinceTs;

	// Region delimiters for the whole-tree reconcile below — the lanes
	// region ends with `next`, the payload segment flows, and `next` +
	// `lanes` reopens the region. Same bytes every time.
	const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0);
	const lanesMarker = buildMarker(TAG_LANES_OPEN, 0);

	// Ids whose lane opening the unacked delivery window deferred. The
	// dirty-on-drain shape generalized: while the window is exceeded,
	// touched ids coalesce here instead of opening lanes, and when an
	// ack frees the window they render their LATEST state. An ack
	// landing while the driver is busy needs no arm of its own — the
	// wait-entry check below re-reads the session's watermark against
	// this set (the latch), and an ack landing while parked fires the
	// session's flip wakes (a disposer-registered listener set, never a
	// long-lived promise reaction).
	const windowDirty = new Set<string>();
	const deliveryWindowExceeded = (): boolean =>
		session !== null &&
		session.deliverySeq - session.ackedDeliverySeq >= UNACKED_DELIVERY_WINDOW;

	// ── Predictive warming at park ──
	// One projection per telemetry statement: the statement is the
	// signal, so its envelope seq is the dedup key — re-parking on the
	// same statement re-projects nothing (same statement, same
	// projection), and a fresh statement is a fresh pass.
	let warmedTelemetrySeq = -1;

	// Render the parked partons the viewport is projected to reach into
	// the server byte-cache, so their flip-in lanes replay warm bytes
	// instead of running cold bodies. Speculation with hard edges:
	//
	//   - runs only at the park point (the driver has nothing real to
	//     do) and NEVER extends the keepalive — warming is not
	//     client-evidenced activity;
	//   - skipped entirely while the unacked delivery window is
	//     exceeded: a client that isn't committing what the kernel
	//     already swallowed gets no speculative CPU spent on it;
	//   - bounded at MAX_WARM_PER_PARK renders (rationale at the
	//     constant) and preempted by any real statement landing
	//     mid-pass — flips outrank speculation;
	//   - byte-silent by construction: each render runs inside a nested
	//     warm scope (`_runWithWarmRenderScope`) that presents the
	//     target id as visible WITHOUT touching the connection's real
	//     session, carries no cached override (the client mirror stays
	//     untouched), and drains into the void — no controller, no
	//     delivery seq, no promote. The only durable effects are the
	//     byte-cache entry and the parton's re-registered content
	//     snapshot (truthful either way; the next covering render
	//     re-registers the culled state).
	//
	// The projection itself — geometry, horizon, velocity judgment — is
	// the app's (`registerWarmProjector`): only the app knows how a
	// scroll vector maps onto its partons' coordinates.
	// True while the session holds a telemetry statement the pass has
	// not consumed AND the gates that would let a pass run are open —
	// the warm pass's LATCH: a telemetry envelope's wake can fire while
	// the driver is busy (no armed listener to hear it), so the
	// wait-entry check below consumes the statement off the session
	// exactly like pendingFlips consumes a busy-window flip.
	const pendingWarmStatement = (): boolean =>
		session !== null &&
		session.telemetry !== null &&
		session.telemetry.seq !== warmedTelemetrySeq &&
		!deliveryWindowExceeded() &&
		_getWarmProjector() !== null;

	// The preload-warm latch: a `warm` frame's stated target awaits its
	// park-point render. Same window discipline as the telemetry pass —
	// a window-skip keeps the slot, so the freeing ack's wake warms the
	// same statement; the consume below nulls it, so the latch can never
	// spin the wait-entry loop.
	const pendingPreloadWarm = (): boolean =>
		session !== null &&
		session.pendingWarmUrl !== null &&
		!deliveryWindowExceeded();

	// ONE byte-silent whole-tree render of the stated target — explicit
	// intent needs no projector: the route is named directly. The render
	// runs inside a nested request scope for the target URL
	// (`_runWithWarmRequestScope`) and drains into the void; the durable
	// effects are the caches it fills (`<Cache>` byte-cache entries,
	// loader caches) and the target route's registered snapshots — the
	// navigation statement that follows renders warm.
	const warmPreloadTarget = async (): Promise<void> => {
		if (session === null) return;
		const warm = session.pendingWarmUrl;
		if (warm === null || deliveryWindowExceeded()) return;
		session.pendingWarmUrl = null;
		try {
			await _runWithWarmRequestScope(warm.url, async () => {
				const reader = renderFullSegment().getReader();
				try {
					while (true) {
						const { done } = await reader.read();
						if (done) break;
					}
				} finally {
					reader.releaseLock();
				}
			});
		} catch {
			// Speculative by definition: a failed warm render costs
			// nothing — the navigation renders cold, exactly as if the
			// statement never arrived.
		}
	};

	const warmProjectedPartons = async (): Promise<void> => {
		if (session === null) return;
		const telemetry = session.telemetry;
		if (telemetry === null || telemetry.seq === warmedTelemetrySeq) return;
		// A window-skip deliberately records nothing: the freeing ack's
		// wake re-reaches this pass and the SAME statement projects then.
		if (deliveryWindowExceeded()) return;
		const projector = _getWarmProjector();
		if (projector === null) return;
		// The statement is consumed from here — projected, or judged not
		// projectable — so the latch above goes false in every path and
		// the wait-entry loop can never spin on one statement.
		warmedTelemetrySeq = telemetry.seq;
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		if (snapshots.size === 0) return;
		const candidates: WarmCandidate[] = [];
		for (const [id, snap] of snapshots) {
			if (!isParkedOnConnection(id, snapshots, session)) continue;
			candidates.push({ id, type: snap.type, props: snap.props });
		}
		if (candidates.length === 0) return;
		const ids = projector(telemetry, candidates).slice(0, MAX_WARM_PER_PARK);
		for (const id of ids) {
			// Real statements outrank speculation: a flip landing mid-pass
			// ends it (the remaining projections were racing that flip
			// anyway), and a closing/detaching connection warms nothing.
			if (closed || session.detached || session.pendingFlips.size > 0) return;
			const snap = snapshots.get(id);
			if (!snap) continue;
			if (!isParkedOnConnection(id, snapshots, session)) continue;
			const warmVisible = new Set(session.visible ?? []);
			warmVisible.add(id);
			try {
				await _runWithWarmRenderScope(warmVisible, async () => {
					// Fresh empty partial state: a warm render must never
					// fp-skip (a skipped body stores nothing) and must never
					// consult or mutate the connection's mirror layers.
					enterPartialState({
						requestedIds: null,
						isPartialRefetch: true,
								cachedFingerprints: new Map(),
						cachedMatchKeys: new Map(),
						ackedFingerprints: null,
						explicitIds: new Set(),
								seenIds: new Set(),
					});
					const reader = renderToReadableStream(
						partialFromSnapshot(id, snap),
					).getReader();
					try {
						while (true) {
							const { done } = await reader.read();
							if (done) break;
						}
					} finally {
						reader.releaseLock();
					}
				});
			} catch {
				// Speculative by definition: a failed warm render costs
				// nothing — the flip-in lane renders cold, exactly as if the
				// pass never ran.
			}
		}
	};

	// Whole-tree reconcile anchor — the last full segment this
	// connection saw (its initial segment, an honored catch-up anchor's
	// document, or the previous reconcile). Evaluated at wakes; an idle
	// connection never reaches the cadence (the keepalive closes it
	// first) and its reopen's first segment is whole-tree anyway.
	let lastFullSegmentAt = Date.now();

	// Ship the cumulative upstream-applied watermark when it has moved —
	// the marker that prunes the client transport's retransmit buffer.
	// Every envelope apply fires the flip wakes, so the announcement
	// rides the very next wake's bytes.
	const announceUpstreamApplied = (): void => {
		if (session === null) return;
		if (session.appliedSeq <= session.announcedAppliedSeq) return;
		session.announcedAppliedSeq = session.appliedSeq;
		enqueue(upstreamAppliedEntry(session.appliedSeq));
	};

	// The scheduled whole-tree reconcile: end the lanes region, flow one
	// full payload segment (rendered by the same renderer the segment
	// loop uses — fp-skip prunes it to placeholders when nothing was
	// missed), and reopen the lanes region. Only at quiesce (no open
	// lanes: a `next` delimiter would tear them client-side) and only
	// with room in the delivery window (the segment IS a delivery).
	const emitReconcileSegment = async (): Promise<boolean> => {
		if (!enqueue(nextMarker)) return false;
		let deliverySeq: number | null = null;
		if (session !== null) {
			deliverySeq = ++session.deliverySeq;
			if (
				!enqueue(segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq))
			)
				return false;
		}
		const reader = renderFullSegment().getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && value.byteLength > 0) {
					if (!(await awaitDemand())) {
						await reader.cancel().catch(() => {});
						return false;
					}
					if (!enqueue(value)) {
						await reader.cancel().catch(() => {});
						return false;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
		if (!(await awaitDemand())) return false;
		if (!enqueue(settledMarker)) return false;
		if (session !== null) session.firstDeliverySettledAt ??= Date.now();
		const tokens: Array<readonly [string, string, string]> = [];
		promoteSnapshotsToCachedOverride(undefined, (id, mk, fp) =>
			tokens.push([id, mk, fp]),
		);
		if (session !== null && deliverySeq !== null) {
			_recordDelivery(session, deliverySeq, tokens, session.consumedNavSeq);
		}
		if (!enqueue(nextMarker)) return false;
		return enqueue(lanesMarker);
	};

	// ── Navigation segments ──
	// A consumed url frame answers with one full payload segment for the
	// new request state, in stream order: `next` ends the lanes region
	// (open lanes torn first — see tearLanesForNavigation), the segment
	// flows with its delivery seq + as-of, `settled`, then `next` +
	// `lanes` reopens the region (the caller writes the reopen after the
	// LAST chained navigation). fp-skip applies as on any segment — a
	// navigation to a mostly-mirrored route ships placeholders.
	//
	// Mid-render supersede — the internal seam W5b's explicit cancel
	// frame reuses: a NEWER url frame latching while this segment
	// renders makes the render moot (the client's as-of guard will drop
	// the delivery), so the emitter aborts it — the read races a
	// nav-latch arm on the session's wake set (disposer-registered, one
	// per emission — the wake-arm release invariant), the reader is
	// cancelled (aborting the Flight render), and the caller consumes
	// the newer statement. Non-streaming navs buffer their Flight bytes
	// until drain, so a superseded delivery has only its early seq entry
	// on the wire; the next `next` delimiter closes an empty, stale
	// segment and the client consumes its processed-drop ack without
	// handing React a partial payload.
	const emitNavSegment = async (): Promise<"done" | "superseded" | "closed"> => {
		if (!enqueue(nextMarker)) return "closed";
		let deliverySeq: number | null = null;
		if (session !== null) {
			deliverySeq = ++session.deliverySeq;
			if (
				!enqueue(segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq))
			)
				return "closed";
		}
		const consumedSeq = session?.consumedNavSeq ?? 0;
		const bufferUntilDrain =
			session !== null && session.consumedNavStreaming !== true;
		const bufferedSegment: Uint8Array[] = [];
		const flushBufferedSegment = async (): Promise<boolean> => {
			if (!bufferUntilDrain || bufferedSegment.length === 0) return true;
			for (const chunk of bufferedSegment) {
				if (!(await awaitDemand())) return false;
				if (!enqueue(chunk)) return false;
			}
			bufferedSegment.length = 0;
			return true;
		};
		const supersededBy = (): boolean =>
			session !== null &&
			session.pendingNav !== null &&
			session.pendingNav.seq > consumedSeq;
		const reader = renderFullSegment().getReader();
		let navArm: (() => void) | null = null;
		const disposeArm = (): void => {
			if (session !== null && navArm !== null) session.flipWakes.delete(navArm);
			navArm = null;
		};
		try {
			while (true) {
				if (supersededBy()) {
					await reader.cancel().catch(() => {});
					return "superseded";
				}
				// Race the read against a nav latch: a suspended render (a
				// slow loader on the destination route) produces no bytes, so
				// without the arm a superseding url frame couldn't preempt
				// until the loader resolved.
				let notify: (() => void) | null = null;
				const latched = new Promise<"nav">((resolve) => {
					notify = () => resolve("nav");
				});
				navArm = () => {
					if (supersededBy()) notify?.();
				};
				if (session !== null) session.flipWakes.add(navArm);
				const winner = await Promise.race([
					reader.read().then((r) => ({ kind: "read" as const, r })),
					latched.then(() => ({ kind: "nav" as const })),
				]);
				disposeArm();
				if (winner.kind === "nav") {
					await reader.cancel().catch(() => {});
					return "superseded";
				}
				const { done, value } = winner.r;
				if (done) break;
				if (value && value.byteLength > 0) {
					if (bufferUntilDrain) {
						bufferedSegment.push(value);
					} else {
						if (!(await awaitDemand())) {
							await reader.cancel().catch(() => {});
							return "closed";
						}
						if (!enqueue(value)) {
							await reader.cancel().catch(() => {});
							return "closed";
						}
					}
				}
			}
		} finally {
			disposeArm();
			reader.releaseLock();
		}
		if (supersededBy()) return "superseded";
		if (!(await flushBufferedSegment())) return "closed";
		if (!(await awaitDemand())) return "closed";
		if (!enqueue(settledMarker)) return "closed";
		if (session !== null) session.firstDeliverySettledAt ??= Date.now();
		const tokens: Array<readonly [string, string, string]> = [];
		promoteSnapshotsToCachedOverride(undefined, (id, mk, fp) =>
			tokens.push([id, mk, fp]),
		);
		if (session !== null && deliverySeq !== null) {
			_recordDelivery(session, deliverySeq, tokens, consumedSeq);
		}
		return "done";
	};

	// Consume every latched url frame (a chain when navigations
	// supersede mid-render) and land exactly one settled navigation
	// segment — the newest statement's. Applies each statement to the
	// connection's request state through the same seam a server-side
	// `getServerNavigation().navigate` uses (`setRequest` on the ALS
	// store), refreshes the route reads, and reopens the lanes region
	// after the final segment. The mirror SURVIVES the consume: the
	// client keeps its pre-navigation partons (parked), so the covering
	// segment fp-skips them — a phantom is evicted only when the client
	// explicitly reports the delivery dropped (`ack.dropped`). Returns
	// false when the connection closed under it.
	const handleNavigation = async (): Promise<boolean> => {
		if (session === null) return true;
		// Explicit forces whose lanes this consume tears were never
		// satisfied — they re-lane after the reopen alongside the new
		// statement's own forces.
		const unfulfilledForces = [...lanes.entries()]
			.filter(([, rt]) => rt.forced)
			.map(([id]) => id);
		await tearLanesForNavigation();
		// The route is left behind: consequence seqs assigned for its
		// lanes can never emit (their client commits would be
		// as-of-dropped anyway) — void them so the watermark passes; the
		// same for frame-nav correlation flags whose covering lanes died
		// with the tear.
		for (const [, seq] of session.assignedLaneSeqs) session.voidSeqs.add(seq);
		session.assignedLaneSeqs.clear();
		laneNavSeqs.clear();
		// The union of the consumed statements' `__force` selectors — the
		// targets that lane after the region reopens. Superseded
		// statements' URLS are moot (the covering statement's stands),
		// but their FORCES are not: a silent restatement with a disjoint
		// target must not lose the earlier statement's refetch.
		// Resolve `__force` selectors (+ torn unfulfilled forces) to the
		// ids they hit on the current route: id match first, then label
		// fan-out — the same narrowing the reopened forced lanes take.
		const resolveForcedIds = (
			labels: ReadonlySet<string>,
			extra: readonly string[],
		): Set<string> => {
			const snapshots = _readSnapshotsForRoute(scope, routeKey);
			const wanted = [...labels];
			const ids = new Set<string>();
			for (const id of extra) if (snapshots.has(id)) ids.add(id);
			for (const name of wanted) if (snapshots.has(name)) ids.add(name);
			for (const [id, snap] of snapshots) {
				if (ids.has(id)) continue;
				if (snap.labels.some((l) => wanted.includes(l))) ids.add(id);
			}
			return ids;
		};
		const forceLabels = new Set<string>();
		try {
			while (true) {
				const nav = takeConnectionNavigation(session);
				if (nav === null) break;
				const current = new URL(request.url);
				const target = new URL(nav.url, current.origin);
				// `__force` is the statement's one-shot overlay, never part of
				// the request state: forced targets render as LANES below —
				// isolated snapshot renders, the same path a discrete
				// `?partials=` refetch takes. The whole-tree segment fp-skips
				// them (and their subtrees) via the fold exclusion below, so a
				// forced target's ancestor can answer with a placeholder while
				// the forced lane re-renders it fresh.
				for (const label of (target.searchParams.get("__force") ?? "")
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)) {
					forceLabels.add(label);
				}
				target.searchParams.delete("__force");
				setRequest(new Request(target, { headers: request.headers }));
				request = getRequest();
				routeKey = computeRouteKey(request.url);
				session.routeKey = routeKey;
				session.consumedNavSeq = nav.seq;
				session.consumedNavStreaming = nav.streaming === true;
				// Exclude the forced targets (and their subtrees) from every
				// ancestor's descendant fold on THIS segment render: the force
				// re-lanes them independently, so their change must not move an
				// ancestor's fp — the ancestor fp-skips, the forced lane covers
				// the change (parent-valid, child-invalid).
				if (forceLabels.size > 0 || unfulfilledForces.length > 0) {
					_setFoldExclusionIds(resolveForcedIds(forceLabels, unfulfilledForces));
				}
				const outcome = await emitNavSegment();
				if (outcome === "closed") return false;
				if (outcome === "superseded") continue;
			}
		} finally {
			// A later invalidation lane or reconcile on this connection folds
			// in full — the exclusion is one nav segment's concern only.
			_setFoldExclusionIds(null);
		}
		lastFullSegmentAt = Date.now();
		since = _currentTs();
		if (!enqueue(nextMarker)) return false;
		if (!enqueue(lanesMarker)) return false;
		// The statement's forced targets lane on the reopened region:
		// rendered EXPLICIT (`forcedLaneIds` — the lane state's
		// explicitIds), so fp-skip and the defer gate both yield: a
		// refetch target must re-render, never match-and-skip.
		// Torn-but-unfulfilled forces re-lane alongside (their id must
		// still snapshot on the new route — a real route change
		// legitimately drops them).
		if (forceLabels.size > 0 || unfulfilledForces.length > 0) {
			const ids = resolveForcedIds(forceLabels, unfulfilledForces);
			if (ids.size > 0) {
				enterRequestRegistry(routeKey, "cache");
				for (const id of ids) {
					forcedLaneIds.add(id);
					startLane(id);
				}
			}
		}
		return true;
	};

	// ── Frame navigation ──
	// Consume every latched FRAME url statement. The session frame URL
	// was written at the endpoint (the same store `?__frame=` writes
	// through); the driver's half is the RENDER: resolve the frame's
	// targets by its top-level name (id first, then label fan-out — the
	// same narrowing the discrete twin's `?partials=<frame[0]>` takes)
	// and lane them EXPLICIT on the OPEN region, each stamped with the
	// statement's seq (`nav=<n>` on its delivery announcement — the
	// client's milestone correlation). Frame content is a subtree, never
	// the whole route, so no region tear: window partons' lanes are
	// untouched — this is exactly the scoping the frame long-poll had.
	// A statement whose targets resolve to NOTHING (the frame never
	// rendered on this route) falls back to one whole-tree segment via
	// the reconcile machinery — its as-of covers the statement, so the
	// client's milestones resolve off the segment instead of a lane.
	const handleFrameNavs = async (): Promise<boolean> => {
		if (session === null) return true;
		const navs = takeConnectionFrameNavs(session);
		if (navs.size === 0) return true;
		// Identity refresh: a frame statement on an ANONYMOUS page mints
		// the session id at the endpoint (and rebinds the connection to
		// it), but this held request predates the mint — its renders
		// would read no session and miss the frame URL the endpoint just
		// wrote. Re-present the BOUND identity (the endpoint's checks
		// proved this client holds it) on the connection's request state.
		if (
			session.boundSessionId !== "" &&
			getSessionId() !== session.boundSessionId
		) {
			const headers = new Headers(request.headers);
			const cookie = headers.get("cookie");
			const sid = `${SESSION_COOKIE}=${session.boundSessionId}`;
			headers.set("cookie", cookie ? `${cookie}; ${sid}` : sid);
			setRequest(new Request(request.url, { headers }));
			request = getRequest();
		}
		const spawn: Array<{ id: string; navSeq: number }> = [];
		let uncovered = false;
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		for (const [key, nav] of navs) {
			session.consumedFrameNavSeqs.set(
				key,
				Math.max(session.consumedFrameNavSeqs.get(key) ?? 0, nav.seq),
			);
			// The as-of every subsequent emission carries — "the last url
			// statement the request state reflects" spans both scopes; a
			// frame consume advances it so covering renders are provably
			// post-consume. Window drop semantics are unaffected: the
			// client's navigation point only ever moves on WINDOW
			// statements, and the guard is `asOf >= navPoint`.
			session.consumedNavSeq = Math.max(session.consumedNavSeq, nav.seq);
			const top = key.split(".")[0];
			const ids = new Set<string>();
			if (snapshots.has(top)) ids.add(top);
			for (const [id, snap] of snapshots) {
				if (ids.has(id)) continue;
				if (snap.labels.includes(top)) ids.add(id);
			}
			if (ids.size === 0) {
				uncovered = true;
				continue;
			}
			for (const id of ids) spawn.push({ id, navSeq: nav.seq });
		}
		// The uncovered fallback needs region delimiters (a whole-tree
		// segment cannot interleave with open lanes), so it runs FIRST —
		// before this statement's own lanes open.
		if (uncovered) {
			await tearLanesForNavigation();
			if (!(await emitReconcileSegment())) return false;
			lastFullSegmentAt = Date.now();
			since = _currentTs();
		}
		if (spawn.length > 0) {
			enterRequestRegistry(routeKey, "cache");
			for (const { id, navSeq } of spawn) {
				const open = lanes.get(id);
				// A cancelled predecessor (the superseding statement's own
				// cancel, applied in the same envelope) is winding down — wait
				// it out so the covering lane opens a fresh body instead of
				// piggybacking a dirty flag on a pump that is exiting.
				if (open?.cancelled) {
					await open.done;
				}
				forcedLaneIds.add(id);
				laneNavSeqs.set(id, navSeq);
				startLane(id);
			}
		}
		return true;
	};

	// The cancel arm — registered for the drive's lifetime, disposed at
	// exit: a `cancel` statement's apply aborts its scope's open lane
	// renders synchronously (the same immediacy the window supersede
	// has through the nav-latch arm).
	const onCancelScope = (s: string): void => cancelScopeLanes(s);
	session?.cancelListeners.add(onCancelScope);

	// The attach statement's `__force` targets — a selector refetch that
	// fired pre-establishment and folded its overlay into the statement's
	// URL — lane EXPLICIT the moment the region opens, resolved against
	// the route's snapshots exactly like a consumed url statement's
	// (id first, then label fan-out). On the full path the whole-tree
	// initial segment has just rendered (fp-skip may have placeholdered
	// the targets — a whole-tree render cannot force a target whose
	// ancestor skips); on the catch-up path there was no segment at all.
	// Either way the forced lane is the covering render.
	{
		const force = attachForceSelector();
		if (force !== null && session !== null) {
			const snapshots = _readSnapshotsForRoute(scope, routeKey);
			const wanted = force
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const ids = new Set<string>();
			for (const name of wanted) {
				if (snapshots.has(name)) ids.add(name);
			}
			for (const [id, snap] of snapshots) {
				if (ids.has(id)) continue;
				if (snap.labels.some((l) => wanted.includes(l))) ids.add(id);
			}
			if (ids.size > 0) {
				enterRequestRegistry(routeKey, "cache");
				for (const id of ids) {
					forcedLaneIds.add(id);
					startLane(id);
				}
			}
		}
	}

	// `session.detached` exits alongside `closed`: an explicit detach
	// frame fires the flip wakes, the parked wait returns, and the
	// condition winds the drive down — the stream closes now instead of
	// holding a goner for the keepalive window. A degraded session
	// (never-acked) exits the same way: the driver stops holding.
	while (
		!closed &&
		session?.detached !== true &&
		session?.degradedReason == null
	) {
		// The never-acked degrade deadline: armed only while the FIRST
		// ack is outstanding after the first delivery-seq'd emission
		// settled — the moment the client's ack obligation began (see
		// FIRST_ACK_DEADLINE_MS for why absence needs a deadline at all).
		const degradeAt =
			session !== null &&
			!session.firstAckReceived &&
			session.firstDeliverySettledAt !== null
				? session.firstDeliverySettledAt + FIRST_ACK_DEADLINE_MS
				: null;
		// A statement that landed while the driver was busy (rendering
		// lanes, or between the lanes hand-off and this loop) is already
		// queued on the session — consume it without parking on the wake
		// arms first; a drain that landed while busy is likewise latched,
		// and so is an ack that freed the delivery window (the windowDirty
		// entry check). Deferred flips deliberately do NOT short-circuit
		// the wait: they only re-resolve on a real wake, so an unknown id
		// can't busy-loop the driver.
		// Navigation FIRST: a latched url frame outranks every other
		// latch — the client already lives on the new URL, so old-route
		// work is moot. Flips queued for the old route then resolve
		// against the new routeKey and defer (no snapshot on the new
		// route) — harmless: deferred ids linger without arming a wake.
		const latchedWake = (): SegmentWake | null =>
			session !== null && session.pendingNav !== null
				? "navigation"
				: session !== null && session.pendingFrameNavs.size > 0
					? "frame-navigation"
					: session !== null && session.pendingFlips.size > 0
						? "visibility"
						: laneDrainedPending
							? "lane-drained"
							: windowDirty.size > 0 && !deliveryWindowExceeded()
								? "window"
								: null;
		let wake: SegmentWake | null = latchedWake();
		while (wake === null && (pendingPreloadWarm() || pendingWarmStatement())) {
			// About to park with an unconsumed warm intent or telemetry
			// statement — the predictive warm point: no latched work, so
			// speculative renders crowd out nothing. Explicit intent
			// (a stated preload target) outranks scroll projection.
			// Statements that land while warming latch on the session; the
			// loop re-checks every latch, so a flip preempts further
			// passes and a fresh statement gets its own pass before the
			// park.
			if (pendingPreloadWarm()) await warmPreloadTarget();
			else await warmProjectedPartons();
			wake = latchedWake();
		}
		if (wake === null) {
			// No await between the loop's final latch evaluations and the
			// wait's synchronous arm registration — an envelope can only
			// land at an await point, so no statement can slip between a
			// checked latch and an armed listener.
			wake = await waitForSegmentWake(since, {
				// Window-deferred ids must not arm the expiry timer
				// either — their due deadlines would otherwise wake
				// immediately, defer again, and hot-spin the loop
				// until the window frees.
				excludeExpiryIds:
					windowDirty.size === 0
						? openLaneIds
						: new Set([...openLaneIds, ...windowDirty]),
				laneDrained: {
					pending: () => laneDrainedPending,
					wakes: laneDrainedWakes,
				},
				session,
				deadline: idleDeadline,
				degradeAt,
			});
		}
		if (wake === false) break;
		if (wake === "degrade") {
			// The first delivery settled a full deadline ago and no ack —
			// no ack FRAME at all — ever arrived: the duplex is unproven
			// (a blocked `/__parton/*` POST path, a frozen downstream). A
			// half-working channel must degrade, never freeze liveness
			// behind an unacked window: note the reason on the session and
			// stop holding — the heartbeat's discrete reopens take over.
			if (session !== null) session.degradedReason = "never-acked";
			break;
		}
		if (wake === "lane-drained") laneDrainedPending = false;
		announceUpstreamApplied();
		announceVoidSeqs();
		// A latched navigation preempts everything below regardless of
		// which arm won the race (a url frame's wake fires the same flip
		// arms). Other latches survive the continue — the next wait entry
		// consumes them against the new route.
		if (session !== null && session.pendingNav !== null) {
			if (!(await handleNavigation())) break;
			idleDeadline = Date.now() + KEEPALIVE_MS;
			announceVoidSeqs();
			continue;
		}
		// Latched FRAME navigations — after the window (a window move
		// outranks frame work: the frame targets resolve against the new
		// route), before flips.
		if (session !== null && session.pendingFrameNavs.size > 0) {
			if (!(await handleFrameNavs())) break;
			idleDeadline = Date.now() + KEEPALIVE_MS;
			announceVoidSeqs();
			continue;
		}
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		if (snapshots.size === 0) break;
		// The reconcile backstop — heals lane-relevance false-negatives
		// the label/constraint surface didn't capture, the correctness
		// role the keepalive reopen cycle plays for connections that
		// close idle. Deliberately does NOT extend the keepalive: it is
		// server-scheduled, not client-evidenced activity.
		if (
			Date.now() - lastFullSegmentAt >= RECONCILE_INTERVAL_MS &&
			lanes.size === 0 &&
			!deliveryWindowExceeded()
		) {
			if (!(await emitReconcileSegment())) break;
			lastFullSegmentAt = Date.now();
			since = _currentTs();
		}
		const touched: string[] = [];
		// Resolve flips. Each flip resolves against its OWN report's
		// statement (`PendingFlip.inView` — the id's presence in that
		// report's `visible` snapshot), never against the session's
		// CURRENT set: a mid-scroll burst legitimately dips the latest
		// snapshot while an earlier in-flip is still pending (old chunks
		// exit before new skeletons mount and testify), the client
		// reports each flip exactly once, and resolving the in-flip
		// against the dip would drop it forever — parking the world until
		// the heartbeat's keepalive reopen reseeds `?visible=`. Per id
		// the statement with the highest seq wins, so only an explicit
		// later out-flip cancels a pending in-flip. The worklist merges
		// deferred ids first (they have waited at least one wake already;
		// reports are ordered viewport-first, and this keeps that order
		// within each group), then the wake's fresh statements.
		//
		// Only in-flips lane: a cull-out is complete on the client the
		// moment it happens (the pair swaps to its inline skeleton — no
		// server bytes exist for a culled state), so an out-flip's entire
		// server-side effect is the session-set update the report already
		// applied. An in-flip's lane may fp-skip: a skip is the zero-byte
		// confirmation that the client's parked copy is current, and a
		// moved fp re-renders the body as usual. The verdict must be
		// against the client's ACTUAL holdings, so a DIRECT flip swaps
		// its statement's cached tokens into the override first (the
		// additive override alone drifts from the client — prunes,
		// evictions, slot overwrites — and confirming a phantom copy
		// blanks the parton). A DEFERRED flip carries no tokens: they are
		// stale by lane time, while the materializing render's
		// just-promoted fps are exactly what the client's slot received.
		const directFlips =
			wake === "visibility" && session !== null
				? takeConnectionFlips(session)
				: null;
		const worklist = new Map<string, PendingFlip>();
		for (const [id, seq] of deferredFlips)
			worklist.set(id, { inView: true, seq });
		if (directFlips) {
			for (const [id, flip] of directFlips) {
				const prior = worklist.get(id);
				if (prior !== undefined && flip.seq < prior.seq) continue;
				worklist.set(id, flip);
			}
		}
		const override = _getCachedOverride();
		for (const [id, flip] of worklist) {
			if (!flip.inView) {
				// The id's standing statement is an out-flip — nothing to
				// lane, and any deferred in-flip it superseded is cancelled.
				deferredFlips.delete(id);
				continue;
			}
			// The set learns the statement before the lane renders: the
			// lane's cull gate reads the session set, the lane ships the
			// in-state, and the client's pair re-primes its controller from
			// that emission — so the connection's knowledge for this id IS
			// "in view", even when the latest snapshot dipped below it
			// (mid-swap nodes drop out of a snapshot without testimony;
			// only `changed` testifies). Replaced, never mutated in place,
			// so a render holding the old reference keeps a consistent
			// view; the next report still replaces the set wholesale.
			if (
				session !== null &&
				session.visible !== null &&
				!session.visible.has(id)
			) {
				session.visible = new Set(session.visible).add(id);
			}
			if (!snapshots.has(id)) {
				deferredFlips.set(id, flip.seq);
				continue;
			}
			deferredFlips.delete(id);
			if (flip.cached !== undefined && override) {
				applyReportedCached(id, flip.cached, override, session?.ackedFps);
			}
			if (!touched.includes(id)) touched.push(id);
		}
		if (wake === "bump") {
			// Parked partons don't lane (see the parked-skip note above);
			// their catch-up is the flip-in revalidation. A parked skip
			// voids the id's assigned consequence seq — the lane it was
			// reserved for is not coming.
			for (const id of _routeMatchingBumpIds(snapshots, since)) {
				if (isParkedOnConnection(id, snapshots, session)) {
					voidAssigned(id);
					continue;
				}
				touched.push(id);
			}
			since = _currentTs();
			// Backstop for assignments this bump pass didn't touch (the
			// snapshot's constraint surface changed between the action's
			// reservation and this wake): an assignment neither laned nor
			// coalesced would pend — and hold the client's gate — forever.
			if (session !== null && session.assignedLaneSeqs.size > 0) {
				for (const id of [...session.assignedLaneSeqs.keys()]) {
					if (touched.includes(id)) continue;
					if (openLaneIds.has(id)) continue;
					if (windowDirty.has(id)) continue;
					voidAssigned(id);
				}
			}
		} else if (wake === "expiry" || wake === "lane-drained") {
			// Expiry wake, or a drained lane whose fresh snapshot may carry
			// a due deadline: render every parton past its `expiresAt`.
			// Open lanes are skipped — their stale snapshots still show the
			// deadline being serviced; the dirty flag / lane-drained arm
			// covers them. Parked partons are skipped like on a bump wake.
			const now = Date.now();
			for (const [id, snap] of snapshots) {
				if (openLaneIds.has(id)) continue;
				const exp = effectiveExpiresAt(snap);
				if (exp === undefined || !Number.isFinite(exp)) continue;
				if (exp <= now && !isParkedOnConnection(id, snapshots, session))
					touched.push(id);
			}
		}
		// The unacked delivery window — the second lane-opening gate (the
		// first is the response stream's own desiredSize pull-gate, which
		// parks enqueues byte-wise). Exceeded: touched ids coalesce into
		// the dirty set instead of opening lanes. Coalescing intermediate
		// states is CORRECT here — cells carry state, not events, so when
		// the window frees, ONE render of the latest state supersedes
		// every intermediate the gate skipped; nothing is dropped, the
		// ids stay dirty until they lane. A gated wake is not useful
		// activity: the keepalive keeps counting down, so a client that
		// never frees the window can't hold the connection open.
		if (deliveryWindowExceeded()) {
			for (const id of touched) windowDirty.add(id);
			continue;
		}
		if (windowDirty.size > 0) {
			// The window freed — the coalesced ids render their LATEST
			// state, ahead of this wake's fresh touches (they have waited
			// longest). Ids that parked while gated stay skipped like on
			// any wake; a flip-in in the dirty set is never parked (the
			// set learned it at consume time above).
			const freed = [...windowDirty];
			windowDirty.clear();
			for (let i = freed.length - 1; i >= 0; i--) {
				const id = freed[i];
				if (isParkedOnConnection(id, snapshots, session)) {
					voidAssigned(id);
					continue;
				}
				if (!touched.includes(id)) touched.unshift(id);
			}
		}
		announceVoidSeqs();
		if (touched.length === 0) continue;
		idleDeadline = Date.now() + KEEPALIVE_MS;
		// Fresh registry pass per wake: descendant folds and lookups read
		// the canonical store as of NOW (with every prior lane's commit
		// applied) instead of the initial segment's memoized fold base.
		enterRequestRegistry(routeKey, "cache");
		for (const id of touched) startLane(id);
	}
	// Release demand-parked pumps before waiting the lanes out — the
	// loop's exit is the signal that no further demand is worth
	// waiting for. Producer lanes get their reads aborted too: their
	// bodies stream until a producer resolves — an unbounded await that
	// must not hold the wind-down (normal renders are loader-bounded
	// and drain out).
	session?.cancelListeners.delete(onCancelScope);
	stopping = true;
	for (const runtime of lanes.values()) {
		if (runtime.producer) {
			runtime.cancelled = true;
			runtime.abortRead?.();
		}
	}
	for (const release of [...gateWaiters]) release();
	await Promise.allSettled([...lanes.values()].map((l) => l.done));
}

const IDLE_TIMEOUT = Symbol("idle-timeout");
const EXPIRES_AT_WAKE = Symbol("expires-at-wake");
const LANE_DRAINED_WAKE = Symbol("lane-drained-wake");
const VISIBILITY_WAKE = Symbol("visibility-wake");
const DEGRADE_WAKE = Symbol("degrade-wake");

/** Which arm woke a segment/lane wait. `false` closes the stream.
 *  `"window"`, `"navigation"` and `"frame-navigation"` are minted only
 *  by the lane driver's wait-entry latch (an ack freed the delivery
 *  window / a url frame latched while the driver was busy); the wait
 *  itself never returns them — a url frame's wake fires the flip arms,
 *  and the loop's pending-nav checks preempt regardless of the winning
 *  arm. `"degrade"` is the never-acked deadline. */
type SegmentWake =
	| false
	| "bump"
	| "expiry"
	| "lane-drained"
	| "visibility"
	| "window"
	| "navigation"
	| "frame-navigation"
	| "degrade";

interface SegmentWakeOptions {
	/** Parton ids whose `expiresAt` must NOT arm the expiry timer —
	 *  the lane driver passes its open lanes: their stale snapshots
	 *  still show the just-serviced deadline, and arming on it would
	 *  busy-loop the wait until the lane's commit lands. */
	excludeExpiryIds?: ReadonlySet<string>;
	/** Extra wake arm: fires when a lane drains, so the wait
	 *  re-evaluates expiry against the drained parton's FRESH snapshot
	 *  (which carries its next deadline). Without it, a wait armed
	 *  while the only expiring parton had an open lane would park on
	 *  bump+keepalive alone and the parton's next tick would starve
	 *  until the keepalive closed the connection. A disposable
	 *  listener set + the driver's latch (never a promise: a `.then`
	 *  reaction on a park-lived promise can't be released, and the
	 *  irrelevant-bump re-arm loop would accrete one per idle wake);
	 *  the wait registers per race iteration and releases with the
	 *  other arms, re-checking `pending` at each re-arm so a drain
	 *  that raced a losing arm is consumed, not starved. */
	laneDrained?: { pending: () => boolean; wakes: Set<() => void> };
	/** The live connection's session (per-parton driver only). Two
	 *  roles. Parked partons' `expiresAt` deadlines must not arm the
	 *  expiry timer — the driver skips their lanes, so arming on a
	 *  parked parton's past-due deadline would hot-spin the wake loop
	 *  (immediate expiry wake → nothing laned → re-arm on the same
	 *  deadline); read live at arm time so a report landing between
	 *  wakes moves the very next arm. And the visibility wake arm
	 *  registers on the session's `flipWakes` for the park's duration
	 *  — the caller drains the flipped ids via `takeConnectionFlips`. */
	session?: ConnectionSession | null;
	/** Absolute idle deadline (ms epoch) overriding the default
	 *  now+KEEPALIVE_MS anchor. The lane driver passes its
	 *  activity-anchored deadline so a run of wakes that ship nothing
	 *  can't extend the connection's life — see the zombie-connection
	 *  note in `driveLaneStream`. */
	deadline?: number;
	/** Absolute never-acked degrade deadline (ms epoch), or null when
	 *  the obligation isn't running (no delivery settled yet, or the
	 *  first ack already arrived). A timer arm with a disposer, like
	 *  the keepalive — anchored at delivered-settle by the caller, see
	 *  `FIRST_ACK_DEADLINE_MS`. */
	degradeAt?: number | null;
}

/**
 * Wait for a reason to emit the next segment, or for the keepalive to
 * elapse. Races the arms:
 *   - a `refreshSelector` bump RELEVANT to the route — one matching a
 *     rendered partial's labels + constraint args (`routeHasRelevantBump`).
 *     A bump in another session/scope, or to a selector this route
 *     doesn't render, would only fp-skip here, so it re-arms the wait
 *     instead of driving a full re-render. This is what stops N
 *     concurrent streams from re-rendering on every one of N peers'
 *     mutations.
 *   - the earliest `expiresAt` boundary (time-based reactivity).
 *   - the keepalive cap, measured from the last segment so a run of
 *     irrelevant bumps can't hold the connection open indefinitely.
 *   - optionally, a lane draining (per-parton driver only).
 *   - optionally, a channel statement landing on the connection
 *     session (per-parton driver only).
 *
 * Returns the arm that fired, or `false` to close the stream (the
 * client's heartbeat reopens on its next tick).
 */
async function waitForSegmentWake(
	sinceTs: number,
	options?: SegmentWakeOptions,
): Promise<SegmentWake> {
	const keepaliveDeadline = options?.deadline ?? Date.now() + KEEPALIVE_MS;
	const expiresAtDelay = computeNextExpiresAtDelay(
		options?.excludeExpiryIds,
		options?.session,
	);
	const expiresAtDeadline =
		expiresAtDelay !== null ? Date.now() + Math.max(0, expiresAtDelay) : null;
	let since = sinceTs;
	while (true) {
		// A drain that landed while a previous iteration's race was being
		// decided (its settle lost to a bump) is latched — consume it here
		// instead of parking past it.
		if (options?.laneDrained?.pending()) return "lane-drained";
		const keepaliveRemaining = keepaliveDeadline - Date.now();
		if (keepaliveRemaining <= 0) return false;
		// One deferred per park, every arm registered against it with an
		// explicit release — the wake-arm release invariant: a reaction
		// only frees when its promise settles, so arming a park on
		// long-lived shared state (the registry's waiter set, the
		// session's flip wakes, the lane driver's drain wakes) without
		// releasing the losers would grow the heap by one full wake race
		// per idle wake, for as long as the connection holds.
		let settle!: (value: symbol | number) => void;
		const woke = new Promise<symbol | number>((resolve) => {
			settle = resolve;
		});
		const disposers: Array<() => void> = [];
		disposers.push(_onNextBump(since, settle));
		const kaTimer = setTimeout(() => settle(IDLE_TIMEOUT), keepaliveRemaining);
		disposers.push(() => clearTimeout(kaTimer));
		if (expiresAtDeadline !== null) {
			const expTimer = setTimeout(
				() => settle(EXPIRES_AT_WAKE),
				Math.max(0, expiresAtDeadline - Date.now()),
			);
			disposers.push(() => clearTimeout(expTimer));
		}
		const laneDrainedWakes = options?.laneDrained?.wakes;
		if (laneDrainedWakes) {
			const onDrain = (): void => settle(LANE_DRAINED_WAKE);
			laneDrainedWakes.add(onDrain);
			disposers.push(() => laneDrainedWakes.delete(onDrain));
		}
		if (options?.degradeAt != null) {
			const dgTimer = setTimeout(
				() => settle(DEGRADE_WAKE),
				Math.max(0, options.degradeAt - Date.now()),
			);
			disposers.push(() => clearTimeout(dgTimer));
		}
		const flipWakes = options?.session?.flipWakes;
		if (flipWakes) {
			const onFlip = (): void => settle(VISIBILITY_WAKE);
			flipWakes.add(onFlip);
			disposers.push(() => flipWakes.delete(onFlip));
		}
		let result: symbol | number;
		try {
			result = await woke;
		} finally {
			for (const dispose of disposers) dispose();
		}
		if (result === IDLE_TIMEOUT) return false;
		if (result === EXPIRES_AT_WAKE) return "expiry";
		if (result === LANE_DRAINED_WAKE) return "lane-drained";
		if (result === VISIBILITY_WAKE) return "visibility";
		if (result === DEGRADE_WAKE) return "degrade";
		// A bump won the race. Emit only if it touched something this route
		// actually renders; otherwise advance the cursor and re-arm.
		if (routeHasRelevantBump(since)) return "bump";
		since = _currentTs();
	}
}

/**
 * True iff some `refreshSelector` bump with `ts > sinceTs` matches any
 * partial rendered on the current route — by label AND constraint args
 * subset, the same surface the live fp folds in via `queryMatchingTs`.
 * Mirrors `invalidationKeyFromSnap`: a snapshot's `varyKey` is the
 * stable-stringified match params, and `constraintArgs` carries any
 * bound-cell args, so their union is the partial's effective
 * constraint surface. Returns `true` on missing scope/snapshots — the
 * safe default is to emit a segment rather than risk withholding one.
 */
function routeHasRelevantBump(sinceTs: number): boolean {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return true;
	}
	const snapshots = _readSnapshotsForRoute(scope, computeRouteKey(request.url));
	if (snapshots.size === 0) return true;
	return _routeHasMatchingBump(snapshots, sinceTs);
}

/**
 * Compute the delay (ms from now) until the earliest `expiresAt`
 * across the just-rendered route's snapshots. Returns `null` when
 * no partial declared one (or the only declared values are
 * `+Infinity` — the "never" sentinel).
 *
 * Partials declare `expiresAt` by calling the `expires()` hook during
 * schema/Render (a live box on the snapshot; see `effectiveExpiresAt`).
 * The segment driver reads the snapshots after each render to derive
 * the next wake time.
 */
function computeNextExpiresAtDelay(
	excludeIds?: ReadonlySet<string>,
	session?: ConnectionSession | null,
): number | null {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return null;
	}
	const routeKey = computeRouteKey(request.url);
	const snapshots = _readSnapshotsForRoute(scope, routeKey);
	if (snapshots.size === 0) return null;
	let min = Number.POSITIVE_INFINITY;
	for (const [id, snap] of snapshots) {
		if (excludeIds?.has(id)) continue;
		const exp = effectiveExpiresAt(snap);
		if (exp === undefined) continue;
		if (!Number.isFinite(exp)) continue;
		if (session && isParkedOnConnection(id, snapshots, session)) continue;
		if (exp < min) min = exp;
	}
	if (!Number.isFinite(min)) return null;
	return min - Date.now();
}

/**
 * True iff `id`'s own snapshot, or a cullable ancestor's, sits outside
 * the connection's measured visible set — the parton is PARKED: its
 * client copy is a hidden Activity slot (cull-to-park), so lanes at it
 * ship bytes nobody sees. Reads the same two signals the cull gate
 * reads: the snapshot's recorded `visible:<id>?seed=…` dep marks the
 * parton cullable, and the session's current set is its viewport
 * state. `visible: null` (no report yet) parks nothing — the seed
 * state is authoritative until the client measures. Skipping is
 * staleness-free: every bump that lands while parked moves the
 * in-state fp, so the flip-in revalidation's skip check can only miss
 * (re-render fresh), never false-match.
 */
function hasCullGateDep(
	deps: ReadonlySet<string> | undefined,
	id: string,
): boolean {
	if (!deps) return false;
	const prefix = `visible:${id}`;
	for (const d of deps) {
		if (d === prefix || d.startsWith(`${prefix}?`)) return true;
	}
	return false;
}

function isParkedOnConnection(
	id: string,
	snapshots: ReadonlyMap<string, PartialSnapshot>,
	session: ConnectionSession | null,
): boolean {
	const visible = session?.visible;
	if (visible == null) return false;
	const snap = snapshots.get(id);
	if (!snap) return false;
	if (hasCullGateDep(snap.deps, id) && !visible.has(id)) return true;
	for (const ancestorId of snap.parentPath) {
		if (ancestorId === id) continue;
		const ancestor = snapshots.get(ancestorId);
		if (!ancestor) continue;
		if (hasCullGateDep(ancestor.deps, ancestorId) && !visible.has(ancestorId))
			return true;
	}
	return false;
}

/**
 * Read the just-committed snapshots for the current route and append
 * each `(id, matchKey, fp)` tuple into the request-scoped cached
 * override Maps. PartialRoot's next render reads from those Maps
 * directly (same identity), so the override IS the next render's
 * `state.cachedFingerprints` / `state.cachedMatchKeys` — no URL
 * rewrite, no parse round-trip.
 *
 * Snapshots without an `emittedFp` (non-addressable specs, e.g.
 * layout wrappers with no selector) or without a `matchKey` are
 * skipped: they have no client-visible wire identity to track.
 *
 * Why the override carrier even exists: the previous shape
 * `rewriteCachedFromSnapshots` did `new URL(req.url)` +
 * `url.searchParams.set("cached", […].join(","))` + `url.toString()` +
 * `new Request(...)` + `setRequest(...)` per segment, and the next
 * segment's PartialRoot re-parsed `?cached=` back into Maps. Per-tick
 * profiling showed that round-trip dominating the streaming CPU
 * profile (~7% total + URL parse cost). The carrier collapses it to
 * one map mutation per snapshot.
 */
/** Replace the mirror's entries for `id` with the client's reported
 *  holdings — `id:matchKey:fp` tokens, parsed right-to-left like
 *  `parseCachedTokens` (ids may contain colons; matchKeys never do).
 *  Replaces EVERY layer for the id: the flip statement is the client's
 *  own attestation of what it holds, so it supersedes both the
 *  optimistic skip-set and the acked layer — an acked fp the client
 *  has since evicted must not confirm a phantom copy (acks report what
 *  the client gained, never what it evicted; this statement is the
 *  eviction evidence). */
function applyReportedCached(
	id: string,
	tokens: readonly string[],
	override: {
		fingerprints: Map<string, Set<string>>;
		matchKeys: Map<string, Set<string>>;
		slots: Map<string, Map<string, Set<string>>>;
	},
	ackedFps?: Map<string, Set<string>>,
): void {
	const fps = new Set<string>();
	const mks = new Set<string>();
	const idSlots = new Map<string, Set<string>>();
	for (const token of tokens) {
		const fpIdx = token.lastIndexOf(":");
		if (fpIdx <= 0) continue;
		const fp = token.slice(fpIdx + 1);
		const rest = token.slice(0, fpIdx);
		const mkIdx = rest.lastIndexOf(":");
		if (mkIdx <= 0) continue;
		const mk = rest.slice(mkIdx + 1);
		fps.add(fp);
		mks.add(mk);
		let slot = idSlots.get(mk);
		if (!slot) {
			slot = new Set();
			idSlots.set(mk, slot);
		}
		slot.add(fp);
	}
	override.fingerprints.set(id, fps);
	override.matchKeys.set(id, mks);
	override.slots.set(id, idSlots);
	// The stated tokens are client-attested holdings — the acked layer's
	// truth class — so they REPLACE its entry rather than clearing it.
	ackedFps?.set(id, new Set(fps));
}

/**
 * Promote one `(id, matchKey, fp)` into the override with the
 * client's SLOT semantics: the client keeps one content per
 * `(id, matchKey)` (`cacheStore` overwrites evict the slot's prior
 * fps), so a fresh fp for a slot EVICTS that slot's other fps from
 * the verdict set — an A→B→A content cycle must re-render at each
 * step, never fp-skip against a slot the client overwrote. An fp
 * folds its matchKey, so it belongs to exactly one slot and the
 * flat-set surgery is exact. A re-promotion of an fp the slot already
 * holds is a no-op (the same content re-rendered).
 */
function promoteSlotFpToOverride(
	override: {
		fingerprints: Map<string, Set<string>>;
		matchKeys: Map<string, Set<string>>;
		slots: Map<string, Map<string, Set<string>>>;
	},
	id: string,
	matchKey: string,
	fp: string,
): void {
	let idSlots = override.slots.get(id);
	if (!idSlots) {
		idSlots = new Map();
		override.slots.set(id, idSlots);
	}
	let slot = idSlots.get(matchKey);
	if (!slot) {
		slot = new Set();
		idSlots.set(matchKey, slot);
	}
	let fpSet = override.fingerprints.get(id);
	if (!fpSet) {
		fpSet = new Set();
		override.fingerprints.set(id, fpSet);
	}
	if (!slot.has(fp)) {
		// Fresh content for the slot: the client's commit evicted every
		// prior fp the slot advertised — mirror the eviction.
		for (const old of slot) fpSet.delete(old);
		slot.clear();
		slot.add(fp);
	}
	fpSet.add(fp);
	capOverrideSet(fpSet);
	let mkSet = override.matchKeys.get(id);
	if (!mkSet) {
		mkSet = new Set();
		override.matchKeys.set(id, mkSet);
	}
	mkSet.add(matchKey);
	capOverrideSet(mkSet);
}

/** Fold a trailer's `{from, to}` warm-fp entries into the live
 *  connection's cached override — the exact server-side mirror of the
 *  client's `_applyFpUpdates`: `to` joins the SLOT still holding `from`
 *  (the same content, warmed — kept alongside `from`, evicted with it
 *  when a sibling variant later overwrites the slot). A heal whose
 *  `from` no slot holds is superseded and DROPPED — never added
 *  slotlessly, which would strand it past the slot's eviction and let a
 *  return-toggle fp-skip against a phantom. `onToken` records the join
 *  under its resolved matchKey so the acked layer folds it the same
 *  way. */
function promoteFpUpdatesToCachedOverride(
	updates: FpUpdatesPayload,
	onToken?: (id: string, matchKey: string, fp: string) => void,
): void {
	const override = _getCachedOverride();
	if (!override) return;
	for (const [id, entry] of Object.entries(updates)) {
		const idSlots = override.slots.get(id);
		if (!idSlots) continue;
		for (const [mk, slot] of idSlots) {
			if (!slot.has(entry.from)) continue;
			slot.add(entry.to);
			capOverrideSet(slot);
			let fpSet = override.fingerprints.get(id);
			if (!fpSet) {
				fpSet = new Set();
				override.fingerprints.set(id, fpSet);
			}
			fpSet.add(entry.to);
			capOverrideSet(fpSet);
			onToken?.(id, mk, entry.to);
			break;
		}
	}
}

export function promoteSnapshotsToCachedOverride(
	withinId?: string,
	// The delivery-record sink: the lane/segment drivers capture the
	// promoted `(id, matchKey, fp)` triples as the emission's holdings
	// in the SAME walk (no second pass per drain) — see
	// `_recordDelivery`.
	onToken?: (id: string, matchKey: string, fp: string) => void,
): void {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return;
	}
	const override = _getCachedOverride();
	if (!override) return;
	const routeKey = computeRouteKey(request.url);
	const snapshots = _readSnapshotsForRoute(scope, routeKey);
	if (snapshots.size === 0) return;

	for (const [id, snap] of snapshots) {
		// `withinId` scopes the walk to one parton's subtree — a lane
		// drain promotes only the snapshots its render just committed.
		if (
			withinId !== undefined &&
			id !== withinId &&
			!snap.parentPath.includes(withinId)
		)
			continue;
		if (!snap.emittedFp || !snap.matchKey) continue;
		promoteSlotFpToOverride(override, id, snap.matchKey, snap.emittedFp);
		onToken?.(id, snap.matchKey, snap.emittedFp);
	}
}

/**
 * Reserve the delivery seqs an action's invalidation consequences will
 * ride on the connection the action request NAMED (`x-parton-conn` —
 * an explicit client statement, never inferred). Returns the reserved
 * seqs for the response's consequence header, or `null` when there is
 * nothing to reserve (no such connection, a binding mismatch, no
 * relevant pending bump).
 *
 * MUST run inside the action's invalidation transaction, AFTER the
 * body queued its bumps and BEFORE the commit flushes them: the flush
 * is what wakes the segment drivers, so assigning here is strictly
 * ordered before any driver could mint the same lanes' seqs — the
 * pump takes an id's assignment at iteration start
 * (`assignedLaneSeqs`), and every skip path voids it (`voidSeqs` → the
 * `seqvoid` entry) so the client's contiguous watermark can always
 * pass a reservation. The client's optimistic overlay holds until its
 * committed watermark covers the returned seqs — never cleared at the
 * POST's return value alone (under window coalescing the consequence
 * lane can trail the response by the whole backpressure window, which
 * is exactly when a returnValue-cleared overlay would flash stale).
 *
 * Binding checks mirror the channel endpoint's: the request's scope
 * and session identity must match the attach's — a mismatched header
 * reserves nothing (the action itself is unaffected).
 */
export function _reserveActionConsequences(
	connectionId: string,
): number[] | null {
	const session = _peekConnectionSession(connectionId);
	if (!session) return null;
	if (getScope() !== session.scope) return null;
	if ((getSessionId() ?? "") !== session.boundSessionId) return null;
	if (session.routeKey === null) return null;
	const selectors = _pendingInvalidationSelectors();
	if (selectors.length === 0) return null;
	const snapshots = _readSnapshotsForRoute(session.scope, session.routeKey);
	if (snapshots.size === 0) return null;
	const seqs: number[] = [];
	for (const id of _routeMatchingSelectorIds(snapshots, selectors)) {
		// Parked partons never lane (the flip-in revalidation is their
		// catch-up) — reserving for one would wedge the watermark.
		if (isParkedOnConnection(id, snapshots, session)) continue;
		// An unconsumed prior reservation is reused: one render of the
		// latest state covers both writes (cells carry state, not
		// events), and the earlier action's gate holds on the same seq.
		let seq = session.assignedLaneSeqs.get(id);
		if (seq === undefined) {
			seq = ++session.deliverySeq;
			session.assignedLaneSeqs.set(id, seq);
		}
		seqs.push(seq);
	}
	return seqs.length > 0 ? seqs : null;
}

/**
 * Promote each snapshot's `emittedFp` into the request state's
 * `cachedFingerprints` map. Call this between segments so the next
 * render's fp-skip path treats just-emitted partials as cached.
 *
 * Snapshots without an `emittedFp` (non-addressable specs) are
 * skipped — there's no client identity to track.
 */
export function promoteEmittedFpsToCached(
	state: PartialRequestState,
	snapshots: ReadonlyMap<string, PartialSnapshot>,
): void {
	for (const [id, snap] of snapshots) {
		const fp = snap.emittedFp;
		if (!fp) continue;
		let set = state.cachedFingerprints.get(id);
		if (!set) {
			set = new Set();
			state.cachedFingerprints.set(id, set);
		}
		set.add(fp);
	}
}
