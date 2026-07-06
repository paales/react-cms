"use client"

/**
 * A culled chunk — the `cull.skeleton` of `WorldChunk`, rendered
 * client-side from the placement's coordinates: the positioned cell,
 * its coordinate label, and a dark light. This is the DOM the chunk's
 * viewport observer measures while the content is culled, and the
 * space reservation that keeps the plane from shifting.
 */

import { inBig } from "./constants.ts"

export function ChunkShell({ cx, cy }: { cx: number; cy: number }) {
  return (
    <div className="chunk" data-testid={`chunk-${cx},${cy}`} style={{ left: inBig(cx), top: inBig(cy) }}>
      <span className="chunk__coord">
        {cx},{cy}
      </span>
      <span className="chunk__light" aria-hidden />
    </div>
  )
}
