/**
 * Segment-driver relevance gate.
 *
 * A streaming connection must re-render only for bumps that touch what
 * its route actually renders — never for a different viewer's or
 * partition's mutation. Without this, one client's `cell.set` wakes
 * every open stream into a (fp-skip) re-render: the cross-stream storm
 * that saturates the server under N concurrent viewers. These tests pin
 * the predicate `_routeHasMatchingBump` that the segment driver gates
 * each re-render on.
 */

import { afterEach, describe, expect, it } from "vitest"
import { _routeHasMatchingBump } from "../segment-relevance.ts"
import type { PartialSnapshot } from "../partial-registry.ts"
import { _clearInvalidationRegistry, _currentTs, refreshSelector } from "../../runtime/invalidation-registry.ts"

function snap(
  labels: string[],
  opts: { constraintArgs?: Record<string, unknown>; varyKey?: string } = {},
): PartialSnapshot {
  return {
    type: "x",
    fallback: null,
    labels,
    framePath: [],
    parentFrameChain: [],
    parentPath: [],
    constraintArgs: opts.constraintArgs,
    varyKey: opts.varyKey,
  }
}

function route(...entries: Array<[string, PartialSnapshot]>): Map<string, PartialSnapshot> {
  return new Map(entries)
}

// A cart-badge parton rendered for cartId=A — the constraint surface
// the driver matches bumps against.
const cartA = () =>
  route(["cart-badge", snap(["cell:cart-badge"], { constraintArgs: { cartId: "A" } })])

describe("segment driver — relevance gate", () => {
  afterEach(() => _clearInvalidationRegistry())

  it("does NOT wake for a bump on a different partition (another viewer's cart)", () => {
    const since = _currentTs()
    refreshSelector("cell:cart-badge?cartId=B")
    expect(_routeHasMatchingBump(cartA(), since)).toBe(false)
  })

  it("wakes for a bump on this partition", () => {
    const since = _currentTs()
    refreshSelector("cell:cart-badge?cartId=A")
    expect(_routeHasMatchingBump(cartA(), since)).toBe(true)
  })

  it("does NOT wake for a bump to a label this route doesn't render", () => {
    const since = _currentTs()
    refreshSelector("cell:something-else?cartId=A")
    expect(_routeHasMatchingBump(cartA(), since)).toBe(false)
  })

  it("wakes for an unconstrained (broadcast) bump on a rendered label", () => {
    const since = _currentTs()
    refreshSelector("cell:cart-badge") // no constraints → matches any cartId
    expect(_routeHasMatchingBump(cartA(), since)).toBe(true)
  })

  it("matches against vary inputs (varyKey JSON), not just bound args", () => {
    const varied = () =>
      route(["badge", snap(["cell:cart-badge"], { varyKey: JSON.stringify({ cartId: "A" }) })])
    const since = _currentTs()
    refreshSelector("cell:cart-badge?cartId=A")
    expect(_routeHasMatchingBump(varied(), since)).toBe(true)
    const since2 = _currentTs()
    refreshSelector("cell:cart-badge?cartId=Z")
    expect(_routeHasMatchingBump(varied(), since2)).toBe(false)
  })

  it("only counts bumps newer than sinceTs", () => {
    refreshSelector("cell:cart-badge?cartId=A") // a bump the driver already saw
    const since = _currentTs()
    expect(_routeHasMatchingBump(cartA(), since)).toBe(false)
    refreshSelector("cell:cart-badge?cartId=A") // a fresh one
    expect(_routeHasMatchingBump(cartA(), since)).toBe(true)
  })
})
