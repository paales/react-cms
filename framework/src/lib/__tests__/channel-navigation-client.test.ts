/**
 * ChannelClient — the window-navigation transport. The claims:
 *
 *   1. `_channelNavigate` reserves the navigation point at STATEMENT
 *      time (`envelopeSeq + 1` — the next envelope), ships exactly one
 *      url frame per flush (newest statement wins pre-flush), and
 *      returns milestones; a DEGRADED page returns null — the caller's
 *      document-navigation cue;
 *   2. the url producer is RELIABLE class: its frames buffer per
 *      envelope, the downstream `applied` marker prunes them, and an
 *      unpruned survivor retransmits at the next establishment with
 *      its original seq;
 *   3. attach-with-intent: a statement with NO connection latches and
 *      requests an immediate attach; the subsume folds the pending
 *      statement into the returned intent's `url`, re-anchors the
 *      records at navigation point 0, and the attach's first covering
 *      segment (as-of 0) resolves them;
 *   4. the as-of guard (`_channelDeliveryCommittable`) drops
 *      deliveries rendered before the navigation point; the server
 *      url-push gate (`_serverUrlPushApplies`) is client-wins in both
 *      directions;
 *   5. milestones wire to the covering segment: commit resolves
 *      `streaming` (and decides the commit mode), settle resolves
 *      `finished` — for every record the segment covers;
 *   6. an envelope failure with pending navigations aborts the held
 *      stream, and the close arbitration re-attaches (established
 *      fire) — the statements ride the next attach; the refetch
 *      dispatcher states batches as `?__force=` url statements on
 *      every non-degraded page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelConnectionClosed,
	_channelDeliveryCommittable,
	_channelEstablished,
	_channelNavAvailable,
	_channelNavigate,
	_channelNavPoint,
	_channelNavPrefersTransition,
	_channelNavSegmentCommitted,
	_channelNavSegmentSettled,
	_channelNavSubsumedByAttach,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_registerAttachRequester,
	_registerLiveStreamAbort,
	_resetChannelClient,
	_serverUrlPushApplies,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope } from "../channel-protocol.ts"
import { _getLiveConnectionId } from "../partial-client-state.ts"
import { enqueueRefetch } from "../refetch.ts"

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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

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

describe("the navigation point + the url frame", () => {
	it("reserves the next envelope seq at statement time and ships one url frame", async () => {
		_channelEstablished("c1")
		expect(_channelNavPoint()).toBe(0)
		const routed = _channelNavigate({ url: "/b?x=1", intent: "push" })
		expect(routed).not.toBeNull()
		// The point advances at CLICK time — before any flush — so a
		// pre-navigation delivery landing in the reservation window is
		// already droppable.
		expect(_channelNavPoint()).toBe(1)
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(1)
		expect(sentEnvelopes()[0].seq).toBe(1)
		expect(sentEnvelopes()[0].frames).toContainEqual({
			kind: "url",
			url: "/b?x=1",
			intent: "push",
		})
	})

	it("newest statement wins pre-flush — one frame ships, both records ride it", async () => {
		_channelEstablished("c1")
		const first = _channelNavigate({ url: "/b", intent: "push" })
		const second = _channelNavigate({ url: "/c", intent: "push" })
		if (!first || !second) throw new Error("expected channel routing")
		expect(_channelNavPoint()).toBe(1)
		raf()
		await settle()
		const urlFrames = sentEnvelopes()[0].frames.filter((f) => f.kind === "url")
		expect(urlFrames).toEqual([{ kind: "url", url: "/c", intent: "push" }])

		// The covering segment (as-of the shared navigation point)
		// resolves BOTH fires — its content is the newest URL's render.
		const p1 = probe(first.finished)
		const p2 = probe(second.finished)
		_channelNavSegmentCommitted(1)
		_channelNavSegmentSettled(1)
		await settle()
		expect(p1.done()).toBe(true)
		expect(p2.done()).toBe(true)
	})

	it("with no connection the statement latches and requests an immediate attach", () => {
		const requested: number[] = []
		_registerAttachRequester(() => requested.push(1))
		expect(_channelNavAvailable()).toBe(false)
		const routed = _channelNavigate({ url: "/b", intent: "push" })
		// First interaction never waits — it rides the attach it just
		// triggered (milestones resolve off that attach's covering
		// segment, exercised in the subsume claims below).
		expect(routed).not.toBeNull()
		expect(requested).toHaveLength(1)
	})

	it("returns null on a degraded page — the document-navigation cue", async () => {
		_channelEstablished("c1")
		// The connection's FIRST ack fails to deliver — the sticky page
		// degrade (the transport proved the duplex broken).
		_channelWireEntry("seq", enc("p\n1 0"))
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blocked"))
		await flushOnce()
		expect(_channelNavAvailable()).toBe(false)
		expect(_channelNavigate({ url: "/b", intent: "push" })).toBeNull()
	})
})

describe("reliable class + the attach subsume", () => {
	it("buffers the url frame, prunes on applied, retransmits an unpruned survivor", async () => {
		_channelEstablished("c1")
		_channelNavigate({ url: "/b", intent: "push", record: false })
		await flushOnce()
		expect(sentEnvelopes()).toHaveLength(1)

		// No applied marker heard — the survivor retransmits at the next
		// establishment with its ORIGINAL page-lifetime seq.
		_channelEstablished("c2")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(2)
		expect(sentEnvelopes()[1]).toMatchObject({ connection: "c2", seq: 1 })
		expect(sentEnvelopes()[1].frames).toEqual([
			{ kind: "url", url: "/b", intent: "push" },
		])

		// The applied marker covers it — nothing left to retransmit.
		_channelWireEntry("applied", enc("1"))
		_channelEstablished("c3")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(2)
	})

	it("the attach subsumes: the pending statement folds into the intent, records re-anchor at 0", async () => {
		_channelEstablished("c1")
		const fire = _channelNavigate({ url: "/b?__force=cart", intent: "silent" })
		if (!fire) throw new Error("expected channel routing")
		expect(_channelNavPoint()).toBe(1)

		const intent = _channelNavSubsumedByAttach()
		expect(intent.url).toBe("/b?__force=cart")
		expect(intent.frames).toEqual([])
		expect(_channelNavPoint()).toBe(0)

		// The attach's first covering segment — as-of 0 — resolves the
		// re-anchored record: the statement's content IS that render.
		const finished = probe(fire.finished)
		_channelNavSegmentCommitted(0)
		_channelNavSegmentSettled(0)
		await settle()
		expect(finished.done()).toBe(true)

		// Establishment after the attach: no retransmit — the statement
		// already rode the attach's own body.
		_channelEstablished("c2")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(0)
	})

	it("a statement latched pre-establishment flushes on the fresh connection", async () => {
		_registerAttachRequester(() => {})
		// Latches (no connection) — the attach it requested is presumed
		// in flight; the statement was NOT subsumed (it landed after the
		// fire), so establishment flushes it as a url frame.
		_channelNavigate({ url: "/late", intent: "push", record: false })
		expect(sentEnvelopes()).toHaveLength(0)
		_channelEstablished("c1")
		raf()
		await settle()
		const urlFrames = sentEnvelopes()
			.flatMap((e) => e.frames)
			.filter((f) => f.kind === "url")
		expect(urlFrames).toEqual([{ kind: "url", url: "/late", intent: "push" }])
	})
})

describe("the as-of guards", () => {
	it("drops deliveries rendered before the navigation point", () => {
		_channelEstablished("c1")
		expect(_channelDeliveryCommittable(0)).toBe(true)
		_channelNavigate({ url: "/b", intent: "push", record: false })
		expect(_channelDeliveryCommittable(0)).toBe(false)
		expect(_channelDeliveryCommittable(1)).toBe(true)
	})

	it("server url pushes are client-wins in both directions", () => {
		_channelEstablished("c1")
		// No navigation stated: every push applies (an uncorrelated
		// caller applies unconditionally).
		expect(_serverUrlPushApplies(undefined)).toBe(true)
		expect(_serverUrlPushApplies(0)).toBe(true)
		_channelNavigate({ url: "/b", intent: "push", record: false })
		// Rendered before the client's statement → a stale suggestion.
		expect(_serverUrlPushApplies(0)).toBe(false)
		// Rendered as-of (or after) it → the server saw the navigation;
		// its push stands.
		expect(_serverUrlPushApplies(1)).toBe(true)
	})
})

describe("milestones ride the covering segment", () => {
	it("commit resolves streaming (and decides the commit mode); settle resolves finished", async () => {
		_channelEstablished("c1")
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			streaming: false,
		})
		if (!routed) throw new Error("expected channel routing")
		const streaming = probe(routed.streaming)
		const finished = probe(routed.finished)

		// A non-covering segment (as-of 0 — pre-navigation) is not ours.
		_channelNavSegmentCommitted(0)
		await settle()
		expect(streaming.done()).toBe(false)

		// The covering commit: an atomic-swap caller makes the segment a
		// transition commit.
		expect(_channelNavPrefersTransition(1)).toBe(true)
		_channelNavSegmentCommitted(1)
		await settle()
		expect(streaming.done()).toBe(true)
		expect(finished.done()).toBe(false)

		_channelNavSegmentSettled(1)
		await settle()
		expect(finished.done()).toBe(true)
		// Retired records no longer shape commit modes.
		expect(_channelNavPrefersTransition(1)).toBe(false)
	})

	it("a progressive caller leaves the live stream's raw commit in place", () => {
		_channelEstablished("c1")
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			streaming: true,
		})
		if (!routed) throw new Error("expected channel routing")
		expect(_channelNavPrefersTransition(1)).toBe(false)
		_channelNavSegmentCommitted(1)
		_channelNavSegmentSettled(1)
	})

	it("an aborted signal rejects the record with AbortError", async () => {
		_channelEstablished("c1")
		const controller = new AbortController()
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			signal: controller.signal,
		})
		if (!routed) throw new Error("expected channel routing")
		const finished = probe(routed.finished)
		controller.abort()
		await settle()
		expect(finished.failed()).toBe(true)
	})
})

describe("connection loss under pending navigations", () => {
	it("a failed url envelope aborts the held stream; the close arbitration re-attaches", async () => {
		const aborts: number[] = []
		const attaches: number[] = []
		_registerLiveStreamAbort(() => aborts.push(1))
		_registerAttachRequester(() => attaches.push(1))
		_channelEstablished("c1")
		const fire = _channelNavigate({ url: "/c?q=1", intent: "push" })
		if (!fire) throw new Error("expected channel routing")
		fetchResults.push({ status: 404 })
		await flushOnce()
		// The stream still renders the state the page left — pulled down;
		// the heartbeat's settle re-attaches with the statement folded in.
		expect(_getLiveConnectionId()).toBeNull()
		expect(aborts).toHaveLength(1)
		_channelConnectionClosed({ aborted: true })
		expect(attaches).toHaveLength(1)
		// The statement was already consumed into the failed envelope —
		// the client's location (which the attach states) is authoritative
		// for it, so the subsume folds no URL and retires the buffered
		// frame; the re-anchored record resolves off the attach's first
		// covering segment.
		const intent = _channelNavSubsumedByAttach()
		expect(intent.url).toBeNull()
		const finished = probe(fire.finished)
		_channelNavSegmentCommitted(0)
		_channelNavSegmentSettled(0)
		await settle()
		expect(finished.done()).toBe(true)
	})

	it("an attach that settles without establishing under a pending interaction degrades the page", async () => {
		const attaches: number[] = []
		_registerAttachRequester(() => attaches.push(1))
		const fire = _channelNavigate({ url: "/b", intent: "push" })
		if (!fire) throw new Error("expected channel routing")
		expect(attaches).toHaveLength(1)
		const finished = probe(fire.finished)
		// The triggered attach settles with NO establishment (not our own
		// abort) — the transport proved unusable under a real interaction.
		_channelConnectionClosed({ aborted: false })
		expect(_channelNavAvailable()).toBe(false)
		expect(_channelNavigate({ url: "/c", intent: "push" })).toBeNull()
		// The records complete as a document navigation (no Navigation
		// API in this environment — they settle as no-ops either way).
		await settle()
		expect(finished.done()).toBe(true)
	})
})

describe("the refetch dispatcher", () => {
	it("states a selector batch as a ?__force= url statement", async () => {
		_channelEstablished("c1")
		const fire = enqueueRefetch({
			labels: ["cart"],
			streaming: false,
		})
		await settle()
		raf()
		await settle()
		const urlFrames = sentEnvelopes()
			.flatMap((e) => e.frames)
			.filter((f) => f.kind === "url")
		expect(urlFrames).toHaveLength(1)
		if (urlFrames[0].kind !== "url") throw new Error("unreachable")
		const stated = new URL(urlFrames[0].url, "http://localhost")
		expect(stated.searchParams.get("__force")).toBe("cart")
		expect(urlFrames[0].intent).toBe("silent")
		// The milestones ride the covering segment.
		const finished = probe(fire.finished)
		_channelNavSegmentCommitted(_channelNavPoint())
		_channelNavSegmentSettled(_channelNavPoint())
		await settle()
		expect(finished.done()).toBe(true)
	})

	it("a statement superseding an uncovered batch restates its targets — the union", async () => {
		_channelEstablished("c1")
		const first = enqueueRefetch({ labels: ["cart"], streaming: false })
		await settle()
		// The second batch flushes while the first is uncovered — the
		// transport keeps one pending url frame (newest wins), so the
		// newer statement must carry BOTH forces.
		const second = enqueueRefetch({ labels: ["price"], streaming: false })
		await settle()
		raf()
		await settle()
		const urlFrames = sentEnvelopes()
			.flatMap((e) => e.frames)
			.filter((f) => f.kind === "url")
		const last = urlFrames[urlFrames.length - 1]
		if (last.kind !== "url") throw new Error("unreachable")
		const force =
			new URL(last.url, "http://localhost").searchParams.get("__force") ?? ""
		expect(force.split(",")).toContain("cart")
		expect(force.split(",")).toContain("price")
		// The covering segment settles both; the restatement duty retires.
		const p1 = probe(first.finished)
		const p2 = probe(second.finished)
		_channelNavSegmentCommitted(_channelNavPoint())
		_channelNavSegmentSettled(_channelNavPoint())
		await settle()
		expect(p1.done()).toBe(true)
		expect(p2.done()).toBe(true)
		// A batch AFTER the settle restates nothing stale.
		enqueueRefetch({ labels: ["badge"], streaming: false })
		await settle()
		raf()
		await settle()
		const later = sentEnvelopes()
			.flatMap((e) => e.frames)
			.filter((f) => f.kind === "url")
			.at(-1)
		if (later?.kind !== "url") throw new Error("unreachable")
		expect(
			new URL(later.url, "http://localhost").searchParams.get("__force"),
		).toBe("badge")
	})

	it("resolves as a no-op on a degraded page — document loads are its renders", async () => {
		_channelEstablished("c1")
		_channelWireEntry("seq", enc("p\n1 0"))
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blocked"))
		await flushOnce()
		expect(_channelNavAvailable()).toBe(false)
		const fire = enqueueRefetch({ labels: ["cart"], streaming: false })
		const finished = probe(fire.finished)
		await settle()
		expect(finished.done()).toBe(true)
	})
})
