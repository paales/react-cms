import { describe, expect, it, beforeEach } from "vitest";
import { orchestrate, clearPatternCache, getPatternCache } from "../orchestrator.ts";
import { fetchSchema, type SchemaGraph } from "../schema.ts";

const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta";
let schema: SchemaGraph;

describe("Orchestrator", { timeout: 15000 }, () => {
	beforeEach(() => clearPatternCache());

	it("full discovery → compile → fetch → data flow", async () => {
		schema ??= await fetchSchema(POKEAPI_ENDPOINT);
		const result = await orchestrate(schema, POKEAPI_ENDPOINT, {
			rootField: "pokemon_v2_pokemon", typeName: "pokemon_v2_pokemon", rootArgs: { limit: 1 },
		}, (pokemon: any) => { pokemon.name.value; pokemon.height.value; });
		expect(result.query).toContain("name");
		expect((result.rawData as any[])[0].name).toBe("bulbasaur");
	});

	it("caches access patterns", async () => {
		schema ??= await fetchSchema(POKEAPI_ENDPOINT);
		await orchestrate(schema, POKEAPI_ENDPOINT, {
			rootField: "pokemon_v2_pokemon", typeName: "pokemon_v2_pokemon", rootArgs: { limit: 1 },
		}, (pokemon: any) => { pokemon.name.value; pokemon.id.value; }, "test-key");
		expect(getPatternCache().has("test-key")).toBe(true);

		const result2 = await orchestrate(schema, POKEAPI_ENDPOINT, {
			rootField: "pokemon_v2_pokemon", typeName: "pokemon_v2_pokemon", rootArgs: { limit: 1 },
		}, () => {}, "test-key");
		expect(result2.query).toContain("name");
		expect(result2.query).toContain("id");
	});

	it("deep traversal", async () => {
		schema ??= await fetchSchema(POKEAPI_ENDPOINT);
		const result = await orchestrate(schema, POKEAPI_ENDPOINT, {
			rootField: "pokemon_v2_pokemon", typeName: "pokemon_v2_pokemon", rootArgs: { limit: 1 },
		}, (pokemon: any) => {
			pokemon.name.value;
			pokemon.pokemon_v2_pokemonspecy.pokemon_v2_generation.name.value;
		});
		expect(result.query).toContain("pokemon_v2_pokemonspecy");
		const data = (result.rawData as any[])[0];
		expect(data.pokemon_v2_pokemonspecy.pokemon_v2_generation.name).toBe("generation-i");
	});
});
