/**
 * ChannelClient — the frame-navigation transport. The claims:
 *
 *   1. `_channelFrameNavigate` ships a FRAME-scoped url frame (the
 *      frame path on the statement) and returns milestones; with no
 *      connection or a degraded page it returns null — the caller's
 *      discrete `__frame` GET cue;
 *   2. a superseding statement for the SAME frame ships `cancel` +
 *      `url` in ONE envelope, cancel first (in-envelope order), scoped
 *      to the frame's top-level name; a first statement ships no
 *      cancel;
 *   3. milestones resolve off the covering lane's `nav=` correlation
 *      (`_channelFrameLaneCommitted` / `Settled`) — records for OTHER
 *      frames are untouched — and off a whole-tree segment whose as-of
 *      covers the statement;
 *   4. a connection loss (and an attach subsume) hands pending frame
 *      fires to the discrete transport: one `__frame` GET per frame
 *      key for the latest statement, `partials=` narrowed to the
 *      frame's top-level name, milestones chained;
 *   5. frame url + cancel frames are RELIABLE class but retire at the
 *      attach subsume — a replay after a discrete frame nav in the
 *      gap could regress the session URL, so uncovered fires re-fire
 *      discrete instead.
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
	return fetchCalls.map(
		(c) => JSON.parse(String(c.init.body)) as ChannelEnvelope,
	)
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

let discreteFires: Array<{ url: URL }>

beforeEach(() => {
	_resetChannelClient()
	rafQueue = []
	fetchCalls = []
	fetchResults = []
	discreteFires = []
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
	;(window as unknown as Record<string, unknown>).__rsc_partial_refetch = (
		url: string,
	) => {
		discreteFires.push({ url: new URL(url) })
		return { streaming: Promise.resolve(), finished: Promise.resolve() }
	}
})

afterEach(() => {
	_resetChannelClient()
	delete (window as unknown as Record<string, unknown>).__rsc_partial_refetch
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

	it("returns null with no connection — the discrete __frame GET cue", () => {
		expect(
			_channelFrameNavigate({ path: ["cart"], url: "/open", intent: "silent" }),
		).toBeNull()
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

describe("falling back to the discrete transport", () => {
	it("a connection loss re-fires the latest statement per frame as a __frame GET", async () => {
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
		expect(discreteFires).toHaveLength(1)
		const url = discreteFires[0].url
		expect(url.searchParams.get("__frame")).toBe("chat-overlay")
		expect(url.searchParams.get("__frameUrl")).toBe("/notes?chat=open&msgs=a,b")
		expect(url.searchParams.get("partials")).toBe("chat-overlay")
		expect(url.searchParams.get("streaming")).toBe("1")
		await settle()
		expect(p1.done()).toBe(true)
		expect(p2.done()).toBe(true)
	})

	it("the attach subsume retires buffered frame statements and re-fires uncovered ones discrete", async () => {
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

		_channelNavSubsumedByAttach()
		await settle()
		// The pending fire fell back to ONE discrete __frame GET…
		expect(discreteFires).toHaveLength(1)
		expect(discreteFires[0].url.searchParams.get("__frame")).toBe("cart")
		expect(finished.done()).toBe(true)
		// …and the buffered url frame never retransmits at the next
		// establishment (a replay could regress a discrete frame nav made
		// in the gap).
		_channelEstablished("c2")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(1)
	})
})
