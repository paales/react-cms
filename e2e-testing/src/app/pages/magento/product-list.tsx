/**
 * /magento — Magento product grid + cart badge.
 *
 * In the new define-step model, dynamic per-SKU partials can't be
 * created from request data. The product-list page renders the
 * fetched products inline; per-row LivePrice / AddToCart components
 * are still client-driven without a per-row Partial wrapper.
 */

import { Suspense } from "react"
import {
  cookie,
  parton,
  searchParam,
  type CellValue,
  type PartialCtx,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import { AddToCartButton } from "./add-to-cart-button.tsx"
import { CartBadge } from "./cart-badge.tsx"
import { cartBadgeCell, type CartBadgeData } from "./cart-badge-cell.ts"
import { LivePricePartial, LivePriceFallback } from "./live-price.tsx"
import { RefreshAllPricesButton } from "./refresh-all-prices-button.tsx"
import { magentoProductsCell } from "./products-cell.ts"
import { Card, CardContent } from "@parton/copies/components/ui/card"

type ProductsValue = NonNullable<CellValue<typeof magentoProductsCell>>
type ProductItem = NonNullable<NonNullable<NonNullable<ProductsValue["products"]>["items"]>[number]>

const MagentoCartBadge = parton(
  function MagentoCartBadgeRender({
    cart,
  }: { cart: ResolvedCell<CartBadgeData | null> } & RenderArgs) {
    return <CartBadge quantity={cart.value?.total_quantity ?? 0} />
  },
  {
    selector: "#cart-badge .cart .header",
    fallback: <CartBadge quantity={"?"} />,
    // No vary — cart binding flows from the parent via JSX prop
    // (cartBadgeCell.with({cartId})). The cell handles per-cartId
    // partitioning and the GraphQL load.
  },
)

const MagentoHeader = parton(
  function MagentoHeaderRender(_: RenderArgs) {
    // Tracked read — records `cookie:cart_id` on this parton, so a new
    // cart cookie (set by the add-to-cart action) moves the fp on the
    // next navigation exactly as the old `vary` did.
    const cartId = cookie("cart_id") ?? ""
    return (
      <header className="mb-4 flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
        {cartId ? (
          <MagentoCartBadge cart={cartBadgeCell.with({ cartId })} />
        ) : (
          <CartBadge quantity={0} />
        )}
      </header>
    )
  },
  // Explicit selector keeps the spec addressable (refetchable by label,
  // fp on the wire) now that no `vary`/`match` marks it as such. Same
  // id the auto-derived name produced.
  { selector: "#magento-header" },
)

const MagentoProducts = parton(
  function MagentoProductsRender({
    q,
    products,
  }: { q: string; products: ResolvedCell<CellValue<typeof magentoProductsCell>> } & RenderArgs) {
    const items = (products.value?.products?.items ?? []).filter(
      (item): item is ProductItem => item != null,
    )
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Magento Store {q ? `— "${q}"` : ""}</h1>
        </div>
        <p className="mb-6 text-muted-foreground">
          Products loaded from GraphCommerce Magento 2 API.
        </p>
        <RefreshAllPricesButton />
        <div
          data-testid="product-grid"
          className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
        >
          {items.map((product) => (
            <ProductCard key={product.sku ?? product.id} product={product} />
          ))}
        </div>
      </div>
    )
  },
  {
    selector: "#products",
    // Byte-cache the product grid; the per-card LivePrice (`.price`)
    // partons stay live as dynamic holes — re-rendered fresh on every
    // cache hit and streamed in over their 1s load. Exercises the
    // row-level cache splice end-to-end (cache-dynamic-partial-holes spec).
    cache: { maxAge: 60 },
    // Tracked in `schema` (runs before the fp), so `q` folds into the
    // byte-cache key from render 1 — a render-BODY read would lag one
    // render and mis-key the cache on a cold process.
    schema: () => ({ q: searchParam("q") ?? "" }),
  },
)

function ProductCard({ product }: { product: ProductItem }) {
  const { name, sku, id } = product
  const imageUrl = product.small_image?.url
  const imageLabel = product.small_image?.label
  const rawPrice = product.price_range.minimum_price.regular_price.value
  const currency = product.price_range.minimum_price.regular_price.currency ?? "USD"
  const price = typeof rawPrice === "number" ? rawPrice : 0

  return (
    <Card className="p-5">
      <CardContent className="flex flex-col gap-2 px-0">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={imageLabel || name || ""}
            loading="lazy"
            className="h-30 w-30 object-contain"
          />
        )}
        <h2 className="mt-2 text-base">
          {name} {id}
        </h2>
        <div className="text-sm text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{sku}</code>
        </div>
        {sku && (
          <Suspense
            fallback={<LivePriceFallback sku={sku} basePrice={price} currency={currency} />}
          >
            <LivePricePartial
              sku={sku}
              basePrice={price}
              currency={currency}
            />
          </Suspense>
        )}
        <div className="mt-2">{sku && <AddToCartButton sku={sku} />}</div>
      </CardContent>
    </Card>
  )
}

export const MagentoPage = parton(
  function MagentoRender() {
    return (
      <>
        <MagentoHeader />
        <MagentoProducts products={magentoProductsCell.with({ pageSize: 12, currentPage: 1 })} />
      </>
    )
  },
  // `/magento` exact — `/magento/cart` is its own page (see cart-page.tsx).
  { match: "/magento" },
)
