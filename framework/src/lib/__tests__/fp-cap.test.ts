/**
 * Unit: the per-variant fingerprint cap (`FP_CAP_PER_VARIANT`).
 *
 * Every rendered partial registers its fp per (id, matchKey); the
 * cold→warm transition and live segments keep adding fps for the same
 * variant. The cap bounds what `getCachedPartialIds()` advertises in
 * `?cached=` — keep the LATEST few, evict the oldest (insertion
 * order) — so a live partial can't inflate the query string
 * unboundedly.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  FP_CAP_PER_VARIANT,
  getCachedPartialIds,
  pruneToLive,
  registerClientPartial,
} from "../partial-client-state.ts"

beforeEach(() => {
  // Reset the module-level maps: pruning against an empty live set
  // drops every (id, matchKey) entry.
  pruneToLive(new Map())
})

function advertisedFps(id: string, mk: string): string[] {
  const prefix = `${id}:${mk}:`
  return getCachedPartialIds()
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
}

describe("registerClientPartial — FP cap / eviction", () => {
  it("keeps up to FP_CAP_PER_VARIANT fps for one variant", () => {
    for (let i = 1; i <= FP_CAP_PER_VARIANT; i++) {
      registerClientPartial("stage", "mk1", `fp${i}`)
    }
    expect(advertisedFps("stage", "mk1")).toEqual(
      Array.from({ length: FP_CAP_PER_VARIANT }, (_, i) => `fp${i + 1}`),
    )
  })

  it("evicts the OLDEST fp once the cap is exceeded", () => {
    for (let i = 1; i <= FP_CAP_PER_VARIANT + 2; i++) {
      registerClientPartial("stage", "mk1", `fp${i}`)
    }
    const fps = advertisedFps("stage", "mk1")
    expect(fps).toHaveLength(FP_CAP_PER_VARIANT)
    // fp1 and fp2 (the oldest) are gone; the latest four remain in
    // insertion order.
    expect(fps).toEqual(
      Array.from({ length: FP_CAP_PER_VARIANT }, (_, i) => `fp${i + 3}`),
    )
  })

  it("re-registering an existing fp neither duplicates nor evicts", () => {
    for (let i = 1; i <= FP_CAP_PER_VARIANT; i++) {
      registerClientPartial("stage", "mk1", `fp${i}`)
    }
    // The set is full. Re-adding a member is a no-op — nothing may be
    // evicted for a value that's already tracked.
    registerClientPartial("stage", "mk1", "fp1")
    expect(advertisedFps("stage", "mk1")).toEqual(
      Array.from({ length: FP_CAP_PER_VARIANT }, (_, i) => `fp${i + 1}`),
    )
  })

  it("caps per (id, matchKey) — variants do not share a budget", () => {
    for (let i = 1; i <= FP_CAP_PER_VARIANT + 1; i++) {
      registerClientPartial("page", "mkA", `a${i}`)
      registerClientPartial("page", "mkB", `b${i}`)
    }
    expect(advertisedFps("page", "mkA")).toHaveLength(FP_CAP_PER_VARIANT)
    expect(advertisedFps("page", "mkB")).toHaveLength(FP_CAP_PER_VARIANT)
    // Each variant evicted only its own oldest entry.
    expect(advertisedFps("page", "mkA")[0]).toBe("a2")
    expect(advertisedFps("page", "mkB")[0]).toBe("b2")
  })
})
