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
  CACHED_MANIFEST_CAP,
  CLIENT_POOL_CAP,
  FP_CAP_PER_VARIANT,
  cacheLookup,
  cacheStore,
  getCachedPartialIds,
  getCurrentPagePartials,
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
    expect(fps).toEqual(Array.from({ length: FP_CAP_PER_VARIANT }, (_, i) => `fp${i + 3}`))
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

describe("getCachedPartialIds — manifest cap", () => {
  it("advertises at most CACHED_MANIFEST_CAP entries, newest registrations first", () => {
    // A chunk-world-sized page: far more partons than the manifest
    // admits. The manifest must stay bounded (it travels in the
    // request URL) and prefer the most recently registered ids —
    // anything older just re-renders server-side on its next visit.
    const total = CACHED_MANIFEST_CAP + 50
    for (let i = 0; i < total; i++) {
      registerClientPartial(`chunk-${i}`, "mk", `fp${i}`)
    }
    const out = getCachedPartialIds()
    expect(out.length).toBe(CACHED_MANIFEST_CAP)
    // Newest first: the last-registered id leads the manifest…
    expect(out[0]).toBe(`chunk-${total - 1}:mk:fp${total - 1}`)
    // …and the oldest ids fell off entirely.
    expect(out.some((t) => t.startsWith("chunk-0:"))).toBe(false)
  })

  it("re-registration refreshes an id's recency", () => {
    for (let i = 0; i < CACHED_MANIFEST_CAP + 10; i++) {
      registerClientPartial(`p-${i}`, "mk", `fp${i}`)
    }
    // p-0 aged out; registering it again puts it back at the front.
    registerClientPartial("p-0", "mk", "fp0b")
    const out = getCachedPartialIds()
    expect(out[0]).toBe("p-0:mk:fp0")
    expect(out[1]).toBe("p-0:mk:fp0b")
  })
})

describe("CLIENT_POOL_CAP eviction — live-tree exemption", () => {
  it("never evicts an id the live tree still references", () => {
    const cache = getCurrentPagePartials()
    // The page shell: registered FIRST (oldest pool position), cached,
    // and referenced by the committed template. Its element identity is
    // stable, so it never re-registers for recency — exactly the entry
    // naive oldest-first eviction would destroy.
    registerClientPartial("world", "mk", "fp-world")
    cacheStore(cache, "world", "mk", "WORLD-SUBTREE")
    registerClientPartial("world", "mk", "fp-world")
    // A sacrificial non-live entry registered before the flood.
    registerClientPartial("stale-chunk", "mk", "fp-stale")
    cacheStore(cache, "stale-chunk", "mk", "STALE-SUBTREE")
    registerClientPartial("stale-chunk", "mk", "fp-stale")
    // The payload commit's prune records what the template references.
    pruneToLive(
      new Map([
        ["world", new Set(["mk"])],
        ["stale-chunk", new Set(["mk"])],
      ]),
    )
    // …then the template moves on without stale-chunk (next commit).
    pruneToLive(new Map([["world", new Set(["mk"])]]))

    // A scroll's worth of fresh registrations blows past the pool cap.
    for (let i = 0; i < CLIENT_POOL_CAP + 40; i++) {
      registerClientPartial(`chunk-${i}`, "mk", `fp${i}`)
      cacheStore(cache, `chunk-${i}`, "mk", `SUBTREE-${i}`)
    }

    // The live-referenced shell survived: a template re-render can still
    // substitute its placeholder (destroying it would blank the page
    // permanently — the server keeps fp-skipping what the client keeps
    // advertising).
    expect(cacheLookup(cache, "world", "mk")).toBe("WORLD-SUBTREE")
    // Non-live oldest entries were destroyed to hold the cap.
    expect(cacheLookup(cache, "chunk-0", "mk")).toBeUndefined()
  })

  it("exceeds the cap rather than destroy live-referenced entries", () => {
    const cache = getCurrentPagePartials()
    const total = CLIENT_POOL_CAP + 20
    const live = new Map<string, Set<string>>()
    for (let i = 0; i < total; i++) live.set(`p-${i}`, new Set(["mk"]))
    pruneToLive(live)
    for (let i = 0; i < total; i++) {
      registerClientPartial(`p-${i}`, "mk", `fp${i}`)
      cacheStore(cache, `p-${i}`, "mk", `SUBTREE-${i}`)
      registerClientPartial(`p-${i}`, "mk", `fp${i}`)
    }
    // Every entry is template-referenced: correctness wins over the
    // bound — nothing was destroyed.
    expect(cacheLookup(cache, "p-0", "mk")).toBe("SUBTREE-0")
    expect(cacheLookup(cache, `p-${total - 1}`, "mk")).toBe(`SUBTREE-${total - 1}`)
  })
})
