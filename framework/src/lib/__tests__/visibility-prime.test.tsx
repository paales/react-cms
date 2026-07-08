/**
 * Visibility priming — the controller's baseline is the DISPLAY state.
 *
 * `CullPair` primes the controller on mount with its emission's
 * server-computed `culled` prop, and the controller overlays any live
 * report for the id — the same precedence the pair's own display uses
 * (`reported ?? culled`). The overlay is what keeps a RESTORED parked
 * subtree honest: its pairs re-mount from emissions minted BEFORE
 * their cull-outs, so the raw prop says "in" while the display shows
 * the skeleton. A baseline primed from the raw prop would swallow the
 * observer's first real measurement (a genuine in-flip against the
 * showing skeleton) as a no-delta duplicate — no dispatch, no lane,
 * and nothing ever revives the subtree.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  _resetCullPark,
  contentSlotStored,
  cullStateGone,
  reportCullState,
  reportedVisibility,
} from "../cull-park.ts"
import {
  _primeVisible,
  _resetVisibilityController,
  _visibleSetIds,
  reportVisible,
} from "../visibility.tsx"

beforeEach(() => {
  _resetCullPark()
  _resetVisibilityController()
})

describe("visibility priming", () => {
  it("a prime honors the live report overlay — the observer's real flip stays a delta", () => {
    // The id's display state is OUT per its live report (its cull-out
    // already happened and swapped the pair to the skeleton)…
    reportCullState("prime-overlay", false)
    // …and a restored emission minted before that cull-out re-mounts,
    // priming with its stale culled:false prop.
    _primeVisible("prime-overlay", true)
    // The baseline followed the DISPLAYED state (out), so the
    // observer's genuine "in view" measurement is a delta: it
    // dispatches and swaps the display.
    reportVisible("prime-overlay", true)
    expect(reportedVisibility("prime-overlay")).toBe(true)
  })

  it("a prime with no report overlay follows the emission's state", () => {
    // Boot shape: no live report yet — the emission's state IS the
    // display, and a first measurement that agrees with it is a
    // no-op (no flip dispatched, display untouched).
    _primeVisible("prime-cold", true)
    reportVisible("prime-cold", true)
    expect(reportedVisibility("prime-cold")).toBeUndefined()
  })
})

describe("visibility priming after report eviction", () => {
  // The journey these tests replay: the id culls out (parked,
  // reported:false), the LRU prune destroys its content, and the merge
  // layer's page-membership prune drops its reported state
  // (`cullStateGone` — a subtree parked inside a cached ancestor ages
  // out of the client maps while that ancestor still holds its
  // pre-park emission). An ancestor restore then re-mounts the pair
  // from that emission — `culled:false`, minted BEFORE the park — with
  // no report left to overlay. The raw prop is the same stale evidence
  // the overlay exists to override, so the prime must fall COLD: the
  // display without content is the skeleton, and the observer's first
  // measurement is authoritative.

  it("the restore flip is not swallowed — an in-view first measurement drives", () => {
    reportCullState("evicted-in", false)
    cullStateGone("evicted-in")
    _primeVisible("evicted-in", true)
    // Content was destroyed; only a dispatched flip can revive it.
    reportVisible("evicted-in", true)
    expect(reportedVisibility("evicted-in")).toBe(true)
  })

  it("no spurious out-flip dribble — an out first measurement agrees and rides", () => {
    reportCullState("evicted-out", false)
    cullStateGone("evicted-out")
    _primeVisible("evicted-out", true)
    reportVisible("evicted-out", false)
    // The cold baseline already said out: no flip, no dispatch.
    expect(reportedVisibility("evicted-out")).toBeUndefined()
  })

  it("an evicted id's prime never inflates the visible set", () => {
    _primeVisible("seed", true)
    reportVisible("seed", true) // measured — the set has a statement
    reportCullState("phantom", false)
    cullStateGone("phantom")
    _primeVisible("phantom", true)
    expect(_visibleSetIds()).not.toContain("phantom")
  })

  it("fresh content retires the tombstone — a route-back emission primes normally", () => {
    reportCullState("returned", false)
    cullStateGone("returned")
    // Navigate back: the new payload's commit walk stores fresh
    // content for the id before the pair's prime effect runs.
    contentSlotStored("returned")
    _primeVisible("returned", true)
    reportVisible("returned", true) // agrees with the fresh emission
    expect(reportedVisibility("returned")).toBeUndefined()
  })
})
