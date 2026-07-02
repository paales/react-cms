import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { ActivityLight } from "./activity-light.tsx"
import { CHUNK_PX, BIG_CHUNKS } from "./constants.ts"

/** Position within the OWNING bigChunk (chunk coords are world-signed). */
const inBig = (c: number): number => (((c % BIG_CHUNKS) + BIG_CHUNKS) % BIG_CHUNKS) * CHUNK_PX

/**
 * One 512px world chunk — the content parton. Per-instance identity
 * from its `{cx, cy}` props: each placement is individually
 * refetchable and cacheable, and its network light flashes when ITS
 * bytes arrive — not on a timer.
 */
export const WorldChunk = parton(
  function WorldChunkRender({ cx, cy }: { cx: number; cy: number } & RenderArgs) {
    return (
      <div
        className="chunk"
        data-testid={`chunk-${cx},${cy}`}
        style={{ left: inBig(cx), top: inBig(cy) }}
      >
        <span className="chunk__coord">
          {cx},{cy}
        </span>
        <ActivityLight ck={`${cx},${cy}`} />
        {cx === 0 && cy === 0 ? <OriginCard /> : null}
      </div>
    )
  },
  { selector: "#world-chunk" },
)

/** The story's first card — the world starts here. */
function OriginCard() {
  return (
    <div className="card">
      <h1 className="card__title">PARTON</h1>
      <p>An RSC-native framework.</p>
      <p>A parton is an enhanced component: one part on the client, one part on the server.</p>
      <p>Every chunk of this world is one. Scroll — chunks load as they enter view, and each light flashes when its chunk's bytes arrive.</p>
      <p className="card__hint">WASD / drag / scroll</p>
    </div>
  )
}
