import React from "react";
import { describe, expect, it, vi } from "vitest";

// Mock client components — useRef/class components need a full React renderer.
vi.mock("../partial-client.tsx", () => ({
	PartialsClient: ({ children }: { children: React.ReactNode }) => children,
	getCachedPartialIds: () => [],
}));

vi.mock("../partial-error-boundary.tsx", () => ({
	PartialErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

import { PartialRoot, Partial } from "../partial.tsx";
import { runWithRequestAsync } from "../../framework/context.ts";

function Hero() {
	return <h1>Hero</h1>;
}
function Stats() {
	return <div>Stats</div>;
}
function Species() {
	return <p>Species</p>;
}

function fakeRequest(params?: Record<string, string>) {
	const url = new URL("http://localhost/test");
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}
	return new Request(url);
}

async function renderToJSON(element: React.ReactNode): Promise<any> {
	if (element instanceof Promise) element = await element;
	if (element == null || typeof element === "string" || typeof element === "number") {
		return element;
	}
	if (Array.isArray(element)) {
		const results = await Promise.all(element.map(renderToJSON));
		return results.filter(Boolean);
	}
	if (React.isValidElement(element)) {
		const { type, props } = element as any;
		if (typeof type === "function") {
			const result = type(props);
			return renderToJSON(result);
		}
		const children = props.children ? await renderToJSON(props.children) : undefined;
		return { type, props: { ...props, children } };
	}
	return null;
}

describe("PartialRoot architecture", () => {
	it("renders all partials when no filter", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
					<Partial id="species"><Species /></Partial>
				</PartialRoot>,
			),
		);
		expect(result).toHaveLength(3);
	});

	it("filters to requested partials", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "hero,stats" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
					<Partial id="species"><Species /></Partial>
				</PartialRoot>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("filters to single partial", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "stats" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
					<Partial id="species"><Species /></Partial>
				</PartialRoot>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
	});

	it("passes props to partial content", async () => {
		function Greeting({ name }: { name?: string }) {
			return <span>Hello {name}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="greeting"><Greeting name="world" /></Partial>
				</PartialRoot>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("world");
	});

	it("filters to nested partial", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "cart" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="header">
						<div>
							Timestamp
							<Partial id="cart"><Cart /></Partial>
						</div>
					</Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
		expect(str).not.toContain("Timestamp");
		expect(str).not.toContain("Stats");
	});

	it("refreshing parent excludes nested partial content", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "header" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="header">
						<div>
							Timestamp
							<Partial id="cart"><Cart /></Partial>
						</div>
					</Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Timestamp");
		expect(str).not.toContain("cart-content");
		expect(str).not.toContain("Stats");
	});

	it("renders partials without heavy wrapper divs", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("discovers partials inside keyless wrappers", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<main>
						<Partial id="stats"><Stats /></Partial>
					</main>
					<footer>
						<Partial id="species"><Species /></Partial>
					</footer>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
		expect(str).toContain("Stats");
		expect(str).toContain("Species");
	});

	it("renders all partials on full render even with cached fingerprints", async () => {
		let fingerprints: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
		}: any) => {
			fingerprints = fp;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);
		expect(fingerprints.hero).toBeDefined();
		expect(fingerprints.stats).toBeDefined();

		const { result } = await runWithRequestAsync(
			fakeRequest({ cached: `hero:${fingerprints.hero}` }),
			async () =>
				renderToJSON(
					<P>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</P>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).toContain("Hero");
	});

	it("fingerprints are stable for same element tree", async () => {
		let fp1: Record<string, string> = {};
		let fp2: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			fingerprints: fp,
		}: any) => {
			if (!fp1.hero) fp1 = fp;
			else fp2 = fp;
			return null;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
				</P>,
			),
		);
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
				</P>,
			),
		);
		expect(fp1.hero).toBe(fp2.hero);
	});

	it("explicitly requested partials always render even with matching cached fingerprint", async () => {
		let fingerprints: Record<string, string> = {};
		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
			freshIds: fids,
		}: any) => {
			fingerprints = fp;
			freshIds = fids;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);

		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "hero", cached: `hero:${fingerprints.hero}` }),
			async () =>
				renderToJSON(
					<P>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</P>,
				),
		);
		expect(freshIds).toContain("hero");
		expect(freshIds).not.toContain("stats");
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("applies partial input overrides to content props", async () => {
		function Greeting({ name }: { name: string }) {
			return <span>Hello {name}</span>;
		}
		const inputs = JSON.stringify({ greeting: { name: "world" } });
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "greeting", __inputs: inputs }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="greeting"><Greeting name="default" /></Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("world");
		expect(str).not.toContain("default");
	});

	it("partial input overrides only affect targeted partial", async () => {
		function Label({ text }: { text: string }) {
			return <span>{text}</span>;
		}
		const inputs = JSON.stringify({ a: { text: "overridden" } });
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "a,b", __inputs: inputs }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="a"><Label text="original-a" /></Partial>
						<Partial id="b"><Label text="original-b" /></Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("overridden");
		expect(str).toContain("original-b");
		expect(str).not.toContain("original-a");
	});

	it("__inputs bypass fingerprint cache (refetch with new props)", async () => {
		let fingerprints: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
			fingerprints: fp,
		}: any) => {
			fingerprints = fp;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);
		expect(fingerprints.hero).toBeDefined();

		const inputs = JSON.stringify({ hero: {} });
		const { result } = await runWithRequestAsync(
			fakeRequest({
				partials: "hero",
				cached: `hero:${fingerprints.hero}`,
				__inputs: inputs,
			}),
			async () =>
				renderToJSON(
					<P>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</P>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("refetch without props still renders when not in cached", async () => {
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "hero", cached: "stats:somefp" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
		expect(str).not.toContain("Stats");
	});

	it("renders all when no partials param", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		expect(result).toHaveLength(2);
	});

	it("filters partials by tag via ?tags= param", async () => {
		function CartBadge() { return <span>cart-badge</span>; }
		function CartDrawer() { return <div>cart-drawer</div>; }
		function ProductGrid() { return <div>products</div>; }
		const { result } = await runWithRequestAsync(fakeRequest({ tags: "cart" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="badge" tags={["cart", "header"]}><CartBadge /></Partial>
					<Partial id="drawer" tags={["cart"]}><CartDrawer /></Partial>
					<Partial id="products" tags={["catalog"]}><ProductGrid /></Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
		expect(str).toContain("cart-drawer");
		expect(str).not.toContain("products");
	});

	it("combines ?partials= and ?tags= as union", async () => {
		function A() { return <span>a-content</span>; }
		function B() { return <span>b-content</span>; }
		function C() { return <span>c-content</span>; }
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "a", tags: "group" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="a"><A /></Partial>
						<Partial id="b" tags={["group"]}><B /></Partial>
						<Partial id="c"><C /></Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("a-content");
		expect(str).toContain("b-content");
		expect(str).not.toContain("c-content");
	});

	it("does not leak reserved props onto the rendered content component", async () => {
		function MyComponent(props: Record<string, unknown>) {
			return <span>{JSON.stringify(Object.keys(props).sort())}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="test" tags={["cart"]} cache={60}>
						<MyComponent name="hello" />
					</Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("name");
		expect(str).not.toContain("tags");
		expect(str).not.toContain("cache");
	});

	it("filters nested partial inside keyless wrapper", async () => {
		const { result } = await runWithRequestAsync(fakeRequest({ partials: "stats" }), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<main>
						<Partial id="stats"><Stats /></Partial>
					</main>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).not.toContain("Hero");
	});

	it("tag-based invalidation renders only tagged partials", async () => {
		function Cart() { return <span>cart-content</span>; }
		function Products() { return <span>products</span>; }

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		const { result } = await runWithRequestAsync(
			fakeRequest({ tags: "cart" }),
			async () =>
				renderToJSON(
					<P>
						<Partial id="cart" tags={["cart"]}><Cart /></Partial>
						<Partial id="products"><Products /></Partial>
					</P>,
				),
		);

		expect(freshIds).toEqual(["cart"]);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
	});
});

describe("Collision detection", () => {
	it("throws on duplicate partial id", async () => {
		await expect(
			runWithRequestAsync(fakeRequest(), async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="cart"><Hero /></Partial>
						<Partial id="cart"><Stats /></Partial>
					</PartialRoot>,
				),
			),
		).rejects.toThrow(/Duplicate partial id "cart"/);
	});

	it("throws on duplicate id when nested inside another partial", async () => {
		await expect(
			runWithRequestAsync(fakeRequest(), async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="header">
							<div>
								<Partial id="cart"><Hero /></Partial>
							</div>
						</Partial>
						<Partial id="cart"><Stats /></Partial>
					</PartialRoot>,
				),
			),
		).rejects.toThrow(/Duplicate partial id "cart"/);
	});

	it("allows unique ids at any depth", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="header">
						<div>
							<Partial id="cart"><Hero /></Partial>
						</div>
					</Partial>
					<Partial id="products"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		expect(result).toBeTruthy();
	});
});

describe("Streaming mode", () => {
	it("full render uses streaming mode", async () => {
		let capturedMode: string | undefined;
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			mode,
			children,
		}: any) => {
			capturedMode = mode;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);
		expect(capturedMode).toBe("streaming");
	});

	it("partial refetch uses cache mode", async () => {
		let capturedMode: string | undefined;
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			mode,
			children,
		}: any) => {
			capturedMode = mode;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest({ partials: "hero" }), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);
		expect(capturedMode).toBe("cache");
	});

	it("partials with fallback prop are wrapped in Suspense in streaming mode", async () => {
		let capturedChildren: React.ReactNode;
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
		}: any) => {
			capturedChildren = children;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		function SlowCart() { return <span>cart</span>; }
		const fallback = <span>loading...</span>;

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="cart" fallback={fallback}><SlowCart /></Partial>
				</P>,
			),
		);

		const children = React.Children.toArray(capturedChildren!);
		const hasSuspense = children.some(
			(child) => React.isValidElement(child) && child.type === React.Suspense,
		);
		expect(hasSuspense).toBe(true);

		// Hero should NOT be wrapped in Suspense
		const heroChild = children.find(
			(child) => React.isValidElement(child) && child.type !== React.Suspense,
		);
		expect(heroChild).toBeDefined();
	});

	it("sync partials are not wrapped in Suspense in streaming mode", async () => {
		let capturedChildren: React.ReactNode;
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
		}: any) => {
			capturedChildren = children;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);

		const children = React.Children.toArray(capturedChildren!);
		const hasSuspense = children.some(
			(child) => React.isValidElement(child) && child.type === React.Suspense,
		);
		expect(hasSuspense).toBe(false);
	});

	it("streaming mode passes all fingerprints to PartialsClient", async () => {
		let capturedFingerprints: Record<string, string> = {};
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			fingerprints,
			children,
		}: any) => {
			capturedFingerprints = fingerprints;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);

		expect(capturedFingerprints).toHaveProperty("hero");
		expect(capturedFingerprints).toHaveProperty("stats");
	});

	it("cache mode renders template and wraps children in error boundaries", async () => {
		let capturedTemplate: React.ReactNode;
		let capturedChildren: React.ReactNode;
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			template,
			children,
		}: any) => {
			capturedTemplate = template;
			capturedChildren = children;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest({ partials: "hero" }), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</P>,
			),
		);

		expect(capturedTemplate).toBeDefined();
		const children = React.Children.toArray(capturedChildren!);
		expect(children.length).toBe(1);
	});

	it("__populateCache renders all partials via streaming mode", async () => {
		let capturedMode: string | undefined;
		let capturedFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			mode,
			freshIds,
			children,
		}: any) => {
			capturedMode = mode;
			capturedFreshIds = freshIds;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		function CartBadge() { return <span>cart-badge</span>; }
		function Products() { return <span>products</span>; }

		const { result } = await runWithRequestAsync(
			fakeRequest({ tags: "cart", __populateCache: "1" }),
			async () =>
				renderToJSON(
					<P>
						<Partial id="cart" tags={["cart"]}><CartBadge /></Partial>
						<Partial id="products"><Products /></Partial>
					</P>,
				),
		);

		expect(capturedMode).toBe("streaming");
		expect(capturedFreshIds).toContain("cart");
		expect(capturedFreshIds).toContain("products");

		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
		expect(str).toContain("products");
	});

	it("tag invalidation with ?cached= only renders tagged partial", async () => {
		let capturedFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds,
			children,
		}: any) => {
			capturedFreshIds = freshIds;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		function CartBadge() { return <span>cart-badge</span>; }
		function Products() { return <span>products</span>; }

		const { result } = await runWithRequestAsync(
			fakeRequest({ tags: "cart", cached: "cart:abc,products:def" }),
			async () =>
				renderToJSON(
					<P>
						<Partial id="cart" tags={["cart"]}><CartBadge /></Partial>
						<Partial id="products"><Products /></Partial>
					</P>,
				),
		);

		expect(capturedFreshIds).toEqual(["cart"]);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
	});
});

describe("Cart invalidation: header must not re-render", () => {
	// Mirrors the actual MagentoPage layout:
	//   <PartialRoot>
	//     <Partial id="header">
	//       <header>
	//         Timestamp: {date}
	//         <Partial id="cart" tags={["cart"]} fallback={...}>
	//           <CartBadge />
	//         </Partial>
	//       </header>
	//     </Partial>
	//     <Partial id="products">
	//       <ProductGrid />
	//     </Partial>
	//   </PartialRoot>
	//
	// After add-to-cart, { invalidate: { tags: ["cart"] } } should:
	// - Re-render only the cart partial
	// - NOT re-render header (the timestamp must not change)
	// - NOT re-render products

	function CartBadge({ quantity }: { quantity: number | string }) {
		return <span data-testid="cart-badge">Cart: {quantity}</span>;
	}
	function ProductGrid() {
		return <div data-testid="products">Products here</div>;
	}

	it("tag=cart with cache: only cart is fresh, header and products are cached", async () => {
		let capturedFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds,
			children,
		}: any) => {
			capturedFreshIds = freshIds;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		const { result: _ } = await runWithRequestAsync(
			fakeRequest({
				tags: "cart",
				cached: "header:h1,cart:c1,products:p1",
			}),
			async () =>
				renderToJSON(
					<P>
						<Partial id="header">
							<header>
								Timestamp: 2024-01-01
								<Partial id="cart" tags={["cart"]} fallback={<span>?</span>}>
									<CartBadge quantity={5} />
								</Partial>
							</header>
						</Partial>
						<main>
							<Partial id="products"><ProductGrid /></Partial>
						</main>
					</P>,
				),
		);

		expect(capturedFreshIds).toEqual(["cart"]);
		expect(capturedFreshIds).not.toContain("header");
		expect(capturedFreshIds).not.toContain("products");
	});

	it("tag=cart with cache: header content is NOT in the rendered output", async () => {
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			children,
		}: any) => {
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		const { result } = await runWithRequestAsync(
			fakeRequest({
				tags: "cart",
				cached: "header:h1,cart:c1,products:p1",
			}),
			async () =>
				renderToJSON(
					<P>
						<Partial id="header">
							<header>
								Timestamp: 2024-01-01
								<Partial id="cart" tags={["cart"]} fallback={<span>?</span>}>
									<CartBadge quantity={5} />
								</Partial>
							</header>
						</Partial>
						<main>
							<Partial id="products"><ProductGrid /></Partial>
						</main>
					</P>,
				),
		);

		const str = JSON.stringify(result);
		// Cart badge should be present (it's being re-rendered)
		expect(str).toContain("cart-badge");
		// Header timestamp must NOT be in the fresh output — it's served from cache
		expect(str).not.toContain("Timestamp:");
		// Products must NOT be in the fresh output — served from cache
		expect(str).not.toContain("products");
	});

	it("__populateCache renders all partials (first action), subsequent only renders cart", async () => {
		let capturedFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds,
			children,
		}: any) => {
			capturedFreshIds = freshIds;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");

		const makeTree = () => (
			<P>
				<Partial id="header">
					<header>
						Timestamp: {Date.now()}
						<Partial id="cart" tags={["cart"]} fallback={<span>?</span>}>
							<CartBadge quantity={1} />
						</Partial>
					</header>
				</Partial>
				<main>
					<Partial id="products"><ProductGrid /></Partial>
				</main>
			</P>
		);

		// First action: __populateCache → all partials
		await runWithRequestAsync(
			fakeRequest({ tags: "cart", __populateCache: "1" }),
			async () => renderToJSON(makeTree()),
		);
		const firstActionFreshIds = [...capturedFreshIds];
		expect(firstActionFreshIds).toContain("header");
		expect(firstActionFreshIds).toContain("cart");
		expect(firstActionFreshIds).toContain("products");

		// Subsequent action: with cache → only cart
		await runWithRequestAsync(
			fakeRequest({
				tags: "cart",
				cached: "header:h1,cart:c1,products:p1",
			}),
			async () => renderToJSON(makeTree()),
		);
		expect(capturedFreshIds).toEqual(["cart"]);
	});
});
