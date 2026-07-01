/**
 * routeKey derivation — the registered-pattern set `computeRouteKey`
 * hashes, and the pattern registry feeding it.
 *
 * The routeKey is a hash of WHICH registered URLPatterns match a URL
 * (see `computeRouteKey` in partial.tsx); the registry's hint table
 * and the byte cache key off it. Two properties are load-bearing:
 *
 *  - Registration is deduplicated by pattern signature, so an HMR
 *    module re-execution (the constructor runs again with the same
 *    `match`) doesn't append a duplicate — a dup signature changes
 *    the hashed signature list and shifts every affected routeKey
 *    across the edit.
 *
 *  - The pathname-keyed routeKey cache is used only while every
 *    registered pattern is pathname-only. A pattern that constrains
 *    another component (`match: { search: "*q=:query" }` — the
 *    documented URLPatternInit dict form) makes two same-pathname
 *    URLs match different pattern sets, so the cache is bypassed.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  _clearRouteKeyCache,
  _resetMatchPatterns,
  computeRouteKey,
  getRegisteredMatchPatterns,
  parton,
} from "../partial.tsx"

beforeEach(() => {
  _resetMatchPatterns()
})

describe("pattern registration dedup (HMR re-execution)", () => {
  it("re-registering the same match pattern doesn't append a duplicate", () => {
    // Simulate HMR: the spec module executes twice, running the
    // constructor with the identical options both times.
    const defineSpec = () =>
      parton(function HmrSpecRender() { return null }, {
        match: "/hmr/:id",
        selector: "route-key-hmr-spec",
      })

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("routeKeys stay stable across a re-registration", () => {
    const defineSpec = () =>
      parton(function HmrStableRender() { return null }, {
        match: "/hmr-stable/:id",
        selector: "route-key-hmr-stable",
      })

    defineSpec()
    const before = computeRouteKey("http://t/hmr-stable/1")

    defineSpec()
    // Recompute from scratch — a cache hit would mask a shifted hash.
    _clearRouteKeyCache()
    expect(computeRouteKey("http://t/hmr-stable/1")).toBe(before)
  })

  it("two specs sharing one pattern contribute a single signature", () => {
    parton(function SharedARender() { return null }, {
      match: "/shared/:id",
      selector: "route-key-shared-a",
    })
    parton(function SharedBRender() { return null }, {
      match: "/shared/:id",
      selector: "route-key-shared-b",
    })
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("distinct patterns register side by side and split routeKeys", () => {
    parton(function DistinctARender() { return null }, {
      match: "/distinct-a/:id",
      selector: "route-key-distinct-a",
    })
    parton(function DistinctBRender() { return null }, {
      match: "/distinct-b/:id",
      selector: "route-key-distinct-b",
    })
    expect(getRegisteredMatchPatterns()).toHaveLength(2)
    expect(computeRouteKey("http://t/distinct-a/1")).not.toBe(
      computeRouteKey("http://t/distinct-b/1"),
    )
  })
})

describe("routeKey cache — pathname-only invariant", () => {
  it("pathname-only patterns: same pathname collapses to one routeKey across query changes", () => {
    parton(function PathOnlyRender() { return null }, {
      match: "/p/:slug",
      selector: "route-key-path-only",
    })
    // Per-segment streaming URLs differ only in framework query params
    // (`?cached=…`) — the matched set (and so the routeKey) is
    // identical, and the second call is served from the pathname cache.
    const first = computeRouteKey("http://t/p/pikachu")
    const second = computeRouteKey("http://t/p/pikachu?cached=hero:mk:fp")
    expect(second).toBe(first)
  })

  it("a search-bearing pattern splits routeKeys for same-pathname URLs", () => {
    // The dict form documented in partial.md — pokemon.tsx's stage-3
    // search parton registers exactly this shape.
    parton(function SearchMatchRender() { return null }, {
      match: { search: "*q=:query" },
      selector: "route-key-search-match",
    })
    // Order matters: compute the matching URL first so a wrongly
    // pathname-keyed cache entry would poison the non-matching one.
    const withQuery = computeRouteKey("http://t/search?q=pika")
    const withoutQuery = computeRouteKey("http://t/search")
    expect(withQuery).not.toBe("__no-pattern")
    expect(withoutQuery).toBe("__no-pattern")
    expect(withoutQuery).not.toBe(withQuery)
  })

  it("search-bearing patterns coexist with pathname patterns without cross-poisoning", () => {
    parton(function MixedPathRender() { return null }, {
      match: "/mixed{/*}?",
      selector: "route-key-mixed-path",
    })
    parton(function MixedSearchRender() { return null }, {
      match: { search: "*q=:query" },
      selector: "route-key-mixed-search",
    })
    const both = computeRouteKey("http://t/mixed?q=x")
    const pathOnly = computeRouteKey("http://t/mixed")
    const searchOnly = computeRouteKey("http://t/elsewhere?q=x")
    expect(new Set([both, pathOnly, searchOnly]).size).toBe(3)
    // Deterministic across repeat calls even with the cache bypassed.
    expect(computeRouteKey("http://t/mixed?q=x")).toBe(both)
    expect(computeRouteKey("http://t/mixed")).toBe(pathOnly)
  })
})
