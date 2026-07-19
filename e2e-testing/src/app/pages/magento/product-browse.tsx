/**
 * /magento/browse — the catalog as a `scroller()` collection.
 *
 * One CSS grid (`.browse-grid` — the app stylesheet owns
 * `--scroller-cols` / `--scroller-row`): a placed span of cull-gated
 * leaf partons around the `?page=` anchor, reservation shells
 * covering the rest of the catalog with CSS arithmetic. Leaves fetch
 * their slice only in view; a scrollbar jump self-materializes
 * skeleton cells client-side and moves the span with one replace
 * navigation.
 *
 * Order and content are split: `browseProductsCell` (the slice) owns
 * which products in what order; each card is its OWN parton bound to
 * `browseCardCell` (the entity, keyed by uid) — a product's content
 * invalidates per entity, wherever it appears.
 */

import { Card, CardContent } from "@parton/copies/components/ui/card"
import {
  parton,
  scroller,
  searchParam,
  type BoundCell,
  type CellValue,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import { browseCardCell, browseProductsCell } from "./products-cell.ts"

type CardItem = CellValue<typeof browseCardCell>

/** Items per leaf parton — also the slice fetch size and the derived
 *  page size of the `?page=` projection. The one geometry number that
 *  is NOT CSS (counts, not pixels). */
const LEAF = 12

// One product card — the ENTITY parton. Its only dependency is the
// card cell it's bound to, so it re-renders on that product's
// invalidation and fp-skips through everything else (a re-sorted
// slice moves placements, not card bytes). The card is one grid cell:
// height comes from the grid's `--scroller-row`; the bottom margin is
// the visual row spacing (row-gap stays 0 by the scroller contract).
const BrowseCard = parton(function BrowseCardRender({
  item,
  anchorId,
}: { item: ResolvedCell<CardItem>; anchorId?: string } & RenderArgs) {
  const p = item.value
  if (!p) return null
  const price = p.price_range.minimum_price.regular_price
  return (
    <Card
      id={anchorId}
      className="mb-3 h-[240px] overflow-hidden p-4"
      data-testid={`browse-card-${p.sku ?? p.uid}`}
    >
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

const BrowseGrid = scroller({
  name: "browse-grid",
  load: async ({ offset, limit }) => {
    // A FILTER is just a tracked read in the loader: `?q=` records as
    // the calling parton's dep, so a filter change re-renders the
    // collection — and the card partons fp-skip through it wherever
    // their entities didn't change (the order/content split).
    const q = searchParam("q")
    const res = await browseProductsCell.resolve({
      pageSize: limit,
      currentPage: offset / limit + 1,
      ...(q ? { search: q } : {}),
    })
    const items = (res.value?.products?.items ?? []).filter(
      (it): it is BoundCell<CardItem> => it != null,
    )
    return { items, total: res.value?.products?.total_count ?? 0 }
  },
  render: ({ item, id }) => <BrowseCard key={String(item.args.uid)} item={item} anchorId={id} />,
  leaf: LEAF,
  className: "browse-grid",
})

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
        {/* The filter projection: a plain GET form — submitting
            navigates to ?q=…, the loader's tracked read re-renders
            the collection. */}
        <form method="get" action="/magento/browse" className="mb-4">
          <input
            type="search"
            name="q"
            defaultValue={searchParam("q") ?? ""}
            placeholder="Filter products…"
            data-testid="browse-filter"
            className="w-64 rounded-md border px-3 py-1.5 text-sm"
          />
        </form>
        <div data-testid="browse-list">
          <BrowseGrid />
        </div>
      </>
    )
  },
  { match: "/magento/browse" },
)
