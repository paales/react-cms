/**
 * The warm intent — the preload statement's client half. The claims:
 *
 *   1. `_channelWarm` ships a `warm` frame on the open connection —
 *      newest-wins (one pending target, the latest hover);
 *   2. with no connection it DROPS (a preload is advisory and must
 *      never trigger an attach — the navigation itself will);
 *   3. a failed envelope drops it too (lossy class — no re-queue).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelEstablished,
	_channelWarm,
	_resetChannelClient,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope } from "../channel-protocol.ts"

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

function sentFrames(): ChannelEnvelope["frames"] {
	return fetchCalls.flatMap(
		(c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames,
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

describe("the warm producer", () => {
	it("ships one warm frame, newest-wins", async () => {
		_channelEstablished("c1")
		expect(_channelWarm("/a")).toBe(true)
		expect(_channelWarm("/b")).toBe(true)
		raf()
		await settle()
		expect(sentFrames()).toEqual([{ kind: "warm", url: "/b" }])
	})

	it("drops with no connection — advisory, never an attach trigger", async () => {
		expect(_channelWarm("/a")).toBe(false)
		_channelEstablished("c1")
		scheduleChannelFlush()
		raf()
		await settle()
		expect(sentFrames()).toEqual([])
	})

	it("a failed envelope drops the statement — no re-queue", async () => {
		_channelEstablished("c1")
		_channelWarm("/a")
		fetchResults.push(new Error("blocked"))
		raf()
		await settle()
		// Re-establish: nothing pends, nothing retransmits.
		_channelEstablished("c2")
		scheduleChannelFlush()
		raf()
		await settle()
		expect(sentFrames().filter((f) => f.kind === "warm")).toHaveLength(1)
	})
})
