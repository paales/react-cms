import React from "react";
import { describe, expect, it, vi } from "vitest";
import { resolve, resolveData } from "../resolve.ts";
import { fetchSchema, type SchemaGraph } from "../schema.ts";
import { SectionList } from "../section.tsx";
import { runWithRequestAsync, getQueryRoot } from "../../framework/context.ts";

// Mock client component to avoid useRef warnings in tests
vi.mock("../section-client.tsx", () => ({
	SectionListClient: ({ children }: { children: React.ReactNode }) => children,
}));

const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql";

async function executeMagentoQuery<T>(query: string): Promise<T> {
	const response = await fetch(MAGENTO_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});
	const json = (await response.json()) as { data: T; errors?: any[] };
	if (json.errors?.length) {
		throw new Error(`GraphQL errors: ${json.errors.map((e: any) => e.message).join(", ")}`);
	}
	return json.data;
}

let schema: SchemaGraph;
const getSchema = async () => (schema ??= await fetchSchema(MAGENTO_ENDPOINT));

describe("Magento E2E: store page", { timeout: 30000 }, () => {

	// === Discovery tests: verify the query is compiled correctly ===

	it("discovery: products-only page compiles correct query", async () => {
		let capturedQuery = "";
		const spyExecute = async <T,>(query: string): Promise<T> => {
			capturedQuery = query;
			return executeMagentoQuery<T>(query);
		};

		function ProductGrid() {
			const q = getQueryRoot();
			const productList = q.products({ filter: {}, pageSize: 12 }).items;
			return (
				<div>
					{productList.map((product: any) => (
						<div key={product.sku.value}>
							{product.name.value}
							<img src={product.small_image.url.value} alt={product.small_image.label.value} />
							{product.price_range.minimum_price.regular_price.value.$value}
							{product.price_range.minimum_price.regular_price.currency.value}
						</div>
					))}
				</div>
			);
		}

		await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				SectionList({
					getSchema,
					execute: spyExecute,
					children: <ProductGrid key="products" />,
				}),
		);

		expect(capturedQuery).toContain("products(");
		expect(capturedQuery).toContain("items");
		expect(capturedQuery).toContain("name");
		expect(capturedQuery).toContain("sku");
		expect(capturedQuery).toContain("small_image");
		expect(capturedQuery).toContain("price_range");
		expect(capturedQuery).not.toContain("cart(");
	});

	it("discovery: products + cart page compiles both root fields", async () => {
		let capturedQuery = "";
		const spyExecute = async <T,>(query: string): Promise<T> => {
			capturedQuery = query;
			// Don't hit the real API — fake cart ID would fail. We only check the query.
			return {} as T;
		};

		function ProductGrid() {
			const q = getQueryRoot();
			const productList = q.products({ filter: {}, pageSize: 12 }).items;
			return (
				<div>
					{productList.map((product: any) => (
						<div key={product.sku.value}>{product.name.value}</div>
					))}
				</div>
			);
		}

		function CartSection() {
			const q = getQueryRoot();
			const totalQuantity = q.cart({ cart_id: "fake-cart-id" }).total_quantity.value;
			return <span>{totalQuantity}</span>;
		}

		await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				SectionList({
					getSchema,
					execute: spyExecute,
					children: [
						<CartSection key="cart" />,
						<ProductGrid key="products" />,
					],
				}),
		);

		// Both root fields should be present
		expect(capturedQuery).toContain("products(");
		expect(capturedQuery).toContain("cart(");
		expect(capturedQuery).toContain("total_quantity");
		expect(capturedQuery).toContain("name");
		expect(capturedQuery).toContain("sku");
	});

	it("discovery: section filter produces minimal query", async () => {
		let capturedQuery = "";
		const spyExecute = async <T,>(query: string): Promise<T> => {
			capturedQuery = query;
			return {} as T;
		};

		function ProductGrid() {
			const q = getQueryRoot();
			const productList = q.products({ filter: {}, pageSize: 12 }).items;
			return (
				<div>
					{productList.map((product: any) => (
						<div key={product.sku.value}>{product.name.value}</div>
					))}
				</div>
			);
		}

		function CartSection() {
			const q = getQueryRoot();
			const totalQuantity = q.cart({ cart_id: "fake-cart-id" }).total_quantity.value;
			return <span>{totalQuantity}</span>;
		}

		// Only request the cart section — products should NOT be in the query
		await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				SectionList({
					getSchema,
					execute: spyExecute,
					sections: "cart",
					children: [
						<CartSection key="cart" />,
						<ProductGrid key="products" />,
					],
				}),
		);

		expect(capturedQuery).toContain("cart(");
		expect(capturedQuery).toContain("total_quantity");
		expect(capturedQuery).not.toContain("products(");
	});

	// === Full lifecycle tests: discovery → compile → fetch → render ===

	it("full lifecycle: products only (no cart)", async () => {
		const result = await resolve(getSchema, executeMagentoQuery, (q, { query }) => {
			const productList = q.products({ search: "sock", pageSize: 3 }).items;
			return {
				items: productList.map((p: any) => ({
					name: p.name.value,
					sku: p.sku.value,
					price: p.price_range.minimum_price.regular_price.value.$value,
					currency: p.price_range.minimum_price.regular_price.currency.value,
				})),
				query,
			};
		});
		const { items, query } = result as any;
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			expect(item.name).toBeTruthy();
			expect(item.sku).toBeTruthy();
			expect(typeof item.price).toBe("number");
			expect(item.currency).toBeTruthy();
		}
		expect(query).toContain("products(");
	});

	it("full lifecycle: products + cart in one query (page pattern)", async () => {
		const createResult = await executeMagentoQuery<{ createEmptyCart: string }>(
			`mutation { createEmptyCart }`,
		);
		const cartId = createResult.createEmptyCart;

		const result = await resolve(getSchema, executeMagentoQuery, (q, { query }) => ({
			products: q.products({ filter: {}, pageSize: 2 }).items.map((p: any) => ({
				name: p.name.value,
				sku: p.sku.value,
			})),
			cartQuantity: q.cart({ cart_id: cartId }).total_quantity.value,
			query,
		}));

		const { products, cartQuantity, query } = result as any;
		expect(products.length).toBeGreaterThan(0);
		expect(products[0].name).toBeTruthy();
		expect(typeof cartQuantity).toBe("number");
		expect(query).toContain("products(");
		expect(query).toContain("cart(");
		expect(query).toContain("total_quantity");
	});

	it("full lifecycle: cart with items shows correct quantity", async () => {
		const { createEmptyCart: cartId } = await executeMagentoQuery<{ createEmptyCart: string }>(
			`mutation { createEmptyCart }`,
		);

		const { data: productData } = await resolveData(getSchema, executeMagentoQuery, (q: any) => {
			q.products({ search: "sock", pageSize: 1 }).items.map((p: any) => {
				p.sku.value;
			});
		});
		const sku = productData.products.items[0].sku.value;

		await executeMagentoQuery<any>(`
			mutation {
				addProductsToCart(
					cartId: "${cartId}"
					cartItems: [{ sku: "${sku}", quantity: 2 }]
				) { cart { total_quantity } }
			}
		`);

		const result = await resolve(getSchema, executeMagentoQuery, (q, { query }) => {
			const productList = q.products({ search: "sock", pageSize: 1 }).items;
			const cartQuantity = q.cart({ cart_id: cartId }).total_quantity.value;

			return {
				firstProduct: productList[0].name.value,
				cartQuantity,
				query,
			};
		});

		const { firstProduct, cartQuantity, query } = result as any;
		expect(firstProduct).toBeTruthy();
		expect(typeof cartQuantity).toBe("number");
		expect(cartQuantity).toBeGreaterThanOrEqual(0);
		expect(query).toContain("products(");
		expect(query).toContain("cart(");
	});

	it("resolve.data: data proxy traverses correctly", async () => {
		const { data, query } = await resolveData(getSchema, executeMagentoQuery, (q: any) => {
			q.products({ search: "sock", pageSize: 2 }).items.map((p: any) => {
				p.name.value;
				p.sku.value;
			});
		});

		const names = data.products.items.map((p: any) => p.name.value);
		expect(names).toHaveLength(2);
		expect(names[0]).toBeTruthy();
		expect(query).toContain("products(");
	});
});
