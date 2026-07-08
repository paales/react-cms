/**
 * fragmentCell(doc) — id derivation, key-default-to-id + validation,
 * value→partition keyOf, and auto-hydration from a query result.
 */

import { graphql as tada } from "gql.tada"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  fragmentCell,
  hydrateFragmentsFromResult,
  spreadSitesOf,
  _clearFragmentCellRegistry,
} from "../cell-gql.ts"
import { _clearCellRegistry, resolveCellValue } from "../cell.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"

const graphql = tada

beforeEach(() => {
  _clearCellRegistry()
  _clearFragmentCellRegistry()
})
afterEach(() => {
  _clearCellRegistry()
  _clearFragmentCellRegistry()
})

describe("fragmentCell — construction", () => {
  it("derives a kebab id from the fragment name", () => {
    const cell = fragmentCell(
      graphql(`
        fragment CartLine on CartItem {
          uid
        }
      `),
      {
        key: (d) => ({ uid: (d as { uid: string }).uid }),
      },
    )
    expect(cell.id).toBe("cart-line")
  })

  it("defaults key to {id} when the fragment selects id", () => {
    const cell = fragmentCell(
      graphql(`
        fragment Hero on Pokemon {
          id
          name
        }
      `),
    )
    expect(cell.keyOf!({ id: 42, name: "pikachu" } as never)).toEqual({ id: 42 })
  })

  it("throws when no id is selected and no key is given", () => {
    expect(() =>
      fragmentCell(
        graphql(`
          fragment CartLine on CartItem {
            uid
            quantity
          }
        `),
      ),
    ).toThrow(/no `id` field is selected and no `key`/)
  })

  it("uses an explicit key over the id default", () => {
    const cell = fragmentCell(
      graphql(`
        fragment CartLine on CartItem {
          uid
        }
      `),
      {
        key: (d) => ({ uid: (d as { uid: string }).uid }),
      },
    )
    expect(cell.keyOf!({ uid: "abc" } as never)).toEqual({ uid: "abc" })
  })

  it("keyOf throws on a null value", () => {
    const cell = fragmentCell(
      graphql(`
        fragment Hero on Pokemon {
          id
        }
      `),
    )
    expect(() => cell.keyOf!(null)).toThrow(/null value/)
  })
})

describe("spreadSitesOf — query AST analysis", () => {
  it("finds spreads with their result path and @defer flag", () => {
    const q = graphql(`
      query Cart($id: String!) {
        cart(cart_id: $id) {
          items {
            uid
            ...CartLine
          }
          extras {
            ...Slow @defer
          }
        }
      }
    `)
    const sites = spreadSitesOf(q)
    expect(sites).toEqual(
      expect.arrayContaining([
        { path: ["cart", "items"], fragName: "CartLine", deferred: false },
        { path: ["cart", "extras"], fragName: "Slow", deferred: true },
      ]),
    )
  })

  it("uses field aliases for the path", () => {
    const q = graphql(`
      query Q {
        box: cart {
          rows: items {
            ...CartLine
          }
        }
      }
    `)
    expect(spreadSitesOf(q)[0]).toEqual({
      path: ["box", "rows"],
      fragName: "CartLine",
      deferred: false,
    })
  })
})

describe("auto-hydration — walk a result, populate keyed partitions", () => {
  it("hydrates every matching node into its keyed partition", async () => {
    await runWithRequestAsync(new Request("http://t/"), async () => {
      const cartLine = fragmentCell(
        graphql(`
          fragment CartLine on CartItem {
            uid
            quantity
          }
        `),
        {
          key: (d) => ({ uid: (d as { uid: string }).uid }),
        },
      )
      const query = graphql(`
        query Cart($id: String!) {
          cart(cart_id: $id) {
            items {
              uid
              quantity
              ...CartLine
            }
          }
        }
      `)
      const result = {
        cart: {
          items: [
            { uid: "a", quantity: 1 },
            { uid: "b", quantity: 3 },
          ],
        },
      }
      hydrateFragmentsFromResult(query, result)

      expect(await resolveCellValue(cartLine, { uid: "a" })).toEqual({ uid: "a", quantity: 1 })
      expect(await resolveCellValue(cartLine, { uid: "b" })).toEqual({ uid: "b", quantity: 3 })
      // a partition never seen stays at the default (null).
      expect(await resolveCellValue(cartLine, { uid: "c" })).toBeNull()
    })
  })

  it("skips deferred spreads (those stream in via the loader)", async () => {
    await runWithRequestAsync(new Request("http://t/"), async () => {
      const slow = fragmentCell(
        graphql(`
          fragment Slow on CartItem {
            uid
            detail
          }
        `),
        {
          key: (d) => ({ uid: (d as { uid: string }).uid }),
        },
      )
      const query = graphql(`
        query Cart($id: String!) {
          cart(cart_id: $id) {
            items {
              uid
              ...Slow @defer
            }
          }
        }
      `)
      hydrateFragmentsFromResult(query, {
        cart: { items: [{ uid: "a", detail: "x" }] },
      })
      // Deferred → NOT hydrated synchronously.
      expect(await resolveCellValue(slow, { uid: "a" })).toBeNull()
    })
  })
})
