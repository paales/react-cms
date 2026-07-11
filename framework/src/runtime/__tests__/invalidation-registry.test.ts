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
  buildCellSelector,
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

describe("queryMatchingTs — keyed probes match the constraint-subset predicate", () => {
  it("bare entry (empty constraints) matches any surface, including none", () => {
    refreshSelector("cart")
    expect(queryMatchingTs(["cart"], null)).toBeGreaterThan(0)
    expect(queryMatchingTs(["cart"], {})).toBeGreaterThan(0)
    expect(queryMatchingTs(["cart"], { anything: "x" })).toBeGreaterThan(0)
  })

  it("exact constraint match", () => {
    refreshSelector("price?sku=A&zone=EU")
    expect(queryMatchingTs(["price"], { sku: "A", zone: "EU" })).toBeGreaterThan(0)
  })

  it("strict-subset constraints match a wider surface", () => {
    refreshSelector("price?sku=A")
    expect(queryMatchingTs(["price"], { sku: "A", zone: "EU", extra: "y" })).toBeGreaterThan(0)
  })

  it("superset constraints do NOT match a narrower surface", () => {
    refreshSelector("price?sku=A&zone=EU")
    expect(queryMatchingTs(["price"], { sku: "A" })).toBe(0)
  })

  it("a null/undefined surface value satisfies no constraint", () => {
    refreshSelector("price?sku=A")
    expect(queryMatchingTs(["price"], { sku: null })).toBe(0)
    expect(queryMatchingTs(["price"], { sku: undefined })).toBe(0)
  })

  it("string entries match string-loosely: '1' matches both '1' and 1", () => {
    refreshSelector("cell:c?uid=1")
    expect(queryMatchingTs(["cell:c"], { uid: "1" })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:c"], { uid: 1 })).toBeGreaterThan(0)
  })

  it("type-tagged number entries match type-exactly: 1 matches 1, not '1'", () => {
    refreshSelector(buildCellSelector("c", { uid: 1 }))
    expect(queryMatchingTs(["cell:c"], { uid: 1 })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:c"], { uid: "1" })).toBe(0)
  })

  it("type-tagged boolean and null entries keep their identity", () => {
    refreshSelector(buildCellSelector("c", { flag: true }))
    expect(queryMatchingTs(["cell:c"], { flag: true })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:c"], { flag: "true" })).toBe(0)
    expect(queryMatchingTs(["cell:c"], { flag: false })).toBe(0)
    // A null constraint is unsatisfiable — the surface value would have
    // to be non-null AND stringify to `null`.
    refreshSelector(buildCellSelector("d", { v: null }))
    expect(queryMatchingTs(["cell:d"], { v: null })).toBe(0)
    expect(queryMatchingTs(["cell:d"], { v: "null" })).toBe(0)
  })

  it("only the queried partition's ts is returned among many entries", () => {
    // 64 partitions of one name — the per-name map the probes index into.
    for (let i = 0; i < 64; i++) {
      refreshSelector(buildCellSelector("world.pulse", { cx: i, cy: -i }))
    }
    const hit = queryMatchingTs(["cell:world.pulse"], { cx: 7, cy: -7 })
    expect(hit).toBeGreaterThan(0)
    // Bump a DIFFERENT partition — the queried one's ts must not move.
    refreshSelector(buildCellSelector("world.pulse", { cx: 8, cy: -8 }))
    expect(queryMatchingTs(["cell:world.pulse"], { cx: 7, cy: -7 })).toBe(hit)
    expect(queryMatchingTs(["cell:world.pulse"], { cx: 99, cy: 1 })).toBe(0)
  })

  it("a surface wider than the probe cap falls back to the scan with identical results", () => {
    refreshSelector("price?sku=A")
    refreshSelector(buildCellSelector("c", { uid: 1 }))
    // 8 non-null keys — past PROBE_SUBSET_CAP, so the query linear-scans.
    const wide = { sku: "A", a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }
    expect(queryMatchingTs(["price"], wide)).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:c"], { ...wide, uid: 1 })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:c"], { ...wide, uid: "1" })).toBe(0)
    expect(queryMatchingTs(["price"], { ...wide, sku: "B" })).toBe(0)
  })

  it("null-valued keys don't count toward the probe cap", () => {
    refreshSelector("price?sku=A")
    // 6 non-null keys + null-valued padding stays on the probe path.
    const surface = { sku: "A", a: 1, b: 2, c: 3, d: 4, e: 5, x: null, y: null, z: null }
    expect(queryMatchingTs(["price"], surface)).toBeGreaterThan(0)
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

  it("nested calls participate in the outer transaction (one commit, batched)", async () => {
    // App-level wrapper batches two cell writes. Each cell.set internally
    // calls runInvalidationTransaction; with nesting, those inner calls
    // join the outer tx and all four refreshSelector bumps flush together
    // at the outer commit — so the segment driver wakes once, not twice.
    await runInvalidationTransaction(async () => {
      await runInvalidationTransaction(async () => {
        refreshSelector("cell:a")
        refreshSelector("cell:b")
      })
      await runInvalidationTransaction(async () => {
        refreshSelector("cell:c")
      })
      // Mid-outer, nothing has committed yet.
      expect(queryMatchingTs(["cell:a"], null)).toBe(0)
      expect(queryMatchingTs(["cell:b"], null)).toBe(0)
      expect(queryMatchingTs(["cell:c"], null)).toBe(0)
    })
    // After outer commit, all three are visible with the same ts cohort.
    const tsA = queryMatchingTs(["cell:a"], null)
    const tsB = queryMatchingTs(["cell:b"], null)
    const tsC = queryMatchingTs(["cell:c"], null)
    expect(tsA).toBeGreaterThan(0)
    expect(tsB).toBeGreaterThan(0)
    expect(tsC).toBeGreaterThan(0)
  })

  it("nested throw discards pending in the outer tx", async () => {
    await expect(
      runInvalidationTransaction(async () => {
        refreshSelector("outer")
        await runInvalidationTransaction(async () => {
          refreshSelector("inner")
        })
        throw new Error("oops")
      }),
    ).rejects.toThrow("oops")
    // Neither outer nor inner bumps reached the registry.
    expect(queryMatchingTs(["outer"], null)).toBe(0)
    expect(queryMatchingTs(["inner"], null)).toBe(0)
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
