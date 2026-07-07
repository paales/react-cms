/**
 * Visibility statement cadence — the passenger policy.
 *
 * The controller drives a transport flush only for what has urgency:
 * a real viewport DELTA (content must materialize / parking must
 * update), and the once-per-establishment full-set sync (the session's
 * set may lag the attach seed, and nothing else is guaranteed to flush
 * after establishment). A first measurement that AGREES with the
 * primed display state — `newlyMeasured` — has none: it marks the
 * producer dirty and rides the next driven envelope (the ack-cadence
 * precedent), so a lane-commit wave mounting fresh skeletons never
 * turns into one cookie-laden POST per frame saying `changed: []`.
 *
 * The claims:
 *   1. a newlyMeasured-only state requests NO flush;
 *   2. it rides the next flush another statement drives (own flip or
 *      another producer's), as the full-set sync frame;
 *   3. a real flip still drives its own flush;
 *   4. the establishment full-set sync still drives its own flush;
 *   5. the no-connection fallback keeps its semantics: measurement
 *      syncs are consumed without a reload, in-view flips reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelEstablished,
	registerChannelProducer,
	_resetChannelClient,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope, VisibleFrame } from "../channel-protocol.ts"
import { _resetCullPark } from "../cull-park.ts"
import { _primeVisible, _resetVisibilityController, reportVisible } from "../visibility.tsx"

vi.mock("../refetch.ts", () => ({
	enqueueRefetch: vi.fn(() => ({ finished: Promise.resolve() })),
}))
import { enqueueRefetch } from "../refetch.ts"

// Deterministic rAF: callbacks queue here and run via `raf()`.
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

function sentFrames(): VisibleFrame[] {
	return fetchCalls
		.flatMap((c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames)
		.filter((f): f is VisibleFrame => f.kind === "visible")
}

/** Drain a would-be flush window and return how many POSTs it produced. */
async function flushWindow(): Promise<number> {
	const before = fetchCalls.length
	raf()
	await settle()
	return fetchCalls.length - before
}

beforeEach(() => {
	_resetChannelClient()
	_resetVisibilityController()
	_resetCullPark()
	vi.mocked(enqueueRefetch).mockClear()
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

/** Establish a connection and consume its first-measurement sync via a
 *  seed id, so the tests below observe steady-state cadence only. */
async function establishPastSync(): Promise<void> {
	_channelEstablished("conn-1")
	_primeVisible("seed", true)
	reportVisible("seed", true) // first measurement → arms + drives the sync
	raf()
	await settle()
	fetchCalls = []
}

describe("visibility statement cadence", () => {
	it("a newlyMeasured-only report requests no flush", async () => {
		await establishPastSync()
		// A freshly mounted skeleton measures OUT, agreeing with its
		// primed display state — no flip, no urgency.
		_primeVisible("late-out", false)
		reportVisible("late-out", false)
		expect(rafQueue).toHaveLength(0)
		expect(await flushWindow()).toBe(0)
	})

	it("the dirty measurement rides the next flip-driven flush as the full-set report", async () => {
		await establishPastSync()
		_primeVisible("late-out", false)
		reportVisible("late-out", false)
		expect(await flushWindow()).toBe(0)
		// A real flip elsewhere drives — ONE envelope, whose statement's
		// snapshot carries the session everything measured so far.
		reportVisible("seed", false)
		expect(await flushWindow()).toBe(1)
		const [frame] = sentFrames()
		expect(frame.changed).toEqual(["seed"])
		expect(frame.visible).toEqual([])
		// The ride consumed the dirty state: nothing left to say.
		scheduleChannelFlush()
		expect(await flushWindow()).toBe(0)
	})

	it("the dirty measurement rides another producer's flush", async () => {
		await establishPastSync()
		let pending: { kind: "ack"; delivered: number } | null = { kind: "ack", delivered: 7 }
		registerChannelProducer({
			collect: (conn) => {
				if (conn === null || pending === null) return null
				const frame = pending
				pending = null
				return frame
			},
			deliveryFailed: () => {},
		})
		_primeVisible("late-in", true)
		reportVisible("late-in", true) // agrees with prime — passenger
		expect(await flushWindow()).toBe(0)
		// The other producer drives; the visibility sync co-rides.
		scheduleChannelFlush()
		expect(await flushWindow()).toBe(1)
		const [frame] = sentFrames()
		expect(frame.changed).toEqual([])
		expect(frame.visible).toEqual(expect.arrayContaining(["seed", "late-in"]))
	})

	it("a real flip drives its own flush", async () => {
		await establishPastSync()
		_primeVisible("flip", false)
		reportVisible("flip", true) // delta against the primed state
		expect(await flushWindow()).toBe(1)
		const [frame] = sentFrames()
		expect(frame.changed).toEqual(["flip"])
	})

	it("the establishment full-set sync drives its own flush", async () => {
		_channelEstablished("conn-sync")
		// First measurement agrees with the prime — no flip anywhere; the
		// establishment sync alone must still reach the session.
		_primeVisible("agrees", true)
		reportVisible("agrees", true)
		expect(await flushWindow()).toBe(1)
		const [frame] = sentFrames()
		expect(frame.changed).toEqual([])
		expect(frame.visible).toEqual(["agrees"])
	})

	it("fallback: measurement-only state never reloads; an in-view flip does", async () => {
		// No connection established. A measurement-only state is moot
		// without a session — even a flush another caller drives consumes
		// it without a reload.
		_primeVisible("cold-out", false)
		reportVisible("cold-out", false)
		scheduleChannelFlush()
		expect(await flushWindow()).toBe(0)
		expect(enqueueRefetch).not.toHaveBeenCalled()
		// A real in-view flip rides the discrete reload with the set.
		_primeVisible("cold-in", false)
		reportVisible("cold-in", true)
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(0) // no envelope — no connection
		expect(enqueueRefetch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				labels: ["cold-in"],
				cullFlip: true,
				params: { visible: "cold-in" },
			}),
		)
	})
})
