import { parton, type RenderArgs } from "@parton/framework"
import { CHUNK_PX, WORLD_RADIUS } from "./constants.ts"

/**
 * One 512px world chunk — the parton unit of the demo. Each placement
 * gets per-instance identity from its `{cx, cy}` props, so a single
 * chunk can be refetched, cached, and live-updated without touching
 * its neighbours; the network light in its top-right corner is where
 * that wire activity will be made visible.
 */
export const WorldChunk = parton(
  function WorldChunkRender({ cx, cy }: { cx: number; cy: number } & RenderArgs) {
    return (
      <div
        className="chunk"
        data-testid={`chunk-${cx},${cy}`}
        style={{
          left: (cx + WORLD_RADIUS) * CHUNK_PX,
          top: (cy + WORLD_RADIUS) * CHUNK_PX,
        }}
      >
        <span className="chunk__coord">
          {cx},{cy}
        </span>
        <span className="chunk__light chunk__light--green" aria-hidden />
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
      <h1 className="card__title">Parton: an RSC-native framework</h1>
      <p>A parton is an enhanced component.</p>
      <p>
        One part on the client.
        <br />
        One part on the server.
      </p>
      <p>Partons talk over the network — this chunk is one.</p>
      <p className="card__hint">Move with WASD, or drag the world.</p>
    </div>
  )
}
