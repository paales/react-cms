import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The partial-registry is module-level and route-keyed. Clear it
// before each test so tag resolution doesn't pick up entries
// registered by a previous test that used the same fake route.
beforeEach(async () => {
  const { clearRegistry } = await import("../partial-registry.ts");
  clearRegistry();
});

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

describe("WhenVisible activator", () => {
	// Mock the client half so vitest renders without needing React.useRef
	// or IntersectionObserver.
	vi.doMock("../when-visible-client.tsx", () => ({
		WhenVisibleClient: ({ partialId, children }: { partialId: string; children: React.ReactNode }) => (
			<span data-activator={partialId}>{children}</span>
		),
	}));

	it("renders fallback on full render", async () => {
		const { WhenVisible } = await import("../when-visible.tsx");
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<PartialRoot>
					<Partial id="bio">
						<WhenVisible partialId="bio" fallback={<span>fb-bio</span>}>
							<article>real-bio</article>
						</WhenVisible>
					</Partial>
				</PartialRoot>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("fb-bio");
		expect(str).not.toContain("real-bio");
	});

	it("renders children when partial is in ?partials=", async () => {
		const { WhenVisible } = await import("../when-visible.tsx");
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "bio" }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="bio">
							<WhenVisible partialId="bio" fallback={<span>fb-bio</span>}>
								<article>real-bio</article>
							</WhenVisible>
						</Partial>
					</PartialRoot>,
				),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("real-bio");
		expect(str).not.toContain("fb-bio");
	});

	it("renders children when __inputs overrides target it", async () => {
		const { WhenVisible } = await import("../when-visible.tsx");
		const inputs = JSON.stringify({ bio: {} });
		const { result } = await runWithRequestAsync(
			fakeRequest({ partials: "bio", __inputs: inputs }),
			async () =>
				renderToJSON(
					<PartialRoot>
						<Partial id="bio">
							<WhenVisible partialId="bio" fallback={<span>fb-bio</span>}>
								<article>real-bio</article>
							</WhenVisible>
						</Partial>
					</PartialRoot>,
				),
		);
		expect(JSON.stringify(result)).toContain("real-bio");
	});
});

describe("Walker discovery limits", () => {
	function Inner() { return <span>inner-real-content</span>; }

	it("discovers a Partial passed as children through a wrapping component", async () => {
		function Wrapper({ children }: { children: React.ReactNode }) {
			return <section className="wrap">{children}</section>;
		}

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Wrapper>
						<Partial id="forwarded"><Inner /></Partial>
					</Wrapper>
				</P>,
			),
		);
		expect(freshIds).toContain("forwarded");
	});

	it("does NOT discover a Partial created inside a child component's return value", async () => {
		function ProductCard() {
			return <Partial id="inside-card"><Inner /></Partial>;
		}

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<div>
						<ProductCard />
					</div>
				</P>,
			),
		);
		expect(freshIds).not.toContain("inside-card");
		expect(freshIds).toHaveLength(0);
	});

	it("does NOT discover a nested Partial created inside a child component even when its parent Partial is discovered", async () => {
		function Body() {
			return (
				<>
					<div>cards</div>
					<Partial id="nested-inside-body"><Inner /></Partial>
				</>
			);
		}

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="page">
						<Body />
					</Partial>
				</P>,
			),
		);
		expect(freshIds).toContain("page");
		expect(freshIds).not.toContain("nested-inside-body");
	});

	it("discovers Partials that DIFFER between two requests (cross-navigation dynamism)", async () => {
		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		// Request A: pokemon list page — "list" partial
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="list"><Inner /></Partial>
				</P>,
			),
		);
		expect(freshIds).toEqual(["list"]);

		// Request B: pokemon detail page — "hero" and "stats" partials
		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<Partial id="hero"><Inner /></Partial>
					<Partial id="stats"><Inner /></Partial>
				</P>,
			),
		);
		expect(freshIds).toEqual(["hero", "stats"]);
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

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					{PokemonPage()}
				</P>,
			),
		);
		expect(freshIds).toContain("hero");
		expect(freshIds).toContain("stats");
	});

	it("does NOT discover Partials when a page is rendered as <PokemonPage/> (component element, not called)", async () => {
		function PokemonPage() {
			return (
				<>
					<Partial id="hero-cmp"><Inner /></Partial>
					<Partial id="stats-cmp"><Inner /></Partial>
				</>
			);
		}

		let freshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds: fids,
			children,
		}: any) => {
			freshIds = fids;
			return children;
		}) as any;
		const { PartialRoot: P } = await import("../partial.tsx");

		await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<P>
					<PokemonPage />
				</P>,
			),
		);
		expect(freshIds).not.toContain("hero-cmp");
		expect(freshIds).not.toContain("stats-cmp");
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

		// Walk the rendered children recursively (descends through the
		// PartialBoundary wrapper that transformForStreaming now adds so
		// <Cache> can recognize partial-bearing subtrees).
		function findSuspense(node: React.ReactNode): boolean {
			if (Array.isArray(node)) return node.some(findSuspense);
			if (!React.isValidElement(node)) return false;
			if (node.type === React.Suspense) return true;
			return findSuspense((node.props as any).children);
		}
		expect(findSuspense(capturedChildren)).toBe(true);

		// Hero (no fallback) should not introduce a Suspense.
		const children = React.Children.toArray(capturedChildren!);
		expect(children.length).toBeGreaterThan(1);
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

		function findSuspense(node: React.ReactNode): boolean {
			if (Array.isArray(node)) return node.some(findSuspense);
			if (!React.isValidElement(node)) return false;
			if (node.type === React.Suspense) return true;
			return findSuspense((node.props as any).children);
		}
		expect(findSuspense(capturedChildren)).toBe(false);
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

// ── Dynamic Partial registry ───────────────────────────────────────────
//
// The static `collectPartials` walk follows JSX `.children` chains; it
// can't see through opaque function components. A `<Partial>` produced
// inside `ProductList.map(p => <ProductItem price={<Partial
// id={`price-${p.sku}`}>…</Partial>}/>)` — the canonical GoldPrice-style
// pattern — is invisible to the static walker. The route-scoped
// `partial-registry` captures each such Partial when `<Partial>`
// self-wraps during the render, so later refetches can resolve by id
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

		// ProductList is opaque to `collectPartials`: the Partials it
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
		let capturedFreshIds: string[] = [];
		vi.mocked(await import("../partial-client.tsx")).PartialsClient = (({
			freshIds,
			children,
		}: any) => {
			capturedFreshIds = freshIds;
			return children;
		}) as any;

		const { PartialRoot: P } = await import("../partial.tsx");
		await runWithRequestAsync(
			new Request("http://localhost/dynamic?partials=price-B"),
			async () =>
				renderToJSON(
					<P>
						<ProductList />
					</P>,
				),
		);

		// The registry supplement picked up `price-B` even though
		// `collectPartials` couldn't find it statically — that's the
		// whole point of the registry.
		expect(capturedFreshIds).toEqual(["price-B"]);
	});

	it("falls back to full render when a requested id is neither static nor in the registry", async () => {
		const { clearRegistry } = await import("../partial-registry.ts");
		clearRegistry();

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

		// Ask for `price-UNKNOWN` on a route where no full render has
		// populated it. PartialRoot should ignore the (stale) filter
		// and drop into streaming mode so the client reconciles against
		// a fresh tree.
		await runWithRequestAsync(
			new Request("http://localhost/cold?partials=price-UNKNOWN"),
			async () =>
				renderToJSON(
					<P>
						<Partial id="hero"><Hero /></Partial>
					</P>,
				),
		);

		expect(capturedMode).toBe("streaming");
		// All statically-discovered partials are rendered as fresh
		// (full-render fallback), so we at least see `hero`.
		expect(capturedFreshIds).toContain("hero");
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
