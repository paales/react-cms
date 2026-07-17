/**
 * Loss is reportable — the client side of the mirror's self-healing.
 *
 * Any client-side destruction of COMMITTED content rides the ack
 * frame's `evicted` statement upstream, so the server revokes the
 * ids' mirror credit instead of confirming ghosts. The producers are
 * the destruction sites themselves (the no-heuristics rule — the code
 * that destroys writes the report):
 *
 *   1. the pool-cap eviction (`CLIENT_POOL_CAP`);
 *   2. the cull-park LRU eviction (`evictCulledContent`);
 *   3. the payload prune (`pruneToLive` — full-id and per-variant
 *      drops alike);
 *   4. a displayed cull pair regressed to its skeleton
 *      (`_visibilityContentRegressed`), which ALSO resets the id's
 *      visibility baseline so the skeleton observer's next
 *      measurement is a DELTA that re-states the flip — without the
 *      reset the id is "already in view" and the exactly-once flip
 *      machinery would leave the skeleton permanent.
 *
 * The statement is loss-tolerant: a fresh establishment clears the
 * pending set (the attach manifest restates holdings wholesale — the
 * same eviction evidence).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _channelEstablished,
  _reportContentEvicted,
  _resetChannelClient,
  scheduleChannelFlush,
} from "../channel-client.ts"
import type { AckFrame, ChannelEnvelope, VisibleFrame } from "../channel-protocol.ts"
import { _resetCullPark, reportCullState } from "../cull-park.ts"
import {
  CLIENT_POOL_CAP,
  cacheStore,
  evictCulledContent,
  getCurrentPagePartials,
  pruneToLive,
  registerClientPartial,
} from "../partial-client-state.ts"
import {
  _primeVisible,
  _resetVisibilityController,
  _visibilityContentRegressed,
  reportVisible,
} from "../visibility.tsx"

let rafQueue: FrameRequestCallback[] = []
function raf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb(0)
}

let fetchCalls: Array<{ url: string; init: RequestInit }> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function sentAcks(): AckFrame[] {
  return fetchCalls
    .flatMap((c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames)
    .filter((f): f is AckFrame => f.kind === "ack")
}

function sentVisibles(): VisibleFrame[] {
  return fetchCalls
    .flatMap((c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames)
    .filter((f): f is VisibleFrame => f.kind === "visible")
}

async function flushWindow(): Promise<void> {
  raf()
  await settle()
}

beforeEach(() => {
  // Empty the client maps FIRST (the prune's own loss reports land in
  // the pending set), then reset the transport (clears them) and
  // re-register the controller's producer.
  pruneToLive(new Map())
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  rafQueue = []
  fetchCalls = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    return Promise.resolve({ status: 204 })
  })
})

afterEach(() => {
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  vi.unstubAllGlobals()
})

describe("loss reports ride the ack's evicted statement", () => {
  it("a pool-cap eviction reports every destroyed id — a PASSENGER, with no watermark advance", async () => {
    _channelEstablished("c1")
    // Drain the establishment ack — the connection's opening
    // statement, not loss traffic.
    await flushWindow()
    expect(sentAcks()).toHaveLength(1)
    const cache = getCurrentPagePartials()
    for (let i = 0; i < CLIENT_POOL_CAP + 3; i++) {
      cacheStore(cache, `pool-${i}`, "mk", `SUBTREE-${i}`)
      registerClientPartial(`pool-${i}`, "mk", `fp${i}`)
    }
    // Off-screen losses have no urgency — nothing confirms the ghost
    // before the id's next flip-in or the reconcile — so the report
    // requests NO flush of its own (a scroll's eviction drain must not
    // become one cookie-laden POST per wave).
    expect(rafQueue).toHaveLength(0)
    // It rides the next driven flush.
    scheduleChannelFlush()
    await flushWindow()
    const acks = sentAcks()
    expect(acks).toHaveLength(2)
    // Nothing was ever delivery-committed on this connection — the
    // eviction alone justified the frame's contribution.
    expect(acks[1].delivered).toBe(0)
    expect(acks[1].evicted).toEqual(expect.arrayContaining(["pool-0", "pool-1", "pool-2"]))
    // The report cleared at collect — a later flush repeats nothing.
    scheduleChannelFlush()
    await flushWindow()
    expect(sentAcks()).toHaveLength(2)
  })

  it("a cull-park eviction reports; an id that held nothing does not", async () => {
    _channelEstablished("c1")
    cacheStore(getCurrentPagePartials(), "parked", "mk", "PARKED-SUBTREE")
    registerClientPartial("parked", "mk", "fp-parked")
    evictCulledContent("parked")
    evictCulledContent("never-held")
    scheduleChannelFlush()
    await flushWindow()
    const acks = sentAcks()
    expect(acks).toHaveLength(1)
    expect(acks[0].evicted).toEqual(["parked"])
  })

  it("the payload prune reports full-id and per-variant drops", async () => {
    _channelEstablished("c1")
    const cache = getCurrentPagePartials()
    cacheStore(cache, "gone", "mk", "GONE-SUBTREE")
    registerClientPartial("gone", "mk", "fp-gone")
    cacheStore(cache, "kept", "mk1", "KEPT-1")
    registerClientPartial("kept", "mk1", "fp-k1")
    cacheStore(cache, "kept", "mk2", "KEPT-2")
    registerClientPartial("kept", "mk2", "fp-k2")
    pruneToLive(new Map([["kept", new Set(["mk1"])]]))
    scheduleChannelFlush()
    await flushWindow()
    const acks = sentAcks()
    expect(acks).toHaveLength(1)
    // `gone` left the maps entirely; `kept` lost its mk2 variant —
    // both are credit the server must not confirm again.
    expect(acks[0].evicted).toEqual(expect.arrayContaining(["gone", "kept"]))
  })

  it("a fresh establishment retires pending reports — the manifest restates holdings", async () => {
    _reportContentEvicted("stale-loss")
    _channelEstablished("c1")
    scheduleChannelFlush()
    await flushWindow()
    // Only the establishment ack ships — the retired report never
    // rides it as an `evicted` statement.
    const acks = sentAcks()
    expect(acks).toHaveLength(1)
    expect(acks[0]).toEqual({ kind: "ack", delivered: 0 })
  })
})

describe("the pair-regression baseline reset", () => {
  it("resets the id's baseline so the next in-view measurement re-states the flip", async () => {
    _channelEstablished("c1")
    // The deadlock's precondition: the id is displayed in view and its
    // first measurement AGREED with the primed state — the controller
    // holds it "already in view" and would never re-state it.
    _primeVisible("clobbered", true)
    reportCullState("clobbered", true)
    reportVisible("clobbered", true)
    await flushWindow()
    fetchCalls = []

    // A commit regressed the displayed pair to its skeleton without a
    // client-stated out-flip — the pair's detector fires.
    _visibilityContentRegressed("clobbered")

    // The skeleton observer's initial callback measures in-view. With
    // the baseline reset that is a DELTA: it dispatches a flip whose
    // envelope also carries the loss report.
    reportVisible("clobbered", true)
    await flushWindow()
    const visibles = sentVisibles()
    expect(visibles).toHaveLength(1)
    expect(visibles[0].changed).toEqual(["clobbered"])
    expect(visibles[0].visible).toContain("clobbered")
    const acks = sentAcks()
    expect(acks).toHaveLength(1)
    expect(acks[0].evicted).toEqual(["clobbered"])
  })
})
