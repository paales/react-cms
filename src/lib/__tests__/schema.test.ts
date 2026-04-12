import { describe, expect, it } from "vitest";
import { SchemaGraph, type SchemaObjectType } from "../schema.js";

function createTestSchema(): SchemaGraph {
	const types: SchemaObjectType[] = [
		{
			name: "Pokemon",
			fields: [
				{
					name: "id",
					type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Int", ofType: null } },
					args: [],
				},
				{
					name: "name",
					type: { kind: "SCALAR", name: "String", ofType: null },
					args: [],
				},
				{
					name: "sprites",
					type: { kind: "OBJECT", name: "PokemonSprites", ofType: null },
					args: [],
				},
				{
					name: "types",
					type: {
						kind: "NON_NULL",
						name: null,
						ofType: {
							kind: "LIST",
							name: null,
							ofType: { kind: "OBJECT", name: "PokemonType", ofType: null },
						},
					},
					args: [],
				},
			],
		},
		{
			name: "PokemonSprites",
			fields: [
				{
					name: "front_default",
					type: { kind: "SCALAR", name: "String", ofType: null },
					args: [],
				},
				{
					name: "back_default",
					type: { kind: "SCALAR", name: "String", ofType: null },
					args: [],
				},
			],
		},
		{
			name: "PokemonType",
			fields: [
				{
					name: "slot",
					type: { kind: "SCALAR", name: "Int", ofType: null },
					args: [],
				},
				{
					name: "type",
					type: { kind: "OBJECT", name: "Type", ofType: null },
					args: [],
				},
			],
		},
		{
			name: "Type",
			fields: [
				{
					name: "name",
					type: { kind: "SCALAR", name: "String", ofType: null },
					args: [],
				},
			],
		},
	];

	return new SchemaGraph(types);
}

describe("SchemaGraph", () => {
	const schema = createTestSchema();

	it("looks up a type by name", () => {
		const type = schema.getType("Pokemon");
		expect(type).toBeDefined();
		expect(type?.name).toBe("Pokemon");
		expect(type?.fields).toHaveLength(4);
	});

	it("returns undefined for unknown types", () => {
		expect(schema.getType("Nonexistent")).toBeUndefined();
	});

	it("looks up a field on a type", () => {
		const field = schema.getField("Pokemon", "name");
		expect(field).toBeDefined();
		expect(field?.name).toBe("name");
	});

	it("unwraps NON_NULL to the inner type", () => {
		const fieldType = schema.getFieldType("Pokemon", "id");
		expect(fieldType).toEqual({ name: "Int", kind: "SCALAR", isList: false });
	});

	it("unwraps NON_NULL > LIST to detect list", () => {
		const fieldType = schema.getFieldType("Pokemon", "types");
		expect(fieldType).toEqual({ name: "PokemonType", kind: "OBJECT", isList: true });
	});

	it("identifies scalars as leaves", () => {
		expect(schema.isLeaf("Pokemon", "name")).toBe(true);
		expect(schema.isLeaf("Pokemon", "id")).toBe(true);
	});

	it("identifies objects as non-leaves", () => {
		expect(schema.isLeaf("Pokemon", "sprites")).toBe(false);
		expect(schema.isLeaf("Pokemon", "types")).toBe(false);
	});

	it("identifies list fields", () => {
		expect(schema.isList("Pokemon", "types")).toBe(true);
		expect(schema.isList("Pokemon", "name")).toBe(false);
	});

	it("returns mock values for scalar types", () => {
		expect(schema.getMockValue("String")).toBe("__mock_string__");
		expect(schema.getMockValue("Int")).toBe(0);
		expect(schema.getMockValue("Boolean")).toBe(true);
		expect(schema.getMockValue("ID")).toBe("__mock_id__");
	});
});
