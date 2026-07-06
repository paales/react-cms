"use client"

/**
 * A culled chunk — the `cull.skeleton` of `WorldChunk`, rendered
 * client-side from the placement's coordinates: the cell, its
 * coordinate label, and a dark light. This is the DOM the chunk's
 * viewport observer measures while the content is culled; the owning
 * leaf cell box reserves the space.
 */

export function ChunkShell({ cx, cy }: { cx: number; cy: number }) {
  return (
    <div className="chunk" data-testid={`chunk-${cx},${cy}`}>
      <span className="chunk__coord">
        {cx},{cy}
      </span>
      <span className="chunk__light" aria-hidden />
    </div>
  )
}
