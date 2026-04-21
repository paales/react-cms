import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The partial-registry is module-level and route-keyed. Clear it
// before each test so tag resolution doesn't pick up entries
// registered by a previous test that used the same fake route.
beforeEach(async () => {
  const { clearRegistry } = await import("../partial-registry.ts");
  clearRegistry();
});

// Accumulates what each Partial emitted during the last render —
// populated by the mocked PartialErrorBoundary, which the Partial
// component passes `partialId` + `partialFingerprint` into. Serves
// as the test-side replacement for the old `freshIds` /
// `fingerprints` props on PartialsClient (which are now registered
// client-side instead of plumbed as props).
const renderCapture: {
	freshIds: string[];
	fingerprints: Record<string, string>;
	mode: string | undefined;
	template: React.ReactNode;
	children: React.ReactNode;
} = {
	freshIds: [],
	fingerprints: {},
	mode: undefined,
	template: undefined,
	children: undefined,
};

// Clear in place (not reassign) so `const x = renderCapture.freshIds`
// references inside tests stay live across the clear.
beforeEach(() => {
	renderCapture.freshIds.length = 0;
	for (const k of Object.keys(renderCapture.fingerprints)) {
		delete renderCapture.fingerprints[k];
	}
});

// Mock client components — useRef/class components need a full React renderer.
vi.mock("../partial-client.tsx", () => ({
	PartialsClient: ({
		children,
		mode,
		template,
	}: { children: React.ReactNode; mode?: string; template?: React.ReactNode }) => {
		// Reset the per-Partial capture at the start of each render so
		// tests see only what THIS render produced. Capture top-level
		// props (mode, template, children) as snapshots.
		renderCapture.freshIds.length = 0;
		for (const k of Object.keys(renderCapture.fingerprints)) {
			delete renderCapture.fingerprints[k];
		}
		renderCapture.mode = mode;
		renderCapture.template = template;
		renderCapture.children = children;
		return children;
	},
	getCachedPartialIds: () => [],
	registerClientPartial: (_id: string, _fp: string) => {},
	FrameNameProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../partial-error-boundary.tsx", () => ({
	PartialErrorBoundary: ({
		children,
		partialId,
		partialFingerprint,
	}: {
		children: React.ReactNode;
		partialId?: string;
		partialFingerprint?: string;
	}) => {
		if (partialId && partialFingerprint) {
			if (!renderCapture.freshIds.includes(partialId)) {
				renderCapture.freshIds.push(partialId);
			}
			renderCapture.fingerprints[partialId] = partialFingerprint;
		}
		return children;
	},
}));

// Cache depends on `@vitejs/plugin-rsc/rsc` which resolves to a
// virtual: URL only Vite can handle. In unit tests we mock it to
// a bypass: return children as-is. End-to-end Cache behavior is
// covered by e2e playwright tests.
vi.mock("../cache.tsx", () => ({
	Cache: ({ children }: { children: React.ReactNode }) => children,
	_cacheStats: async () => ({ size: 0, keys: [] }),
	_clearCache: async () => {},
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

/**
 * Cache-mode is only meaningful after a streaming render has populated
 * the route registry. This helper warms the registry by doing a
 * no-filter render of the same tree, then performs the actual request
 * under test and returns its rendered output.
 */
async function warmThenRender(
	params: Record<string, string>,
	tree: React.ReactNode,
): Promise<any> {
	await runWithRequestAsync(fakeRequest(), async () => renderToJSON(tree));
	return (
		await runWithRequestAsync(fakeRequest(params), async () =>
			renderToJSON(tree),
		)
	).result;
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
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<Partial id="stats"><Stats /></Partial>
				<Partial id="species"><Species /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender({ partials: "hero,stats" }, tree);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("filters to single partial", async () => {
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<Partial id="stats"><Stats /></Partial>
				<Partial id="species"><Species /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender({ partials: "stats" }, tree);
		// Cache mode passes wrappedChildren as positional args to
		// `React.createElement(PartialsClient, ..., ...wrappedChildren)`
		// to avoid the "missing key" warning, so a single filtered
		// partial arrives as one child (not an array of one).
		const rendered = (Array.isArray(result) ? result : [result]).filter(Boolean);
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
		const rendered = (Array.isArray(result) ? result : [result]).filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("world");
	});

	it("filters to nested partial", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const tree = (
			<PartialRoot>
				<Partial id="header">
					<div>
						Timestamp
						<Partial id="cart"><Cart /></Partial>
					</div>
				</Partial>
				<Partial id="stats"><Stats /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender({ partials: "cart" }, tree);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
		expect(str).not.toContain("Timestamp");
		expect(str).not.toContain("Stats");
	});

	it("refreshing parent excludes nested partial content", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const tree = (
			<PartialRoot>
				<Partial id="header">
					<div>
						Timestamp
						<Partial id="cart"><Cart /></Partial>
					</div>
				</Partial>
				<Partial id="stats"><Stats /></Partial>
			</PartialRoot>
		);
		// The client always sends `cached=id:fp,…` alongside a partial
		// refetch (see `fetchRscPayload` in entry.browser.tsx). The
		// server skips a non-explicit Partial iff its computed fp
		// matches what the client has — mismatched fps mean the body
		// changed and must re-render. Warm-render first to capture
		// the real fingerprints, then feed them back on the refetch
		// so cart/stats match and get placeholder-skipped.
		await runWithRequestAsync(fakeRequest(), async () => renderToJSON(tree));
		const cartFp = renderCapture.fingerprints["cart"];
		const statsFp = renderCapture.fingerprints["stats"];
		const { result } = await runWithRequestAsync(
			fakeRequest({
				partials: "header",
				cached: `cart:${cartFp},stats:${statsFp}`,
			}),
			async () => renderToJSON(tree),
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

	it("skips re-rendering partials whose fingerprint matches the client's ?cached= entry", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.fingerprints.hero).toBeDefined();
		expect(renderCapture.fingerprints.stats).toBeDefined();
		const heroFp = renderCapture.fingerprints.hero;

		// Second render: client reports the `hero` fingerprint
		// unchanged, so the server emits a `<i data-partial hidden
		// key="hero">` placeholder instead of running `<Hero/>`.
		// `stats` has no cached fingerprint → still renders fresh.
		const { result } = await runWithRequestAsync(
			fakeRequest({ cached: `hero:${heroFp}` }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).not.toContain("Hero");
	});

	it("fingerprints are stable for same element tree", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
				</PartialRoot>,
			),
		);
		const fp1 = renderCapture.fingerprints.hero;

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
				</PartialRoot>,
			),
		);
		const fp2 = renderCapture.fingerprints.hero;

		expect(fp1).toBeDefined();
		expect(fp1).toBe(fp2);
	});

	it("explicitly requested partials always render even with matching cached fingerprint", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		const heroFp = renderCapture.fingerprints.hero;

		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "hero", cached: `hero:${heroFp}` }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="stats"><Stats /></Partial>
					</PartialRoot>,
				),
		);
		expect(renderCapture.freshIds).toContain("hero");
		expect(renderCapture.freshIds).not.toContain("stats");
		const str = JSON.stringify(result);
		expect(str).toContain("Hero");
	});

	it("refetch without props still renders when not in cached", async () => {
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<Partial id="stats"><Stats /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender(
			{ partials: "hero", cached: "stats:somefp" },
			tree,
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
		const tree = (
			<PartialRoot>
				<Partial id="badge" tags={["cart", "header"]}><CartBadge /></Partial>
				<Partial id="drawer" tags={["cart"]}><CartDrawer /></Partial>
				<Partial id="products" tags={["catalog"]}><ProductGrid /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender({ tags: "cart" }, tree);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
		expect(str).toContain("cart-drawer");
		expect(str).not.toContain("products");
	});

	it("combines ?partials= and ?tags= as union", async () => {
		function A() { return <span>a-content</span>; }
		function B() { return <span>b-content</span>; }
		function C() { return <span>c-content</span>; }
		const tree = (
			<PartialRoot>
				<Partial id="a"><A /></Partial>
				<Partial id="b" tags={["group"]}><B /></Partial>
				<Partial id="c"><C /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender(
			{ partials: "a", tags: "group" },
			tree,
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
					<Partial id="test" tags={["cart"]} cache={{ maxAge: 60 }}>
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
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<main>
					<Partial id="stats"><Stats /></Partial>
				</main>
			</PartialRoot>
		);
		const result = await warmThenRender({ partials: "stats" }, tree);
		const str = JSON.stringify(result);
		expect(str).toContain("Stats");
		expect(str).not.toContain("Hero");
	});

	it("tag-based invalidation renders only tagged partials", async () => {
		function Cart() { return <span>cart-content</span>; }
		function Products() { return <span>products</span>; }

		const tree = (
			<PartialRoot>
				<Partial id="cart" tags={["cart"]}><Cart /></Partial>
				<Partial id="products"><Products /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender({ tags: "cart" }, tree);

		expect(renderCapture.freshIds).toEqual(["cart"]);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
	});
});

describe("Partial discovery", () => {
	// The runtime path runs Partial's component body on every render, so
	// deep / dynamic Partials (ones produced inside `.map()`, inside
	// function components, etc.) are first-class: they all register
	// themselves and show up in `freshIds` just like statically-visible
	// Partials do. These tests pin that invariant.
	function Inner() { return <span>inner-real-content</span>; }

	it("discovers a Partial passed as children through a wrapping component", async () => {
		function Wrapper({ children }: { children: React.ReactNode }) {
			return <section className="wrap">{children}</section>;
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Wrapper>
						<Partial id="forwarded"><Inner /></Partial>
					</Wrapper>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("forwarded");
	});

	it("discovers a Partial created inside a child component's return value", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div>
						<ProductCard />
					</div>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("inside-card");
	});

	it("discovers a nested Partial created inside a child component", async () => {
		function Body() {
			return (
				<>
					<div>cards</div>
					<Partial id="nested-inside-body"><Inner /></Partial>
				</>
			);
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="page">
						<Body />
					</Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("page");
		expect(renderCapture.freshIds).toContain("nested-inside-body");
	});

	it("discovers Partials that DIFFER between two requests (cross-navigation dynamism)", async () => {
		// Request A: pokemon list page — "list" partial
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="list"><Inner /></Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toEqual(["list"]);

		// Request B: pokemon detail page — "hero" and "stats" partials.
		// Capture resets per render (see the mocked PartialsClient),
		// so we see only what this render produced.
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Inner /></Partial>
					<Partial id="stats"><Inner /></Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toEqual(["hero", "stats"]);
	});

	it("discovers Partials produced by calling a page function inline (today's Root pattern)", async () => {
		// Mirrors src/app/root.tsx — pickRoute calls PokemonPage() directly,
		// inlining its returned JSX under <PartialRoot>.
		function PokemonPage() {
			return (
				<>
					<Partial id="hero"><Inner /></Partial>
					<Partial id="stats"><Inner /></Partial>
				</>
			);
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					{PokemonPage()}
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("hero");
		expect(renderCapture.freshIds).toContain("stats");
	});

	it("discovers Partials when a page is rendered as <PokemonPage/> (component element, not called)", async () => {
		// The old static walker couldn't see through <PokemonPage/>;
		// the runtime path renders it like any other component and its
		// child Partials self-register during render.
		function PokemonPage() {
			return (
				<>
					<Partial id="hero-cmp"><Inner /></Partial>
					<Partial id="stats-cmp"><Inner /></Partial>
				</>
			);
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<PokemonPage />
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("hero-cmp");
		expect(renderCapture.freshIds).toContain("stats-cmp");
	});
});

describe("Deep (dynamic) Partial discovery", () => {
	// A Partial produced inside a child component's return value —
	// the canonical `.map(p => <Partial id={"price-" + p.sku}/>)`
	// pattern. The old static walker could not see these; the
	// runtime path via the Partial component body registers them
	// during render. These tests pin the *functional* invariants
	// regardless of which path the framework uses internally.
	function Inner() { return <span>inner-real-content</span>; }

	it("registers a Partial produced inside a component body during first render", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div><ProductCard /></div>
				</PartialRoot>,
			),
		);
		const { lookupPartial } = await import("../partial-registry.ts");
		expect(lookupPartial("/test", "inside-card")).toBeDefined();
	});

	it("registers Partials produced by .map() inside a component", async () => {
		function ProductList() {
			const skus = ["abc", "def", "ghi"];
			return (
				<ul>
					{skus.map((sku) => (
						<Partial key={sku} id={`price-${sku}`} tags={["price"]}>
							<Inner />
						</Partial>
					))}
				</ul>
			);
		}
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<ProductList />
				</PartialRoot>,
			),
		);
		const { lookupPartial } = await import("../partial-registry.ts");
		for (const sku of ["abc", "def", "ghi"]) {
			expect(lookupPartial("/test", `price-${sku}`)).toBeDefined();
		}
	});

	it("deep dynamic Partial is refetchable by id (registry supplement)", async () => {
		function ProductCard() {
			return <Partial id="price-abc"><Inner /></Partial>;
		}

		// Full render populates registry.
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div><ProductCard /></div>
				</PartialRoot>,
			),
		);

		// Refetch by id resolves through the registry.
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "price-abc" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<div><ProductCard /></div>
					</PartialRoot>,
				),
		);
		expect(JSON.stringify(result)).toContain("inner-real-content");
	});

	it("dynamic Partial is refetchable by tag", async () => {
		function ProductList() {
			return (
				<ul>
					<Partial id="price-abc" tags={["price"]}><Inner /></Partial>
					<Partial id="price-def" tags={["price"]}><Inner /></Partial>
				</ul>
			);
		}

		// Prime the registry.
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<ProductList />
				</PartialRoot>,
			),
		);

		// `?tags=price` should resolve to both price-abc and price-def via
		// the registry's tag index.
		const { result } = await runWithRequestAsync(
			fakeRequest({ tags: "price" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<ProductList />
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str.match(/inner-real-content/g)?.length).toBe(2);
	});

	it("deep dynamic Partial is included in freshIds on first render", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div><ProductCard /></div>
				</PartialRoot>,
			),
		);
		expect(renderCapture.freshIds).toContain("inside-card");
	});

	it("fingerprint is computed for deep dynamic Partial on first render", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div><ProductCard /></div>
				</PartialRoot>,
			),
		);
		expect(renderCapture.fingerprints["inside-card"]).toBeTruthy();
	});

	it("fingerprint skip applies to deep dynamic Partial on nav", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}

		// First render — capture fingerprint.
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<div><ProductCard /></div>
				</PartialRoot>,
			),
		);
		const fp = renderCapture.fingerprints["inside-card"];
		expect(fp).toBeTruthy();

		// Second render — client reports that fingerprint; server should
		// emit a placeholder and not render `<Inner/>`.
		const { result } = await runWithRequestAsync(
			fakeRequest({ cached: `inside-card:${fp}` }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<div><ProductCard /></div>
					</PartialRoot>,
				),
		);
		expect(JSON.stringify(result)).not.toContain("inner-real-content");
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
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.mode).toBe("streaming");
	});

	it("partial refetch uses cache mode", async () => {
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<Partial id="stats"><Stats /></Partial>
			</PartialRoot>
		);
		// Warm registry with a streaming render, then refetch.
		await runWithRequestAsync(fakeRequest(), async () => renderToJSON(tree));
		await runWithRequestAsync(fakeRequest({ partials: "hero" }), async () =>
			renderToJSON(tree),
		);
		expect(renderCapture.mode).toBe("cache");
	});

	it("partials with fallback prop are wrapped in Suspense in streaming mode", async () => {
		function SlowCart() { return <span>cart</span>; }
		const fallback = <span>loading...</span>;

		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="cart" fallback={fallback}><SlowCart /></Partial>
				</PartialRoot>,
			),
		);

		// Walk the rendered tree for any Suspense element — it's there
		// because <Partial id="cart" fallback={...}> wrapped its content.
		function findSuspense(node: any): boolean {
			if (Array.isArray(node)) return node.some(findSuspense);
			if (!node || typeof node !== "object") return false;
			if (node.type === React.Suspense) return true;
			const kids = node?.props?.children;
			return findSuspense(kids);
		}
		expect(findSuspense(result)).toBe(true);
	});

	it("wraps Partial in Suspense when a fallback is provided", async () => {
		// With a fallback: outer wrapper is `<Suspense key={id}>…</Suspense>`.
		// Without a fallback: outer wrapper is `<PartialErrorBoundary key={id}>`.
		// Bug #1 from the refactor: unconditional Suspense wrapping broke
		// nested-Partial substitution because the client walker skips
		// Suspense subtrees (Flight lazies).
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero" fallback={<div>loading hero</div>}><Hero /></Partial>
					<Partial id="stats" fallback={<div>loading stats</div>}><Stats /></Partial>
				</PartialRoot>,
			),
		);

		function countSuspense(node: any): number {
			if (Array.isArray(node)) return node.reduce((sum, n) => sum + countSuspense(n), 0);
			if (!node || typeof node !== "object") return 0;
			const self = node.type === React.Suspense ? 1 : 0;
			return self + countSuspense(node?.props?.children);
		}
		expect(countSuspense(result)).toBe(2);
	});

	it("omits Suspense when no fallback (nested-substitution invariant)", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);

		function countSuspense(node: any): number {
			if (Array.isArray(node)) return node.reduce((sum, n) => sum + countSuspense(n), 0);
			if (!node || typeof node !== "object") return 0;
			const self = node.type === React.Suspense ? 1 : 0;
			return self + countSuspense(node?.props?.children);
		}
		expect(countSuspense(result)).toBe(0);
	});

	it("streaming mode captures fingerprints for each Partial", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="hero"><Hero /></Partial>
					<Partial id="stats"><Stats /></Partial>
				</PartialRoot>,
			),
		);

		expect(renderCapture.fingerprints).toHaveProperty("hero");
		expect(renderCapture.fingerprints).toHaveProperty("stats");
	});

	it("cache mode renders only the requested partial as children", async () => {
		const tree = (
			<PartialRoot>
				<Partial id="hero"><Hero /></Partial>
				<Partial id="stats"><Stats /></Partial>
			</PartialRoot>
		);
		await runWithRequestAsync(fakeRequest(), async () => renderToJSON(tree));
		await runWithRequestAsync(fakeRequest({ partials: "hero" }), async () =>
			renderToJSON(tree),
		);

		// Template is now client-derived, not a server prop.
		expect(renderCapture.mode).toBe("cache");
		const children = React.Children.toArray(renderCapture.children);
		expect(children.length).toBe(1);
	});

	it("__populateCache renders all partials via streaming mode", async () => {
		function CartBadge() { return <span>cart-badge</span>; }
		function Products() { return <span>products</span>; }

		const { result } = await runWithRequestAsync(
			fakeRequest({ tags: "cart", __populateCache: "1" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="cart" tags={["cart"]}><CartBadge /></Partial>
						<Partial id="products"><Products /></Partial>
					</PartialRoot>,
				),
		);

		expect(renderCapture.freshIds).toContain("cart");
		expect(renderCapture.freshIds).toContain("products");

		const str = JSON.stringify(result);
		expect(str).toContain("cart-badge");
		expect(str).toContain("products");
	});

	it("tag invalidation with ?cached= only renders tagged partial", async () => {
		function CartBadge() { return <span>cart-badge</span>; }
		function Products() { return <span>products</span>; }

		const tree = (
			<PartialRoot>
				<Partial id="cart" tags={["cart"]}><CartBadge /></Partial>
				<Partial id="products"><Products /></Partial>
			</PartialRoot>
		);
		const result = await warmThenRender(
			{ tags: "cart", cached: "cart:abc,products:def" },
			tree,
		);

		expect(renderCapture.freshIds).toEqual(["cart"]);
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

	const cartTree = (
		<PartialRoot>
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
		</PartialRoot>
	);

	it("tag=cart with cache: only cart is fresh, header and products are cached", async () => {
		await warmThenRender(
			{ tags: "cart", cached: "header:h1,cart:c1,products:p1" },
			cartTree,
		);

		expect(renderCapture.freshIds).toEqual(["cart"]);
		expect(renderCapture.freshIds).not.toContain("header");
		expect(renderCapture.freshIds).not.toContain("products");
	});

	it("tag=cart with cache: header content is NOT in the rendered output", async () => {
		const result = await warmThenRender(
			{ tags: "cart", cached: "header:h1,cart:c1,products:p1" },
			cartTree,
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
		const makeTree = () => (
			<PartialRoot>
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
			</PartialRoot>
		);

		// First action: __populateCache → all partials render.
		await runWithRequestAsync(
			fakeRequest({ tags: "cart", __populateCache: "1" }),
			async () => renderToJSON(makeTree()),
		);
		expect(renderCapture.freshIds).toContain("header");
		expect(renderCapture.freshIds).toContain("cart");
		expect(renderCapture.freshIds).toContain("products");

		// Subsequent action: with cache → only cart.
		await runWithRequestAsync(
			fakeRequest({
				tags: "cart",
				cached: "header:h1,cart:c1,products:p1",
			}),
			async () => renderToJSON(makeTree()),
		);
		expect(renderCapture.freshIds).toEqual(["cart"]);
	});
});

// ── Dynamic Partial registry ───────────────────────────────────────────
//
// The bootstrap JSX walk in `PartialRoot` (`seedRegistry`) follows
// `.children` chains; it can't see through opaque function components.
// A `<Partial>` produced inside `ProductList.map(p => <ProductItem
// price={<Partial id={`price-${p.sku}`}>…</Partial>}/>)` — the canonical
// GoldPrice-style pattern — is invisible to that bootstrap walk. But
// every `<Partial>` self-registers in the route-scoped
// `partial-registry` on render, so later refetches can resolve by id
// without re-running the ancestor tree.

describe("Dynamic Partial discovery via route-scoped registry", () => {
	it("static partials populate the registry on a full render", async () => {
		const { registerPartial: _reg, clearRegistry, _registryStats } = await import(
			"../partial-registry.ts"
		);
		clearRegistry();

		function GoldPrice({ sku }: { sku: string }) {
			return <span data-sku={sku}>$1.00</span>;
		}

		await runWithRequestAsync(
			new Request("http://localhost/registry-test"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="hero"><Hero /></Partial>
						<Partial id="price-ABC"><GoldPrice sku="ABC" /></Partial>
					</PartialRoot>,
				),
		);

		const stats = _registryStats();
		expect(stats.byRoute["/registry-test"]).toEqual(
			expect.arrayContaining(["hero", "price-ABC"]),
		);
	});

	it("dynamic partial (produced inside an opaque function component) is registered when it renders and can be refetched", async () => {
		const { clearRegistry, _registryStats } = await import(
			"../partial-registry.ts"
		);
		clearRegistry();

		function GoldPrice({ sku }: { sku: string }) {
			return <span data-testid={`price-${sku}`}>$1.00</span>;
		}

		// ProductList is opaque to the bootstrap walk: the Partials it
		// produces live inside its return value, not inside its
		// `.children` prop.
		function ProductList() {
			return (
				<>
					{["A", "B", "C"].map((sku) => (
						<Partial key={sku} id={`price-${sku}`}>
							<GoldPrice sku={sku} />
						</Partial>
					))}
				</>
			);
		}

		// First render: populates the registry for the route.
		await runWithRequestAsync(
			new Request("http://localhost/dynamic"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<ProductList />
					</PartialRoot>,
				),
		);

		const stats = _registryStats();
		expect(stats.byRoute["/dynamic"]).toEqual(
			expect.arrayContaining(["price-A", "price-B", "price-C"]),
		);

		// Subsequent refetch for one dynamic id.
		await runWithRequestAsync(
			new Request("http://localhost/dynamic?partials=price-B"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<ProductList />
					</PartialRoot>,
				),
		);

		// Only price-B rendered; the registry resolved it even though
		// `seedRegistry` (the static walk) couldn't see through
		// ProductList.
		expect(renderCapture.freshIds).toEqual(["price-B"]);
	});

	it("falls back to full render when a requested id is neither static nor in the registry", async () => {
		const { clearRegistry } = await import("../partial-registry.ts");
		clearRegistry();

		// Ask for `price-UNKNOWN` on a route where no full render has
		// populated it. PartialRoot should ignore the (stale) filter
		// and drop into streaming mode so the client reconciles against
		// a fresh tree.
		await runWithRequestAsync(
			new Request("http://localhost/cold?partials=price-UNKNOWN"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="hero"><Hero /></Partial>
					</PartialRoot>,
				),
		);

		// Full-render fallback rendered `hero` even though the caller
		// asked for price-UNKNOWN.
		expect(renderCapture.freshIds).toContain("hero");
	});

	it("registry captures each dynamic partial's content so refetch can render it without the ancestor", async () => {
		const { clearRegistry, lookupPartial } = await import(
			"../partial-registry.ts"
		);
		clearRegistry();

		function GoldPrice({ sku }: { sku: string }) {
			return <span data-sku={sku}>base:{sku}</span>;
		}

		function ProductList() {
			return (
				<>
					{["X", "Y"].map((sku) => (
						<Partial key={sku} id={`price-${sku}`}>
							<GoldPrice sku={sku} />
						</Partial>
					))}
				</>
			);
		}

		await runWithRequestAsync(
			new Request("http://localhost/snap"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<ProductList />
					</PartialRoot>,
				),
		);

		const snap = lookupPartial("/snap", "price-Y");
		expect(snap).toBeDefined();
		// The snapshot's content is the *original* JSX inside the
		// `<Partial>` — a single element of type GoldPrice with the
		// parent-bound `sku` prop. That's enough for a refetch to
		// render it directly; ancestor execution isn't needed.
		const content = snap!.content as React.ReactElement<any>;
		expect(React.isValidElement(content)).toBe(true);
		expect((content.props as any).sku).toBe("Y");
	});
});

describe("Partial defer prop", () => {
	function Dormant() {
		return <div data-testid="dormant">dormant</div>;
	}
	function Activated() {
		return <div data-testid="activated">activated</div>;
	}

	it("emits fallback when defer={true} and not explicitly requested", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="feed" defer fallback={<Dormant />}>
						<Activated />
					</Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("dormant");
		expect(str).not.toContain("activated");
	});

	it("renders content when the deferred id is in ?partials=", async () => {
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "feed" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="feed" defer fallback={<Dormant />}>
							<Activated />
						</Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("activated");
		expect(str).not.toContain("dormant");
	});

	it("clones an activator element with partialId + fallback as children", async () => {
		function Activator({
			partialId,
			children,
		}: {
			partialId?: string;
			children?: React.ReactNode;
		}) {
			return (
				<div data-activator data-id={partialId}>
					{children}
				</div>
			);
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="feed" defer={<Activator />} fallback={<Dormant />}>
						<Activated />
					</Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("dormant");
		expect(str).toContain('"data-id":"feed"');
		expect(str).not.toContain("activated");
	});

	it("preserves user-set activator props when cloning", async () => {
		function Activator({
			partialId,
			children,
			label,
		}: {
			partialId?: string;
			children?: React.ReactNode;
			label?: string;
		}) {
			return (
				<div data-label={label} data-id={partialId}>
					{children}
				</div>
			);
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial
						id="feed"
						defer={<Activator label="hello" />}
						fallback={<Dormant />}
					>
						<Activated />
					</Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain('"data-label":"hello"');
		expect(str).toContain('"data-id":"feed"');
	});

	it("registers the deferred partial so activation refetches can look it up", async () => {
		const { lookupPartial } = await import("../partial-registry.ts");
		await runWithRequestAsync(
			new Request("http://localhost/defer-route"),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="feed" defer fallback={<Dormant />}>
							<Activated />
						</Partial>
					</PartialRoot>,
				),
		);
		const snap = lookupPartial("/defer-route", "feed");
		expect(snap).toBeDefined();
		// The registered content is the REAL content, not the fallback —
		// so an activation refetch renders `<Activated/>`, not `<Dormant/>`.
		const content = snap!.content as React.ReactElement<any>;
		expect(React.isValidElement(content)).toBe(true);
		expect(content.type).toBe(Activated);
	});

	it("emits a partial fingerprint even when deferred (so nav-skip still works)", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="feed" defer fallback={<Dormant />}>
						<Activated />
					</Partial>
				</PartialRoot>,
			),
		);
		expect(renderCapture.fingerprints.feed).toBeDefined();
	});
});

describe("normalizeTags", () => {
	it("splits a whitespace-separated string", async () => {
		const { normalizeTags } = await import("../partial-component.tsx");
		expect(normalizeTags("price product featured")).toEqual([
			"price",
			"product",
			"featured",
		]);
	});

	it("accepts an array as-is", async () => {
		const { normalizeTags } = await import("../partial-component.tsx");
		expect(normalizeTags(["cart", "header"])).toEqual(["cart", "header"]);
	});

	it("deduplicates + trims", async () => {
		const { normalizeTags } = await import("../partial-component.tsx");
		expect(normalizeTags("  cart  cart  header ")).toEqual(["cart", "header"]);
	});

	it("empty / undefined → []", async () => {
		const { normalizeTags } = await import("../partial-component.tsx");
		expect(normalizeTags(undefined)).toEqual([]);
		expect(normalizeTags("")).toEqual([]);
		expect(normalizeTags("   ")).toEqual([]);
	});
});

describe("Partial id optional + tag synthesis", () => {
	it("accepts a whitespace-separated tags string", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="thing" tags="price product">
						<span>hello</span>
					</Partial>
				</PartialRoot>,
			),
		);
		const { lookupPartial } = await import("../partial-registry.ts");
		const snap = lookupPartial("/test", "thing");
		expect(snap?.tags).toEqual(["price", "product"]);
		expect(JSON.stringify(result)).toContain("hello");
	});

	it("synthesizes __anon:<sorted-tags> id when no id is provided", async () => {
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial tags="cart">
						<span>anon</span>
					</Partial>
				</PartialRoot>,
			),
		);
		const { lookupPartial } = await import("../partial-registry.ts");
		const snap = lookupPartial("/test", "__anon:cart");
		expect(snap).toBeDefined();
		expect(snap?.tags).toEqual(["cart"]);
	});

	it("throws when neither id nor tags is provided", async () => {
		await expect(
			runWithRequestAsync(fakeRequest(), async () =>
				renderToJSON(
					<PartialRoot>
						<Partial>
							<span>nope</span>
						</Partial>
					</PartialRoot>,
				),
			),
		).rejects.toThrow(/requires either `id` or `tags`/);
	});

	it("throws on duplicate anonymous Partials (same tags)", async () => {
		await expect(
			runWithRequestAsync(fakeRequest(), async () =>
				renderToJSON(
					<PartialRoot>
						<>
							<Partial tags="cart">
								<span>a</span>
							</Partial>
							<Partial tags="cart">
								<span>b</span>
							</Partial>
						</>
					</PartialRoot>,
				),
			),
		).rejects.toThrow(/Duplicate anonymous/);
	});
});

