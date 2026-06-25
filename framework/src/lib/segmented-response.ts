/**
 * Server-side multi-segment response driver.
 *
 * Stays open for up to `KEEPALIVE_MS` of idle after each segment
 * when the request opts in via `?streaming=1` (set by the client's
 * `reload({streaming: true})` / `navigate({streaming: true})`).
 * Within that window, any `refreshSelector` activity wakes the
 * driver, re-runs the render, and emits the next segment delimited
 * by a `next` marker. If the window elapses with no activity, the
 * response closes.
 *
 * Non-streaming requests (no `?streaming=1` — most navigations,
 * cache-mode refetches, action responses) emit one segment and
 * close — byte-identical to the pre-segment-loop output.
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

import type { PartialRequestState } from "./partial-request-state.ts"
import type { PartialSnapshot } from "./partial-registry.ts"
import { _readSnapshotsForRoute } from "./partial-registry.ts"
import { computeRouteKey } from "./partial.tsx"
import {
  _clearConnectionLive,
  _getCachedOverride,
  _isConnectionLive,
  _clearRequestEphemeralStorage,
  getRequest,
  getScope,
} from "../runtime/context.ts"
import { _currentTs, _waitForNextBump } from "../runtime/invalidation-registry.ts"
import { _routeHasMatchingBump } from "./segment-relevance.ts"
import { buildMarker, TAG_NEXT_SEGMENT, TAG_SEGMENT_SETTLED } from "./fp-trailer-marker.ts"

/** How long the driver holds the response open after each segment.
 *  Bumped to 20s — long enough that most realtime updates land
 *  without a reconnect, short enough that idle connections don't
 *  pile up. */
const KEEPALIVE_MS = 20_000

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
  const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0)
  const settledMarker = buildMarker(TAG_SEGMENT_SETTLED, 0)

  let segmentIndex = 0
  let lastTs = _currentTs()

  while (true) {
    _clearConnectionLive()

    if (segmentIndex > 0) {
      controller.enqueue(nextMarker)
    }

    const flightStream = renderSegment()
    const reader = flightStream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) controller.enqueue(value)
      }
    } finally {
      reader.releaseLock()
    }

    // The render for this segment has fully drained — its body bytes and
    // the `fp`/`url` trailers are all on the wire. Emit the `settled`
    // milestone so the client knows the iteration is complete: from this
    // point the connection is parked (held open awaiting the next bump),
    // and an abort can cancel the reader WITHOUT tearing a mid-render
    // body. The client's cooperative abort (the live heartbeat tearing
    // down on navigate) gates on this marker — see `SegmentIterator` in
    // `fp-trailer-split.ts`.
    controller.enqueue(settledMarker)

    if (onSegmentEnd) onSegmentEnd()

    // Multi-segment opt-in: either the request URL carried
    // `?streaming=1` (client-side `reload({streaming: true})` /
    // `navigate({streaming: true})`), or this segment's render
    // called `markConnectionLive()` (server-side opt-in used by
    // producer-await sentinels like the chat's `ChunkSlot`).
    if (!isStreamingRequest() && !_isConnectionLive()) break

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
    promoteSnapshotsToCachedOverride()

    // Wait for a reason to emit the next segment, or for the keepalive
    // to elapse. Only a bump RELEVANT to this route's rendered partials
    // (or an expiresAt boundary) emits another segment; bumps in other
    // sessions/scopes — which this stream would only fp-skip — re-arm
    // without re-rendering. See waitForSegmentWake.
    const proceed = await waitForSegmentWake(lastTs)
    if (!proceed) break
    lastTs = _currentTs()
    segmentIndex++
  }
}

const IDLE_TIMEOUT = Symbol("idle-timeout")
const EXPIRES_AT_WAKE = Symbol("expires-at-wake")

/**
 * Wait for a reason to emit the next segment, or for the keepalive to
 * elapse. Races three arms:
 *   - a `refreshSelector` bump RELEVANT to the route — one matching a
 *     rendered partial's labels + vary/args (`routeHasRelevantBump`).
 *     A bump in another session/scope, or to a selector this route
 *     doesn't render, would only fp-skip here, so it re-arms the wait
 *     instead of driving a full re-render. This is what stops N
 *     concurrent streams from re-rendering on every one of N peers'
 *     mutations.
 *   - the earliest `expiresAt` boundary (time-based reactivity).
 *   - the keepalive cap, measured from the last segment so a run of
 *     irrelevant bumps can't hold the connection open indefinitely.
 *
 * Returns `true` to emit another segment, `false` to close the stream
 * (the client's heartbeat reopens on its next tick).
 */
async function waitForSegmentWake(sinceTs: number): Promise<boolean> {
  const keepaliveDeadline = Date.now() + KEEPALIVE_MS
  const expiresAtDelay = computeNextExpiresAtDelay()
  const expiresAtDeadline =
    expiresAtDelay !== null ? Date.now() + Math.max(0, expiresAtDelay) : null
  let since = sinceTs
  while (true) {
    const keepaliveRemaining = keepaliveDeadline - Date.now()
    if (keepaliveRemaining <= 0) return false
    let kaTimer: ReturnType<typeof setTimeout> | null = null
    let expTimer: ReturnType<typeof setTimeout> | null = null
    const arms: Array<Promise<symbol | number>> = [
      _waitForNextBump(since),
      new Promise<symbol>((resolve) => {
        kaTimer = setTimeout(() => resolve(IDLE_TIMEOUT), keepaliveRemaining)
      }),
    ]
    if (expiresAtDeadline !== null) {
      const expRemaining = Math.max(0, expiresAtDeadline - Date.now())
      arms.push(
        new Promise<symbol>((resolve) => {
          expTimer = setTimeout(() => resolve(EXPIRES_AT_WAKE), expRemaining)
        }),
      )
    }
    const result = await Promise.race(arms)
    if (kaTimer) clearTimeout(kaTimer)
    if (expTimer) clearTimeout(expTimer)
    if (result === IDLE_TIMEOUT) return false
    if (result === EXPIRES_AT_WAKE) return true
    // A bump won the race. Emit only if it touched something this route
    // actually renders; otherwise advance the cursor and re-arm.
    if (routeHasRelevantBump(since)) return true
    since = _currentTs()
  }
}

/**
 * True iff some `refreshSelector` bump with `ts > sinceTs` matches any
 * partial rendered on the current route — by label AND vary/args
 * subset, the same surface the live fp folds in via `queryMatchingTs`.
 * Mirrors `invalidationKeyFromSnap`: a snapshot's `varyKey` is the
 * stable-stringified vary result, and `constraintArgs` carries any
 * bound-cell args, so their union is the partial's effective
 * constraint surface. Returns `true` on missing scope/snapshots — the
 * safe default is to emit a segment rather than risk withholding one.
 */
function routeHasRelevantBump(sinceTs: number): boolean {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return true
  }
  const snapshots = _readSnapshotsForRoute(scope, computeRouteKey(request.url))
  if (snapshots.size === 0) return true
  return _routeHasMatchingBump(snapshots, sinceTs)
}

/**
 * Compute the delay (ms from now) until the earliest `expiresAt`
 * across the just-rendered route's snapshots. Returns `null` when
 * no partial declared one (or the only declared values are
 * `+Infinity` — the "never" sentinel).
 *
 * Partials declare `expiresAt` by returning it from `vary`; the
 * framework strips it from the vary result before fp computation
 * (see `stripReservedVaryKeys` in partial.tsx) and stores it on
 * the partial's snapshot. The segment driver reads those snapshots
 * after each render to derive the next wake time.
 */
function computeNextExpiresAtDelay(): number | null {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return null
  }
  const routeKey = computeRouteKey(request.url)
  const snapshots = _readSnapshotsForRoute(scope, routeKey)
  if (snapshots.size === 0) return null
  let min = Number.POSITIVE_INFINITY
  for (const snap of snapshots.values()) {
    if (snap.expiresAt === undefined) continue
    if (!Number.isFinite(snap.expiresAt)) continue
    if (snap.expiresAt < min) min = snap.expiresAt
  }
  if (!Number.isFinite(min)) return null
  return min - Date.now()
}

/** Inspect the active request's URL for a `?streaming=1` flag. The
 *  client's `reload({streaming: true})` sets it; everything else
 *  (page nav, cache-mode refetch, action response) doesn't. Returning
 *  false here keeps the driver's first-and-only segment behaviour
 *  byte-identical to the pre-segment-loop output. */
function isStreamingRequest(): boolean {
  try {
    return new URL(getRequest().url).searchParams.get("streaming") === "1"
  } catch {
    return false
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
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return
  }
  const override = _getCachedOverride()
  if (!override) return
  const routeKey = computeRouteKey(request.url)
  const snapshots = _readSnapshotsForRoute(scope, routeKey)
  if (snapshots.size === 0) return

  for (const [id, snap] of snapshots) {
    if (!snap.emittedFp || !snap.matchKey) continue
    let fpSet = override.fingerprints.get(id)
    if (!fpSet) {
      fpSet = new Set()
      override.fingerprints.set(id, fpSet)
    }
    fpSet.add(snap.emittedFp)
    let mkSet = override.matchKeys.get(id)
    if (!mkSet) {
      mkSet = new Set()
      override.matchKeys.set(id, mkSet)
    }
    mkSet.add(snap.matchKey)
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
    const fp = snap.emittedFp
    if (!fp) continue
    let set = state.cachedFingerprints.get(id)
    if (!set) {
      set = new Set()
      state.cachedFingerprints.set(id, set)
    }
    set.add(fp)
  }
}
