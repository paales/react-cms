import { describe, expect, it } from "vitest"
import { stableStringify } from "../stable-stringify.ts"

/**
 * Properties covered:
 *  - key-order independence at every nesting level
 *  - distinct encodings for primitives JSON conflates
 *    (undefined / NaN / Infinity / -0 / BigInt)
 *  - Date round-trip via ms timestamp
 *  - Set / Map normalization (so they don't all serialize to "{}")
 *  - circular reference detection (terminates with a sentinel
 *    instead of recursing)
 *  - non-serializable values produce a stable sentinel rather than
 *    being silently dropped
 */

describe("stableStringify", () => {
  it("is independent of object key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    expect(stableStringify({ x: { a: 1, b: 2 } })).toBe(stableStringify({ x: { b: 2, a: 1 } }))
  })

  it("preserves array order", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it("distinguishes undefined from null and from missing", () => {
    expect(stableStringify(undefined)).not.toBe(stableStringify(null))
    expect(stableStringify({ a: undefined })).not.toBe(stableStringify({}))
    expect(stableStringify({ a: null })).not.toBe(stableStringify({ a: undefined }))
  })

  it("distinguishes NaN, +Infinity, -Infinity, and null", () => {
    const nan = stableStringify(Number.NaN)
    const pinf = stableStringify(Number.POSITIVE_INFINITY)
    const ninf = stableStringify(Number.NEGATIVE_INFINITY)
    const nul = stableStringify(null)
    const set = new Set([nan, pinf, ninf, nul])
    expect(set.size).toBe(4)
  })

  it("distinguishes -0 from +0", () => {
    expect(stableStringify(0)).not.toBe(stableStringify(-0))
  })

  it("encodes BigInt rather than throwing", () => {
    expect(stableStringify(123n)).toBe("<bigint:123>")
    expect(stableStringify({ n: 1n })).toContain("<bigint:1>")
    expect(stableStringify(123n)).not.toBe(stableStringify(124n))
  })

  it("encodes Date by its ms timestamp", () => {
    const d1 = new Date(1_700_000_000_000)
    const d2 = new Date(1_700_000_000_000)
    const d3 = new Date(1_700_000_000_001)
    expect(stableStringify(d1)).toBe(stableStringify(d2))
    expect(stableStringify(d1)).not.toBe(stableStringify(d3))
    expect(stableStringify(d1)).toBe("<date:1700000000000>")
  })

  it("normalizes Set membership independent of insertion order", () => {
    const a = new Set([1, 2, 3])
    const b = new Set([3, 1, 2])
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(stableStringify(new Set([1, 2]))).not.toBe(stableStringify(new Set([1, 2, 3])))
  })

  it("does not collapse different Sets to the same string", () => {
    // The previous impl returned "{}" for every Set.
    expect(stableStringify(new Set([1]))).not.toBe(stableStringify(new Set([2])))
    expect(stableStringify(new Set())).not.toBe(stableStringify(new Set([1])))
  })

  it("normalizes Map entries by serialized key, distinguishes content", () => {
    const a = new Map<string, number>()
    a.set("x", 1)
    a.set("y", 2)
    const b = new Map<string, number>()
    b.set("y", 2)
    b.set("x", 1)
    expect(stableStringify(a)).toBe(stableStringify(b))

    const c = new Map<string, number>()
    c.set("x", 1)
    c.set("y", 3)
    expect(stableStringify(a)).not.toBe(stableStringify(c))
  })

  it("differentiates Map from a plain object with the same shape", () => {
    const m = new Map<string, number>()
    m.set("a", 1)
    expect(stableStringify(m)).not.toBe(stableStringify({ a: 1 }))
  })

  it("emits <circular> on self-referential structures rather than overflowing", () => {
    const obj: { self?: unknown } = {}
    obj.self = obj
    const out = stableStringify(obj)
    expect(out).toContain("<circular>")
  })

  it("handles mutual circular refs", () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a.b = b
    expect(() => stableStringify(a)).not.toThrow()
  })

  it("emits <unsupported> for functions and symbols rather than dropping them", () => {
    expect(stableStringify(() => 1)).toBe("<unsupported>")
    expect(stableStringify(Symbol("s"))).toBe("<unsupported>")
    expect(stableStringify({ fn: () => 1 })).toContain("<unsupported>")
  })

  it("sorts deeply at every level", () => {
    const a = { z: { b: 1, a: 2 }, a: 3 }
    const b = { a: 3, z: { a: 2, b: 1 } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it("round-trips simple JSON values byte-for-byte across runs", () => {
    expect(stableStringify({ q: "foo", n: 1, b: true, list: [1, 2, "x"] })).toBe(
      stableStringify({ list: [1, 2, "x"], b: true, n: 1, q: "foo" }),
    )
  })
})
