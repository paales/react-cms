import { describe, expect, it } from "vitest";
import { AccessRecorder } from "../access-recorder.js";
import { createProxy } from "../proxy-node.js";
import { compileQuery } from "../query-compiler.js";
import { fetchSchema } from "../schema.js";

const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta";

describe("Integration: PokeAPI full flow", { timeout: 15000 }, () => {
	it("introspects the schema", async () => {
		const schema = await fetchSchema(POKEAPI_ENDPOINT);
		expect(schema.getType("pokemon_v2_pokemon")).toBeDefined();
		expect(schema.isLeaf("pokemon_v2_pokemon", "name")).toBe(true);
	});

	it("discovers, compiles, fetches, and serves data", async () => {
		const schema = await fetchSchema(POKEAPI_ENDPOINT);
		const recorder = new AccessRecorder();
		const phantom = createProxy(schema, "pokemon_v2_pokemon", recorder) as any;
		phantom.name.value;
		phantom.height.value;
		phantom.pokemon_v2_pokemontypes.map((t: any) => t.pokemon_v2_type.name.value);

		const query = compileQuery(recorder.getAccessTree(), "pokemon_v2_pokemon", { limit: 2 });
		const response = await fetch(POKEAPI_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});
		const json = (await response.json()) as { data: { pokemon_v2_pokemon: any[] }; errors?: any[] };
		expect(json.errors).toBeUndefined();
		expect(json.data.pokemon_v2_pokemon).toHaveLength(2);

		const proxy = createProxy(schema, "pokemon_v2_pokemon", new AccessRecorder(), json.data.pokemon_v2_pokemon[0]) as any;
		expect(proxy.name.value).toBe("bulbasaur");
		expect(typeof proxy.height.value).toBe("number");
		expect(proxy.pokemon_v2_pokemontypes.map((t: any) => t.pokemon_v2_type.name.value)).toContain("grass");
	});

	it("handles deep traversal", async () => {
		const schema = await fetchSchema(POKEAPI_ENDPOINT);
		const recorder = new AccessRecorder();
		const phantom = createProxy(schema, "pokemon_v2_pokemon", recorder) as any;
		phantom.name.value;
		phantom.pokemon_v2_pokemonspecy.pokemon_v2_generation.name.value;

		const query = compileQuery(recorder.getAccessTree(), "pokemon_v2_pokemon", { limit: 1 });
		const response = await fetch(POKEAPI_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});
		const json = (await response.json()) as { data: { pokemon_v2_pokemon: any[] } };
		const proxy = createProxy(schema, "pokemon_v2_pokemon", new AccessRecorder(), json.data.pokemon_v2_pokemon[0]) as any;
		expect(proxy.name.value).toBe("bulbasaur");
		expect(proxy.pokemon_v2_pokemonspecy.pokemon_v2_generation.name.value).toBe("generation-i");
	});

	it("proxy is thenable (use() compatible)", async () => {
		const schema = await fetchSchema(POKEAPI_ENDPOINT);
		const recorder = new AccessRecorder();
		const phantom = createProxy(schema, "pokemon_v2_pokemon", recorder) as any;
		expect(await phantom.name).toBe("__mock_string__");

		phantom.name.value;
		const query = compileQuery(recorder.getAccessTree(), "pokemon_v2_pokemon", { limit: 1 });
		const response = await fetch(POKEAPI_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});
		const json = (await response.json()) as { data: { pokemon_v2_pokemon: any[] } };
		const pokemon = createProxy(schema, "pokemon_v2_pokemon", new AccessRecorder(), json.data.pokemon_v2_pokemon[0]) as any;
		expect(await pokemon.name).toBe("bulbasaur");
		expect(await pokemon).toHaveProperty("name", "bulbasaur");
	});

	it("simulates component render", async () => {
		const schema = await fetchSchema(POKEAPI_ENDPOINT);
		function PokemonCard(pokemon: any) {
			return {
				name: pokemon.name.value,
				height: pokemon.height.value,
				types: pokemon.pokemon_v2_pokemontypes.map((t: any) => t.pokemon_v2_type.name.value),
			};
		}

		const recorder = new AccessRecorder();
		const phantom = createProxy(schema, "pokemon_v2_pokemon", recorder) as any;
		expect(PokemonCard(phantom).name).toBe("__mock_string__");

		const query = compileQuery(recorder.getAccessTree(), "pokemon_v2_pokemon", { limit: 1 });
		const response = await fetch(POKEAPI_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});
		const json = (await response.json()) as { data: { pokemon_v2_pokemon: any[] } };
		const real = PokemonCard(createProxy(schema, "pokemon_v2_pokemon", new AccessRecorder(), json.data.pokemon_v2_pokemon[0]));
		expect(real.name).toBe("bulbasaur");
		expect(real.types).toContain("grass");
	});
});
