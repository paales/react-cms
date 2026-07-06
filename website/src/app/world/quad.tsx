import type { RenderArgs } from "@parton/framework"
import { parton } from "@parton/framework"
import { WorldChunk } from "./chunk.tsx"
import { CHUNK_PX, QUAD_LEAF_PX, seedIntersects } from "./constants.ts"
import { QuadShell } from "./quad-shell.tsx"

/**
 * One quadtree tile — the recursive LOAD unit. A tile is a cullable
 * parton over the plane-coordinate box `[x, x+size)²`; in view it
 * materializes its four half-size children (child tiles, or 2×2
 * chunks at the leaf), out of view the framework skips this body and
 * the client renders `QuadShell` — so the whole subtree under an
 * off-screen tile costs one ~200-byte pair, no matter how much world
 * it covers. Each child sits in its own positioned box
 * (`contain: strict`) so a tile's materialization never lays out
 * beyond its cell.
 *
 * Cold seed: a tile renders content before any client measurement iff
 * its box intersects the seed viewport estimate — the same test at
 * every level, so the placed tree is exactly the root-to-viewport
 * spine: O(visible chunks + log₂ world).
 */
export const QuadTile = parton(
  function QuadTileRender({ x, y, size }: { x: number; y: number; size: number } & RenderArgs) {
    const half = size / 2
    const cells: React.ReactNode[] = []
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cellX = x + dx * half
        const cellY = y + dy * half
        cells.push(
          <div
            key={`${dx},${dy}`}
            className="quad"
            style={{ left: dx * half, top: dy * half, width: half, height: half }}
          >
            {size === QUAD_LEAF_PX ? (
              <WorldChunk cx={cellX / CHUNK_PX - 32} cy={cellY / CHUNK_PX - 32} />
            ) : (
              <QuadTile x={cellX} y={cellY} size={half} />
            )}
          </div>,
        )
      }
    }
    return <>{cells}</>
  },
  {
    selector: "#quad-tile",
    cull: {
      rootMargin: "100px",
      seed: ({ x, y, size }: { x: number; y: number; size: number }) => seedIntersects(x, y, size),
      skeleton: QuadShell,
    },
  },
)
