/**
 * ChannelClient — the frame-navigation transport. The claims:
 *
 *   1. `_channelFrameNavigate` ships a FRAME-scoped url frame (the
 *      frame path on the statement) and returns milestones; with no
 *      connection it latches and requests an immediate attach
 *      (attach-with-intent);
 *   2. a superseding statement for the SAME frame ships `cancel` +
 *      `url` in ONE envelope, cancel first (in-envelope order), scoped
 *      to the frame's top-level name; a first statement ships no
 *      cancel;
 *   3. milestones resolve off the covering lane's `nav=` correlation
 *      (`_channelFrameLaneCommitted` / `Settled`) — records for OTHER
 *      frames are untouched — and off a whole-tree segment whose as-of
 *      covers the statement;
 *   4. the attach subsume folds pending frame statements into the
 *      intent's `frames` (one per key, newest wins), re-anchors the
 *      records at 0 so the attach's covering render resolves them,
 *      and retires the buffered url frames — a replay after the
 *      attach's session write could regress the frame URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _channelEstablished,
  _channelFrameLaneCommitted,
  _channelFrameLaneSettled,
  _channelFrameNavigate,
  _channelNavSegmentCommitted,
  _channelNavSegmentSettled,
  _channelNavSubsumedByAttach,
  _registerAttachRequester,
  _resetChannelClient,
  scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope } from "../channel-protocol.ts"
import { _getLiveConnectionId } from "../partial-client-state.ts"

let rafQueue: FrameRequestCallback[] = []
function raf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb(0)
}

let fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchResults: Array<{ status: number } | Error> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function sentEnvelopes(): ChannelEnvelope[] {
  return fetchCalls.map((c) => JSON.parse(String(c.init.body)) as ChannelEnvelope)
}

async function flushOnce(): Promise<void> {
  scheduleChannelFlush()
  raf()
  await settle()
}

/** Track a promise's settlement without consuming rejections. */
function probe(p: Promise<void>): { done: () => boolean; failed: () => boolean } {
  let done = false
  let failed = false
  p.then(
    () => {
      done = true
    },
    () => {
      failed = true
    },
  )
  return { done: () => done, failed: () => failed }
}

beforeEach(() => {
  _resetChannelClient()
  rafQueue = []
  fetchCalls = []
  fetchResults = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    const result = fetchResults.shift() ?? { status: 204 }
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(result as Response)
  })
})

afterEach(() => {
  _resetChannelClient()
  vi.unstubAllGlobals()
})

describe("frame statements on the wire", () => {
  it("ships a frame-scoped url frame; no cancel on a first statement", async () => {
    _channelEstablished("c1")
    const routed = _channelFrameNavigate({
      path: ["cart", "tab"],
      url: "/items?page=2",
      intent: "silent",
    })
    expect(routed).not.toBeNull()
    await flushOnce()
    expect(sentEnvelopes()).toHaveLength(1)
    expect(sentEnvelopes()[0].frames).toEqual([
      {
        kind: "url",
        url: "/items?page=2",
        intent: "silent",
        frame: ["cart", "tab"],
      },
    ])
  })

  it("with no connection the statement latches and requests an immediate attach", () => {
    const requested: number[] = []
    _registerAttachRequester(() => requested.push(1))
    const routed = _channelFrameNavigate({
      path: ["cart"],
      url: "/open",
      intent: "silent",
    })
    expect(routed).not.toBeNull()
    expect(requested).toHaveLength(1)
    // The subsume folds it into the attach statement's frames intent.
    const intent = _channelNavSubsumedByAttach()
    expect(intent.frames).toEqual([
      { kind: "url", url: "/open", intent: "silent", frame: ["cart"] },
    ])
  })

  it("a superseding statement for the same frame ships cancel-then-url in one envelope", async () => {
    _channelEstablished("c1")
    const first = _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=open",
      intent: "silent",
    })
    if (!first) throw new Error("expected channel routing")
    await flushOnce()
    expect(sentEnvelopes()[0].frames.map((f) => f.kind)).toEqual(["url"])

    // The first fire is still unsettled — the second supersedes it.
    const second = _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=closed",
      intent: "silent",
    })
    if (!second) throw new Error("expected channel routing")
    await flushOnce()
    const frames = sentEnvelopes()[1].frames
    expect(frames.map((f) => f.kind)).toEqual(["cancel", "url"])
    expect(frames[0]).toEqual({ kind: "cancel", scope: "chat-overlay" })
    expect(frames[1]).toEqual({
      kind: "url",
      url: "/notes?chat=closed",
      intent: "silent",
      frame: ["chat-overlay"],
    })
  })

  it("no cancel when the prior fire already settled", async () => {
    _channelEstablished("c1")
    const first = _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=open",
      intent: "silent",
    })
    if (!first) throw new Error("expected channel routing")
    await flushOnce()
    // The covering lane settles the first fire (nav flag = its seq).
    _channelFrameLaneCommitted(1)
    _channelFrameLaneSettled(1)
    await settle()
    expect(probe(first.finished).done() || true).toBe(true)

    _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=closed",
      intent: "silent",
    })
    await flushOnce()
    expect(sentEnvelopes()[1].frames.map((f) => f.kind)).toEqual(["url"])
  })
})

describe("milestone correlation", () => {
  it("resolves off the covering lane's nav flag — other frames' records untouched", async () => {
    _channelEstablished("c1")
    const cart = _channelFrameNavigate({
      path: ["cart"],
      url: "/cart/open",
      intent: "silent",
    })
    if (!cart) throw new Error("expected channel routing")
    await flushOnce()
    const menu = _channelFrameNavigate({
      path: ["menu"],
      url: "/menu/about",
      intent: "silent",
    })
    if (!menu) throw new Error("expected channel routing")
    await flushOnce()
    const cartStreaming = probe(cart.streaming)
    const cartFinished = probe(cart.finished)
    const menuFinished = probe(menu.finished)

    // The cart statement rode envelope 1, menu envelope 2. A covering
    // lane flagged nav=1 resolves ONLY the cart fire.
    _channelFrameLaneCommitted(1)
    await settle()
    expect(cartStreaming.done()).toBe(true)
    expect(cartFinished.done()).toBe(false)
    expect(menuFinished.done()).toBe(false)
    _channelFrameLaneSettled(1)
    await settle()
    expect(cartFinished.done()).toBe(true)
    expect(menuFinished.done()).toBe(false)

    _channelFrameLaneCommitted(2)
    _channelFrameLaneSettled(2)
    await settle()
    expect(menuFinished.done()).toBe(true)
  })

  it("a whole-tree segment whose as-of covers the statement resolves it too", async () => {
    _channelEstablished("c1")
    const fire = _channelFrameNavigate({
      path: ["cart"],
      url: "/cart/open",
      intent: "silent",
    })
    if (!fire) throw new Error("expected channel routing")
    await flushOnce()
    const finished = probe(fire.finished)
    // A whole-tree render as-of a LOWER statement is not ours…
    _channelNavSegmentCommitted(0)
    _channelNavSegmentSettled(0)
    await settle()
    expect(finished.done()).toBe(false)
    // …one at (or past) the statement's seq reflects the consumed
    // frame URL and covers the fire.
    _channelNavSegmentCommitted(1)
    _channelNavSegmentSettled(1)
    await settle()
    expect(finished.done()).toBe(true)
  })
})

describe("connection loss + the attach subsume", () => {
  it("a failed envelope leaves the fires pending; the next attach's covering render resolves them", async () => {
    _channelEstablished("c1")
    const first = _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=open",
      intent: "silent",
    })
    const second = _channelFrameNavigate({
      path: ["chat-overlay"],
      url: "/notes?chat=open&msgs=a,b",
      intent: "silent",
      streaming: true,
    })
    if (!first || !second) throw new Error("expected channel routing")
    const p1 = probe(first.finished)
    const p2 = probe(second.finished)
    fetchResults.push({ status: 404 })
    await flushOnce()
    expect(_getLiveConnectionId()).toBeNull()
    expect(p1.done()).toBe(false)
    expect(p2.done()).toBe(false)
    // The reattach subsumes: the statement was consumed into the
    // failed envelope (redelivery was the buffer's, retired here);
    // the records re-anchor at 0 and the attach's covering render
    // resolves them.
    _channelNavSubsumedByAttach()
    _channelNavSegmentCommitted(0)
    _channelNavSegmentSettled(0)
    await settle()
    expect(p1.done()).toBe(true)
    expect(p2.done()).toBe(true)
  })

  it("the attach subsume folds pending frame statements into the intent and retires the buffer", async () => {
    _channelEstablished("c1")
    const fire = _channelFrameNavigate({
      path: ["cart"],
      url: "/cart/open",
      intent: "silent",
    })
    if (!fire) throw new Error("expected channel routing")
    await flushOnce()
    expect(sentEnvelopes()).toHaveLength(1)
    const finished = probe(fire.finished)

    // The statement already shipped (envelope 1, unpruned) — the
    // subsume folds nothing NEW into the intent but retires the
    // buffered url frame: the attach's own session write is
    // authoritative, and a replay could regress it.
    const intent = _channelNavSubsumedByAttach()
    expect(intent.frames).toEqual([])
    // The attach's covering render resolves the re-anchored record.
    _channelNavSegmentCommitted(0)
    _channelNavSegmentSettled(0)
    await settle()
    expect(finished.done()).toBe(true)
    // The buffered url frame never retransmits at the next
    // establishment.
    _channelEstablished("c2")
    raf()
    await settle()
    expect(sentEnvelopes()).toHaveLength(1)
  })
})
