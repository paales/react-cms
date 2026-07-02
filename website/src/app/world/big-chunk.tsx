import type { RenderArgs } from "@parton/framework"
import { parton, visible } from "@parton/framework"
import { WorldChunk } from "./chunk.tsx"
import { BIG_CHUNKS } from "./constants.ts"

/**
 * The load unit: an 8×8-chunk (4096px) cullable parton. Reading
 * `visible()` folds its viewport state into its fingerprint — the
 * client observes its rendered box and self-refetches on flips, so a
 * bigChunk materializes its 64 chunk partons only near the viewport
 * and empties again when scrolled far away. Its section keeps a fixed
 * size either way, so the plane never shifts.
 *
 * Cold seed (no client report yet): the four bigChunks meeting at the
 * plane's center render — the scroller starts there, so first paint
 * fills the initial viewport before any IntersectionObserver runs.
 */
export const BigChunk = parton(function BigChunkRender({
  bx,
  by,
}: { bx: number; by: number } & RenderArgs) {
  const vis = visible({ rootMargin: "1024px" })
  const show = vis ?? (bx >= -1 && bx <= 0 && by >= -1 && by <= 0)
  // Culled: keep a full-size placeholder in the tree — the visibility
  // observer needs rendered nodes to measure, and the empty cell is
  // what the IntersectionObserver watches for re-entry.
  if (!show) return <div className="big__placeholder" />
  const chunks: React.ReactNode[] = []
  for (let dy = 0; dy < BIG_CHUNKS; dy++) {
    for (let dx = 0; dx < BIG_CHUNKS; dx++) {
      const cx = bx * BIG_CHUNKS + dx
      const cy = by * BIG_CHUNKS + dy
      chunks.push(<WorldChunk key={`${cx},${cy}`} cx={cx} cy={cy} />)
    }
  }
  return <>{chunks}</>
})
