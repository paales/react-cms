import { SectionList } from "../../../lib/section.tsx";
import { getSchema, execute } from "../../magento-data.ts";
import {
  getCookie,
  getQueryRoot,
  getQueryMeta,
} from "../../../framework/context.ts";
import { AddToCartButton } from "./add-to-cart-button.tsx";
import { CartBadge } from "./cart-badge.tsx";

interface Props {
  search?: string;
  sections?: string | null;
}

export function MagentoPage({ search = "", sections }: Props) {
  return (
    <SectionList getSchema={getSchema} execute={execute} sections={sections}>
      <div key="header">
        {new Date().toLocaleString()}
        <CartSection key="cart" />
      </div>
      <ProductGrid key="products" search={search} />
      <QueryDebug key="debug" />
    </SectionList>
  );
}

function CartSection() {
  const q = getQueryRoot();
  const cartId = getCookie("cart_id");
  if (!cartId) return <CartBadge quantity={0} />;
  return (
    <CartBadge quantity={q.cart({ cart_id: cartId }).total_quantity.value} />
  );
}

function ProductGrid({ search }: { search?: string }) {
  const q = getQueryRoot();
  const productList = q.products({ filter: {}, pageSize: 12 }).items;
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
        Products loaded from GraphCommerce Magento 2 API using the same proxy
        data layer. Access patterns auto-compile to GraphQL.
      </p>
      <div className="grid">
        {productList.map((product: any) => (
          <ProductCard key={product.sku.value} product={product} />
        ))}
      </div>
    </div>
  );
}

function ProductCard({ product }: { product: any }) {
  const name = product.name.value as string;
  const sku = product.sku.value as string;
  const imageUrl = product.small_image.url.value as string;
  const imageLabel = product.small_image.label.value as string;
  const price = product.price_range.minimum_price.regular_price.value
    .value as number;
  const currency = product.price_range.minimum_price.regular_price.currency
    .value as string;
  const id = product.id.value;

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

function QueryDebug() {
  const meta = getQueryMeta();
  return (
    <details className="query-debug">
      <summary
        style={{ cursor: "pointer", color: "#888", fontSize: "0.85rem" }}
      >
        Generated GraphQL Query (Magento)
      </summary>
      <pre>{meta.query}</pre>
    </details>
  );
}
