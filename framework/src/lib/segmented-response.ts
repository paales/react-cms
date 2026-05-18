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
import { _isConnectionLive, _clearConnectionLive } from "../runtime/context.ts"
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

    await _waitForNextBump(lastTs)
    lastTs = _currentTs()
    segmentIndex++
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
