"use client"

/**
 * A culled bigChunk — the `cull.skeleton` of `BigChunk`: one
 * full-size placeholder div. Its section (owned by the world page,
 * always present) fixes the cell's size; this div is the observable
 * DOM the big's viewport observer measures for re-entry.
 */

export function BigShell(_: { bx: number; by: number }) {
  return <div className="big__placeholder" />
}
