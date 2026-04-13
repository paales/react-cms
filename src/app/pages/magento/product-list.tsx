import { gql } from "graphql-request";
import { Partials, type PartialProps } from "../../../lib/partial.tsx";
import { client } from "../../magento-data.ts";
import { getCookie, getRequest } from "../../../framework/context.ts";
import { AddToCartButton } from "./add-to-cart-button.tsx";
import { CartBadge } from "./cart-badge.tsx";

export function MagentoPage() {
  const url = new URL(getRequest().url);
  const search = url.searchParams.get("q") ?? "";

  return (
    <Partials namespace="magento">
      <header key="header">
        {new Date().toLocaleString()}
        <CartPartial
          key="cart"
          tags={["cart"]}
          fallback={<CartBadge quantity={"?"} />}
        />
      </header>
      <main>
        <ProductGrid key="products" search={search} />
      </main>
      <footer />
    </Partials>
  );
}

async function CartPartial(_props: PartialProps) {
  // Simulate slow cart API
  await new Promise((r) => setTimeout(r, 2000));

  const cartId = getCookie("cart_id");
  if (!cartId) return <CartBadge quantity={0} />;

  const data = await client.request<{ cart: { total_quantity: number } }>(
    gql`
      query Cart($cartId: String!) {
        cart(cart_id: $cartId) {
          total_quantity
        }
      }
    `,
    { cartId },
  );

  return <CartBadge quantity={data.cart.total_quantity} />;
}

async function ProductGrid({ search }: { search?: string }) {
  const data = await client.request<{
    products: {
      items: Array<{
        id: number;
        name: string;
        sku: string;
        small_image: { url: string; label: string };
        price_range: {
          minimum_price: {
            regular_price: { value: number; currency: string };
          };
        };
      }>;
    };
  }>(
    gql`
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
    `,
    { pageSize: 12 },
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
        {data.products.items.map((product) => (
          <ProductCard key={product.sku} product={product} />
        ))}
      </div>
    </div>
  );
}

function ProductCard({
  product,
}: {
  product: {
    id: number;
    name: string;
    sku: string;
    small_image: { url: string; label: string };
    price_range: {
      minimum_price: {
        regular_price: { value: number; currency: string };
      };
    };
  };
}) {
  const { name, sku, id } = product;
  const imageUrl = product.small_image.url;
  const imageLabel = product.small_image.label;
  const price = product.price_range.minimum_price.regular_price.value;
  const currency = product.price_range.minimum_price.regular_price.currency;

  return (
    <div className="card">
      {imageUrl && (
        <img
          src={imageUrl}
          alt={imageLabel || name}
          style={{ width: 120, height: 120, objectFit: "contain" }}
        />
      )}
      <h2 style={{ fontSize: "1rem", marginTop: "0.5rem" }}>
        {name} {id}
      </h2>
      <div className="meta">
        <code>{sku}</code>
      </div>
      <div style={{ marginTop: "0.5rem", color: "#48bb78", fontWeight: 600 }}>
        {currency} {typeof price === "number" ? price.toFixed(2) : price}
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <AddToCartButton sku={sku} />
      </div>
    </div>
  );
}
