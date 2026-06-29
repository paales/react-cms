/**
 * /magento/browse — read-tracked view culling over the product catalog.
 *
 * Each catalog page is a `BrowsePage` parton that reads `visible()`: in
 * view it renders the page's products, out of view a skeleton. Reading
 * `visible()` is the whole protocol — it makes the parton CULLABLE, so the
 * framework observes its viewport intersection through a `<Fragment ref>`
 * (no wrapper DOM, no id stamping) and self-refetches it as it enters or
 * leaves the viewport, carrying the live `?visible=` set so the re-render
 * reads its own bit. The fixed-height section (owned by the parent, always
 * present) reserves the space, so culling never shifts the scroll. No
 * app-side scroller, anchor, or cookie.
 *
 * Two deliberate shapes:
 *  - `total_count` is fetched by the ROUTE (rendered once) and passed down
 *    as a prop — never a child's `schema` cell, which would make the
 *    framework treat the child as unchanged and stop its reloads.
 *  - the products for a page are a parton keyed by page, rendered only
 *    while that page is visible — so the fetch itself is gated by culling.
 */

import {
  parton,
  visible,
  searchParam,
  type CellValue,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { PageUrlSync } from "../../components/page-url-sync.tsx"
import { magentoProductsCell } from "./products-cell.ts"

type ProductsValue = NonNullable<CellValue<typeof magentoProductsCell>>
type ProductItem = NonNullable<NonNullable<NonNullable<ProductsValue["products"]>["items"]>[number]>

const PAGE_SIZE = 12
/** Fixed pixel height of every page section — reserves space so a culled
 *  (skeleton) page holds exactly the room its products will need. */
const PAGE_H = 760
/** Pages rendered full on the COLD paint (before the client has measured),
 *  centered on the `?page=` anchor — a placeholder neighborhood the live
 *  `visible()` set then refines. */
const COLD_RING = 2

const GRID = "grid flex-1 grid-cols-4 grid-rows-3 gap-3 min-h-0"

function GridSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: PAGE_SIZE }, (_, i) => (
        <div key={i} className="h-full animate-pulse rounded-xl bg-muted/40" />
      ))}
    </div>
  )
}

function BrowseProductCard({ product }: { product: ProductItem }) {
  const { name, sku, id } = product

  return (
    <Card className="h-full overflow-hidden p-4" data-testid={`browse-card-${sku ?? id}`}>
      <CardContent className="flex h-full flex-col gap-1 px-0">
        {product.small_image?.url && (
          <img
            src={product.small_image.url}
            alt={product.small_image?.label || name || ""}
            loading="lazy"
            className="h-24 w-24 object-contain"
          />
        )}
        <h3 className="mt-1 line-clamp-2 text-sm">{name}</h3>
        <span className="mt-auto font-semibold tabular-nums">
          {product.price_range.minimum_price.regular_price.currency}{" "}
          {(product.price_range.minimum_price.regular_price.value || 0).toFixed(2)}
        </span>
      </CardContent>
    </Card>
  )
}

// One page's products — a parton keyed by page (distinct props ⇒ distinct
// id, so it fp-skips and caches). Rendered only while its page is visible,
// so the products fetch is gated by culling.
const PageProducts = parton(
  function PageProductsRender({
    products,
  }: { page: number; products: ResolvedCell<CellValue<typeof magentoProductsCell>> } & RenderArgs) {
    const items = (products.value?.products?.items ?? []).filter(
      (it): it is ProductItem => it != null,
    )
    return (
      <div className={GRID}>
        {items.map((p) => (
          <BrowseProductCard key={p.sku ?? p.id} product={p} />
        ))}
      </div>
    )
  },
  { fallback: <GridSkeleton /> },
)

// One catalog page — CULLABLE. Reads `visible()`: in view → its products,
// out → a skeleton. Keyed by page. The fixed-height section that reserves
// its space lives in the parent (always present), so this parton's content
// can swap skeleton ⇄ products without ever shifting layout.
const BrowsePage = parton(function BrowsePageRender({ page }: { page: number } & RenderArgs) {
  // Fetch ~a page ahead of the viewport so the grid fills before you reach it.
  const vis = visible({ rootMargin: "900px 0px" })
  // Cold (no client report yet): seed the cull off the `?page=` anchor so
  // the first paint fills the right neighborhood; the live set refines it.
  const show = vis ?? Math.abs(page - (Number(searchParam("page")) || 1)) <= COLD_RING
  return show ? (
    <PageProducts
      page={page}
      products={magentoProductsCell.with({ pageSize: PAGE_SIZE, currentPage: page })}
    />
  ) : (
    <GridSkeleton />
  )
})

function BrowseList({ totalPages }: { totalPages: number }) {
  // Render every catalog page as a fixed-height section. Off-screen ones
  // are cheap skeletons (no fetch) until `visible()` pulls them in, so the
  // whole catalog is reachable at a constant document height. (Not
  // rendering thousands of skeletons for a huge catalog — true windowing —
  // is a perf follow-up; the catalog here is bounded by `total_count`.)
  const pages: number[] = []
  for (let p = 1; p <= totalPages; p++) pages.push(p)
  return (
    <div data-testid="browse-list" data-total-pages={totalPages}>
      {pages.map((p) => (
        <section
          key={p}
          data-testid={`browse-page-${p}`}
          data-page={p}
          style={{ height: PAGE_H }}
          className="flex flex-col overflow-hidden"
        >
          <h2 className="h-6 text-xs font-medium text-muted-foreground">Page {p}</h2>
          <BrowsePage page={p} />
        </section>
      ))}
    </div>
  )
}

export const ProductBrowsePage = parton(
  function ProductBrowseRender({
    meta,
  }: { meta: ResolvedCell<CellValue<typeof magentoProductsCell>> } & RenderArgs) {
    const total = meta.value?.products?.total_count ?? 0
    const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1
    return (
      <>
        <title>Browse Products</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Browse Products</h1>
          <p className="text-muted-foreground">
            Read-tracked view culling over the whole catalog ({totalPages} pages) — only pages in
            view fetch; the rest are reserved space. <code>?page=</code> seeds the first paint.
          </p>
        </header>
        <BrowseList totalPages={totalPages} />
        <PageUrlSync />
        {/* Pre-hydration scroll: a fresh load / hard reload of ?page=N must
            paint at section N, not at 0,0 and then jump. This inline script
            runs during HTML parse (the sections are already above it),
            before hydration. On a client nav it's inert — React doesn't
            execute dangerouslySetInnerHTML scripts — and PageUrlSync's
            layout effect covers that path. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=new URLSearchParams(location.search).get("page");if(p&&+p>1){var e=document.querySelector('[data-page="'+p+'"]');if(e)e.scrollIntoView({block:"start"})}}catch(_){}})()`,
          }}
        />
      </>
    )
  },
  {
    match: "/magento/browse",
    // `total_count` is fetched HERE (the route renders once) and passed to
    // BrowseList as a prop — never a child's schema (see header note).
    schema: () => ({ meta: magentoProductsCell.with({ pageSize: PAGE_SIZE, currentPage: 1 }) }),
  },
)
