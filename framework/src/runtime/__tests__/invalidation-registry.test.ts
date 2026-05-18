/**
 * Unit tests for the server-side invalidation registry.
 *
 * Locks down selector parsing, constraint subset-matching, the
 * transactional commit/rollback semantics, and the monotonic ts
 * behavior that the fp-fold relies on.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  _flushPendingInvalidations,
  _registryStats,
  parseSelector,
  parseSelectors,
  queryMatchingTs,
  refreshSelector,
  runInvalidationTransaction,
} from "../invalidation-registry.ts"

afterEach(() => {
  _clearInvalidationRegistry()
})

describe("parseSelector", () => {
  it("parses bare names", () => {
    expect(parseSelector("cart")).toEqual({ name: "cart", constraints: {} })
  })

  it("strips leading # and . decorators", () => {
    expect(parseSelector("#cart")).toEqual({ name: "cart", constraints: {} })
    expect(parseSelector(".price")).toEqual({ name: "price", constraints: {} })
  })

  it("parses query-style constraints", () => {
    expect(parseSelector("cart?cart_id=1234")).toEqual({
      name: "cart",
      constraints: { cart_id: "1234" },
    })
  })

  it("parses multi-key constraints", () => {
    expect(parseSelector("price?sku=A&zone=EU")).toEqual({
      name: "price",
      constraints: { sku: "A", zone: "EU" },
    })
  })

  it("URL-decodes constraint values", () => {
    expect(parseSelector("cart?sid=hello%20world")).toEqual({
      name: "cart",
      constraints: { sid: "hello world" },
    })
  })
})

describe("parseSelectors", () => {
  it("splits whitespace-separated tokens", () => {
    const parsed = parseSelectors("cart price#stale .promo")
    expect(parsed.map((p) => p.name)).toEqual(["cart", "price#stale", "promo"])
  })

  it("accepts array form", () => {
    const parsed = parseSelectors(["cart", "price"])
    expect(parsed.map((p) => p.name)).toEqual(["cart", "price"])
  })
})

describe("refreshSelector + queryMatchingTs", () => {
  it("bumps an unconstrained entry; matches every partial with the label", () => {
    refreshSelector("cart")
    expect(queryMatchingTs(["cart"], { cart_id: "1234" })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cart"], { cart_id: "5678" })).toBeGreaterThan(0)
  })

  it("returns 0 when no matching label", () => {
    refreshSelector("cart")
    expect(queryMatchingTs(["price"], { cart_id: "1234" })).toBe(0)
  })

  it("constrained entries only match partials whose vary inputs satisfy the subset", () => {
    refreshSelector("cart?cart_id=1234")
    expect(queryMatchingTs(["cart"], { cart_id: "1234" })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cart"], { cart_id: "5678" })).toBe(0)
  })

  it("constraints are key-subset — extra vary keys are fine", () => {
    refreshSelector("cart?cart_id=1234")
    expect(queryMatchingTs(["cart"], { cart_id: "1234", session: "abc" })).toBeGreaterThan(0)
  })

  it("ts is monotonic across bumps; latest wins", () => {
    refreshSelector("cart")
    const ts1 = queryMatchingTs(["cart"], null)
    refreshSelector("cart")
    const ts2 = queryMatchingTs(["cart"], null)
    expect(ts2).toBeGreaterThan(ts1)
  })

  it("multiple labels return the max matching ts across them", () => {
    refreshSelector("a")
    refreshSelector("b")
    const ts1 = queryMatchingTs(["a"], null)
    const ts2 = queryMatchingTs(["b"], null)
    expect(queryMatchingTs(["a", "b"], null)).toBe(Math.max(ts1, ts2))
  })

  it("null vary inputs: unconstrained entries match, constrained do not", () => {
    refreshSelector("cart")
    refreshSelector("price?sku=A")
    expect(queryMatchingTs(["cart"], null)).toBeGreaterThan(0)
    expect(queryMatchingTs(["price"], null)).toBe(0)
  })
})

describe("runInvalidationTransaction", () => {
  it("commits queued bumps on success", async () => {
    expect(queryMatchingTs(["cart"], null)).toBe(0)
    await runInvalidationTransaction(async () => {
      refreshSelector("cart")
      // Inside the transaction, the bump hasn't been applied yet.
      expect(queryMatchingTs(["cart"], null)).toBe(0)
    })
    // After commit, the bump is visible.
    expect(queryMatchingTs(["cart"], null)).toBeGreaterThan(0)
  })

  it("discards queued bumps on throw", async () => {
    expect(queryMatchingTs(["cart"], null)).toBe(0)
    await expect(
      runInvalidationTransaction(async () => {
        refreshSelector("cart")
        throw new Error("action failed")
      }),
    ).rejects.toThrow("action failed")
    expect(queryMatchingTs(["cart"], null)).toBe(0)
  })

  it("nested calls outside any transaction apply immediately", () => {
    refreshSelector("cart")
    expect(queryMatchingTs(["cart"], null)).toBeGreaterThan(0)
  })

  it("_flushPendingInvalidations mid-transaction makes bumps visible without ending tx", async () => {
    await runInvalidationTransaction(async () => {
      refreshSelector("cart")
      expect(queryMatchingTs(["cart"], null)).toBe(0)
      _flushPendingInvalidations()
      expect(queryMatchingTs(["cart"], null)).toBeGreaterThan(0)
    })
  })
})

describe("registry state", () => {
  it("tracks entries by name in the lookup index", () => {
    refreshSelector("cart")
    refreshSelector("cart?cart_id=1")
    refreshSelector("price")
    const stats = _registryStats()
    expect(stats.entries).toBe(3)
    expect(stats.byName).toBe(2) // cart + price
  })
})
