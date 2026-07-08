import { describe, expect, it } from "vitest"
import {
  CAPABILITY_HEADER,
  decodeCapability,
  encodeCapability,
  getCapability,
  runWithCapability,
} from "../capability.ts"

describe("encodeCapability / decodeCapability", () => {
  it("round-trips a simple capability", () => {
    const cap = { cart_id: "abc123", currency: "USD", total: 49.95 }
    const back = decodeCapability(encodeCapability(cap))
    expect(back).toEqual(cap)
  })

  it("handles all primitive value types", () => {
    const cap = {
      str: "hello world",
      empty: "",
      int: 42,
      neg: -1,
      float: 3.14,
      zero: 0,
      yes: true,
      no: false,
      n: null,
    }
    const back = decodeCapability(encodeCapability(cap))
    expect(back).toEqual(cap)
  })

  it("preserves unicode in string values", () => {
    const cap = { greet: "héllo wörld 🌍", cjk: "你好世界" }
    const back = decodeCapability(encodeCapability(cap))
    expect(back).toEqual(cap)
  })

  it("encodes to base64url (no +/= chars)", () => {
    const cap = { large: "x".repeat(200) }
    const encoded = encodeCapability(cap)
    expect(encoded).not.toContain("+")
    expect(encoded).not.toContain("/")
    expect(encoded).not.toContain("=")
  })

  it("empty capability round-trips to empty", () => {
    expect(decodeCapability(encodeCapability({}))).toEqual({})
  })

  it("decodes null/undefined/empty string to empty", () => {
    expect(decodeCapability(null)).toEqual({})
    expect(decodeCapability(undefined)).toEqual({})
    expect(decodeCapability("")).toEqual({})
  })

  it("decodes malformed input to empty (no throw)", () => {
    expect(decodeCapability("not-base64!!!")).toEqual({})
    expect(decodeCapability("aGVsbG8=")).toEqual({}) // "hello" — valid base64, invalid JSON
    expect(decodeCapability(encodeCapability(null as unknown as Record<string, string>))).toEqual(
      {},
    )
    // Encoded array (not an object) — decoder rejects.
    expect(
      decodeCapability(encodeCapability(["a", "b"] as unknown as Record<string, string>)),
    ).toEqual({})
  })
})

describe("getCapability / runWithCapability ALS scoping", () => {
  it("returns empty outside a scope", () => {
    expect(getCapability()).toEqual({})
  })

  it("returns the active scope inside runWithCapability", () => {
    const cap = { user_id: "u1", locale: "en-US" }
    const result = runWithCapability(cap, () => getCapability())
    expect(result).toEqual(cap)
  })

  it("nested scopes shadow outer ones", () => {
    const inner = runWithCapability({ x: "outer" }, () =>
      runWithCapability({ x: "inner", y: "also-inner" }, () => getCapability()),
    )
    expect(inner).toEqual({ x: "inner", y: "also-inner" })
  })

  it("scope unwinds after the callback", () => {
    runWithCapability({ x: "in" }, () => {
      expect(getCapability()).toEqual({ x: "in" })
    })
    expect(getCapability()).toEqual({})
  })

  it("scope persists across awaits inside the callback", async () => {
    const result = await runWithCapability({ x: "yo" }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      return getCapability()
    })
    expect(result).toEqual({ x: "yo" })
  })
})

describe("CAPABILITY_HEADER constant", () => {
  it("is the expected header name (lowercase)", () => {
    expect(CAPABILITY_HEADER).toBe("x-parton-capability")
  })
})
