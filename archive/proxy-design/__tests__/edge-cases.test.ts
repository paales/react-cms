import { describe, expect, it } from "vitest"
import { AccessRecorder } from "../access-recorder.ts"
import { createProxy } from "../proxy-node.ts"
import { compileQuery, raw } from "../query-compiler.ts"
import { SchemaGraph, type SchemaObjectType } from "../schema.ts"

function createTestSchema(): SchemaGraph {
  const types: SchemaObjectType[] = [
    {
      name: "Pokemon",
      fields: [
        {
          name: "id",
          type: {
            kind: "NON_NULL",
            name: null,
            ofType: { kind: "SCALAR", name: "Int", ofType: null },
          },
          args: [],
        },
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
        {
          name: "is_legendary",
          type: { kind: "SCALAR", name: "Boolean", ofType: null },
          args: [],
        },
        {
          name: "base_experience",
          type: { kind: "SCALAR", name: "Int", ofType: null },
          args: [],
        },
        {
          name: "sprites",
          type: { kind: "OBJECT", name: "Sprites", ofType: null },
          args: [],
        },
        {
          name: "types",
          type: {
            kind: "LIST",
            name: null,
            ofType: { kind: "OBJECT", name: "PokemonType", ofType: null },
          },
          args: [],
        },
        {
          name: "abilities",
          type: {
            kind: "LIST",
            name: null,
            ofType: { kind: "OBJECT", name: "Ability", ofType: null },
          },
          args: [],
        },
        {
          name: "species",
          type: { kind: "OBJECT", name: "Species", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Sprites",
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
    {
      name: "Ability",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
        {
          name: "is_hidden",
          type: { kind: "SCALAR", name: "Boolean", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Species",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
        {
          name: "generation",
          type: { kind: "OBJECT", name: "Generation", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Generation",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
      ],
    },
  ]
  return new SchemaGraph(types)
}

describe("Edge cases — conditional access", () => {
  const schema = createTestSchema()

  it("only records accessed branches", () => {
    const recorder = new AccessRecorder()
    const pokemon = createProxy(schema, "Pokemon", recorder, {
      is_legendary: false,
      base_experience: 64,
      name: "bulbasaur",
    }) as any
    pokemon.name.value
    if (pokemon.is_legendary.value) pokemon.base_experience.value
    const fields = recorder.getAccessTree().map((n) => n.field)
    expect(fields).toContain("name")
    expect(fields).not.toContain("base_experience")
  })

  it("phantom discovers through true-mock branches", () => {
    const recorder = new AccessRecorder()
    const phantom = createProxy(schema, "Pokemon", recorder) as any
    phantom.name.value
    if (phantom.is_legendary.value) phantom.base_experience.value
    expect(recorder.getAccessTree().map((n) => n.field)).toContain("base_experience")
  })
})

describe("Edge cases — array operations", () => {
  const schema = createTestSchema()
  const data = {
    types: [
      { slot: 1, type: { name: "grass" } },
      { slot: 2, type: { name: "poison" } },
    ],
    abilities: [
      { name: "overgrow", is_hidden: false },
      { name: "chlorophyll", is_hidden: true },
    ],
  }

  it(".find()", () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), data) as any
    expect(pokemon.abilities.find((a: any) => a.is_hidden.value === true).name.value).toBe(
      "chlorophyll",
    )
  })

  it(".filter()", () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), data) as any
    const visible = pokemon.abilities.filter((a: any) => !a.is_hidden.value)
    expect(visible).toHaveLength(1)
    expect(visible[0].name.value).toBe("overgrow")
  })

  it(".at()", () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), data) as any
    expect(pokemon.types.at(0).type.name.value).toBe("grass")
    expect(pokemon.types.at(-1).type.name.value).toBe("poison")
  })

  it("nested arrays in discovery", () => {
    const phantom = createProxy(schema, "Pokemon", new AccessRecorder()) as any
    const recorder = new AccessRecorder()
    const p = createProxy(schema, "Pokemon", recorder) as any
    p.types.map((t: any) => {
      t.slot.value
      t.type.name.value
    })
    p.abilities.map((a: any) => {
      a.name.value
      a.is_hidden.value
    })
    const query = compileQuery(recorder.getAccessTree(), "pokemon")
    expect(query).toContain("slot")
    expect(query).toContain("type {")
    expect(query).toContain("is_hidden")
  })
})

describe("Edge cases — deep traversal", () => {
  it("3-level deep", () => {
    const schema = createTestSchema()
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), {
      species: { name: "bulbasaur", generation: { name: "generation-i" } },
    }) as any
    expect(pokemon.species.generation.name.value).toBe("generation-i")
  })
})

describe("Edge cases — raw() expressions", () => {
  it("passes raw without quotes", () => {
    const query = compileQuery([{ field: "name", children: [] }], "pokemon", {
      where: raw("{id: {_eq: 25}}"),
      order_by: raw("{name: asc}"),
    })
    expect(query).toContain("where: {id: {_eq: 25}}")
    expect(query).toContain("order_by: {name: asc}")
  })

  it("handles nested object args", () => {
    const query = compileQuery([{ field: "name", children: [] }], "pokemon", {
      where: { id: { _eq: 25 } },
    })
    expect(query).toContain("where: {id: {_eq: 25}}")
  })
})

describe("Edge cases — partial merging", () => {
  const schema = createTestSchema()

  it("merges patterns from multiple partials", () => {
    const recorder = new AccessRecorder()
    const phantom = createProxy(schema, "Pokemon", recorder) as any
    phantom.name.value
    phantom.sprites.front_default.value
    phantom.types.map((t: any) => t.type.name.value)
    phantom.species.generation.name.value
    const query = compileQuery(recorder.getAccessTree(), "pokemon")
    expect(query).toContain("sprites {")
    expect(query).toContain("types {")
    expect(query).toContain("species {")
    expect(query).toContain("generation {")
  })

  it("deduplicates", () => {
    const recorder = new AccessRecorder()
    const phantom = createProxy(schema, "Pokemon", recorder) as any
    phantom.name.value
    phantom.sprites.front_default.value
    phantom.name.value
    phantom.sprites.back_default.value
    const tree = recorder.getAccessTree()
    expect(tree.filter((n) => n.field === "name")).toHaveLength(1)
    expect(tree.find((n) => n.field === "sprites")?.children).toHaveLength(2)
  })
})

describe("Edge cases — thenable/use()", () => {
  const schema = createTestSchema()

  it("use(pokemon) resolves to full data", async () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), {
      name: "pikachu",
      id: 25,
    }) as any
    expect(await pokemon).toEqual({ name: "pikachu", id: 25 })
  })

  it("use(pokemon.name) resolves to scalar", async () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), {
      name: "pikachu",
    }) as any
    expect(await pokemon.name).toBe("pikachu")
  })

  it("use(pokemon.species) resolves to nested object", async () => {
    const pokemon = createProxy(schema, "Pokemon", new AccessRecorder(), {
      species: { name: "pikachu", generation: { name: "gen-1" } },
    }) as any
    expect(await pokemon.species).toEqual({
      name: "pikachu",
      generation: { name: "gen-1" },
    })
  })
})
