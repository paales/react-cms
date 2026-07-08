/**
 * gqlCell / gqlCellBuilder — auto-id derivation, prefix namespacing,
 * anonymous-operation guard, and loader wiring.
 */

import { graphql as tada } from "gql.tada"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { gqlCell, gqlCellBuilder, type GqlClient } from "../cell-gql.ts"
import { _clearCellRegistry, getCellById } from "../cell.ts"

// Schemaless gql.tada tag — parses to a real AST; typing is irrelevant
// for these runtime assertions.
const graphql = tada

function fakeClient(result: unknown): GqlClient & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    request: (async (doc: unknown, vars: unknown) => {
      calls.push([doc, vars])
      return result
    }) as GqlClient["request"],
  }
}

beforeEach(() => {
  _clearCellRegistry()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("gqlCell — doc mode", () => {
  it("derives a kebab-case id from the operation name", () => {
    const doc = graphql(`
      query PokemonHero($id: Int!) {
        foo
      }
    `)
    const cell = gqlCell(fakeClient(null), doc)
    expect(cell.id).toBe("pokemon-hero")
    expect(getCellById("pokemon-hero")).toBe(cell)
  })

  it("namespaces the id with a prefix", () => {
    const doc = graphql(`
      query Products($pageSize: Int!) {
        foo
      }
    `)
    const cell = gqlCell(fakeClient(null), doc, { prefix: "magento" })
    expect(cell.id).toBe("magento.products")
  })

  it("honours an explicit id override", () => {
    const doc =
      graphql(`
        query Whatever {
          foo
        }
      `)
    const cell = gqlCell(fakeClient(null), doc, { id: "custom.id" })
    expect(cell.id).toBe("custom.id")
  })

  it("throws on an anonymous operation with no explicit id", () => {
    const doc =
      graphql(`
        query {
          foo
        }
      `)
    expect(() => gqlCell(fakeClient(null), doc)).toThrow(/anonymous operation/)
  })

  it("runs the query via the client when the loader fires", async () => {
    const doc = graphql(`
      query PokemonStats($id: Int!) {
        foo
      }
    `)
    const client = fakeClient({ ok: true })
    const cell = gqlCell(client, doc)
    const out = await cell.load!({ id: 7 })
    expect(out).toEqual({ ok: true })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.[0]).toBe(doc)
    expect(client.calls[0]?.[1]).toEqual({ id: 7 })
  })
})

describe("gqlCellBuilder — per-backend constructor", () => {
  it("binds client + prefix and builds from a query string", () => {
    const client = fakeClient(null)
    const make = gqlCellBuilder({
      client,
      // schemaless tag stands in for a schema-bound one at runtime
      graphql: graphql as never,
      prefix: "magento",
    })
    const cell = make.query(`query CartWithItems($cartId: String!) { foo }`)
    expect(cell.id).toBe("magento.cart-with-items")
  })

  it("builds un-prefixed ids when no prefix is given", () => {
    const make = gqlCellBuilder({ client: fakeClient(null), graphql: graphql as never })
    const cell = make.query(`query PokemonList($limit: Int!) { foo }`)
    expect(cell.id).toBe("pokemon-list")
  })

  it("a built cell binds args into a partitioned BoundCell", () => {
    const make = gqlCellBuilder({ client: fakeClient(null), graphql: graphql as never })
    const cell = make.query(`query PokemonHero($id: Int!) { foo }`)
    const bound = cell.with({ id: 25 } as never)
    expect(bound.__boundCell).toBe(true)
    expect(bound.cellId).toBe("pokemon-hero")
    expect(bound.args).toEqual({ id: 25 })
  })
})
