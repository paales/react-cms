import React from "react";
import { describe, expect, it, vi } from "vitest";
import { SectionList } from "../section.tsx";
import { runWithRequestAsync, getQueryRoot } from "../../framework/context.ts";

vi.mock("../section-client.tsx", () => ({
	SectionListClient: ({ children }: { children: React.ReactNode }) => children,
}));

import { fetchSchema, type SchemaGraph } from "../schema.ts";

const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta";

async function executeQuery<T>(query: string): Promise<T> {
	const response = await fetch(POKEAPI_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});
	return ((await response.json()) as { data: T }).data;
}

let schema: SchemaGraph;
const getSchema = async () => (schema ??= await fetchSchema(POKEAPI_ENDPOINT));

function NameSection() {
	const q = getQueryRoot();
	const pokemon = q.pokemon_v2_pokemon({ limit: 1 })[0];
	return <h1>{pokemon.name.value}</h1>;
}

function HeightSection() {
	const q = getQueryRoot();
	const pokemon = q.pokemon_v2_pokemon({ limit: 1 })[0];
	return <span>{pokemon.height.value}</span>;
}

describe("Section + resolve() integration", { timeout: 15000 }, () => {
	it("renders all sections when no filter", async () => {
		const { result } = await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				SectionList({
					getSchema,
					execute: executeQuery,
					children: [
						<NameSection key="name" />,
						<HeightSection key="height" />,
					],
				}),
		);
		const str = JSON.stringify(result);
		expect(str).toContain("name");
		expect(str).toContain("height");
	});

	it("filters to requested sections", async () => {
		const { result } = await runWithRequestAsync(
			new Request("http://localhost/test"),
			async () =>
				SectionList({
					getSchema,
					execute: executeQuery,
					sections: "name",
					children: [
						<NameSection key="name" />,
						<HeightSection key="height" />,
					],
				}),
		);
		const str = JSON.stringify(result);
		expect(str).toContain('"name"');
	});
});
