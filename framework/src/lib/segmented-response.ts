/**
 * Server-side multi-segment response driver.
 *
 * For routes where a partial signalled `markConnectionLive()` during
 * its render, the response stays open after the first Flight document
 * closes. The driver waits for any `refreshSelector` activity, re-runs
 * the render, and emits the next segment delimited by a `next` marker.
 * Loop until the most recent segment's render did NOT signal live
 * (no `markConnectionLive` call), then close the response.
 *
 * Wire shape per segment matches `wrapStreamWithFpTrailer` exactly —
 * one Flight document, optional fp-trailer entry, no other markers
 * within the segment. Segments are joined by `next`-tagged delimiters.
 * Single-segment responses (the common case) are byte-identical to
 * the pre-segment-loop output.
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
  _isConnectionLive,
  _clearConnectionLive,
  getRequest,
  getScope,
  setRequest,
} from "../runtime/context.ts"
import { _currentTs, _waitForNextBump } from "../runtime/invalidation-registry.ts"
import { buildMarker, TAG_NEXT_SEGMENT } from "./fp-trailer-marker.ts"

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

    if (!_isConnectionLive()) break

    // Promote just-emitted (id, matchKey, fp) tokens into the
    // request's `?cached=` so the NEXT segment's render fp-skips the
    // unchanged partials. Gated on `_isConnectionLive()` so single-
    // segment responses stay byte-identical to the pre-promotion
    // path. Safe under live partials because the descendant-fold
    // (both live in `descendantContribution` and snapshot-based in
    // `descendantContributionFromSnapshot`) folds each descendant's
    // invalidation ts in — when a hot-bumping descendant's `|inv=N`
    // shifts, the ancestor's fold moves with it, the ancestor's fp
    // moves, the promoted fp from the prior segment no longer
    // matches, the ancestor body re-runs, and the descendant is
    // re-instantiated.
    rewriteCachedFromSnapshots()

    await _waitForNextBump(lastTs)
    lastTs = _currentTs()
    segmentIndex++
  }
}

/**
 * Read the just-committed snapshots for the current route and append
 * any emitted `(id, matchKey, fp)` tokens to the request URL's
 * `?cached=` param. Updates the request via `setRequest` so the next
 * segment's render reads the expanded cached set.
 *
 * Token shape mirrors `parseCachedTokens` in partial.tsx —
 * `id:matchKey:fp`, comma-separated. Snapshots without an
 * `emittedFp` (non-addressable specs, e.g. layout wrappers with no
 * selector) or without a `matchKey` are skipped: they have no
 * client-visible wire identity to track.
 */
function rewriteCachedFromSnapshots(): void {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return
  }
  const routeKey = computeRouteKey(request.url)
  const snapshots = _readSnapshotsForRoute(scope, routeKey)
  if (snapshots.size === 0) return

  const url = new URL(request.url)
  const existing = url.searchParams.get("cached") ?? ""
  const have = new Set<string>(
    existing
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  let changed = false
  for (const [id, snap] of snapshots) {
    if (!snap.emittedFp || !snap.matchKey) continue
    const token = `${id}:${snap.matchKey}:${snap.emittedFp}`
    if (have.has(token)) continue
    have.add(token)
    changed = true
  }
  if (!changed) return
  url.searchParams.set("cached", [...have].join(","))
  setRequest(new Request(url.toString(), { headers: request.headers }))
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
