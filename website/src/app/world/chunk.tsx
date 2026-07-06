import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { ActivityLight } from "./activity-light.tsx"
import { ChunkShell } from "./chunk-shell.tsx"
import { inBig } from "./constants.ts"
import { chunkPulse, ensurePulseTicker } from "./pulse.ts"

/**
 * One 512px world chunk — the content parton, cullable at its own
 * grain via the spec-level `cull` gate. The owning bigChunk windows
 * STRUCTURE (does this region exist in the DOM); the chunk windows
 * CONTENT: out of view the framework skips this body entirely and the
 * client renders `ChunkShell` from the same coordinates (a tight
 * 100px runway, so you can watch chunks pop in as you scroll). The
 * pulse cell resolves HERE — a pulse bump re-sends the whole chunk as
 * one lane, and the light flashes when ITS bytes arrive; a culled
 * chunk resolves nothing and is dark to the cell's invalidation until
 * it flips back in (the cell keeps counting; re-entry renders the
 * caught-up value).
 *
 * Cold seed: no client report yet → exactly the origin viewport's
 * chunk neighborhood renders content, so the first paint fills the
 * screen and nothing more.
 */
export const WorldChunk = parton(
  async function WorldChunkRender({
    cx,
    cy,
  }: { cx: number; cy: number } & RenderArgs) {
    ensurePulseTicker(cx, cy)
    const pulse = await chunkPulse.resolve({ cx, cy })
    return (
      <div
        className="chunk"
        data-testid={`chunk-${cx},${cy}`}
        data-loaded
        style={{ left: inBig(cx), top: inBig(cy) }}
      >
        <span className="chunk__coord">
          {cx},{cy}
        </span>
        <ActivityLight ck={`${cx},${cy}`} stamp={pulse.value} />
        <span className="chunk__pulse">{pulse.value}ms</span>
        {cx === 0 && cy === 0 ? <OriginCard /> : null}
      </div>
    )
  },
  {
    selector: "#world-chunk",
    cull: {
      rootMargin: "100px",
      // The 1600×900 boot viewport, centered on chunk 0,0's top-left
      // corner, spans chunks x −2..1 × y −1..0 — seed exactly those.
      seed: ({ cx, cy }) => cx >= -2 && cx <= 1 && cy >= -1 && cy <= 0,
      skeleton: ChunkShell,
    },
  },
)

/** The story's first card — the world starts here. */
function OriginCard() {
  return (
    <div className="card">
      <h1 className="card__title">PARTON</h1>
      <p>An RSC-native framework.</p>
      <p>
        A parton is an enhanced component: one part on the client, one part on
        the server.
      </p>
      <p>
        Every chunk of this world is one. Scroll — chunks load as they enter
        view, and each light flashes when its chunk's bytes arrive.
      </p>
      <p className="card__hint">WASD / drag / scroll</p>
    </div>
  )
}
