/**
 * /magento — Magento product grid + cart badge.
 *
 * In the new define-step model, dynamic per-SKU partials can't be
 * created from request data. The product-list page renders the
 * fetched products inline; per-row LivePrice / AddToCart components
 * are still client-driven without a per-row Partial wrapper.
 */

import { Suspense } from "react"
import { ReactCms, type PartialCtx, type RenderArgs } from "@react-cms/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"
import { AddToCartButton } from "./add-to-cart-button.tsx"
import { CartBadge } from "./cart-badge.tsx"
import { LivePricePartial, LivePriceFallback } from "./live-price.tsx"
import { RefreshAllPricesButton } from "./refresh-all-prices-button.tsx"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"

const CartQuery = graphql(`
  query Cart($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`)

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

const MagentoCartBadge = ReactCms.partial(
  async function MagentoCartBadgeRender({ cartId }: { cartId: string | undefined } & RenderArgs) {
    await new Promise((r) => setTimeout(r, 100))
    if (!cartId) return <CartBadge quantity={0} />
    const data = await client.request(CartQuery, { cartId })
    return <CartBadge quantity={data.cart?.total_quantity ?? 0} />
  },
  {
    selector: "#cart-badge .cart .header",
    fallback: <CartBadge quantity={"?"} />,
    vary: ({ cookies: { cart_id: cartId } }) => ({ cartId }),
  },
)

const MagentoHeader = ReactCms.partial(function MagentoHeaderRender({ parent }: RenderArgs) {
  return (
    <header className="mb-4 flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
      <MagentoCartBadge parent={parent} />
    </header>
  )
})

const MagentoProducts = ReactCms.partial(
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
          <Suspense fallback={<LivePriceFallback sku={sku} basePrice={price} currency={currency} />}>
            <LivePricePartial
              parent={parent}
              cmsId={`price-${sku}`}
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

export const MagentoPage = ReactCms.partial(
  function MagentoRender({ parent }: RenderArgs) {
    return (
      <>
        <MagentoHeader parent={parent} />
        <MagentoProducts parent={parent} />
      </>
    )
  },
  { match: "/magento/*" },
)
