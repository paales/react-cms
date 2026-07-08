/**
 * Telemetry — the channel's LOSSY frame class, client side. The
 * claims:
 *
 *   1. decoder: a well-formed telemetry frame decodes strict-known
 *      (extra fields dropped); any malformed known field is a protocol
 *      violation (`null` envelope), exactly like the other kinds;
 *   2. newest-wins, no queue: a burst of reports contributes ONE frame
 *      per flush — the latest — and a consumed statement never
 *      re-sends;
 *   3. telemetry never generates traffic of its own: `reportTelemetry`
 *      schedules nothing — the frame rides the next envelope another
 *      statement justifies;
 *   4. droppable: a failed envelope drops the frame (`deliveryFailed`
 *      re-queues nothing) and it never enters the retransmit buffer
 *      (not `reliable`); `collect(null)` — no connection — drops the
 *      pending statement instead of holding it stale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _channelEstablished,
  _resetChannelClient,
  type ChannelProducer,
  registerChannelProducer,
  scheduleChannelFlush,
} from "../channel-client.ts"
import {
  type ChannelEnvelope,
  decodeChannelEnvelope,
  type TelemetryFrame,
} from "../channel-protocol.ts"
import { _resetTelemetry, _telemetryProducer, reportTelemetry } from "../telemetry.ts"

// Deterministic rAF: callbacks queue here and run via `raf()`.
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

function telemetryInput(vx: number) {
  return {
    viewport: { w: 1280, h: 800 },
    scroll: { x: 16384, y: 16384, vx, vy: 0 },
    at: 1000 + vx,
  }
}

/** A loss-tolerant co-rider whose statement justifies the envelope —
 *  the flip/ack role in production. */
function coRider(): { producer: ChannelProducer; arm: () => void } {
  let pending = false
  return {
    producer: {
      collect: (conn) => {
        if (conn === null || !pending) return null
        pending = false
        return { kind: "visible", changed: ["x"], visible: ["x"] }
      },
      deliveryFailed: () => {},
    },
    arm: () => {
      pending = true
    },
  }
}

beforeEach(() => {
  _resetChannelClient()
  _resetTelemetry()
  // The reset clears the producer set — re-register the telemetry
  // producer the module registered at import.
  registerChannelProducer(_telemetryProducer)
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
  _resetTelemetry()
  vi.unstubAllGlobals()
})

describe("telemetry frame decoding", () => {
  const frame = {
    kind: "telemetry",
    viewport: { w: 1920, h: 1080 },
    scroll: { x: 100, y: 200, vx: -812.5, vy: 40 },
    at: 1234.5,
  }
  const envelope = (f: unknown) => ({ connection: "c", seq: 1, frames: [f] })

  it("decodes a well-formed frame, dropping unknown extras (strict-known)", () => {
    const decoded = decodeChannelEnvelope(
      envelope({
        ...frame,
        future: "field",
        scroll: { ...frame.scroll, extra: 1 },
      }),
    )
    expect(decoded?.frames).toEqual([frame])
  })

  it("rejects malformed known fields as protocol violations", () => {
    for (const bad of [
      { ...frame, viewport: { w: 1920 } },
      { ...frame, viewport: null },
      { ...frame, scroll: { ...frame.scroll, vx: Number.NaN } },
      { ...frame, scroll: { ...frame.scroll, y: "200" } },
      { ...frame, at: Number.POSITIVE_INFINITY },
      { ...frame, at: undefined },
    ]) {
      expect(decodeChannelEnvelope(envelope(bad))).toBeNull()
    }
  })
})

describe("the lossy telemetry producer", () => {
  it("newest-wins: a burst of reports rides ONE envelope with the latest frame, then nothing re-sends", async () => {
    const rider = coRider()
    registerChannelProducer(rider.producer)
    _channelEstablished("conn-t")

    reportTelemetry(telemetryInput(100))
    reportTelemetry(telemetryInput(200))
    reportTelemetry(telemetryInput(300))
    rider.arm()
    scheduleChannelFlush()
    raf()
    await settle()

    expect(fetchCalls).toHaveLength(1)
    const frames = sentEnvelopes()[0].frames
    const telemetry = frames.filter((f) => f.kind === "telemetry")
    expect(telemetry).toHaveLength(1)
    expect((telemetry[0] as TelemetryFrame).scroll.vx).toBe(300)

    // Consumed: the next justified envelope carries no telemetry.
    rider.arm()
    scheduleChannelFlush()
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(2)
    expect(sentEnvelopes()[1].frames.some((f) => f.kind === "telemetry")).toBe(false)
  })

  it("reportTelemetry schedules nothing — no envelope fires at telemetry's own cadence", async () => {
    _channelEstablished("conn-t")
    reportTelemetry(telemetryInput(100))
    reportTelemetry(telemetryInput(200))
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(0)
  })

  it("a failed envelope drops the frame — no re-queue, no retransmit", async () => {
    const rider = coRider()
    registerChannelProducer(rider.producer)
    _channelEstablished("conn-t")

    reportTelemetry(telemetryInput(100))
    rider.arm()
    fetchResults.push({ status: 404 })
    scheduleChannelFlush()
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(1)

    // Re-establish: no retransmit fires (telemetry is not reliable —
    // the buffer holds nothing), and the next justified envelope
    // carries no resurrected telemetry.
    _channelEstablished("conn-t2")
    rider.arm()
    scheduleChannelFlush()
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(2)
    const second = sentEnvelopes()[1]
    expect(second.connection).toBe("conn-t2")
    expect(second.seq).toBe(2) // fresh seq, not a replay of 1
    expect(second.frames.some((f) => f.kind === "telemetry")).toBe(false)
  })

  it("collect(null) drops the pending statement — stale context is never held for later", async () => {
    reportTelemetry(telemetryInput(100))
    // No connection: the flush cues producers with null and POSTs
    // nothing; the pending statement is dropped, not parked.
    scheduleChannelFlush()
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(0)

    const rider = coRider()
    registerChannelProducer(rider.producer)
    _channelEstablished("conn-t")
    rider.arm()
    scheduleChannelFlush()
    raf()
    await settle()
    expect(fetchCalls).toHaveLength(1)
    expect(sentEnvelopes()[0].frames.some((f) => f.kind === "telemetry")).toBe(false)
  })
})
