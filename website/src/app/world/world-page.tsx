import { parton, type RenderArgs } from "@parton/framework"
import { BigChunk } from "./big-chunk.tsx"
import { WorldScroller } from "./scroller.tsx"
import { BIG_MIN, WORLD_BIGS, bigLeft, BIG_PX } from "./constants.ts"

/**
 * The world page — a real scroller over 8×8 bigChunk sections. Every
 * section is a fixed-size cell (the plane never shifts); each hosts a
 * cullable BigChunk parton that fills with its 64 chunks only near
 * the viewport.
 */
export const WorldPage = parton(
  function WorldPageRender(_: RenderArgs) {
    const bigs: React.ReactNode[] = []
    for (let by = BIG_MIN; by < BIG_MIN + WORLD_BIGS; by++) {
      for (let bx = BIG_MIN; bx < BIG_MIN + WORLD_BIGS; bx++) {
        bigs.push(
          <section
            key={`${bx},${by}`}
            className="big"
            data-testid={`big-${bx},${by}`}
            style={{ left: bigLeft(bx), top: bigLeft(by), width: BIG_PX, height: BIG_PX }}
          >
            <BigChunk bx={bx} by={by} />
          </section>,
        )
      }
    }
    return <WorldScroller>{bigs}</WorldScroller>
  },
  { match: "{/*}?", selector: "#world" },
)
