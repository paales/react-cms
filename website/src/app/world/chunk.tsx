import type { RenderArgs } from "@parton/framework"
import { parton, visible } from "@parton/framework"
import { ActivityLight } from "./activity-light.tsx"
import { CHUNK_PX, BIG_CHUNKS } from "./constants.ts"
import { chunkPulse, ensurePulseTicker } from "./pulse.ts"

/** Position within the OWNING bigChunk (chunk coords are world-signed). */
const inBig = (c: number): number => (((c % BIG_CHUNKS) + BIG_CHUNKS) % BIG_CHUNKS) * CHUNK_PX

/**
 * One 512px world chunk — the content parton, cullable at its own
 * grain. The owning bigChunk windows STRUCTURE (does this region
 * exist in the DOM); the chunk windows CONTENT: out of view it
 * renders its shell — coordinate + light, the nodes the visibility
 * observer measures — and its content fills only near the viewport
 * (a tight 100px runway, so you can watch chunks pop in as you
 * scroll). Per-instance identity from `{cx, cy}`: each placement is
 * individually refetchable and cacheable, and its light flashes when
 * ITS bytes arrive — shell and content arrivals both, never a timer.
 *
 * Cold seed: no client report yet → the origin neighborhood renders
 * with content so the initial viewport is filled at first paint.
 */
export const WorldChunk = parton(
  function WorldChunkRender({ cx, cy }: { cx: number; cy: number } & RenderArgs) {
    const vis = visible({ rootMargin: "100px" })
    const show = vis ?? (Math.abs(cx) <= 2 && Math.abs(cy) <= 2)
    return (
      <div
        className="chunk"
        data-testid={`chunk-${cx},${cy}`}
        data-loaded={show || undefined}
        style={{ left: inBig(cx), top: inBig(cy) }}
      >
        <span className="chunk__coord">
          {cx},{cy}
        </span>
        {show ? (
          <ChunkPulse cx={cx} cy={cy} />
        ) : (
          <span className="chunk__light" aria-hidden />
        )}
        {show && cx === 0 && cy === 0 ? <OriginCard /> : null}
      </div>
    )
  },
  { selector: "#world-chunk" },
)

/**
 * The chunk's live tenant — a non-cullable leaf resolving the pulse
 * cell. The cell dep lives HERE, not on the cullable chunk, so a
 * pulse bump wakes only this leaf's lane: the counter and light
 * update live without ever re-rendering (or shell-flipping) the
 * chunk around it. Culled content unmounts the leaf; the cell keeps
 * counting; re-entry renders the caught-up value.
 */
const ChunkPulse = parton(
  async function ChunkPulseRender({ cx, cy }: { cx: number; cy: number } & RenderArgs) {
    ensurePulseTicker(cx, cy)
    const pulse = await chunkPulse.resolve({ cx, cy })
    return (
      <>
        <ActivityLight ck={`${cx},${cy}`} />
        <span className="chunk__pulse">{pulse.value}</span>
      </>
    )
  },
  { selector: "#chunk-pulse" },
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
