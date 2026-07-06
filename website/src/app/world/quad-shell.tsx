"use client"

/**
 * A culled quad tile — the `cull.skeleton` of `QuadTile`: one div
 * filling the tile's positioned box (owned by the parent, always
 * present). It is the observable DOM the tile's viewport observer
 * measures for re-entry, standing in for however much world the tile
 * covers.
 */

export function QuadShell(_: { x: number; y: number; size: number }) {
  return <div className="quad__placeholder" />
}
