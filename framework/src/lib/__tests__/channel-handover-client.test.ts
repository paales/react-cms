/**
 * ChannelClient — the transport-handover half (fetch → WebSocket). The
 * claims:
 *
 *   1. `_channelBeginTransportHandover` is the commit point: it states
 *      the old connection's `atPark` detach on the FETCH transport —
 *      the graceful park-exit wind-down — while the id stays PUBLISHED
 *      (the old connection serves statements and actions until it
 *      actually closes). The close's settle then re-fires the attach
 *      even with no pending interaction (the one-shot reattach flag),
 *      and the replacing attach consumes the `handoverFrom` continuity
 *      link (one-shot).
 *   2. A detach the server never took falls back to aborting the held
 *      stream — its settle still re-fires.
 *   3. Statements racing the close latch (the id is unpublished
 *      between the close and the replacing establishment) and their
 *      reservations gate stale deliveries; the replacing attach's
 *      subsume folds them — the ordinary pre-establishment machinery.
 *   4. Action POSTs hold for `_channelHandoverSettled` across the
 *      close→establish window, released at establishment.
 *   5. `_channelIdle` — the upgrade's quiesce gate — resolves only
 *      when no navigation / refetch record is in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _channelBeginTransportHandover,
  _channelConnectionClosed,
  _channelEstablished,
  _channelHandoverSettled,
  _channelIdle,
  _channelNavigate,
  _channelNavSegmentCommitted,
  _channelNavSegmentSettled,
  _registerAttachRequester,
  _registerLiveStreamAbort,
  _resetChannelClient,
  _takeHandoverFrom,
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
  // Tests that moved jsdom's location put it back.
  window.history.replaceState(null, "", "/")
})

describe("beginning the handover", () => {
  it("states the old connection's atPark detach and keeps it published for the wind-down", async () => {
    _channelEstablished("old1")
    expect(_channelBeginTransportHandover()).toBe(true)
    // The id stays published — the old connection serves statements
    // and actions for the whole wind-down.
    expect(_getLiveConnectionId()).toBe("old1")
    await settle()
    const envelopes = sentEnvelopes()
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].connection).toBe("old1")
    expect(envelopes[0].frames).toContainEqual({ kind: "detach", atPark: true })
  })

  it("the close re-fires the attach, which consumes the handoverFrom link one-shot", async () => {
    const fires: number[] = []
    _registerAttachRequester(() => fires.push(1))
    _channelEstablished("old1")
    _channelBeginTransportHandover()
    await settle()
    // The park-exit ends the old stream CLEANLY — not our supersede,
    // not a failure — and the one-shot flag re-fires.
    _channelConnectionClosed({ aborted: false })
    expect(fires).toHaveLength(1)
    // The replacing attach names the wound-down connection, once.
    expect(_takeHandoverFrom()).toBe("old1")
    expect(_takeHandoverFrom()).toBeNull()
    // One-shot: a later close without a pending interaction is quiet.
    _channelEstablished("ws1")
    _channelConnectionClosed({ aborted: false })
    expect(fires).toHaveLength(1)
  })

  it("a detach the server never took aborts the held stream instead", async () => {
    let aborted = 0
    _registerLiveStreamAbort(() => {
      aborted += 1
    })
    _channelEstablished("old1")
    fetchResults.push({ status: 404 })
    _channelBeginTransportHandover()
    await settle()
    expect(aborted).toBe(1)
  })

  it("with nothing established it requests the re-fire directly", () => {
    const fires: number[] = []
    _registerAttachRequester(() => fires.push(1))
    expect(_channelBeginTransportHandover()).toBe(false)
    expect(fires).toHaveLength(1)
  })
})

describe("the close→establish window", () => {
  it("a statement racing the close latches; its reservation gates stale deliveries", async () => {
    _registerAttachRequester(() => {})
    _channelEstablished("old1")
    _channelBeginTransportHandover()
    await settle()
    // The old connection reached its park and closed — the handover's
    // only unpublished window opens here.
    _channelConnectionClosed({ aborted: false })
    const callsAtClose = fetchCalls.length
    // Latched: no connection is published. The navigation's history
    // commit precedes the statement (the Navigation API intercept), so
    // the location moves with it.
    window.history.replaceState(null, "", "/next?q=1")
    const routed = _channelNavigate({ url: "/next?q=1", intent: "push" })
    expect(routed).not.toBeNull()
    expect(fetchCalls.length).toBe(callsAtClose)
    // The replacing attach's subsume folds the statement (the ordinary
    // attach-with-intent path) and its covering segment resolves it.
    let finished = false
    routed!.finished.then(() => {
      finished = true
    })
    _channelEstablished("ws1")
    _channelNavSegmentCommitted(0)
    _channelNavSegmentSettled(0)
    await settle()
    expect(finished).toBe(false)
    // Records re-anchor at the subsume in the real path; here the
    // covering segment for the statement's own reservation resolves it.
    _channelNavSegmentCommitted(999)
    _channelNavSegmentSettled(999)
    await settle()
    expect(finished).toBe(true)
  })

  it("action POSTs hold for _channelHandoverSettled until the replacing establishment", async () => {
    _registerAttachRequester(() => {})
    _channelEstablished("old1")
    _channelBeginTransportHandover()
    // While the old connection winds down, actions proceed (the id is
    // still published) — the gate is open.
    let settledBeforeClose = false
    void _channelHandoverSettled().then(() => {
      settledBeforeClose = true
    })
    await settle()
    expect(settledBeforeClose).toBe(true)
    // The close opens the window: the gate holds…
    _channelConnectionClosed({ aborted: false })
    let released = false
    void _channelHandoverSettled().then(() => {
      released = true
    })
    await settle()
    expect(released).toBe(false)
    // …until the replacing connection establishes.
    _channelEstablished("ws1")
    await settle()
    expect(released).toBe(true)
  })
})

describe("the quiesce gate", () => {
  it("_channelIdle resolves immediately when nothing is in flight, else at the record's settle", async () => {
    _channelEstablished("c1")
    let idleNow = false
    void _channelIdle().then(() => {
      idleNow = true
    })
    await settle()
    expect(idleNow).toBe(true)

    const routed = _channelNavigate({ url: "/b", intent: "push" })
    expect(routed).not.toBeNull()
    raf()
    await settle()
    let idleLater = false
    void _channelIdle().then(() => {
      idleLater = true
    })
    await settle()
    expect(idleLater).toBe(false)
    // The covering segment settles the record — the gate releases.
    _channelNavSegmentCommitted(1)
    _channelNavSegmentSettled(1)
    await settle()
    expect(idleLater).toBe(true)
  })
})
