/**
 * routeKey derivation — the registered-pattern set `computeRouteKey`
 * hashes, and the pattern registry feeding it.
 *
 * The routeKey is a hash of WHICH registered URLPatterns match a
 * URL's BASE — scheme + host + pathname, search and hash stripped
 * before matching (see `computeRouteKey` in partial.tsx). The
 * registry's hint table, fold-base snapshot reads, and the fp-trailer
 * all bucket by it. Two properties are load-bearing:
 *
 *  - Registration is deduplicated by pattern signature, so an HMR
 *    module re-execution (the constructor runs again with the same
 *    `match`) doesn't append a duplicate — a dup signature changes
 *    the hashed signature list and shifts every affected routeKey
 *    across the edit.
 *
 *  - Route identity is a pure function of the URL base. A pattern
 *    that constrains search (`match: { search: "*q=:query" }` — the
 *    documented URLPatternInit dict form, used by pokemon.tsx's
 *    stage-3 search parton) gates its spec's rendering but never
 *    splits its page's bucket: the search overlay's `?q=` refetches
 *    must find the snapshots and hints the page's earlier renders
 *    committed, and the key must never depend on request arrival
 *    order (the failure mode of a first-seen-wins cache).
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
      parton(
        function HmrSpecRender() {
          return null
        },
        {
          match: "/hmr/:id",
          selector: "route-key-hmr-spec",
        },
      )

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("routeKeys stay stable across a re-registration", () => {
    const defineSpec = () =>
      parton(
        function HmrStableRender() {
          return null
        },
        {
          match: "/hmr-stable/:id",
          selector: "route-key-hmr-stable",
        },
      )

    defineSpec()
    const before = computeRouteKey("http://t/hmr-stable/1")

    defineSpec()
    // Recompute from scratch — a cache hit would mask a shifted hash.
    _clearRouteKeyCache()
    expect(computeRouteKey("http://t/hmr-stable/1")).toBe(before)
  })

  it("two specs sharing one pattern contribute a single signature", () => {
    parton(
      function SharedARender() {
        return null
      },
      {
        match: "/shared/:id",
        selector: "route-key-shared-a",
      },
    )
    parton(
      function SharedBRender() {
        return null
      },
      {
        match: "/shared/:id",
        selector: "route-key-shared-b",
      },
    )
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("distinct patterns register side by side and split routeKeys", () => {
    parton(
      function DistinctARender() {
        return null
      },
      {
        match: "/distinct-a/:id",
        selector: "route-key-distinct-a",
      },
    )
    parton(
      function DistinctBRender() {
        return null
      },
      {
        match: "/distinct-b/:id",
        selector: "route-key-distinct-b",
      },
    )
    expect(getRegisteredMatchPatterns()).toHaveLength(2)
    expect(computeRouteKey("http://t/distinct-a/1")).not.toBe(
      computeRouteKey("http://t/distinct-b/1"),
    )
  })
})

describe("route identity — the URL base", () => {
  it("same page collapses to one routeKey across query changes", () => {
    parton(
      function PathOnlyRender() {
        return null
      },
      {
        match: "/p/:slug",
        selector: "route-key-path-only",
      },
    )
    // Per-segment streaming URLs differ only in framework query params
    // (`?cached=…`) — same base, same routeKey, one cache entry.
    const first = computeRouteKey("http://t/p/pikachu")
    const second = computeRouteKey("http://t/p/pikachu?cached=hero:mk:fp")
    expect(second).toBe(first)
  })

  it("a search-bearing pattern never splits its page's bucket", () => {
    parton(
      function MixedPathRender() {
        return null
      },
      {
        match: "/search{/*}?",
        selector: "route-key-mixed-path",
      },
    )
    parton(
      function SearchMatchRender() {
        return null
      },
      {
        match: { search: "*q=:query" },
        selector: "route-key-search-match",
      },
    )
    // The typing session: /search → ?q=p → ?q=po. Every shape must
    // land in the SAME bucket so refetches find the page's snapshots
    // and hints — the warm-fp lockstep the search overlay relies on.
    const bare = computeRouteKey("http://t/search")
    expect(computeRouteKey("http://t/search?q=p")).toBe(bare)
    expect(computeRouteKey("http://t/search?q=po")).toBe(bare)
    // Distinct pages still split.
    expect(computeRouteKey("http://t/elsewhere?q=p")).not.toBe(bare)
  })

  it("routeKey is a pure function of the URL, not of arrival order", () => {
    const define = () => {
      parton(
        function OrderPathRender() {
          return null
        },
        {
          match: "/order{/*}?",
          selector: "route-key-order-path",
        },
      )
      parton(
        function OrderSearchRender() {
          return null
        },
        {
          match: { search: "*q=:query" },
          selector: "route-key-order-search",
        },
      )
    }
    // Arrival order A: bare page first (the cold-load-then-type flow).
    define()
    const bareFirst = computeRouteKey("http://t/order")
    const queryAfter = computeRouteKey("http://t/order?q=x")
    // Arrival order B: query URL first (reload mid-search).
    _resetMatchPatterns()
    define()
    const queryFirst = computeRouteKey("http://t/order?q=x")
    const bareAfter = computeRouteKey("http://t/order")
    expect(queryFirst).toBe(queryAfter)
    expect(bareAfter).toBe(bareFirst)
    expect(bareFirst).toBe(queryFirst)
  })

  it("host is part of the base — hostname patterns split per host", () => {
    parton(
      function HostRender() {
        return null
      },
      {
        match: { hostname: "shop.example", pathname: "/p/:slug" },
        selector: "route-key-host",
      },
    )
    const shop = computeRouteKey("http://shop.example/p/x")
    const other = computeRouteKey("http://other.example/p/x")
    expect(shop).not.toBe("__no-pattern")
    expect(other).toBe("__no-pattern")
  })
})
