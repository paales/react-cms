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
	_getCachedOverride,
	_isConnectionLive,
	_setConnectionSession,
	getRequest,
	getScope,
} from "../runtime/context.ts";
import {
	_currentTs,
	_waitForNextBump,
} from "../runtime/invalidation-registry.ts";
import {
	_closeConnectionSession,
	_openConnectionSession,
	type ConnectionSession,
	takeConnectionFlips,
} from "./connection-session.ts";
import { renderToReadableStream } from "./flight-runtime.ts";
import { wrapStreamWithFpTrailer } from "./fp-trailer.ts";
import {
	buildMarker,
	TAG_LANES_OPEN,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
} from "./fp-trailer-marker.ts";
import { computeRouteKey, partialFromSnapshot } from "./partial.tsx";
import type { PartialSnapshot } from "./partial-registry.ts";
import {
	_readSnapshotsForRoute,
	effectiveExpiresAt,
	enterRequestRegistry,
	lookupPartial,
} from "./partial-registry.ts";
import type { PartialRequestState } from "./partial-request-state.ts";
import { muxEndFrame, muxFrame } from "./parton-mux.ts";
import {
	_routeHasMatchingBump,
	_routeMatchingBumpIds,
} from "./segment-relevance.ts";

/** How long the driver holds the response open after each segment.
 *  Bumped to 20s — long enough that most realtime updates land
 *  without a reconnect, short enough that idle connections don't
 *  pile up. */
const KEEPALIVE_MS = 20_000;

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
 */
export async function driveSegmentedResponse(
	controller: ReadableStreamDefaultController<Uint8Array>,
	renderSegment: () => ReadableStream<Uint8Array>,
	onSegmentEnd?: () => void,
): Promise<void> {
	// Pre-encode the `next` delimiter and the `settled` milestone — same
	// bytes every time, so build each once.
	const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0);
	const settledMarker = buildMarker(TAG_SEGMENT_SETTLED, 0);

	// A live subscription carrying a connection id gets a connection
	// session — the per-connection state slot visibility-report POSTs
	// address. Opened BEFORE the first segment renders so a report can
	// land at any point of the connection's lifetime, and so the first
	// whole-tree segment already reads the client's measured set (the
	// session seeds from the request's `?visible=` param). Closed when
	// the drive loop exits: a report for a closed session gets a `404`,
	// the client controller's explicit fall-back-to-reload signal.
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

		while (true) {
			_clearConnectionLive();

			if (segmentIndex > 0) {
				controller.enqueue(nextMarker);
			}

			const flightStream = renderSegment();
			const reader = flightStream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) controller.enqueue(value);
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
				await driveLaneStream(controller, lastTs, settledMarker, session);
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
 * Open the connection session for the active request when it is a live
 * subscription carrying a `?__conn=` connection id, seeding the visible
 * set from the request's `?visible=` param (`null` when absent — the
 * pre-measurement state). The session is stamped onto the request's ALS
 * store so `visible()` / `evalDepKeys` read it for the connection's
 * whole lifetime. Returns `null` for one-shot requests and id-less live
 * subscriptions (no POST can address those, so no session is needed).
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
	const id = params.get("__conn");
	if (!id) return null;
	const rawVisible = params.get("visible");
	const seed =
		rawVisible === null ? null : new Set(rawVisible.split(",").filter(Boolean));
	const session = _openConnectionSession(id, seed);
	_setConnectionSession(session);
	return session;
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
 * `wrapStreamWithFpTrailer` commits at its own flush and re-emits
 * `{from,to}` fp updates for EVERY route snapshot whose recomputed fp
 * drifted — which is how ancestors' descendant-fold refreshes ride the
 * child's lane without the ancestors ever re-rendering.
 *
 * The `settled` milestone is written at quiesce (every lane drained),
 * marking a safe abort point; mid-lane aborts are also safe client-side
 * because a torn lane rejects only its own un-committed decode.
 *
 * Visibility flips are the fourth wake: a report POST updates the
 * connection session's visible set and names the flipped ids, and the
 * driver renders exactly those ids as lanes — with `visible()` (and the
 * fp fold's store-and-reread) reading the session's CURRENT set. A
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

	// Lane-drained wake arm. A drained lane's fresh snapshot carries its
	// next `expiresAt`; resolving this re-arms the wait so the deadline
	// is re-read from the committed snapshot instead of starving behind
	// the open-lane expiry exclusion.
	let signalLaneDrained: () => void = () => {};
	let laneDrained = new Promise<void>((resolve) => {
		signalLaneDrained = resolve;
	});

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
					},
				);
				const reader = wrapped.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						if (
							value &&
							value.byteLength > 0 &&
							!enqueue(muxFrame(id, value))
						) {
							await reader.cancel().catch(() => {});
							return;
						}
					}
				} finally {
					reader.releaseLock();
				}
				if (!enqueue(muxEndFrame(id))) return;
				// The lane's snapshots just committed (the per-lane fp-trailer
				// wrap commits at flush). Promote the fresh emittedFps into the
				// request's cached override so this parton's next lane render —
				// and every other lane's descendants — fp-skip against them.
				promoteSnapshotsToCachedOverride();
				if (!runtime.dirty) return;
			}
		} finally {
			lanes.delete(id);
			openLaneIds.delete(id);
			if (!closed && lanes.size === 0) enqueue(settledMarker);
			signalLaneDrained();
		}
	};

	// Flips whose ids had no route snapshot when their report arrived — a
	// report racing the render that first materializes its parton (a
	// chunk reported in-view while its bigChunk's flip-in lane is still
	// streaming). Deferred, never dropped: the client reports each flip
	// exactly once (the IntersectionObserver only fires on change), so a
	// dropped flip would leave that parton stale until the next
	// whole-tree reconciliation. Re-checked against fresh snapshots on
	// every subsequent wake — the materializing lane's own drain is a
	// wake — and resolved ids lane like any other flip. Ids that never
	// materialize linger harmlessly until the connection closes.
	const deferredFlips = new Set<string>();

	let since = sinceTs;
	while (!closed) {
		// A report that landed while the driver was busy (rendering lanes,
		// or between the lanes hand-off and this loop) is already queued on
		// the session — consume it without parking on the wake arms first.
		// Deferred flips deliberately do NOT short-circuit the wait: they
		// only re-resolve on a real wake, so an unknown id can't busy-loop
		// the driver.
		const wake: SegmentWake =
			session !== null && session.pendingFlips.size > 0
				? "visibility"
				: await waitForSegmentWake(since, {
						excludeExpiryIds: openLaneIds,
						laneDrained,
						visibilityFlip: session?.flipped,
					});
		if (wake === false) break;
		if (wake === "lane-drained") {
			laneDrained = new Promise<void>((resolve) => {
				signalLaneDrained = resolve;
			});
		}
		const snapshots = _readSnapshotsForRoute(scope, routeKey);
		if (snapshots.size === 0) break;
		const touched: string[] = [];
		// Resolve flips — the wake's fresh ids after any deferred ones (a
		// deferred flip has waited at least one wake already; reports are
		// ordered viewport-first, and this keeps that order within each
		// group). Flips keep their promoted fps and the lane render may
		// fp-skip: the culled state is its own cache variant
		// (`~cull` — see render-pipeline.md §Cull-to-park), so each
		// state's fps only ever match that state's own body — a skip is
		// the zero-byte confirmation that the client's parked copy for
		// the state being entered is current, and a moved fp re-renders
		// the body as usual.
		const directFlips =
			wake === "visibility" && session !== null
				? takeConnectionFlips(session)
				: [];
		for (const id of [...deferredFlips, ...directFlips]) {
			if (!snapshots.has(id)) {
				deferredFlips.add(id);
				continue;
			}
			deferredFlips.delete(id);
			if (!touched.includes(id)) touched.push(id);
		}
		if (wake === "bump") {
			touched.push(..._routeMatchingBumpIds(snapshots, since));
			since = _currentTs();
		} else if (wake !== "visibility") {
			// Expiry wake, or a drained lane whose fresh snapshot may carry
			// a due deadline: render every parton past its `expiresAt`.
			// Open lanes are skipped — their stale snapshots still show the
			// deadline being serviced; the dirty flag / lane-drained arm
			// covers them.
			const now = Date.now();
			for (const [id, snap] of snapshots) {
				if (openLaneIds.has(id)) continue;
				const exp = effectiveExpiresAt(snap);
				if (exp === undefined || !Number.isFinite(exp)) continue;
				if (exp <= now) touched.push(id);
			}
		}
		if (touched.length === 0) continue;
		// Fresh registry pass per wake: descendant folds and lookups read
		// the canonical store as of NOW (with every prior lane's commit
		// applied) instead of the initial segment's memoized fold base.
		enterRequestRegistry(routeKey, "cache");
		for (const id of touched) startLane(id);
	}
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
	 *  until the keepalive closed the connection. */
	laneDrained?: Promise<void>;
	/** Extra wake arm: resolves when a visibility report lands on the
	 *  connection session (per-parton driver only). The caller drains
	 *  the flipped ids via `takeConnectionFlips`, which re-arms. */
	visibilityFlip?: Promise<void>;
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
 *   - optionally, a visibility report landing on the connection
 *     session (per-parton driver only).
 *
 * Returns the arm that fired, or `false` to close the stream (the
 * client's heartbeat reopens on its next tick).
 */
async function waitForSegmentWake(
	sinceTs: number,
	options?: SegmentWakeOptions,
): Promise<SegmentWake> {
	const keepaliveDeadline = Date.now() + KEEPALIVE_MS;
	const expiresAtDelay = computeNextExpiresAtDelay(options?.excludeExpiryIds);
	const expiresAtDeadline =
		expiresAtDelay !== null ? Date.now() + Math.max(0, expiresAtDelay) : null;
	let since = sinceTs;
	while (true) {
		const keepaliveRemaining = keepaliveDeadline - Date.now();
		if (keepaliveRemaining <= 0) return false;
		let kaTimer: ReturnType<typeof setTimeout> | null = null;
		let expTimer: ReturnType<typeof setTimeout> | null = null;
		const arms: Array<Promise<symbol | number>> = [
			_waitForNextBump(since),
			new Promise<symbol>((resolve) => {
				kaTimer = setTimeout(() => resolve(IDLE_TIMEOUT), keepaliveRemaining);
			}),
		];
		if (expiresAtDeadline !== null) {
			const expRemaining = Math.max(0, expiresAtDeadline - Date.now());
			arms.push(
				new Promise<symbol>((resolve) => {
					expTimer = setTimeout(() => resolve(EXPIRES_AT_WAKE), expRemaining);
				}),
			);
		}
		if (options?.laneDrained) {
			arms.push(options.laneDrained.then(() => LANE_DRAINED_WAKE));
		}
		if (options?.visibilityFlip) {
			arms.push(options.visibilityFlip.then(() => VISIBILITY_WAKE));
		}
		const result = await Promise.race(arms);
		if (kaTimer) clearTimeout(kaTimer);
		if (expTimer) clearTimeout(expTimer);
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
		if (exp < min) min = exp;
	}
	if (!Number.isFinite(min)) return null;
	return min - Date.now();
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
export function promoteSnapshotsToCachedOverride(): void {
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
		if (!snap.emittedFp || !snap.matchKey) continue;
		let fpSet = override.fingerprints.get(id);
		if (!fpSet) {
			fpSet = new Set();
			override.fingerprints.set(id, fpSet);
		}
		fpSet.add(snap.emittedFp);
		let mkSet = override.matchKeys.get(id);
		if (!mkSet) {
			mkSet = new Set();
			override.matchKeys.set(id, mkSet);
		}
		mkSet.add(snap.matchKey);
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
