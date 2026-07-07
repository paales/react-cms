/**
 * ChannelClient — delivery tracking, the ack producer, the reliable
 * buffer, and the degrade mark. The claims:
 *
 *   1. lane delivery seqs queue per parton off the wire and commit in
 *      chain order; the ack producer contributes the highest
 *      CONTIGUOUSLY committed seq (out-of-order commits wait for the
 *      gap to fill), coalesced — one cumulative frame per flush;
 *   2. the ack is a PASSENGER, never a driver: past the connection's
 *      delivered first ack, a watermark advance flushes NOTHING of its
 *      own — the current watermark rides any envelope other statements
 *      justify. Exactly two advances drive a flush: the connection's
 *      FIRST committed delivery (the prompt duplex proof), and the
 *      unacked count crossing ACK_FLUSH_THRESHOLD — half the server's
 *      backpressure window, so steady state keeps 2× headroom;
 *   3. a DROPPED lane (stale-page guard on a dying stream, torn
 *      decode) consumes its queued seq without recording it, so the
 *      watermark stalls at the drop and later commits stay correctly
 *      attributed; an AS-OF drop (`_laneDeliveryDroppedStale` — a
 *      continuing stream whose delivery predates the navigation
 *      point) consumes PROCESSED, advancing the watermark, and a
 *      reported drop (`_reportAsOfDrop`) rides the next ack's `dropped`
 *      set so the server evicts the delivery's mirror promotions;
 *   4. segment-form `seq` entries are fetch-local: `_segmentDelivery`
 *      parses them (seq + as-of), `_channelWireEntry` ignores them;
 *   5. frames from `reliable: true` producers buffer per envelope and
 *      retransmit at the next establishment with their ORIGINAL seqs,
 *      in order, before new flushes; the downstream `applied` marker
 *      prunes the buffer; `deliveryFailed` is never called for them;
 *   6. bounded re-establishment: a SINGLE failed first-ack envelope
 *      re-attaches (not a degrade); only a RUN past the failure limit
 *      falls to document-nav mode, and a later delivered ack RECOVERS
 *      it. A connection that delivered an ack before a later failure is
 *      never degraded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelAppliedWatermark,
	_channelConnectionClosed,
	_channelEstablished,
	_channelIsDegraded,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_laneDeliveryDropped,
	_laneDeliveryDroppedStale,
	_registerAttachRequester,
	_registerLiveStreamAbort,
	_reportAsOfDrop,
	_resetChannelClient,
	_segmentDelivery,
	_segmentDeliveryCommitted,
	type ChannelProducer,
	registerChannelProducer,
	scheduleChannelFlush,
} from "../channel-client.ts"
import {
	type ChannelEnvelope,
	type ChannelFrame,
	UNACKED_DELIVERY_WINDOW,
	type VisibleFrame,
} from "../channel-protocol.ts"
import { _getLiveConnectionId } from "../partial-client-state.ts"

// The transport's driving cadence, by its own derivation: half the
// server's backpressure window.
const ACK_FLUSH_THRESHOLD = UNACKED_DELIVERY_WINDOW / 2

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

/** Feed a lane-form `seq` entry the way the wire hook receives it —
 *  `<parton-id>\n<seq> <asof>`. */
function laneSeqEntry(partonId: string, seq: number, asOf = 0): void {
	_channelWireEntry("seq", enc(`${partonId}\n${seq} ${asOf}`))
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

		// p1 commits — the frontier reaches 2 through the filled gap; the
		// connection's FIRST committed delivery drives ONE flush, and the
		// cumulative ack rides it.
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

	it("the first committed delivery drives a prompt flush of its own — the duplex proof", async () => {
		_channelEstablished("c1")
		expect(rafQueue).toHaveLength(0)
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		// The commit alone scheduled the flush — no producer, no manual
		// request. The degrade machinery on both sides times exactly this
		// promptness (FIRST_ACK_DEADLINE_MS server-side, the sticky client
		// degrade on the envelope's failure).
		expect(rafQueue).toHaveLength(1)
		raf()
		await settle()
		expect(sentEnvelopes().map((e) => e.frames)).toEqual([
			[{ kind: "ack", delivered: 1 }],
		])
	})

	it("past the delivered first ack, a watermark advance is a passenger — no flush of its own", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(fetchCalls).toHaveLength(1)

		// A commit with nothing else to say sends NOTHING: no rAF is
		// scheduled, no envelope fires — the advance only marks the ack
		// producer dirty.
		laneSeqEntry("p", 2)
		_laneDeliveryCommitted("p")
		expect(rafQueue).toHaveLength(0)
		await settle()
		expect(fetchCalls).toHaveLength(1)

		// A statement flush (the visibility controller's schedule is this
		// exact call) picks the current watermark up for free.
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
		await flushOnce()
		expect(fetchCalls).toHaveLength(2)
		expect(sentEnvelopes()[1].frames).toEqual([
			{ kind: "ack", delivered: 2 },
			statement,
		])
	})

	it("the unacked count crossing the threshold drives one flush with the cumulative ack", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(fetchCalls).toHaveLength(1)

		// Sustained lane traffic below the threshold: every commit is a
		// passenger, nothing fires.
		for (let seq = 2; seq <= ACK_FLUSH_THRESHOLD; seq++) {
			laneSeqEntry("p", seq)
			_laneDeliveryCommitted("p")
		}
		expect(rafQueue).toHaveLength(0)
		await settle()
		expect(fetchCalls).toHaveLength(1)

		// The crossing commit drives the flush; the ack is cumulative —
		// one envelope covers the whole run.
		laneSeqEntry("p", ACK_FLUSH_THRESHOLD + 1)
		_laneDeliveryCommitted("p")
		expect(rafQueue).toHaveLength(1)
		raf()
		await settle()
		expect(fetchCalls).toHaveLength(2)
		expect(sentEnvelopes()[1].frames).toEqual([
			{ kind: "ack", delivered: ACK_FLUSH_THRESHOLD + 1 },
		])

		// The counter re-anchors at the collected value: the next commit
		// is a passenger again.
		laneSeqEntry("p", ACK_FLUSH_THRESHOLD + 2)
		_laneDeliveryCommitted("p")
		expect(rafQueue).toHaveLength(0)
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

	it("an as-of drop consumes PROCESSED — the watermark advances past it", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1, 0)
		laneSeqEntry("p", 2, 3)
		// A pre-navigation lane dropped by the as-of guard on a stream
		// that lives on: processed, not held — the frontier moves so the
		// window frees. The reported drop (`_reportAsOfDrop`, at the browser
		// entry's drop site) is what keeps it out of the server's mirror.
		_laneDeliveryDroppedStale("p")
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes()[0].frames).toEqual([{ kind: "ack", delivered: 2 }])
	})

	it("a reported as-of drop rides the next ack's `dropped` set once the watermark covers it", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1, 0)
		laneSeqEntry("p", 2, 0)
		// Seq 1 is an as-of drop the browser entry reports; seq 2 the client
		// holds. Both advance the contiguous watermark.
		_reportAsOfDrop(1)
		_laneDeliveryDroppedStale("p")
		_laneDeliveryCommitted("p")
		await flushOnce()
		// The ack carries the cumulative watermark AND names seq 1 dropped —
		// the server evicts its mirror promotions instead of folding them.
		expect(sentEnvelopes()[0].frames).toEqual([
			{ kind: "ack", delivered: 2, dropped: [1] },
		])

		// The report cleared once sent — a later ack repeats nothing.
		laneSeqEntry("p", 3, 0)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes()[1].frames).toEqual([{ kind: "ack", delivered: 3 }])
	})

	it("a drop past the contiguous frontier waits for the watermark to cover it", async () => {
		_channelEstablished("c1")
		laneSeqEntry("p", 1, 0)
		laneSeqEntry("p", 2, 0)
		// Seq 2 drops while seq 1 is still uncommitted — the frontier is at
		// 0, so the drop can't ride yet (the server has no settled record to
		// evict). The commit for seq 2 arrives out of order.
		_reportAsOfDrop(2)
		_laneDeliveryDropped("p") // seq 1 decoded but not committed (stalls)
		_laneDeliveryDroppedStale("p") // seq 2 processed — but frontier stalls at 0
		await flushOnce()
		// Nothing acks: the watermark is still 0 (seq 1 never committed), so
		// the drop for seq 2 is not yet in range.
		expect(fetchCalls).toHaveLength(0)
	})

	it("segment-form seq entries are fetch-local; commits advance the same watermark", async () => {
		_channelEstablished("c1")
		// The wire hook ignores the segment form (no parton-id prefix)…
		_channelWireEntry("seq", enc("1 0"))
		expect(_segmentDelivery("seq", enc("1 0"))).toEqual({ seq: 1, asOf: 0 })
		expect(_segmentDelivery("seq", enc("3 7"))).toEqual({ seq: 3, asOf: 7 })
		expect(_segmentDelivery("seq", enc("p\n2 0"))).toBeNull()
		expect(_segmentDelivery("fp", enc("1 0"))).toBeNull()
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

describe("bounded re-establishment", () => {
	it("a SINGLE failed first-ack envelope re-establishes — not a page degrade", async () => {
		const aborts: number[] = []
		const attaches: number[] = []
		_registerLiveStreamAbort(() => aborts.push(1))
		_registerAttachRequester(() => attaches.push(1))
		_channelEstablished("c1")
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blocked by client"))
		await flushOnce()
		// The now-unackable stream is pulled down, but the page is NOT
		// degraded — a single stumble re-establishes.
		expect(aborts).toHaveLength(1)
		expect(_channelIsDegraded()).toBe(false)
		expect(_getLiveConnectionId()).toBeNull()
		// The stream's settle re-attaches (backoff attempt 1 is immediate).
		_channelConnectionClosed({ aborted: true })
		expect(_channelIsDegraded()).toBe(false)
		expect(attaches).toHaveLength(1)
	})

	it("a RUN of first-ack failures falls to document-nav mode; a delivered ack recovers it", async () => {
		_registerLiveStreamAbort(() => {})
		_registerAttachRequester(() => {})
		// The blocked-`/__parton/channel` signature: each connection
		// establishes and delivers (downstream works), but its first ack
		// can never land (upstream blocked). Three consecutive such
		// failures cross the bound.
		for (let i = 1; i <= 3; i++) {
			_channelEstablished(`c${i}`)
			laneSeqEntry("p", 1)
			_laneDeliveryCommitted("p")
			fetchResults.push(new Error("blocked"))
			await flushOnce()
			_channelConnectionClosed({ aborted: true })
			// The stream's settle counts the first-ack failure; document-nav
			// mode arrives only once the run reaches the bound.
			expect(_channelIsDegraded()).toBe(i >= 3)
		}

		// Establishment alone does NOT clear a first-ack streak (that was
		// the upstream, not the downstream) — only the full duplex proof
		// does.
		_channelEstablished("c4")
		expect(_channelIsDegraded()).toBe(true)
		// A fresh delivery whose ack LANDS proves the duplex — recovered.
		laneSeqEntry("p", 1)
		_laneDeliveryCommitted("p")
		await flushOnce()
		expect(sentEnvelopes().at(-1)?.frames).toEqual([
			{ kind: "ack", delivered: 1 },
		])
		expect(_channelIsDegraded()).toBe(false)
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
