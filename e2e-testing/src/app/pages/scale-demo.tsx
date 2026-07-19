/**
 * /scale — the scroller at 1,000,000 items.
 *
 * A synthetic source (pure function of the offset — no backend, no
 * cells; the read set is empty and that's fine: nothing can
 * invalidate it) driving the same window model as the real catalogs.
 * The point is the physics, pinned by scroller-scale.spec.ts:
 *
 *  - the document holds a placed span + two reservation shells, so
 *    DOM size is O(viewport), independent of the million;
 *  - a scrollbar jump to anywhere paints skeleton cells the same
 *    frame (client arithmetic, zero round trips) and fills with
 *    content after ONE window statement;
 *  - scrolling back up never moves the viewport (uniform rows make
 *    the before-reservation exact by construction).
 *
 * Geometry: `.scale-grid` — 8 columns × 40px rows ⇒ 1M items is a
 * ~5M px document, comfortably inside browser height limits.
 */

import { parton, scroller, type RenderArgs } from "@parton/framework"

const TOTAL = 1_000_000
const LEAF = 64

const ScaleGrid = scroller({
  name: "scale-grid",
  load: async ({ offset, limit }) => ({
    items: Array.from(
      { length: Math.max(0, Math.min(limit, TOTAL - offset)) },
      (_, i) => offset + i,
    ),
    total: TOTAL,
  }),
  render: ({ item: i, id }) => (
    <div
      key={i}
      id={id}
      data-testid="scale-cell"
      data-i={i}
      className="mb-1 flex items-center justify-center rounded bg-secondary tabular-nums"
    >
      {i.toLocaleString()}
    </div>
  ),
  leaf: LEAF,
  ring: 4,
  className: "scale-grid",
})

export const ScaleDemoPage = parton(
  function ScaleDemoRender(_: RenderArgs) {
    return (
      <>
        <title>Scale demo</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">One million items</h1>
          <p className="text-muted-foreground">
            A synthetic collection: the DOM holds only the placed span; the reservations are CSS
            arithmetic; jump anywhere with the scrollbar.
          </p>
        </header>
        <div data-testid="scale-list">
          <ScaleGrid />
        </div>
      </>
    )
  },
  { match: "/scale" },
)
