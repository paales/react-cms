import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { BigShell } from "./big-shell.tsx"
import { WorldChunk } from "./chunk.tsx"
import { BIG_CHUNKS } from "./constants.ts"

/**
 * The load unit: an 8×8-chunk (4096px) cullable parton. The `cull`
 * gate folds its resolved viewport state into its fingerprint — the
 * client observes its rendered box and the framework materializes its
 * 64 chunk partons only near the viewport, emptying to the
 * client-rendered `BigShell` when scrolled far away. Its section
 * keeps a fixed size either way, so the plane never shifts.
 *
 * Cold seed (no client report yet): the four bigChunks meeting at the
 * plane's center render — the scroller starts there, so first paint
 * fills the initial viewport before any IntersectionObserver runs.
 */
export const BigChunk = parton(
  function BigChunkRender({ bx, by }: { bx: number; by: number } & RenderArgs) {
    const chunks: React.ReactNode[] = []
    for (let dy = 0; dy < BIG_CHUNKS; dy++) {
      for (let dx = 0; dx < BIG_CHUNKS; dx++) {
        const cx = bx * BIG_CHUNKS + dx
        const cy = by * BIG_CHUNKS + dy
        chunks.push(<WorldChunk key={`${cx},${cy}`} cx={cx} cy={cy} />)
      }
    }
    return <>{chunks}</>
  },
  {
    cull: {
      rootMargin: "100px",
      seed: ({ bx, by }) => bx >= -1 && bx <= 0 && by >= -1 && by <= 0,
      skeleton: BigShell,
    },
  },
)
