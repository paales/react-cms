import { parton, type RenderArgs } from "@parton/framework"
import { WorldCamera } from "./camera.tsx"
import { WorldChunk } from "./chunk.tsx"
import { WORLD_RADIUS } from "./constants.ts"

/**
 * The world page — a camera over a plane of chunk partons. The camera
 * is a client component; the chunks are its server-rendered children,
 * so panning never re-renders them and each chunk keeps its own
 * addressable identity on the wire.
 */
export const WorldPage = parton(
  function WorldPageRender(_: RenderArgs) {
    const chunks: React.ReactNode[] = []
    for (let cy = -WORLD_RADIUS; cy <= WORLD_RADIUS; cy++) {
      for (let cx = -WORLD_RADIUS; cx <= WORLD_RADIUS; cx++) {
        chunks.push(<WorldChunk key={`${cx},${cy}`} cx={cx} cy={cy} />)
      }
    }
    return <WorldCamera>{chunks}</WorldCamera>
  },
  { match: "{/*}?", selector: "#world" },
)
