import { describe, expect, it } from "vitest";
import { AccessRecorder } from "../access-recorder.js";
import { createProxy } from "../proxy-node.js";
import { compileQuery } from "../query-compiler.js";
import { SchemaGraph, type SchemaObjectType } from "../schema.js";

function createTestSchema(): SchemaGraph {
	const types: SchemaObjectType[] = [
		{
			name: "Pokemon",
			fields: [
				{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Int", ofType: null } }, args: [] },
				{ name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [] },
				{ name: "height", type: { kind: "SCALAR", name: "Int", ofType: null }, args: [] },
				{ name: "sprites", type: { kind: "OBJECT", name: "PokemonSprites", ofType: null }, args: [] },
				{
					name: "types",
					type: { kind: "NON_NULL", name: null, ofType: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "PokemonType", ofType: null } } },
					args: [],
				},
			],
		},
		{
			name: "PokemonSprites",
			fields: [
				{ name: "front_default", type: { kind: "SCALAR", name: "String", ofType: null }, args: [] },
				{ name: "back_default", type: { kind: "SCALAR", name: "String", ofType: null }, args: [] },
			],
		},
		{
			name: "PokemonType",
			fields: [
				{ name: "slot", type: { kind: "SCALAR", name: "Int", ofType: null }, args: [] },
				{ name: "type", type: { kind: "OBJECT", name: "Type", ofType: null }, args: [] },
			],
		},
		{ name: "Type", fields: [{ name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [] }] },
	];
	return new SchemaGraph(types);
}

describe("Proxy — Discovery Mode (no data)", () => {
	const schema = createTestSchema();

	it("records a simple field access", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder) as any;
		pokemon.name;
		const tree = recorder.getAccessTree();
		expect(tree).toHaveLength(1);
		expect(tree[0].field).toBe("name");
	});

	it("records nested field access", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder) as any;
		pokemon.sprites.front_default;
		const tree = recorder.getAccessTree();
		const sprites = tree.find((n) => n.field === "sprites");
		expect(sprites?.children.find((c) => c.field === "front_default")).toBeDefined();
	});

	it("returns mock value via .value", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder) as any;
		expect(pokemon.name.value).toBe("__mock_string__");
		expect(pokemon.id.value).toBe(0);
	});

	it("records accesses through .map on list fields", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder) as any;
		pokemon.types.map((t: any) => t.type.name.value);
		const types = recorder.getAccessTree().find((n) => n.field === "types");
		const typeField = types?.children.find((c) => c.field === "type");
		expect(typeField?.children.find((c) => c.field === "name")).toBeDefined();
	});

	it("is thenable — resolves with .value equivalent", async () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder) as any;
		expect(await pokemon.name).toBe("__mock_string__");
	});
});

describe("Proxy — Data Mode (with data)", () => {
	const schema = createTestSchema();
	const pokemonData = {
		id: 25, name: "pikachu", height: 4,
		sprites: { front_default: "https://example.com/pikachu-front.png", back_default: "https://example.com/pikachu-back.png" },
		types: [{ slot: 1, type: { name: "electric" } }],
	};

	it("returns real data via .value", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		expect(pokemon.name.value).toBe("pikachu");
		expect(pokemon.id.value).toBe(25);
		expect(pokemon.height.value).toBe(4);
	});

	it("returns nested real data via .value", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		expect(pokemon.sprites.front_default.value).toBe("https://example.com/pikachu-front.png");
	});

	it("maps over real array data", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		expect(pokemon.types.map((t: any) => t.type.name.value)).toEqual(["electric"]);
	});

	it("still records accesses in data mode", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		pokemon.name.value;
		pokemon.sprites.front_default.value;
		const tree = recorder.getAccessTree();
		expect(tree.find((n) => n.field === "name")).toBeDefined();
		expect(tree.find((n) => n.field === "sprites")?.children.find((c) => c.field === "front_default")).toBeDefined();
	});

	it("is thenable — resolves with real data", async () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		expect(await pokemon.name).toBe("pikachu");
		expect(await pokemon).toEqual(pokemonData);
	});

	it("supports numeric index access on arrays", () => {
		const recorder = new AccessRecorder();
		const pokemon = createProxy(schema, "Pokemon", recorder, pokemonData) as any;
		expect(pokemon.types[0].type.name.value).toBe("electric");
	});
});

describe("Proxy — Full Flow: discovery → query → data", () => {
	const schema = createTestSchema();

	it("generates a valid query from discovery, then serves data", () => {
		const discoveryRecorder = new AccessRecorder();
		const phantom = createProxy(schema, "Pokemon", discoveryRecorder) as any;
		phantom.name.value;
		phantom.sprites.front_default.value;
		phantom.types.map((t: any) => t.type.name.value);

		const query = compileQuery(discoveryRecorder.getAccessTree(), "pokemon_v2_pokemon", { limit: 1 });
		expect(query).toContain("name");
		expect(query).toContain("sprites");
		expect(query).toContain("front_default");
		expect(query).toContain("types");
		expect(query).toContain("pokemon_v2_pokemon(limit: 1)");

		const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), {
			name: "bulbasaur",
			sprites: { front_default: "https://example.com/bulbasaur.png" },
			types: [{ type: { name: "grass" } }, { type: { name: "poison" } }],
		}) as any;
		expect(pokemon.name.value).toBe("bulbasaur");
		expect(pokemon.types.map((t: any) => t.type.name.value)).toEqual(["grass", "poison"]);
	});
});
