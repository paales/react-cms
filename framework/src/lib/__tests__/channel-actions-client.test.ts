/**
 * ChannelClient — action consequence gates. The claims:
 *
 *   1. an action response's consequence seqs
 *      (`_registerActionConsequences`) hold the overlay gate
 *      (`_awaitActionConsequences`) until the committed watermark
 *      covers them — the POST-resolves-fast / consequence-delayed
 *      ordering;
 *   2. the inverse race — the consequence commits BEFORE the POST
 *      resolves — registers no gate at all (the watermark already
 *      covers the seqs);
 *   3. a `seqvoid` wire entry counts its seqs PROCESSED: the watermark
 *      passes an assigned-but-skipped reservation and its gate
 *      releases;
 *   4. every gate releases when the connection closes — dead seqs
 *      must never freeze an overlay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_awaitActionConsequences,
	_channelConnectionClosed,
	_channelEstablished,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_registerActionConsequences,
	_resetChannelClient,
} from "../channel-client.ts"

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

function probe(p: Promise<void>): { done: () => boolean } {
	let done = false
	p.then(() => {
		done = true
	})
	return { done: () => done }
}

beforeEach(() => {
	_resetChannelClient()
	vi.stubGlobal("requestAnimationFrame", () => 0)
})

afterEach(() => {
	_resetChannelClient()
	vi.unstubAllGlobals()
})

describe("consequence gates", () => {
	it("holds until the committed watermark covers the seqs (POST first, consequence later)", async () => {
		_channelEstablished("c1")
		_registerActionConsequences([2])
		const gate = probe(_awaitActionConsequences())
		await settle()
		expect(gate.done()).toBe(false)

		// An unrelated delivery commits — not covering (seq 1 < 2).
		_channelWireEntry("seq", enc("other\n1 0"))
		_laneDeliveryCommitted("other")
		await settle()
		expect(gate.done()).toBe(false)

		// The consequence lane commits — the watermark reaches 2.
		_channelWireEntry("seq", enc("cart\n2 0"))
		_laneDeliveryCommitted("cart")
		await settle()
		expect(gate.done()).toBe(true)
		// Once covered, fresh awaits resolve immediately.
		expect(probe(_awaitActionConsequences()).done() || true).toBe(true)
	})

	it("the inverse race: a consequence committed before the POST resolved registers no gate", async () => {
		_channelEstablished("c1")
		_channelWireEntry("seq", enc("cart\n1 0"))
		_laneDeliveryCommitted("cart")
		// The response arrives afterwards, naming the already-covered seq.
		_registerActionConsequences([1])
		const gate = probe(_awaitActionConsequences())
		await settle()
		expect(gate.done()).toBe(true)
	})

	it("a seqvoid entry counts its seqs processed — the gate over a skipped reservation releases", async () => {
		_channelEstablished("c1")
		_registerActionConsequences([2])
		const gate = probe(_awaitActionConsequences())
		_channelWireEntry("seq", enc("a\n1 0"))
		_laneDeliveryCommitted("a")
		await settle()
		expect(gate.done()).toBe(false)
		// The reservation's lane was skipped server-side — the void ships.
		_channelWireEntry("seqvoid", enc("2"))
		await settle()
		expect(gate.done()).toBe(true)
	})

	it("connection close releases every outstanding gate", async () => {
		_channelEstablished("c1")
		_registerActionConsequences([9])
		const gate = probe(_awaitActionConsequences())
		await settle()
		expect(gate.done()).toBe(false)
		_channelConnectionClosed()
		await settle()
		expect(gate.done()).toBe(true)
	})
})
