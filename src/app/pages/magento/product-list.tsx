import { Partial } from "../../../lib/partial.tsx";
import { Cache } from "../../../lib/cache.tsx";
import { client } from "../../magento-data.ts";
import { graphql, type ResultOf } from "../../magento-graphql.ts";
import { getCookie, getRequest } from "../../../framework/context.ts";
import { AddToCartButton } from "./add-to-cart-button.tsx";
import { CartBadge } from "./cart-badge.tsx";
import { LivePrice, LivePriceFallback } from "./live-price.tsx";
import { RefreshAllPricesButton } from "./refresh-all-prices-button.tsx";

const CartQuery = graphql(`
  query Cart($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`);

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
`);

type ProductItem = NonNullable<
  NonNullable<
    NonNullable<ResultOf<typeof ProductsQuery>["products"]>["items"]
  >[number]
>;

export function MagentoPage() {
  const url = new URL(getRequest().url);
  const search = url.searchParams.get("q") ?? "";

  return (
    <>
      <Partial id="header">
        <header>
          {new Date().toLocaleString()}
          <Partial
            id="cart"
            tags={["cart"]}
            fallback={<CartBadge quantity={"?"} />}
          >
            <CartPartial />
          </Partial>
        </header>
      </Partial>
      <main>
        <RefreshAllPricesButton />
        <Partial id="products">
          <Cache id="products" dep={{ search }}>
            <ProductGrid search={search} />
          </Cache>
        </Partial>
      </main>
      <footer />
    </>
  );
}

async function CartPartial() {
  // Simulate slow cart API
  await new Promise((r) => setTimeout(r, 100));

  const cartId = getCookie("cart_id");
  if (!cartId) return <CartBadge quantity={0} />;

  const data = await client.request(CartQuery, { cartId });

  return <CartBadge quantity={data.cart?.total_quantity ?? 0} />;
}

async function ProductGrid({ search }: { search?: string }) {
  const data = await client.request(ProductsQuery, { pageSize: 12 });
  const items = (data.products?.items ?? []).filter(
    (item): item is ProductItem => item != null,
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
        }}
      >
        <h1 style={{ margin: 0 }}>
          Magento Store {search ? `\u2014 "${search}"` : ""}
        </h1>
      </div>
      <p style={{ color: "#888", marginBottom: "1.5rem" }}>
        Products loaded from GraphCommerce Magento 2 API.
      </p>
      <div className="grid">
        {items.map((product) => (
          <ProductCard key={product.sku ?? product.id} product={product} />
        ))}
      </div>
    </div>
  );
}

function ProductCard({ product }: { product: ProductItem }) {
  const { name, sku, id } = product;
  const imageUrl = product.small_image?.url;
  const imageLabel = product.small_image?.label;
  const rawPrice = product.price_range.minimum_price.regular_price.value;
  const currency =
    product.price_range.minimum_price.regular_price.currency ?? "USD";
  const price = typeof rawPrice === "number" ? rawPrice : 0;

  return (
    <div className="card">
      {imageUrl && (
        <img
          src={imageUrl}
          alt={imageLabel || name || ""}
          loading="lazy"
          style={{ width: 120, height: 120, objectFit: "contain" }}
        />
      )}
      <h2 style={{ fontSize: "1rem", marginTop: "0.5rem" }}>
        {name} {id}
      </h2>
      <div className="meta">
        <code>{sku}</code>
      </div>
      {sku && (
        // Dynamic Partial: id is built from the product sku, produced
        // inside the `.map()` in `ProductGrid` — invisible to the static
        // `collectPartials` walk. The route-scoped registry captures
        // each instance on first render so refreshing one live price
        // doesn't require re-running the product list query. The
        // `price` tag lets `RefreshAllPricesButton` pull every price
        // partial in a single tag-based refetch. `fallback` shows the
        // base price in gray while the refreshed LivePrice is resolving.
        <Partial
          id={`price-${sku}`}
          tags={["price"]}
          fallback={
            <LivePriceFallback
              sku={sku}
              basePrice={price}
              currency={currency}
            />
          }
        >
          <LivePrice sku={sku} basePrice={price} currency={currency} />
        </Partial>
      )}
      <div style={{ marginTop: "0.75rem" }}>
        {sku && <AddToCartButton sku={sku} />}
      </div>
    </div>
  );
}
