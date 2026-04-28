/**
 * Unit: shape guard for the multi-frame snapshot stored in a
 * navigation entry's state (`state.__frames`).
 *
 * The browser's traverse listener reads this to diff destination
 * vs current and dispatch refetches for the frames that changed.
 */
import { describe, expect, it } from "vitest"
import { _readFramesSnapshot } from "../partial-client.tsx"

describe("_readFramesSnapshot", () => {
  it("reads the __frames bucket from state", () => {
    const state = {
      __frames: {
        cart: { url: "/cart/open" },
        menu: { url: "/menu/about" },
      },
    }
    const snap = _readFramesSnapshot(state)
    expect(snap.cart?.url).toBe("/cart/open")
    expect(snap.menu?.url).toBe("/menu/about")
  })

  it("coexists with other state keys (scroll, user data)", () => {
    const state = {
      scrollY: 400,
      __frames: { cart: { url: "/cart/x" } },
    }
    const snap = _readFramesSnapshot(state)
    expect(snap.cart?.url).toBe("/cart/x")
  })

  it("returns empty snapshot when state has no __frames bucket", () => {
    expect(_readFramesSnapshot({ scrollY: 100 })).toEqual({})
    expect(_readFramesSnapshot(null)).toEqual({})
    expect(_readFramesSnapshot(undefined)).toEqual({})
    expect(_readFramesSnapshot("not an object")).toEqual({})
  })

  it("returns empty when __frames is non-object", () => {
    expect(_readFramesSnapshot({ __frames: null })).toEqual({})
    expect(_readFramesSnapshot({ __frames: "bad" })).toEqual({})
  })
})
