import { Partial } from "../../../lib/partial.tsx"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"
import { getCookie, getSearchParam } from "../../../framework/context.ts"
import { AddToCartButton } from "./add-to-cart-button.tsx"
import { CartBadge } from "./cart-badge.tsx"
import { LivePrice, LivePriceFallback } from "./live-price.tsx"
import { RefreshAllPricesButton } from "./refresh-all-prices-button.tsx"
import { Card, CardContent } from "@/components/ui/card"
import { ROOT, capturePartialContext, type PartialCtx } from "@/lib/partial-context.ts"

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

export function MagentoPage() {
  return (
    <>
      <Partial parent={ROOT} selector="#header">
        <header className="mb-4 flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
          <Partial
            parent={ROOT}
            selector="#cart-badge .cart .header"
            fallback={<CartBadge quantity={"?"} />}
          >
            <CartPartial />
          </Partial>
        </header>
      </Partial>
      <main>
        <RefreshAllPricesButton />
        <Partial parent={ROOT} selector="#products" cache={{ maxAge: 12 }}>
          <ProductGrid />
        </Partial>
      </main>
    </>
  )
}

async function CartPartial() {
  // Hoist the tracked accessor read above ALL awaits — the manifest
  // cell drifts after a yield (sibling Partials run in between and
  // overwrite the per-request cell), so a `getCookie` after the
  // `await` would attribute to the wrong Partial AND trip
  // `HoistingViolationError` on the second render. Same discipline
  // the framework enforces for `<Cache>` — see
  // `docs/cache.md`.
  const cartId = getCookie("cart_id")

  // Simulate slow cart API
  await new Promise((r) => setTimeout(r, 100))

  if (!cartId) return <CartBadge quantity={0} />

  const data = await client.request(CartQuery, { cartId })

  return <CartBadge quantity={data.cart?.total_quantity ?? 0} />
}

async function ProductGrid() {
  // Hoist sync reads above the await for two reasons:
  //   - `capturePartialContext()` — the shared cell drifts post-await
  //     (RSC sibling interleaving), so per-row ProductCards receive
  //     this as a prop and register under `#products` regardless of
  //     what React scheduled in between.
  //   - `getSearchParam("q")` — the tracked-accessor read attributes
  //     to whichever Partial body last set the per-request manifest
  //     cell. Reading here (inside `<Partial selector="#products">`'s
  //     body) routes the read to this Partial; reading at the top of
  //     `MagentoPage` (outside any Partial) leaks into a sibling
  //     Partial's manifest under editor mode, where AppNav's nav-link
  //     Partials run before the page handler.
  const parent = capturePartialContext()
  const search = getSearchParam("q") ?? ""
  const data = await client.request(ProductsQuery, { pageSize: 12 })
  const items = (data.products?.items ?? []).filter((item): item is ProductItem => item != null)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Magento Store {search ? `— "${search}"` : ""}</h1>
      </div>
      <p className="mb-6 text-muted-foreground">
        Products loaded from GraphCommerce Magento 2 API.
      </p>
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
}

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
          // Dynamic Partial — see previous comment pool.
          <Partial
            parent={parent}
            selector={[`#price-${sku}`, ".price"]}
            fallback={<LivePriceFallback sku={sku} basePrice={price} currency={currency} />}
          >
            <LivePrice sku={sku} basePrice={price} currency={currency} />
          </Partial>
        )}
        <div className="mt-2">{sku && <AddToCartButton sku={sku} />}</div>
      </CardContent>
    </Card>
  )
}
