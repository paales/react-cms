import { describe, expect, it } from "vitest"
import type { AccessPath } from "../access-recorder.js"
import { compileQuery, compileSelectionSet } from "../query-compiler.js"

describe("compileSelectionSet", () => {
  it("compiles flat fields", () => {
    const tree: AccessPath[] = [
      { field: "name", children: [] },
      { field: "id", children: [] },
    ]
    expect(compileSelectionSet(tree)).toBe("name\nid")
  })

  it("compiles nested fields with __typename", () => {
    const tree: AccessPath[] = [
      {
        field: "sprites",
        children: [
          { field: "front_default", children: [] },
          { field: "back_default", children: [] },
        ],
      },
    ]
    expect(compileSelectionSet(tree)).toBe(
      "sprites {\n  __typename\n  front_default\n  back_default\n}",
    )
  })

  it("compiles deeply nested fields with __typename at each level", () => {
    const tree: AccessPath[] = [
      {
        field: "species",
        children: [
          {
            field: "generation",
            children: [{ field: "name", children: [] }],
          },
        ],
      },
    ]
    expect(compileSelectionSet(tree)).toBe(
      "species {\n  __typename\n  generation {\n    __typename\n    name\n  }\n}",
    )
  })

  it("compiles fields with arguments", () => {
    const tree: AccessPath[] = [
      {
        field: "pokemon",
        args: { limit: 10, offset: 0 },
        children: [{ field: "name", children: [] }],
      },
    ]
    expect(compileSelectionSet(tree)).toBe(
      "pokemon(limit: 10, offset: 0) {\n  __typename\n  name\n}",
    )
  })

  it("compiles string arguments with quotes", () => {
    const tree: AccessPath[] = [
      {
        field: "pokemon",
        args: { name: "pikachu" },
        children: [{ field: "id", children: [] }],
      },
    ]
    expect(compileSelectionSet(tree)).toBe('pokemon(name: "pikachu") {\n  __typename\n  id\n}')
  })
})

describe("compileQuery", () => {
  it("wraps selection in query block", () => {
    const tree: AccessPath[] = [{ field: "name", children: [] }]
    expect(compileQuery(tree)).toBe("query {\n  __typename\n  name\n}")
  })

  it("wraps in root field with args", () => {
    const tree: AccessPath[] = [
      { field: "name", children: [] },
      { field: "id", children: [] },
    ]
    expect(compileQuery(tree, "pokemon_v2_pokemon", { limit: 1 })).toBe(
      "query {\n  pokemon_v2_pokemon(limit: 1) {\n    __typename\n    name\n    id\n  }\n}",
    )
  })

  it("compiles mixed flat and nested fields", () => {
    const tree: AccessPath[] = [
      { field: "name", children: [] },
      {
        field: "sprites",
        children: [{ field: "front_default", children: [] }],
      },
      {
        field: "types",
        children: [
          {
            field: "type",
            children: [{ field: "name", children: [] }],
          },
        ],
      },
    ]
    const result = compileQuery(tree, "pokemon_v2_pokemon")
    expect(result).toBe(
      [
        "query {",
        "  pokemon_v2_pokemon {",
        "    __typename",
        "    name",
        "    sprites {",
        "      __typename",
        "      front_default",
        "    }",
        "    types {",
        "      __typename",
        "      type {",
        "        __typename",
        "        name",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    )
  })
})
