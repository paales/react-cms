/**
 * The deadline wheel — the expiry arm's delivery-side structure.
 *
 * Declared `expires()` boundaries are maintained per connection by the
 * wake-subscription sync (the same pointer-diff that registers index
 * entries): a fresh snapshot inserts/moves its id's grid slot, a drop
 * removes it, and ONE head-slot timer fires due ids into the shared
 * pending set through the bump path's park gating. Pins:
 *
 *   - insert on sync + the head timer delivering a due id (with wake);
 *   - move on re-render (a fresh snapshot object with a later
 *     boundary — the old slot must not fire);
 *   - remove on drop (no firing after the id leaves the route);
 *   - park-aware firing (a parked carrier's due id records into
 *     pending WITHOUT waking);
 *   - fired-once dedup (a past-due boundary fires one slot's worth of
 *     deliveries and re-enters the wheel only via a fresh snapshot);
 *   - wholesale death on subscription close (armed timer cleared, no
 *     late delivery);
 *   - the parity oracle's expiry side (due-but-undelivered throws;
 *     covered/parked/delivered pass; escalation to carriers).
 *
 * Fake timers drive both `Date.now` and the head-slot timeout, so slot
 * math is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _clearInvalidationRegistry,
  _takeWakeSubscriptionPending,
  refreshSelector,
  type WakeSubscriberContext,
} from "../../runtime/invalidation-registry.ts"
import type { PartialSnapshot } from "../partial-registry.ts"
import {
  _assertWakeParity,
  _closeRouteWakeSubscription,
  _openRouteWakeSubscription,
  _syncRouteWakeSubscription,
  EXPIRY_COALESCE_MS,
  type RouteWakeSubscription,
} from "../segment-relevance.ts"

function snap(
  labels: string[],
  opts: {
    expiresAt?: number
    emittedFp?: string | undefined
    parentPath?: string[]
    cullGated?: string
  } = {},
): PartialSnapshot {
  const deps =
    opts.cullGated !== undefined ? new Set([`visible:${opts.cullGated}?seed=1`]) : undefined
  return {
    type: "x",
    fallback: null,
    labels,
    framePath: [],
    parentFrameChain: [],
    parentPath: opts.parentPath ?? [],
    emittedFp: "emittedFp" in opts ? opts.emittedFp : "fp",
    matchKey: "mk",
    deps,
    ...(opts.expiresAt !== undefined ? { wakeHints: { expiresAt: opts.expiresAt } } : {}),
  }
}

const openSubs: RouteWakeSubscription[] = []

function open(context?: Partial<WakeSubscriberContext>): {
  rws: RouteWakeSubscription
  wokeCount: () => number
} {
  const rws = _openRouteWakeSubscription({
    visible: context?.visible ?? (() => null),
    hasAssignedSeq: context?.hasAssignedSeq ?? (() => false),
  })
  openSubs.push(rws)
  let woke = 0
  rws.sub.wakes.add(() => {
    woke++
  })
  return { rws, wokeCount: () => woke }
}

const GRID = EXPIRY_COALESCE_MS

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const rws of openSubs.splice(0)) _closeRouteWakeSubscription(rws)
  _clearInvalidationRegistry()
  vi.useRealTimers()
})

describe("deadline wheel — maintained by the subscription sync", () => {
  it("a declared boundary is delivered by the head-slot timer, with a wake", () => {
    const { rws, wokeCount } = open()
    const route = new Map([["clock", snap(["clock"], { expiresAt: Date.now() + 60 })]])
    _syncRouteWakeSubscription(rws, route, 0)
    expect(rws.wheel.slotOf.has("clock")).toBe(true)
    expect(rws.wheel.timer).not.toBeNull()

    // Not yet due: nothing delivered.
    vi.advanceTimersByTime(GRID)
    expect(rws.sub.pending.size).toBe(0)

    // Past the boundary's slot (round-up + at most one slot late).
    vi.advanceTimersByTime(60 + GRID)
    expect([...rws.sub.pending]).toEqual(["clock"])
    expect(wokeCount()).toBe(1)
    // Consumed at fire — the wheel no longer tracks the id.
    expect(rws.wheel.slotOf.has("clock")).toBe(false)
  })

  it("a re-registered snapshot MOVES the id to its new slot; the old slot no longer fires it", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["clock", snap(["clock"], { expiresAt: Date.now() + 50 })]]),
      0,
    )
    // Re-render before the boundary: the fresh snapshot declares a
    // later one.
    _syncRouteWakeSubscription(
      rws,
      new Map([["clock", snap(["clock"], { expiresAt: Date.now() + 500 })]]),
      0,
    )
    vi.advanceTimersByTime(50 + 2 * GRID)
    expect(rws.sub.pending.size).toBe(0)
    vi.advanceTimersByTime(500)
    expect([...rws.sub.pending]).toEqual(["clock"])
  })

  it("a boundary-less re-registration and a dropped id both remove the wheel entry", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([
        ["a", snap(["a"], { expiresAt: Date.now() + 40 })],
        ["b", snap(["b"], { expiresAt: Date.now() + 40 })],
      ]),
      0,
    )
    // a re-registers with no boundary (e.g. its culled variant); b
    // leaves the route entirely.
    _syncRouteWakeSubscription(rws, new Map([["a", snap(["a"])]]), 0)
    expect(rws.wheel.slotOf.size).toBe(0)
    expect(rws.wheel.timer).toBeNull()
    vi.advanceTimersByTime(40 + 2 * GRID)
    expect(rws.sub.pending.size).toBe(0)
  })

  it("the +Infinity 'never' sentinel never enters the wheel", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["never", snap(["never"], { expiresAt: Number.POSITIVE_INFINITY })]]),
      0,
    )
    expect(rws.wheel.slotOf.size).toBe(0)
    expect(rws.wheel.timer).toBeNull()
  })

  it("a parked carrier's slot firing records into pending WITHOUT waking; fired once, not respun", () => {
    const visible = new Set<string>(["elsewhere"])
    const { rws, wokeCount } = open({ visible: () => visible })
    // Cull-gated, out of the visible set → parked; boundary already due.
    const parked = snap(["pulse"], { expiresAt: Date.now() - 1_000, cullGated: "pulse" })
    _syncRouteWakeSubscription(rws, new Map([["pulse", parked]]), 0)
    vi.advanceTimersByTime(2 * GRID)
    // Recorded silently — the flip-in drain is the catch-up.
    expect([...rws.sub.pending]).toEqual(["pulse"])
    expect(wokeCount()).toBe(0)
    // Fired once: the forever-past-due boundary is out of the wheel and
    // an unchanged snapshot never re-inserts it — no hot spin.
    expect(rws.wheel.slotOf.size).toBe(0)
    rws.sub.pending.clear()
    _syncRouteWakeSubscription(rws, new Map([["pulse", parked]]), 0)
    vi.advanceTimersByTime(10 * GRID)
    expect(rws.sub.pending.size).toBe(0)
  })

  it("a parked carrier holding an assigned consequence seq still wakes (prompt voiding)", () => {
    const visible = new Set<string>([])
    const { rws, wokeCount } = open({
      visible: () => visible,
      hasAssignedSeq: (id) => id === "pulse",
    })
    _syncRouteWakeSubscription(
      rws,
      new Map([["pulse", snap(["pulse"], { expiresAt: Date.now() + 30, cullGated: "pulse" })]]),
      0,
    )
    vi.advanceTimersByTime(30 + 2 * GRID)
    expect([...rws.sub.pending]).toEqual(["pulse"])
    expect(wokeCount()).toBe(1)
  })

  it("an already-due boundary fires at the NEXT grid slot, never synchronously (drain pacing)", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["hot", snap(["hot"], { expiresAt: Date.now() - 5_000 })]]),
      0,
    )
    // Scheduled, not delivered at insert — the drain that just synced
    // must not observe its own insert as pending work.
    expect(rws.sub.pending.size).toBe(0)
    expect(rws.wheel.slotOf.has("hot")).toBe(true)
    vi.advanceTimersByTime(2 * GRID)
    expect([...rws.sub.pending]).toEqual(["hot"])
  })

  it("dies wholesale with the subscription: close clears the armed timer, nothing fires late", () => {
    const { rws, wokeCount } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["clock", snap(["clock"], { expiresAt: Date.now() + 40 })]]),
      0,
    )
    expect(rws.wheel.timer).not.toBeNull()
    _closeRouteWakeSubscription(rws)
    expect(rws.wheel.timer).toBeNull()
    expect(rws.wheel.slotOf.size).toBe(0)
    vi.advanceTimersByTime(40 + 5 * GRID)
    expect(rws.sub.pending.size).toBe(0)
    expect(wokeCount()).toBe(0)
    // A post-close sync must not re-arm a dead wheel.
    _syncRouteWakeSubscription(
      rws,
      new Map([["clock", snap(["clock"], { expiresAt: Date.now() + 40 })]]),
      0,
    )
    expect(rws.wheel.timer).toBeNull()
  })

  it("boundaries in one grid slot share a single firing; distinct slots fire in order", () => {
    const { rws, wokeCount } = open()
    const base = Math.floor(Date.now() / GRID) * GRID
    _syncRouteWakeSubscription(
      rws,
      new Map([
        ["a", snap(["a"], { expiresAt: base + 4 * GRID })],
        ["b", snap(["b"], { expiresAt: base + 4 * GRID - 3 })],
        ["c", snap(["c"], { expiresAt: base + 12 * GRID })],
      ]),
      0,
    )
    vi.advanceTimersByTime(5 * GRID)
    expect(new Set(rws.sub.pending)).toEqual(new Set(["a", "b"]))
    expect(wokeCount()).toBe(1)
    expect(rws.wheel.slotOf.has("c")).toBe(true)
    vi.advanceTimersByTime(8 * GRID)
    expect(rws.sub.pending.has("c")).toBe(true)
  })
})

describe("wake parity — the expiry side of the coverage oracle", () => {
  const unparked = () => false
  const uncovered = () => false

  it("a due boundary must be delivered, wheel-armed, or otherwise covered", () => {
    const { rws } = open()
    const now = Date.now()
    const route = new Map([["clock", snap(["clock"], { expiresAt: now - 100 })]])
    _syncRouteWakeSubscription(rws, route, 0)

    // Armed in the wheel (fires ≤ one slot late) — covered.
    const wheelCovered = (id: string) => rws.wheel.slotOf.has(id)
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: wheelCovered }),
    ).not.toThrow()

    // Fired into pending — delivered.
    vi.advanceTimersByTime(2 * GRID)
    expect(rws.sub.pending.has("clock")).toBe(true)
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: wheelCovered }),
    ).not.toThrow()

    // Neither armed nor delivered nor covered — a lost deadline throws.
    rws.sub.pending.clear()
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: uncovered }),
    ).toThrow(/parity/)

    // …unless parked (the drain would drop it; flip-in is the catch-up)
    // or covered by an open lane / the window / this wake's worklist.
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, (id) => id === "clock", {
        now,
        covered: uncovered,
      }),
    ).not.toThrow()
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: () => true }),
    ).not.toThrow()
  })

  it("a due non-addressable child escalates to its carrier on both sides", () => {
    const { rws } = open()
    const now = Date.now()
    const route = new Map([
      ["parent", snap(["parent"])],
      [
        "child",
        snap(["child"], { expiresAt: now - 50, emittedFp: undefined, parentPath: ["parent"] }),
      ],
    ])
    _syncRouteWakeSubscription(rws, route, 0)
    vi.advanceTimersByTime(2 * GRID)
    // The wheel delivered the RAW id; expected escalates to the carrier
    // and the delivered side escalates identically — parity holds.
    expect(rws.sub.pending.has("child")).toBe(true)
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: uncovered }),
    ).not.toThrow()
    // An empty delivery for the same due child names the carrier as
    // the missing lane.
    rws.sub.pending.clear()
    expect(() =>
      _assertWakeParity(route, 0, rws.sub.pending, unparked, { now, covered: uncovered }),
    ).toThrow(/\[parent\]/)
  })

  it("future boundaries and bump parity are untouched by the expiry side", () => {
    const { rws } = open()
    const now = Date.now()
    const route = new Map([
      ["later", snap(["later"], { expiresAt: now + 60_000 })],
      ["bumped", snap(["cell:x"])],
    ])
    const since = 0
    _syncRouteWakeSubscription(rws, route, since)
    refreshSelector("cell:x")
    expect(() =>
      _assertWakeParity(route, since, rws.sub.pending, unparked, { now, covered: uncovered }),
    ).not.toThrow()
    _takeWakeSubscriptionPending(rws.sub)
    // The bump is now undelivered — the bump side still throws with the
    // expiry argument present.
    expect(() =>
      _assertWakeParity(route, since, rws.sub.pending, unparked, { now, covered: uncovered }),
    ).toThrow(/parity/)
  })
})
