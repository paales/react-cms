/**
 * /magento — Magento product grid + cart badge.
 *
 * In the new define-step model, dynamic per-SKU partials can't be
 * created from request data. The product-list page renders the
 * fetched products inline; per-row LivePrice / AddToCart components
 * are still client-driven without a per-row Partial wrapper.
 */

import { Suspense } from "react"
import { parton, type PartialCtx, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"
import { AddToCartButton } from "./add-to-cart-button.tsx"
import { CartBadge } from "./cart-badge.tsx"
import { cartBadgeCell, type CartBadgeData } from "./cart-badge-cell.ts"
import { LivePricePartial, LivePriceFallback } from "./live-price.tsx"
import { RefreshAllPricesButton } from "./refresh-all-prices-button.tsx"
import { Card, CardContent } from "@parton/copies/components/ui/card"

const ProductsQuery = graphql(`
  query Products($pageSize: Int!) {
    products(filter: {}, pageSize: $pageSize) {
      items {
        id
        name
        sku
        small_image {
          url
          label
        }
        price_range {
          minimum_price {
            regular_price {
              value
              currency
            }
          }
        }
      }
    }
  }
`)

type ProductItem = NonNullable<
  NonNullable<NonNullable<ResultOf<typeof ProductsQuery>["products"]>["items"]>[number]
>

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
  function MagentoHeaderRender({ parent, cartId }: { cartId: string } & RenderArgs) {
    return (
      <header className="mb-4 flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
        {cartId ? (
          <MagentoCartBadge parent={parent} cart={cartBadgeCell.with({ cartId })} />
        ) : (
          <CartBadge quantity={0} />
        )}
      </header>
    )
  },
  {
    vary: ({ cookies: { cart_id: cartId } }) => ({ cartId: cartId ?? "" }),
  },
)

const MagentoProducts = parton(
  async function MagentoProductsRender({ q, parent }: { q: string } & RenderArgs) {
    const data = await client.request(ProductsQuery, { pageSize: 12 })
    const items = (data.products?.items ?? []).filter((item): item is ProductItem => item != null)
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
            <ProductCard key={product.sku ?? product.id} product={product} parent={parent} />
          ))}
        </div>
      </div>
    )
  },
  {
    selector: "#products",
    cache: { maxAge: 12 },
    vary: ({ search: { q = "" } }) => ({ q }),
  },
)

function ProductCard({ product, parent }: { product: ProductItem; parent: PartialCtx }) {
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
              parent={parent}
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
  function MagentoRender({ parent }: RenderArgs) {
    return (
      <>
        <MagentoHeader parent={parent} />
        <MagentoProducts parent={parent} />
      </>
    )
  },
  // `/magento` exact — `/magento/cart` is its own page (see cart-page.tsx).
  { match: "/magento" },
)
