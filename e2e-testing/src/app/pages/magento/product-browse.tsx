/**
 * /magento/browse — view-culled, bidirectional product scroller.
 *
 * The page is split into fixed page-partons (`#browse-page-N`), each
 * bound to one `currentPage` slice of `magentoProductsCell`. A page
 * renders in one of three zones, decided by `vary` reading `visible`
 * off the FRAME url (the client `<BrowseScroller>` reports it there):
 *
 *   ring     — near the viewport: binds the cell, renders products.
 *   reserved — the runway just outside the ring: a fixed-height
 *              skeleton that reserves space (so the observer can see
 *              the page coming) WITHOUT fetching.
 *   absent   — beyond the reserved band: `vary` → null, so the page
 *              leaves the live tree (keepalive parks it warm in the
 *              client cache for a cheap scroll-back).
 *
 * The visible set is the driver; `?page=` on the page url is its
 * sharable shadow (an effect the scroller writes via replaceState, and
 * the cold-start seed for the frame). See `<BrowseScroller>`.
 */

import {
  parton,
  type CellValue,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import { Frame } from "@parton/framework/lib/frame.tsx"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { BrowseScroller } from "../../components/browse-scroller.tsx"
import { magentoProductsCell } from "./products-cell.ts"

type ProductsValue = NonNullable<CellValue<typeof magentoProductsCell>>
type ProductItem = NonNullable<NonNullable<NonNullable<ProductsValue["products"]>["items"]>[number]>

const PAGE_SIZE = 12
/** Pages within ±RING_OVER of the visible span fetch + render products. */
const RING_OVER = 1
/** Pages within ±RESERVE_OVER reserve space as skeletons (the runway). */
const RESERVE_OVER = 3
/** Fixed pool — capped well above any realistic Magento page count. */
const MAX_PAGES = 30

type Zone = "ring" | "reserved"

function parseVisible(raw: string | undefined): number[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 1)
}

/** The ring/reserve bands derived from the reported visible span. The
 *  client reports the set; the server derives the bands here — the
 *  policy lives server-side. */
function bands(visibleRaw: string | undefined) {
  const vis = parseVisible(visibleRaw)
  if (vis.length === 0) return null
  const lo = Math.min(...vis)
  const hi = Math.max(...vis)
  return {
    ringLo: lo - RING_OVER,
    ringHi: hi + RING_OVER,
    reserveLo: lo - RESERVE_OVER,
    reserveHi: hi + RESERVE_OVER,
  }
}

function makeBrowsePage(page: number) {
  return parton(
    function BrowsePageRender({
      zone,
      products,
    }: {
      zone: Zone
      products?: ResolvedCell<CellValue<typeof magentoProductsCell>>
    } & RenderArgs) {
      if (zone === "reserved" || !products) {
        return <BrowsePageSection page={page} skeleton />
      }
      const items = (products.value?.products?.items ?? []).filter(
        (it): it is ProductItem => it != null,
      )
      if (items.length === 0) return null
      return <BrowsePageSection page={page} items={items} />
    },
    {
      selector: `#browse-page-${page}`,
      // Cull cleanly: an out-of-band page leaves the tree rather than
      // parking a hidden variant sibling.
      keepalive: false,
      // `visible` rides the FRAME url, so inside <Frame name="browse">
      // this `search` is the frame's — never the sharable page url.
      vary: ({ search: { visible } }) => {
        const b = bands(visible)
        if (!b || page < b.reserveLo || page > b.reserveHi) return null
        const inRing = page >= b.ringLo && page <= b.ringHi
        return { zone: inRing ? ("ring" as const) : ("reserved" as const) }
      },
      // Bind the cell only in the ring — a reserved/absent page never
      // fetches. This is where the payload actually shrinks.
      schema: (_f, vary) =>
        (vary as { zone: Zone }).zone === "ring"
          ? { products: magentoProductsCell.with({ pageSize: PAGE_SIZE, currentPage: page }) }
          : {},
      // While a ring page's cell loads, hold its reserved space.
      fallback: <BrowsePageSection page={page} skeleton />,
    },
  )
}

const BrowsePagePartials = Array.from({ length: MAX_PAGES }, (_, i) => makeBrowsePage(i + 1))

function BrowseSkeletonCard() {
  return (
    <div
      data-testid="browse-skeleton"
      className="h-[260px] animate-pulse rounded-xl bg-muted/40"
      aria-hidden
    />
  )
}

function BrowseProductCard({ product }: { product: ProductItem }) {
  const { name, sku, id } = product
  const imageUrl = product.small_image?.url
  const imageLabel = product.small_image?.label
  const rawPrice = product.price_range.minimum_price.regular_price.value
  const currency = product.price_range.minimum_price.regular_price.currency ?? "USD"
  const price = typeof rawPrice === "number" ? rawPrice : 0
  return (
    <Card className="p-5" data-testid={`browse-card-${sku ?? id}`}>
      <CardContent className="flex flex-col gap-2 px-0">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={imageLabel || name || ""}
            loading="lazy"
            className="h-30 w-30 object-contain"
          />
        )}
        <h3 className="mt-2 text-base">{name}</h3>
        <code className="w-fit rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-muted-foreground">
          {sku}
        </code>
        <span className="font-semibold tabular-nums">
          {currency} {price.toFixed(2)}
        </span>
      </CardContent>
    </Card>
  )
}

function BrowsePageSection({
  page,
  items,
  skeleton,
}: {
  page: number
  items?: ProductItem[]
  skeleton?: boolean
}) {
  return (
    <section
      data-testid={`browse-page-${page}`}
      data-page={page}
      data-zone={skeleton ? "reserved" : "ring"}
      className="mb-6"
    >
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">Page {page}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        {skeleton
          ? Array.from({ length: PAGE_SIZE }, (_, i) => <BrowseSkeletonCard key={i} />)
          : (items ?? []).map((p) => <BrowseProductCard key={p.sku ?? p.id} product={p} />)}
      </div>
    </section>
  )
}

export const ProductBrowsePage = parton(
  function ProductBrowseRender({ anchor }: { anchor: number } & RenderArgs) {
    return (
      <>
        <title>Browse Products</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Browse Products</h1>
          <p className="text-muted-foreground">
            View-culled infinite scroll — pages cull both ways; <code>?page=</code> tracks where
            you are.
          </p>
        </header>
        {/* Cold-start: seed the frame's `visible` from the page anchor. */}
        <Frame name="browse" initialUrl={`/magento/browse?visible=${anchor}`}>
          <BrowseScroller>
            {BrowsePagePartials.map((P, i) => (
              <P key={`browse-page-${i + 1}`} />
            ))}
          </BrowseScroller>
        </Frame>
      </>
    )
  },
  {
    match: "/magento/browse",
    vary: ({ search: { page } }) => ({ anchor: Math.max(1, Number(page) || 1) }),
  },
)
