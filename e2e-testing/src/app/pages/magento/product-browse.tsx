/**
 * /magento/browse — the catalog as a `scroller()` collection.
 *
 * The interval tree windows the catalog: leaf partons cover
 * `PAGE_SIZE` products and resolve their slice only while in view
 * (the fetch is gated by culling); culled regions collapse to shells
 * (per-item placeholders at leaf counts, one estimated block deeper),
 * so the document holds O(viewport + log catalog) partons, not one
 * section per page.
 *
 * Order and content are split: `browseProductsCell` (the slice) owns
 * which products in what order; each card is its OWN parton bound to
 * `browseCardCell` (the entity, keyed by uid) — a product's content
 * invalidates per entity, wherever it appears.
 *
 * Pagination is a projection: `?page=N` is the scroller's anchor —
 * the cold seed a deep link paints at, and the bookmarkable shadow
 * scrolling mirrors into. No page is ever a render unit.
 */

import { Card, CardContent } from "@parton/copies/components/ui/card"
import {
  parton,
  scroller,
  type BoundCell,
  type CellValue,
  type RenderArgs,
  type ResolvedCell,
  type ScrollerSlice,
} from "@parton/framework"
import { CARD_ROW_PX, COLS, GRID, PAGE_SIZE } from "./browse-constants.ts"
import { BrowseShell } from "./browse-shell.tsx"
import { browseCardCell, browseProductsCell } from "./products-cell.ts"

type CardItem = CellValue<typeof browseCardCell>

// One product card — the ENTITY parton. Its only dependency is the
// card cell it's bound to, so it re-renders on that product's
// invalidation and fp-skips through everything else (a re-sorted
// slice moves placements, not card bytes).
const BrowseCard = parton(function BrowseCardRender({
  item,
}: { item: ResolvedCell<CardItem> } & RenderArgs) {
  const p = item.value
  if (!p) return null
  const price = p.price_range.minimum_price.regular_price
  return (
    <Card className="h-full overflow-hidden p-4" data-testid={`browse-card-${p.sku ?? p.uid}`}>
      <CardContent className="flex h-full flex-col gap-1 px-0">
        {p.small_image?.url && (
          <img
            src={p.small_image.url}
            alt={p.small_image?.label || p.name || ""}
            loading="lazy"
            className="h-24 w-24 object-contain"
          />
        )}
        <h3 className="mt-1 line-clamp-2 text-sm">{p.name}</h3>
        <span className="mt-auto font-semibold tabular-nums">
          {price.currency} {(price.value || 0).toFixed(2)}
        </span>
      </CardContent>
    </Card>
  )
})

// The collection — leaf Render is the layout renderer: it lays the
// slice out and places each item's parton. The scroller owns
// windowing, existence, and the `?page=` anchor.
const BrowseGrid = scroller(
  function BrowseGridRender({ items }: ScrollerSlice<BoundCell<CardItem>> & RenderArgs) {
    return (
      <div className={GRID}>
        {items.map((item) => (
          <BrowseCard key={String(item.args.uid)} item={item} />
        ))}
      </div>
    )
  },
  {
    range: async ({ offset, limit }) => {
      const res = await browseProductsCell.resolve({
        pageSize: limit,
        currentPage: offset / limit + 1,
      })
      const items = (res.value?.products?.items ?? []).filter(
        (it): it is BoundCell<CardItem> => it != null,
      )
      return { items, total: res.value?.products?.total_count ?? 0 }
    },
    shell: BrowseShell,
    estimate: (n) => Math.ceil(n / COLS) * CARD_ROW_PX,
    leaf: PAGE_SIZE,
    fanout: 4,
    anchor: { param: "page", pageSize: PAGE_SIZE },
  },
)

export const ProductBrowsePage = parton(
  function ProductBrowseRender(_: RenderArgs) {
    return (
      <>
        <title>Browse Products</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Browse Products</h1>
          <p className="text-muted-foreground">
            The catalog as one windowed collection — leaf partons fetch only in view, every card is
            its own parton, <code>?page=</code> is a projection over the same source.
          </p>
        </header>
        <div data-testid="browse-list">
          <BrowseGrid />
        </div>
      </>
    )
  },
  { match: "/magento/browse" },
)
