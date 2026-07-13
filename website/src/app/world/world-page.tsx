import { parton, searchParam, type RenderArgs } from "@parton/framework"
import { AuctionDistrict } from "./auction-lot.tsx"
import { DEFAULT_CHUNK_PX, GEOMETRIES, geometryFor, QUAD_ROOT_PX } from "./constants.ts"
import { defineQuadTree, type QuadLevel } from "./quad.tsx"
import { WorldScroller } from "./scroller.tsx"
// Registers the world's warm projector (predictive chunk warming).
import "./warm.ts"

/**
 * The world page — a real scroller over a quadtree of quad tiles.
 * Four 16384px roots quarter the plane (the scroller starts at their
 * meeting point, chunk 0,0's corner); each root is a cullable
 * quad-tile that subdivides toward the viewport, so the document
 * carries the root-to-viewport spine and nothing else.
 *
 * Every whitelisted geometry's spec chain registers here at module
 * scope; `?chunk=` (a tracked read — it folds into the page's fp)
 * picks which chain's roots this render places. Switching sizes is
 * just a navigation: the other geometry's variants park.
 */
const quadTreeByChunkPx = new Map<number, QuadLevel>(
  GEOMETRIES.map((geo) => [geo.chunkPx, defineQuadTree(geo)]),
)

export const WorldPage = parton(
  function WorldPageRender(_: RenderArgs) {
    const geo = geometryFor(searchParam("chunk"))
    const QuadRoot = quadTreeByChunkPx.get(geo.chunkPx) as QuadLevel
    const roots: React.ReactNode[] = []
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        roots.push(
          <div
            key={`${qx},${qy}`}
            className="quad"
            data-testid={`quad-root-${qx},${qy}`}
            style={{
              left: qx * QUAD_ROOT_PX,
              top: qy * QUAD_ROOT_PX,
              width: QUAD_ROOT_PX,
              height: QUAD_ROOT_PX,
            }}
          >
            <QuadRoot x={qx * QUAD_ROOT_PX} y={qy * QUAD_ROOT_PX} />
          </div>,
        )
      }
    }
    // The default geometry's scroller carries no prop, so a bare URL's
    // wire is exactly the historical one. The auction district rides
    // this page parton (not the chunks) as an overlay layer at plane
    // coordinates — see ./auction-lot.tsx for why the lots' lanes
    // must not nest under the chunks.
    return (
      <WorldScroller {...(geo.chunkPx === DEFAULT_CHUNK_PX ? {} : { chunkPx: geo.chunkPx })}>
        {roots}
        <AuctionDistrict />
      </WorldScroller>
    )
  },
  { match: "{/*}?", selector: "#world" },
)
