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
  getRequest,
  getScope,
} from "../runtime/context.ts"
import { _currentTs, _waitForNextBump } from "../runtime/invalidation-registry.ts"
import { buildMarker, TAG_NEXT_SEGMENT } from "./fp-trailer-marker.ts"

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
  // Pre-encode the `next` delimiter — same bytes every segment
  // boundary, so build it once.
  const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0)

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

    // Race three arms:
    //   - `_waitForNextBump` — wakes on any `refreshSelector` activity
    //     (CRUD writes, cell.set, server-action invalidations).
    //   - `timeoutPromise` — keepalive cap. Idle for >KEEPALIVE_MS →
    //     close and let the client's heartbeat reopen.
    //   - `expiresAtPromise` — wakes at the earliest `expiresAt`
    //     declared by any rendered partial's vary. Drives time-based
    //     reactivity (clock displays, TTL banners) without any
    //     userspace timer. Absent when no partial declared one.
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<typeof IDLE_TIMEOUT>((resolve) => {
      timeoutId = setTimeout(() => resolve(IDLE_TIMEOUT), KEEPALIVE_MS)
    })
    const arms: Array<Promise<unknown>> = [_waitForNextBump(lastTs), timeoutPromise]
    let expiresAtTimeoutId: ReturnType<typeof setTimeout> | null = null
    const expiresAtDelay = computeNextExpiresAtDelay()
    if (expiresAtDelay !== null) {
      arms.push(
        new Promise<typeof EXPIRES_AT_WAKE>((resolve) => {
          expiresAtTimeoutId = setTimeout(
            () => resolve(EXPIRES_AT_WAKE),
            Math.max(0, expiresAtDelay),
          )
        }),
      )
    }
    const result = await Promise.race(arms)
    if (timeoutId) clearTimeout(timeoutId)
    if (expiresAtTimeoutId) clearTimeout(expiresAtTimeoutId)
    if (result === IDLE_TIMEOUT) break
    lastTs = _currentTs()
    segmentIndex++
  }
}

const IDLE_TIMEOUT = Symbol("idle-timeout")
const EXPIRES_AT_WAKE = Symbol("expires-at-wake")

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
function promoteSnapshotsToCachedOverride(): void {
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
