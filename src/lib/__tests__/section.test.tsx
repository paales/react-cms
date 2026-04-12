import React from "react";
import { describe, expect, it, vi } from "vitest";

// Mock the pipeline dependencies so SectionList doesn't need real schema/API
vi.mock("../access-recorder.ts", () => ({
	AccessRecorder: vi.fn().mockImplementation(() => ({
		getAccessTree: () => ({}),
	})),
}));

vi.mock("../proxy-node.ts", () => ({
	createProxy: () => ({ _fake: true }),
}));

vi.mock("../discovery.ts", () => ({
	renderForDiscovery: vi.fn(),
}));

vi.mock("../query-compiler.ts", () => ({
	compileQuery: () => "{ __typename }",
	raw: (s: string) => s,
}));

// Mock client component — useRef needs a full React renderer.
vi.mock("../section-client.tsx", () => ({
	SectionListClient: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionList } from "../section.tsx";
import { runWithRequestAsync, getQueryRoot, getQueryMeta } from "../../framework/context.ts";

function Hero() {
	return <h1>Hero</h1>;
}
function Stats() {
	return <div>Stats</div>;
}
function Species() {
	return <p>Species</p>;
}

const fakeGetSchema = async () => ({ getQueryTypeName: () => "query_root" }) as any;
const fakeExecute = async () => ({}) as any;

function fakeRequest() {
	return new Request("http://localhost/test");
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

describe("Section architecture", () => {
	it("renders all sections when no filter", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</SectionList>,
			),
		);
		expect(result).toHaveLength(3);
	});

	it("filters to requested sections", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute} sections="hero,stats">
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(2);
	});

	it("filters to single section", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute} sections="stats">
					<Hero key="hero" />
					<Stats key="stats" />
					<Species key="species" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
	});

	it("passes props to section components", async () => {
		function Greeting({ name }: { name?: string }) {
			return <span>Hello {name}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute}>
					<Greeting key="greeting" name="world" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("world");
	});

	it("provides query root via ALS context", async () => {
		function MySection() {
			const q = getQueryRoot();
			return <span>{q?._fake ? "got-proxy" : "missing"}</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute}>
					<MySection key="test" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		expect(JSON.stringify(rendered)).toContain("got-proxy");
	});

	it("provides query meta via ALS context", async () => {
		function DebugSection() {
			const meta = getQueryMeta();
			return <pre>{meta.query}</pre>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute}>
					<DebugSection key="debug" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		// The compiled query from our mock is "{ __typename }"
		expect(JSON.stringify(rendered)).toContain("__typename");
	});

	it("renders nothing when filter matches no sections", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute} sections="nonexistent">
					<Hero key="hero" />
					<Stats key="stats" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(0);
	});

	it("filters to nested section by key", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute} sections="cart">
					<div key="header">
						Timestamp
						<Cart key="cart" />
					</div>
					<Stats key="stats" />
				</SectionList>,
			),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("cart-content");
		expect(str).not.toContain("Timestamp");
		expect(str).not.toContain("Stats");
	});

	it("refreshing parent excludes nested section content", async () => {
		function Cart() {
			return <span>cart-content</span>;
		}
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute} sections="header">
					<div key="header">
						Timestamp
						<Cart key="cart" />
					</div>
					<Stats key="stats" />
				</SectionList>,
			),
		);
		const str = JSON.stringify(result);
		// Header's own content is rendered
		expect(str).toContain("Timestamp");
		// Nested cart is NOT rendered — parent refresh doesn't re-render children
		expect(str).not.toContain("cart-content");
		// Other top-level sections are not rendered either
		expect(str).not.toContain("Stats");
	});

	it("renders sections without wrapper divs", async () => {
		const { result } = await runWithRequestAsync(fakeRequest(), async () =>
			renderToJSON(
				<SectionList getSchema={fakeGetSchema} execute={fakeExecute}>
					<Hero key="hero" />
				</SectionList>,
			),
		);
		const rendered = result.filter(Boolean);
		expect(rendered).toHaveLength(1);
		// Should render the component directly, no wrapper div
		expect(rendered[0].type).toBe("h1");
	});
});
