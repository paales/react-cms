import { parton, type RenderArgs } from "@parton/framework"
import { QUAD_ROOT_PX } from "./constants.ts"
import { QuadTile } from "./quad.tsx"
import { WorldScroller } from "./scroller.tsx"

/**
 * The world page — a real scroller over a quadtree of quad tiles.
 * Four 16384px roots quarter the plane (the scroller starts at their
 * meeting point, chunk 0,0's corner); each root is a cullable
 * `QuadTile` that subdivides toward the viewport, so the document
 * carries the root-to-viewport spine and nothing else.
 */
export const WorldPage = parton(
  function WorldPageRender(_: RenderArgs) {
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
            <QuadTile x={qx * QUAD_ROOT_PX} y={qy * QUAD_ROOT_PX} size={QUAD_ROOT_PX} />
          </div>,
        )
      }
    }
    return <WorldScroller>{roots}</WorldScroller>
  },
  { match: "{/*}?", selector: "#world" },
)
