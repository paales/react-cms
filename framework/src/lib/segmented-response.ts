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
	_clearConnectionLive,
	_clearRequestEphemeralStorage,
	_getAttachStatement,
	_getCachedOverride,
	_isConnectionLive,
	_setCachedOverride,
	_setConnectionSession,
	getRequest,
	getScope,
} from "../runtime/context.ts";
import {
	_currentTs,
	_onNextBump,
	_registryEpoch,
} from "../runtime/invalidation-registry.ts";
import { getSessionId } from "../runtime/session.ts";
import {
	_closeConnectionSession,
	_openConnectionSession,
	type ConnectionSession,
	type PendingFlip,
	takeConnectionFlips,
} from "./connection-session.ts";
import { renderToReadableStream } from "./flight-runtime.ts";
import { wrapStreamWithFpTrailer } from "./fp-trailer.ts";
import {
	buildMarker,
	type FpUpdatesPayload,
	TAG_CONNECTION_ID,
	TAG_LANES_OPEN,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
} from "./fp-trailer-marker.ts";
import { computeRouteKey, parseCachedTokens, partialFromSnapshot } from "./partial.tsx";
import type { PartialSnapshot } from "./partial-registry.ts";
import {
	_readSnapshotsForRoute,
	effectiveExpiresAt,
	enterRequestRegistry,
	lookupPartial,
} from "./partial-registry.ts";
import { enterPartialState, type PartialRequestState } from "./partial-request-state.ts";
import { muxEndFrame, muxFrame } from "./parton-mux.ts";
import {
	_routeHasMatchingBump,
	_routeMatchingBumpIds,
} from "./segment-relevance.ts";

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
		let segmentIndex = 0;
		let lastTs = _currentTs();

		// Live catch-up: the attach's first fire presents the document's
		// registry anchor (the statement's `since`, minted into the SSR
		// trailing comment). The document IS the page state as of that
		// point, so re-rendering the whole route here would only re-ship
		// bytes the client already holds — skip the initial segment
		// entirely and open straight into lanes anchored at the document's
		// timestamp: the first wake lanes exactly what bumped or expired
		// after the document rendered. Honored only when the anchor's
		// epoch names THIS registry timeline (a restart or clear starts a
		// new one) and the route still has snapshots (an HMR dispose wipes
		// them); otherwise fall through to the full initial render.
		const catchUpTs = liveCatchupTs();
		if (catchUpTs !== null && session !== null) {
			installCatchupCachedOverride();
			controller.enqueue(buildMarker(TAG_LANES_OPEN, 0));
			enqueueConnectionId(controller, session.id);
			await driveLaneStream(controller, catchUpTs, settledMarker, session, demand);
			return;
		}

		while (true) {
			_clearConnectionLive();

			if (segmentIndex > 0) {
				controller.enqueue(nextMarker);
			}

			// The server-minted connection id, ahead of the first segment's
			// Flight rows — an ENTRY, so the splitter surfaces it and keeps
			// the body flowing. Shipping it FIRST means the client transport
			// can address the session before the whole-tree render has even
			// drained; the id's existence proves the session is open (it was
			// minted at session open, above).
			if (segmentIndex === 0 && session !== null) {
				enqueueConnectionId(controller, session.id);
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
			// body. The client's cooperative abort (the live heartbeat tearing
			// down on navigate) gates on this marker — see `SegmentIterator` in
			// `fp-trailer-split.ts`.
			controller.enqueue(settledMarker);

			if (onSegmentEnd) onSegmentEnd();

			// Live subscription (`?live=1`, the heartbeat's long-poll): after
			// the initial whole-tree segment, the connection switches to
			// per-parton lanes — each wake renders only the partons the bump /
			// expiresAt boundary actually touched, and their payloads
			// interleave as independent `mux` frames, so one parton's slow
			// Suspense boundary never head-of-line-blocks another parton's
			// next update. Relevance false-negatives (a dependency the
			// label/dep surface doesn't capture) are reconciled by the next
			// whole-tree render: the keepalive close forces the heartbeat to
			// reopen, and the reopened connection's first segment is always
			// whole-tree.
			if (isLiveSubscription()) {
				promoteSnapshotsToCachedOverride();
				controller.enqueue(nextMarker);
				controller.enqueue(buildMarker(TAG_LANES_OPEN, 0));
				await driveLaneStream(controller, lastTs, settledMarker, session, demand);
				return;
			}

			// Server-side multi-segment opt-in: this segment's render called
			// `markConnectionLive()` (producer-await sentinels like the chat's
			// `ChunkSlot`). Those stay whole-tree — their next content comes
			// from the render itself resolving, not from a relevance-matched
			// bump, so per-parton lanes have nothing to key on. A bare
			// `?streaming=1` targeted refetch is NOT a subscription — it's a
			// one-shot that commits its segment and closes.
			if (!_isConnectionLive()) break;

			// Promote just-emitted (id, matchKey, fp) tokens into the
			// request-scoped cached override so the NEXT segment's render
			// fp-skips the unchanged partials. We append to the in-memory
			// Maps shared with PartialRoot's state — no URL rewrite, no
			// re-parse. Safe under live partials because the descendant-fold
			// (both live in `descendantContribution` and snapshot-based in
			// `descendantContributionFromSnapshot`) folds each descendant's
			// invalidation ts in — when a hot-bumping descendant's `|inv=N`
			// shifts, the ancestor's fold moves with it, the ancestor's fp
			// moves, the promoted fp from the prior segment no longer
			// matches, the ancestor body re-runs, and the descendant is
			// re-instantiated.
			promoteSnapshotsToCachedOverride();

			// Wait for a reason to emit the next segment, or for the keepalive
			// to elapse. Only a bump RELEVANT to this route's rendered partials
			// (or an expiresAt boundary) emits another segment; bumps in other
			// sessions/scopes — which this stream would only fp-skip — re-arm
			// without re-rendering. See waitForSegmentWake.
			const proceed = await waitForSegmentWake(lastTs);
			if (proceed === false) break;
			lastTs = _currentTs();
			segmentIndex++;
		}
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
 * Resolve the request's live catch-up anchor — the attach statement's
 * `since` (the document's registry anchor the heartbeat's first fire
 * presents; see [[channel-protocol]]'s `AttachStatement`). The anchor
 * rides ONLY the attach body — no URL form exists — so a discrete live
 * GET always takes the full initial render. Returns the anchor
 * timestamp when it is honorable: a live subscription, the epoch names
 * the CURRENT registry timeline, and the route still has snapshots to
 * lane from. `null` otherwise — the caller falls through to the full
 * initial render (over-fetch, never stale).
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
	if (new URL(request.url).searchParams.get("live") !== "1") return null;
	const since = _getAttachStatement()?.since ?? null;
	if (since === null) return null;
	if (since.epoch !== _registryEpoch()) return null;
	const routeKey = computeRouteKey(request.url);
	if (_readSnapshotsForRoute(scope, routeKey).size === 0) return null;
	return since.ts;
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
	});
}

/**
 * Open the connection session for the active request when it is a live
 * subscription, under a SERVER-MINTED connection id (never a
 * client-chosen URL param — that shape invites fixation and leaks the
 * addressable token into access logs; the id ships downstream as the
 * stream's `conn` entry instead). Seeds the visible set from the
 * attach statement's `visible` — the in-process live GET's `?visible=`
 * param is the statement-less carrier — with `null` as the
 * pre-measurement state, and binds the attach's scope + session
 * identity (what every channel envelope must re-present — see
 * `handleChannelPost` in `connection-session.ts`). Every attach binds
 * its OWN request's identity, which makes it the explicit rebind
 * point: a session cookie minted mid-connection starts working the
 * moment the next attach presents it. The session is
 * stamped onto the request's ALS store so the cull gate and
 * `evalDepKeys` read it for the connection's whole lifetime. Returns
 * `null` for one-shot requests — no envelope can address those, so no
 * session is needed.
 */
function openLiveConnectionSession(): ConnectionSession | null {
	let request: Request;
	try {
		request = getRequest();
	} catch {
		return null;
	}
	const params = new URL(request.url).searchParams;
	if (params.get("live") !== "1") return null;
	const statement = _getAttachStatement();
	let seed: ReadonlySet<string> | null;
	if (statement !== null) {
		seed = statement.visible === null ? null : new Set(statement.visible);
	} else {
		const rawVisible = params.get("visible");
		seed =
			rawVisible === null
				? null
				: new Set(rawVisible.split(",").filter(Boolean));
	}
	const session = _openConnectionSession(crypto.randomUUID(), seed, {
		scope: getScope(),
		sessionId: getSessionId() ?? "",
	});
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

/** One open lane: a parton whose payload is currently rendering and
 *  framing onto the connection. */
interface LaneRuntime {
	/** A wake touched this parton while its lane was open. One lane per
	 *  parton id keeps the wire unambiguous (the client keys open bodies
	 *  by id), so the pump re-renders once the current payload drains
	 *  instead of opening a second lane. */
	dirty: boolean;
	done: Promise<void>;
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
): Promise<void> {
	let request: Request;
	let scope: string;
	try {
		request = getRequest();
		scope = getScope();
	} catch {
		return;
	}
	const routeKey = computeRouteKey(request.url);
	const lanes = new Map<string, LaneRuntime>();
	const openLaneIds = new Set<string>();
	let closed = false;

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

	// Lane-output demand gate. Parks while the consumer's queue is
	// full; the stream's pull releases it. Returns false when the lane
	// must wind down instead of enqueue: the consumer cancelled (the
	// explicit no-pull-is-coming signal — also marks the connection
	// closed so the wake loop exits at its next wake), or the wake
	// loop exited while this pump was parked with the queue still
	// full. A pump caught by `stopping` with room in the queue still
	// delivers — only a consumer that stopped pulling gets its lane
	// tail torn.
	const awaitDemand = async (): Promise<boolean> => {
		if (!demand) return true;
		while (
			!stopping &&
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
		return !(
			stopping &&
			controller.desiredSize !== null &&
			controller.desiredSize <= 0
		);
	};

	// Lane-drained wake arm. A drained lane's fresh snapshot carries its
	// next `expiresAt`; the wake re-arms the wait so the deadline is
	// re-read from the committed snapshot instead of starving behind
	// the open-lane expiry exclusion. A latch plus a per-park promise
	// rather than one long-lived promise: the wait races a FRESH
	// promise each park (discarded with the park, so exited waits
	// retain nothing — the wake-arm release invariant), and a drain
	// landing while the driver is busy sets the latch, which the next
	// wait entry consumes without parking.
	let laneDrainedPending = false;
	let signalLaneDrained: () => void = () => {};
	const noteLaneDrained = (): void => {
		laneDrainedPending = true;
		signalLaneDrained();
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
		const runtime: LaneRuntime = { dirty: false, done: Promise.resolve() };
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
		if (laneOverride) {
			enterPartialState({
				requestedIds: null,
				isPartialRefetch: true,
				populateCache: false,
				cachedFingerprints: laneOverride.fingerprints,
				cachedMatchKeys: laneOverride.matchKeys,
				explicitIds: new Set(),
				cullFlip: false,
				seenIds: new Set(),
			});
		}
		try {
			while (!closed) {
				runtime.dirty = false;
				const snap = lookupPartial(id);
				if (!snap) break;
				const flight = renderToReadableStream(partialFromSnapshot(id, snap));
				// A lane is a single parton's render — its flush already fires at
				// that parton's completion, and lanes run concurrently (the
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
						// Fold this lane's warm fps into the connection's cached
						// override alongside the client-bound trailer, so the
						// server-side skip check tracks the same drift the client
						// heals (a bump landing between this lane's render and
						// its flush moves the recomputed fp past the emitted one).
						onUpdates: promoteFpUpdatesToCachedOverride,
					},
				);
				const reader = wrapped.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value && value.byteLength > 0) {
							// Pull-gated: park before the enqueue while the consumer's
							// queue is full. Not reading the NEXT chunk until then
							// propagates the wait into the lane's Flight stream, so a
							// stalled reader holds at most one frame per lane
							// server-side instead of every wake's full payload.
							if (!(await awaitDemand())) {
								await reader.cancel().catch(() => {});
								return;
							}
							if (!enqueue(muxFrame(id, value))) {
								await reader.cancel().catch(() => {});
								return;
							}
						}
					}
				} finally {
					reader.releaseLock();
				}
				if (!(await awaitDemand())) return;
				if (!enqueue(muxEndFrame(id))) return;
				// The lane's snapshots just committed (the per-lane fp-trailer
				// wrap commits at flush). Promote the fresh emittedFps into the
				// request's cached override so this parton's next lane render —
				// and every other lane's descendants — fp-skip against them.
				// Scoped to the lane's subtree: only those snapshots are fresh
				// from this render; walking the whole route map per drain is
				// O(route) churn for entries the drain didn't touch.
				promoteSnapshotsToCachedOverride(id);
				if (!runtime.dirty) return;
			}
		} finally {
			lanes.delete(id);
			openLaneIds.delete(id);
			if (!closed && lanes.size === 0) enqueue(settledMarker);
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
	// `session.detached` exits alongside `closed`: an explicit detach
	// frame fires the flip wakes, the parked wait returns, and the
	// condition winds the drive down — the stream closes now instead of
	// holding a goner for the keepalive window.
	while (!closed && session?.detached !== true) {
		// A statement that landed while the driver was busy (rendering
		// lanes, or between the lanes hand-off and this loop) is already
		// queued on the session — consume it without parking on the wake
		// arms first; a drain that landed while busy is likewise latched.
		// Deferred flips deliberately do NOT short-circuit the wait: they
		// only re-resolve on a real wake, so an unknown id can't busy-loop
		// the driver.
		const wake: SegmentWake =
			session !== null && session.pendingFlips.size > 0
				? "visibility"
				: laneDrainedPending
					? "lane-drained"
					: await waitForSegmentWake(since, {
							excludeExpiryIds: openLaneIds,
							laneDrained: new Promise<void>((resolve) => {
								signalLaneDrained = resolve;
							}),
							session,
							deadline: idleDeadline,
						});
		if (wake === false) break;
		if (wake === "lane-drained") laneDrainedPending = false;
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		if (snapshots.size === 0) break;
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
			if (session !== null && session.visible !== null && !session.visible.has(id)) {
				session.visible = new Set(session.visible).add(id);
			}
			if (!snapshots.has(id)) {
				deferredFlips.set(id, flip.seq);
				continue;
			}
			deferredFlips.delete(id);
			if (flip.cached !== undefined && override) {
				applyReportedCached(id, flip.cached, override);
			}
			if (!touched.includes(id)) touched.push(id);
		}
		if (wake === "bump") {
			// Parked partons don't lane (see the parked-skip note above);
			// their catch-up is the flip-in revalidation.
			for (const id of _routeMatchingBumpIds(snapshots, since)) {
				if (isParkedOnConnection(id, snapshots, session)) continue;
				touched.push(id);
			}
			since = _currentTs();
		} else if (wake !== "visibility") {
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
	// waiting for.
	stopping = true;
	for (const release of [...gateWaiters]) release();
	await Promise.allSettled([...lanes.values()].map((l) => l.done));
}

const IDLE_TIMEOUT = Symbol("idle-timeout");
const EXPIRES_AT_WAKE = Symbol("expires-at-wake");
const LANE_DRAINED_WAKE = Symbol("lane-drained-wake");
const VISIBILITY_WAKE = Symbol("visibility-wake");

/** Which arm woke a segment/lane wait. `false` closes the stream. */
type SegmentWake = false | "bump" | "expiry" | "lane-drained" | "visibility";

interface SegmentWakeOptions {
	/** Parton ids whose `expiresAt` must NOT arm the expiry timer —
	 *  the lane driver passes its open lanes: their stale snapshots
	 *  still show the just-serviced deadline, and arming on it would
	 *  busy-loop the wait until the lane's commit lands. */
	excludeExpiryIds?: ReadonlySet<string>;
	/** Extra wake arm: resolves when a lane drains, so the wait
	 *  re-evaluates expiry against the drained parton's FRESH snapshot
	 *  (which carries its next deadline). Without it, a wait armed
	 *  while the only expiring parton had an open lane would park on
	 *  bump+keepalive alone and the parton's next tick would starve
	 *  until the keepalive closed the connection. Minted fresh per
	 *  park by the lane driver (drains between parks ride its latch),
	 *  so the wait's reaction is discarded with the park. */
	laneDrained?: Promise<void>;
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
		const keepaliveRemaining = keepaliveDeadline - Date.now();
		if (keepaliveRemaining <= 0) return false;
		// One deferred per park, every arm registered against it with an
		// explicit release — the wake-arm release invariant: a reaction
		// only frees when its promise settles, so arming a park on
		// long-lived shared state (the registry's waiter set, the
		// session's flip wakes) without releasing the losers would grow
		// the heap by one full wake race per idle wake, for as long as
		// the connection holds.
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
		if (options?.laneDrained) {
			// A reaction on a per-park promise (see the lane driver's
			// latch) — dropped with the park, nothing to release.
			void options.laneDrained.then(() => settle(LANE_DRAINED_WAKE));
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

/** Inspect the active request's URL for a `?live=1` flag — the live-
 *  subscription opt-in set by `<LivePageHeartbeat>` (a whole-route
 *  long-poll that wants the connection held open for pushes). Targeted
 *  refetches and one-shot navs never set it, so they emit their
 *  segment and close. Returning false here keeps the driver's
 *  first-and-only segment behaviour byte-identical to a one-shot. */
function isLiveSubscription(): boolean {
	try {
		return new URL(getRequest().url).searchParams.get("live") === "1";
	} catch {
		return false;
	}
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
/** Replace the override's entries for `id` with the client's reported
 *  holdings — `id:matchKey:fp` tokens, parsed right-to-left like
 *  `parseCachedTokens` (ids may contain colons; matchKeys never do). */
function applyReportedCached(
	id: string,
	tokens: readonly string[],
	override: { fingerprints: Map<string, Set<string>>; matchKeys: Map<string, Set<string>> },
): void {
	const fps = new Set<string>();
	const mks = new Set<string>();
	for (const token of tokens) {
		const fpIdx = token.lastIndexOf(":");
		if (fpIdx <= 0) continue;
		const fp = token.slice(fpIdx + 1);
		const rest = token.slice(0, fpIdx);
		const mkIdx = rest.lastIndexOf(":");
		if (mkIdx <= 0) continue;
		fps.add(fp);
		mks.add(rest.slice(mkIdx + 1));
	}
	override.fingerprints.set(id, fps);
	override.matchKeys.set(id, mks);
}

/** Per-id bound on the override's fp / matchKey sets — same shape as
 *  the client's `FP_CAP_PER_VARIANT`: a live parton drifting every
 *  lane (each bump folds a fresh invalidation ts) would grow its set
 *  unboundedly over a long-held connection. Oldest-first eviction
 *  keeps the newest few — enough for the next render's skip check;
 *  an evicted entry only costs an over-fetch, never staleness. */
const OVERRIDE_SET_CAP = 8;

function capOverrideSet(set: Set<string>): void {
	while (set.size > OVERRIDE_SET_CAP) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

/** Fold a trailer's `{from, to}` warm-fp entries into the live
 *  connection's cached override — the server-side mirror of the
 *  client's `_applyFpUpdates`. The override's fp sets are per id;
 *  additions are safe (a candidate fp is computed fresh each render,
 *  so matching any accumulated fp means the fold values genuinely
 *  coincide) and bounded per set by `capOverrideSet`. */
function promoteFpUpdatesToCachedOverride(updates: FpUpdatesPayload): void {
	const override = _getCachedOverride();
	if (!override) return;
	for (const [id, entry] of Object.entries(updates)) {
		let fpSet = override.fingerprints.get(id);
		if (!fpSet) {
			fpSet = new Set();
			override.fingerprints.set(id, fpSet);
		}
		fpSet.add(entry.to);
		capOverrideSet(fpSet);
	}
}

export function promoteSnapshotsToCachedOverride(withinId?: string): void {
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
		let fpSet = override.fingerprints.get(id);
		if (!fpSet) {
			fpSet = new Set();
			override.fingerprints.set(id, fpSet);
		}
		fpSet.add(snap.emittedFp);
		capOverrideSet(fpSet);
		let mkSet = override.matchKeys.get(id);
		if (!mkSet) {
			mkSet = new Set();
			override.matchKeys.set(id, mkSet);
		}
		mkSet.add(snap.matchKey);
		capOverrideSet(mkSet);
	}
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
