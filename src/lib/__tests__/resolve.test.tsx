import React from "react";
import { describe, expect, it } from "vitest";
import { resolve, resolveData, getQueryRoot } from "../resolve.ts";
import { raw } from "../query-compiler.ts";
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

describe("resolve()", { timeout: 15000 }, () => {
	it("full lifecycle with query root proxy", async () => {
		const result = await resolve(getSchema, executeQuery, (q, { query }) => {
			const pokemonList = q.pokemon_v2_pokemon({ limit: 2, order_by: raw("{id: asc}") });
			return {
				names: pokemonList.map((p: any) => p.name.value),
				query,
			};
		});
		const { names, query } = result as any;
		expect(names).toEqual(["bulbasaur", "ivysaur"]);
		expect(query).toContain("pokemon_v2_pokemon");
		expect(query).toContain("name");
	});

	it("discovers fields from JSX tree", async () => {
		const result = await resolve(getSchema, executeQuery, (q) => {
			const pokemonList = q.pokemon_v2_pokemon({ limit: 1 });
			return pokemonList.map((p: any) => ({ id: p.id.value, name: p.name.value, height: p.height.value }));
		});
		const items = result as any[];
		expect(items[0].name).toBe("bulbasaur");
		expect(items[0].id).toBe(1);
	});

	it("provides compiled query in meta", async () => {
		let q = "";
		await resolve(getSchema, executeQuery, (query, { query: compiledQuery }) => {
			query.pokemon_v2_pokemon({ limit: 1 }).map((p: any) => p.name.value);
			q = compiledQuery;
			return null;
		});
		expect(q).toContain("pokemon_v2_pokemon(limit: 1)");
	});

	it("deep traversal", async () => {
		const result = await resolve(getSchema, executeQuery, (q) => {
			const list = q.pokemon_v2_pokemon({ limit: 1 });
			return list.map((p: any) => ({
				name: p.name.value,
				gen: p.pokemon_v2_pokemonspecy.pokemon_v2_generation.name.value,
			}));
		});
		expect((result as any[])[0].gen).toBe("generation-i");
	});

	it("resolveData returns data-backed proxy", async () => {
		const { data, query } = await resolveData(getSchema, executeQuery, (q: any) => {
			const list = q.pokemon_v2_pokemon({ limit: 2, order_by: raw("{id: asc}") });
			list.map((p: any) => { p.name.value; p.id.value; });
		});
		const names = data.pokemon_v2_pokemon.map((p: any) => p.name.value);
		expect(names).toEqual(["bulbasaur", "ivysaur"]);
		expect(query).toContain("pokemon_v2_pokemon");
	});

	it("getQueryRoot() throws outside resolve", () => {
		expect(() => getQueryRoot()).toThrow("getQueryRoot() must be called inside a resolve()");
	});

	it("getQueryRoot() returns proxy inside resolve render function", async () => {
		const result = await resolve(getSchema, executeQuery, (q) => {
			const fromALS = getQueryRoot();
			expect(fromALS).toBe(q);
			const list = fromALS.pokemon_v2_pokemon({ limit: 1 });
			return list.map((p: any) => p.name.value);
		});
		expect((result as any[])[0]).toBe("bulbasaur");
	});

	it("getQueryRoot() discovers fields from deep components", async () => {
		function DeepComponent() {
			const q = getQueryRoot();
			q.pokemon_v2_pokemon({ limit: 1 }).map((p: any) => p.name.value);
			return null;
		}

		const result = await resolve(getSchema, executeQuery, (q) => {
			expect(getQueryRoot()).toBe(q);
			return <DeepComponent />;
		});

		expect(result).toBeDefined();
	});
});
