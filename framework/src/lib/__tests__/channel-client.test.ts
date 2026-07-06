/**
 * ChannelClient — envelope assembly, coalescing, seq, and the
 * fallback signal, tested against mock producers and a stubbed
 * transport. The claims:
 *
 *   1. one flush collects at most one frame per producer into ONE
 *      envelope — a burst of flush requests within a frame coalesces;
 *   2. the envelope seq is per-connection monotonic and restarts at
 *      establishment;
 *   3. with no connection open, `collect(null)` is the producers' cue
 *      (their own fallback) and nothing POSTs;
 *   4. a non-204 answer or a network failure clears the published id
 *      and hands each carried frame back via `deliveryFailed`;
 *   5. dispatch serializes — a flush requested mid-flight re-fires
 *      when the envelope lands instead of racing it;
 *   6. `pagehide` sends a `detach` frame via a keepalive fetch and
 *      clears the id;
 *   7. establishment sets the `data-parton-live` liveness marker and
 *      notifies listeners; close removes it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelConnectionClosed,
	_channelEstablished,
	type ChannelProducer,
	onChannelEstablished,
	registerChannelProducer,
	_resetChannelClient,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope, VisibleFrame } from "../channel-protocol.ts"
import { _getLiveConnectionId } from "../partial-client-state.ts"

// Deterministic rAF: callbacks queue here and run via `raf()`.
let rafQueue: FrameRequestCallback[] = []
function raf(): void {
	const queue = rafQueue
	rafQueue = []
	for (const cb of queue) cb(0)
}

// Controllable fetch: each call records its args and resolves with the
// next queued status (default 204). A queued rejection simulates a
// network failure.
let fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchResults: Array<{ status: number } | Error> = []
async function settle(): Promise<void> {
	// Drain the microtask chain the async flush walks through.
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

function visibleFrame(changed: string[]): VisibleFrame {
	return { kind: "visible", changed, visible: changed, cached: [] }
}

function sentEnvelopes(): ChannelEnvelope[] {
	return fetchCalls.map(
		(c) => JSON.parse(String(c.init.body)) as ChannelEnvelope,
	)
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

describe("ChannelClient", () => {
	it("coalesces a burst into one envelope with one frame per producer", async () => {
		const a: ChannelProducer = {
			collect: (conn) => (conn !== null ? visibleFrame(["a"]) : null),
			deliveryFailed: vi.fn(),
		}
		const b: ChannelProducer = {
			collect: (conn) => (conn !== null ? visibleFrame(["b"]) : null),
			deliveryFailed: vi.fn(),
		}
		registerChannelProducer(a)
		registerChannelProducer(b)
		_channelEstablished("conn-1")

		scheduleChannelFlush()
		scheduleChannelFlush()
		scheduleChannelFlush()
		raf()
		await settle()

		expect(fetchCalls).toHaveLength(1)
		const [envelope] = sentEnvelopes()
		expect(envelope.connection).toBe("conn-1")
		expect(envelope.seq).toBe(1)
		expect(envelope.frames).toEqual([visibleFrame(["a"]), visibleFrame(["b"])])
		// Fire-and-forget: the envelope survives a page unload.
		expect(fetchCalls[0].init.keepalive).toBe(true)
	})

	it("mints a per-connection monotonic seq, restarting at establishment", async () => {
		let pending: string[] | null = ["x"]
		registerChannelProducer({
			collect: (conn) => {
				if (conn === null || pending === null) return null
				const frame = visibleFrame(pending)
				pending = null
				return frame
			},
			deliveryFailed: vi.fn(),
		})
		_channelEstablished("conn-1")
		scheduleChannelFlush()
		raf()
		await settle()
		pending = ["y"]
		scheduleChannelFlush()
		raf()
		await settle()
		expect(sentEnvelopes().map((e) => e.seq)).toEqual([1, 2])

		// A new connection starts a new session server-side — its seq gate
		// starts fresh, and so does the transport's counter.
		_channelEstablished("conn-2")
		pending = ["z"]
		scheduleChannelFlush()
		raf()
		await settle()
		const envelopes = sentEnvelopes()
		expect(envelopes[2].connection).toBe("conn-2")
		expect(envelopes[2].seq).toBe(1)
	})

	it("with no connection, collect(null) cues the producers' fallback and nothing POSTs", async () => {
		const collect = vi.fn().mockReturnValue(null)
		registerChannelProducer({ collect, deliveryFailed: vi.fn() })
		scheduleChannelFlush()
		raf()
		await settle()
		expect(collect).toHaveBeenCalledWith(null)
		expect(fetchCalls).toHaveLength(0)
	})

	it("a non-204 answer clears the id and hands the frame back", async () => {
		const deliveryFailed = vi.fn()
		const frame = visibleFrame(["a"])
		registerChannelProducer({
			collect: (conn) => (conn !== null ? frame : null),
			deliveryFailed,
		})
		_channelEstablished("conn-gone")
		fetchResults.push({ status: 404 })
		scheduleChannelFlush()
		raf()
		await settle()
		expect(_getLiveConnectionId()).toBeNull()
		expect(deliveryFailed).toHaveBeenCalledExactlyOnceWith(frame)
	})

	it("a network failure clears the id and hands the frame back", async () => {
		const deliveryFailed = vi.fn()
		const frame = visibleFrame(["a"])
		registerChannelProducer({
			collect: (conn) => (conn !== null ? frame : null),
			deliveryFailed,
		})
		_channelEstablished("conn-net")
		fetchResults.push(new Error("network down"))
		scheduleChannelFlush()
		raf()
		await settle()
		expect(_getLiveConnectionId()).toBeNull()
		expect(deliveryFailed).toHaveBeenCalledExactlyOnceWith(frame)
	})

	it("serializes dispatch — a flush requested mid-flight re-fires when the envelope lands", async () => {
		let payloads: string[][] = [["first"]]
		registerChannelProducer({
			collect: (conn) => {
				if (conn === null) return null
				const next = payloads.shift()
				return next ? visibleFrame(next) : null
			},
			deliveryFailed: vi.fn(),
		})
		_channelEstablished("conn-serial")

		// Hold the first envelope's fetch open.
		let releaseFirst!: (r: { status: number }) => void
		const held = new Promise<{ status: number }>((resolve) => {
			releaseFirst = resolve
		})
		vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
			fetchCalls.push({ url, init })
			if (fetchCalls.length === 1) return held
			return Promise.resolve({ status: 204 })
		})

		scheduleChannelFlush()
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(1)

		// A second statement lands while the first envelope is in flight:
		// its rAF flush parks (serialized), then re-fires on completion.
		payloads = [["second"]]
		scheduleChannelFlush()
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(1)

		releaseFirst({ status: 204 })
		await settle()
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(2)
		expect(sentEnvelopes()[1].frames).toEqual([visibleFrame(["second"])])
	})

	it("pagehide sends a detach frame via keepalive fetch and clears the id", async () => {
		_channelEstablished("conn-detach")
		window.dispatchEvent(new Event("pagehide"))
		await settle()
		expect(_getLiveConnectionId()).toBeNull()
		expect(fetchCalls).toHaveLength(1)
		const [envelope] = sentEnvelopes()
		expect(envelope.connection).toBe("conn-detach")
		expect(envelope.frames).toEqual([{ kind: "detach" }])
		expect(fetchCalls[0].init.keepalive).toBe(true)

		// No connection → pagehide sends nothing.
		window.dispatchEvent(new Event("pagehide"))
		await settle()
		expect(fetchCalls).toHaveLength(1)
	})

	it("establishment publishes the liveness marker and notifies listeners; close retracts it", () => {
		const seen: string[] = []
		onChannelEstablished((id) => seen.push(id))
		_channelEstablished("conn-live")
		expect(seen).toEqual(["conn-live"])
		expect(_getLiveConnectionId()).toBe("conn-live")
		expect(document.documentElement.hasAttribute("data-parton-live")).toBe(true)
		_channelConnectionClosed()
		expect(_getLiveConnectionId()).toBeNull()
		expect(document.documentElement.hasAttribute("data-parton-live")).toBe(false)
	})
})
