import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { ActivityLight } from "./activity-light.tsx"
import { ChunkShell } from "./chunk-shell.tsx"
import { CHUNK_FLIP_MARGIN_PX, CHUNK_PX, chunkOrigin, seedIntersects } from "./constants.ts"
import { chunkPulse, ensurePulseTicker } from "./pulse.ts"

/**
 * One 512px world chunk — the content parton, the quadtree's leaf
 * cell, cullable at its own grain via the spec-level `cull` gate. The
 * quad tiles above it window STRUCTURE (does this region exist in the
 * DOM); the chunk windows CONTENT: out of view the framework skips
 * this body entirely and the client renders `ChunkShell` (a tight
 * 100px runway, so you can watch chunks pop in as you scroll). The
 * pulse cell resolves HERE — a pulse bump re-sends the whole chunk as
 * one lane, and the light flashes when ITS bytes arrive; a culled
 * chunk resolves nothing and is dark to the cell's invalidation until
 * it flips back in (the cell keeps counting; re-entry renders the
 * caught-up value). The chunk fills its owning leaf cell box, so it
 * carries no position of its own.
 *
 * Cold seed: the same box-intersection test as every quad level — the
 * origin viewport estimate renders with content at first paint, and
 * nothing more.
 */
export const WorldChunk = parton(
  async function WorldChunkRender({ cx, cy }: { cx: number; cy: number } & RenderArgs) {
    ensurePulseTicker(cx, cy)
    const pulse = await chunkPulse.resolve({ cx, cy })
    return (
      <div className="chunk" data-testid={`chunk-${cx},${cy}`} data-loaded>
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
    // The byte-cache predictive warming fills (see ./warm.ts): the
    // scroller's telemetry projects which parked chunks the viewport
    // will reach, the warm pass renders them in here, and the real
    // flip-in lane replays the stored bytes instead of re-encoding
    // the subtree. Staleness is impossible — the cache key folds the
    // pulse cell's invalidation ts, so a bump moves the key and
    // misses; maxAge only bounds how long an untouched entry lingers.
    cache: { maxAge: 30 },
    cull: {
      rootMargin: `${CHUNK_FLIP_MARGIN_PX}px`,
      seed: ({ cx, cy }: { cx: number; cy: number }) =>
        seedIntersects(chunkOrigin(cx), chunkOrigin(cy), CHUNK_PX),
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
      <p>A parton is an enhanced component: one part on the client, one part on the server.</p>
      <p>
        Every chunk of this world is one. Scroll — chunks load as they enter view, and each light
        flashes when its chunk's bytes arrive.
      </p>
      <p className="card__hint">WASD / drag / scroll</p>
    </div>
  )
}
