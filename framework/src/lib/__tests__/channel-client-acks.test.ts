/**
 * ChannelClient — delivery tracking, the ack producer, the reliable
 * buffer, and the degrade mark. The claims:
 *
 *   1. lane delivery seqs queue per parton off the wire and commit in
 *      chain order; the ack producer contributes the highest
 *      CONTIGUOUSLY committed seq (out-of-order commits wait for the
 *      gap to fill), coalesced — one cumulative frame per flush;
 *   2. the ack piggybacks on any pending statement's envelope — no
 *      envelope of its own when another producer is firing anyway;
 *   3. a DROPPED lane (stale-page guard, torn decode) consumes its
 *      queued seq without recording it, so the watermark stalls at
 *      the drop and later commits stay correctly attributed;
 *   4. segment-form `seq` entries are fetch-local: `_segmentDeliverySeq`
 *      parses them, `_channelWireEntry` ignores them;
 *   5. frames from `reliable: true` producers buffer per envelope and
 *      retransmit at the next establishment with their ORIGINAL seqs,
 *      in order, before new flushes; the downstream `applied` marker
 *      prunes the buffer; `deliveryFailed` is never called for them;
 *   6. an envelope failure carrying the connection's FIRST ack marks
 *      the page degraded (sticky); a connection that delivered an ack
 *      before a later failure is NOT degraded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelAppliedWatermark,
	_channelEstablished,
	_channelIsDegraded,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_laneDeliveryDropped,
	_resetChannelClient,
	_segmentDeliveryCommitted,
	_segmentDeliverySeq,
	type ChannelProducer,
	registerChannelProducer,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope, ChannelFrame, VisibleFrame } from "../channel-protocol.ts"
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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Feed a lane-form `seq` entry the way the wire hook receives it. */
function laneSeqEntry(partonId: string, seq: number): void {
	_channelWireEntry("seq", enc(`${partonId}\n${seq}`))
}

/** Flush the transport once: schedule → rAF → drain microtasks. */
async function flushOnce(): Promise<void> {
	scheduleChannelFlush()
	raf()
	await settle()
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

describe("delivery tracking + the ack producer", () => {
	it("acks the contiguous commit watermark; out-of-order commits wait for the gap", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p1", 1)
		laneSeqEntry("p2", 2)

		// p2's lane commits first — seq 2 is past the gap at 1: no ack.
		_laneDeliveryCommitted("p2")
		await flushOnce()
		expect(fetchCalls).toHaveLength(0)

		// p1 commits — the frontier reaches 2 through the filled gap; ONE
		// cumulative ack rides one envelope.
		_laneDeliveryCommitted("p1")
		await flushOnce()
		expect(fetchCalls).toHaveLength(1)
		const [envelope] = sentEnvelopes()
		expect(envelope.connection).toBe("c1")
		expect(envelope.frames).toEqual([{ kind: "ack", delivered: 2 }])

		// Nothing new committed — the producer stays silent.
		await flushOnce()
		expect(fetchCalls).toHaveLength(1)
	})

	it("coalesces a burst of commits into one cumulative ack", async () => {
		_channelEstablished("c1")
		for (let seq = 1; seq <= 3; seq++) laneSeqEntry("p", seq)
		_laneDeliveryCommitted("p")
		_laneDeliveryCommitted("p")
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes().map((e) => e.frames)).toEqual([
			[{ kind: "ack", delivered: 3 }],
		])
	})

	it("piggybacks the ack on a pending statement's envelope", async () => {
		const statement: VisibleFrame = {
			kind: "visible",
			changed: ["a"],
			visible: ["a"],
			cached: [],
		}
		let pending: VisibleFrame | null = statement
		registerChannelProducer({
			collect: (conn) => {
				if (conn === null || pending === null) return null
				const frame = pending
				pending = null
				return frame
			},
			deliveryFailed: vi.fn(),
		})
		_channelEstablished("c1")
		laneSeqEntry("a", 1)
		_laneDeliveryCommitted("a")
		await flushOnce()
		expect(fetchCalls).toHaveLength(1)
		expect(sentEnvelopes()[0].frames).toEqual([
			{ kind: "ack", delivered: 1 },
			statement,
		])
	})

	it("a dropped lane stalls the watermark and keeps later attribution aligned", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		laneSeqEntry("p", 2)
		// The first payload decoded but never committed (stale page):
		// its seq is consumed without recording.
		_laneDeliveryDropped("p")
		// The second payload commits — as seq 2, not seq 1: the frontier
		// stalls at 0 and no ack ever claims the dropped delivery.
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(fetchCalls).toHaveLength(0)
	})

	it("segment-form seq entries are fetch-local; commits advance the same watermark", async () => {
		_channelEstablished("c1")
		// The wire hook ignores the segment form (no parton-id prefix)…
		_channelWireEntry("seq", enc("1"))
		expect(_segmentDeliverySeq("seq", enc("1"))).toBe(1)
		expect(_segmentDeliverySeq("seq", enc("p\n2"))).toBeNull()
		expect(_segmentDeliverySeq("fp", enc("1"))).toBeNull()
		// …and the browser entry records it at commit via the dedicated
		// hook.
		_segmentDeliveryCommitted(1)
		await flushOnce()
		expect(sentEnvelopes()[0].frames).toEqual([{ kind: "ack", delivered: 1 }])
	})

	it("delivery tracking resets per connection — seqs restart with the session", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes()[0].frames).toEqual([{ kind: "ack", delivered: 1 }])

		// New connection: delivery seqs restart at 1 server-side, and so
		// does the client's watermark — the first commit acks 1 again.
		_channelEstablished("c2")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		await flushOnce()
		const envelopes = sentEnvelopes()
		expect(envelopes[1].connection).toBe("c2")
		expect(envelopes[1].frames).toEqual([{ kind: "ack", delivered: 1 }])
	})
})

describe("the reliable buffer + retransmit", () => {
	/** A reliable producer emitting caller-supplied frames once each.
	 *  The frame kind is opaque to the transport — the buffer machinery
	 *  is kind-agnostic (the url/cancel kinds land in a later package). */
	function reliableProducer(queue: ChannelFrame[]): {
		producer: ChannelProducer
		deliveryFailed: ReturnType<typeof vi.fn>
	} {
		const deliveryFailed = vi.fn()
		const producer: ChannelProducer = {
			reliable: true,
			collect: (conn) => (conn !== null ? (queue.shift() ?? null) : null),
			deliveryFailed,
		}
		registerChannelProducer(producer)
		return { producer, deliveryFailed }
	}

	const urlFrame = (href: string): ChannelFrame =>
		({ kind: "url", href }) as unknown as ChannelFrame

	it("buffers reliable envelopes, prunes on the applied marker, retransmits survivors with original seqs", async () => {
		const { deliveryFailed } = reliableProducer([
			urlFrame("/one"),
			urlFrame("/two"),
		])
		_channelEstablished("c1")
		await flushOnce() // envelope seq 1 — /one
		await flushOnce() // envelope seq 2 — /two
		expect(sentEnvelopes().map((e) => e.seq)).toEqual([1, 2])

		// The server states it applied envelope 1 — the buffer prunes it,
		// and the watermark feeds the next attach statement.
		_channelWireEntry("applied", enc("1"))
		expect(_channelAppliedWatermark()).toBe(1)

		// Reattach: the survivor retransmits FIRST, with its ORIGINAL
		// page-lifetime seq, on the new connection.
		_channelEstablished("c2")
		raf()
		await settle()
		const envelopes = sentEnvelopes()
		expect(envelopes).toHaveLength(3)
		expect(envelopes[2].connection).toBe("c2")
		expect(envelopes[2].seq).toBe(2)
		expect(envelopes[2].frames).toEqual([urlFrame("/two")])
		expect(deliveryFailed).not.toHaveBeenCalled()

		// A second reattach without an applied marker retransmits the
		// same envelope again — idempotence is the server's applied gate
		// plus the frame kind's seq-ordered statement semantics.
		_channelEstablished("c3")
		raf()
		await settle()
		expect(sentEnvelopes()[3]).toMatchObject({ connection: "c3", seq: 2 })

		// Once applied covers it, nothing retransmits.
		_channelWireEntry("applied", enc("2"))
		_channelEstablished("c4")
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(4)
	})

	it("a failed reliable envelope stays buffered and is never handed back", async () => {
		const { deliveryFailed } = reliableProducer([urlFrame("/keep")])
		_channelEstablished("c1")
		fetchResults.push({ status: 404 })
		await flushOnce()
		expect(_getLiveConnectionId()).toBeNull()
		expect(deliveryFailed).not.toHaveBeenCalled()

		// The buffer owns redelivery: the next establishment replays it.
		_channelEstablished("c2")
		raf()
		await settle()
		const envelopes = sentEnvelopes()
		expect(envelopes[1].connection).toBe("c2")
		expect(envelopes[1].seq).toBe(1)
		expect(envelopes[1].frames).toEqual([urlFrame("/keep")])
	})
})

describe("the degrade mark", () => {
	it("a failed envelope carrying the connection's FIRST ack degrades the page — sticky", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blocked by client"))
		await flushOnce()
		expect(_channelIsDegraded()).toBe(true)
		expect(_getLiveConnectionId()).toBeNull()

		// Sticky across establishments — the heartbeat reads this and
		// stops holding live attaches for the page lifetime.
		_channelEstablished("c2")
		expect(_channelIsDegraded()).toBe(true)
	})

	it("a connection whose first ack DELIVERED is never degraded by a later failure", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		laneSeqEntry("p", 2)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes()[0].frames).toEqual([{ kind: "ack", delivered: 1 }])

		// A later ack envelope fails — transient: normal fallback, no
		// page degrade.
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blip"))
		await flushOnce()
		expect(_channelIsDegraded()).toBe(false)
		expect(_getLiveConnectionId()).toBeNull()
	})

	it("a failed statement-only envelope (no ack aboard) never degrades", async () => {
		const frame: VisibleFrame = {
			kind: "visible",
			changed: ["a"],
			visible: ["a"],
			cached: [],
		}
		let pending: VisibleFrame | null = frame
		const deliveryFailed = vi.fn()
		registerChannelProducer({
			collect: (conn) => {
				if (conn === null || pending === null) return null
				const f = pending
				pending = null
				return f
			},
			deliveryFailed,
		})
		_channelEstablished("c1")
		fetchResults.push(new Error("blip"))
		await flushOnce()
		expect(_channelIsDegraded()).toBe(false)
		expect(deliveryFailed).toHaveBeenCalledExactlyOnceWith(frame)
	})
})
