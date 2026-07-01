/**
 * Client-side lanes grammar — `splitSegments` classifying and demuxing
 * a per-parton lane region (the live connection's shape after its
 * initial whole-tree segment; see `driveLaneStream` in
 * `segmented-response.ts`).
 *
 * Synthetic byte fixtures, mirroring `trailer-segmented.test.ts`: the
 * wire is `<flight seg-0> settled next [lanes] mux/muxend… settled`,
 * with each lane's body itself shaped like a one-segment fp-trailer
 * stream.
 */

import { describe, expect, it } from "vitest";
import {
	buildMarker,
	TAG_LANES_OPEN,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
} from "../fp-trailer-marker.ts";
import {
	type DemuxedLane,
	type Segment,
	splitSegments,
} from "../fp-trailer-split.ts";
import { muxEndFrame, muxFrame } from "../parton-mux.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(...parts: (Uint8Array | string)[]): Uint8Array {
	const encoded = parts.map((p) =>
		typeof p === "string" ? encoder.encode(p) : p,
	);
	const total = encoded.reduce((n, b) => n + b.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const b of encoded) {
		out.set(b, offset);
		offset += b.byteLength;
	}
	return out;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(c);
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	return await new Response(stream).text();
}

const SETTLED = buildMarker(TAG_SEGMENT_SETTLED, 0);
const NEXT = buildMarker(TAG_NEXT_SEGMENT, 0);
const LANES = buildMarker(TAG_LANES_OPEN, 0);

/** Consume every segment; lanes are drained eagerly (bodies collected
 *  as they announce) so the drive loop never stalls on an unread lane. */
async function consumeAll(
	source: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
) {
	const segments: Array<
		| { kind: "payload"; body: string }
		| {
				kind: "lanes";
				lanes: Array<{ partonId: string; body: Promise<string> }>;
		  }
	> = [];
	for await (const seg of splitSegments(source, signal)) {
		if (seg.kind === "payload") {
			segments.push({ kind: "payload", body: await collect(seg.body) });
			await seg.trailers;
			continue;
		}
		const lanes: Array<{ partonId: string; body: Promise<string> }> = [];
		const entry = { kind: "lanes" as const, lanes };
		segments.push(entry);
		for await (const lane of seg.lanes) {
			lanes.push({ partonId: lane.partonId, body: collect(lane.body) });
		}
	}
	return segments;
}

describe("splitSegments — lanes segments", () => {
	it("classifies the lanes region and demuxes interleaved lanes", async () => {
		const wire = bytes(
			"seg-0-flight",
			SETTLED,
			NEXT,
			LANES,
			muxFrame("clock", encoder.encode("clock-part-1|")),
			muxFrame("cart", encoder.encode("cart-part-1|")),
			muxFrame("clock", encoder.encode("clock-part-2")),
			muxEndFrame("clock"),
			muxFrame("cart", encoder.encode("cart-part-2")),
			muxEndFrame("cart"),
			SETTLED,
		);
		const segments = await consumeAll(streamOf(wire));
		expect(segments).toHaveLength(2);
		expect(segments[0]).toEqual({ kind: "payload", body: "seg-0-flight" });
		const lanesSeg = segments[1];
		if (lanesSeg.kind !== "lanes") throw new Error("expected lanes segment");
		expect(lanesSeg.lanes.map((l) => l.partonId)).toEqual(["clock", "cart"]);
		expect(await lanesSeg.lanes[0].body).toBe("clock-part-1|clock-part-2");
		expect(await lanesSeg.lanes[1].body).toBe("cart-part-1|cart-part-2");
	});

	it("the same parton id reopens as a NEW lane after its muxend", async () => {
		const wire = bytes(
			"seg-0",
			SETTLED,
			NEXT,
			LANES,
			muxFrame("clock", encoder.encode("tick-1")),
			muxEndFrame("clock"),
			SETTLED,
			muxFrame("clock", encoder.encode("tick-2")),
			muxEndFrame("clock"),
			SETTLED,
		);
		const segments = await consumeAll(streamOf(wire));
		const lanesSeg = segments[1];
		if (lanesSeg.kind !== "lanes") throw new Error("expected lanes segment");
		expect(lanesSeg.lanes.map((l) => l.partonId)).toEqual(["clock", "clock"]);
		expect(await lanesSeg.lanes[0].body).toBe("tick-1");
		expect(await lanesSeg.lanes[1].body).toBe("tick-2");
	});

	it("a source close with a lane open errors that lane's body", async () => {
		const wire = bytes(
			"seg-0",
			SETTLED,
			NEXT,
			LANES,
			muxFrame("solo", encoder.encode("partial-content")),
			// no muxend — torn connection
		);
		const iter = splitSegments(streamOf(wire))[Symbol.asyncIterator]();
		const first = await iter.next();
		if (first.done || first.value.kind !== "payload")
			throw new Error("expected payload");
		await collect(first.value.body);
		await first.value.trailers;

		const second = await iter.next();
		if (second.done || second.value.kind !== "lanes")
			throw new Error("expected lanes");
		const laneIter = second.value.lanes[Symbol.asyncIterator]();
		const lane = await laneIter.next();
		expect(lane.done).toBe(false);
		const { partonId, body } = lane.value as DemuxedLane;
		expect(partonId).toBe("solo");
		// The tear rejects the lane's body — the consumer's decode for
		// THIS lane fails; nothing else is affected. (Erroring a
		// controller discards its queue, so whether the delivered chunk
		// surfaces first depends on read timing — a torn HTTP body drops
		// unread bytes the same way.)
		const reader = body.getReader();
		await expect(
			(async () => {
				await reader.read();
				await reader.read();
			})(),
		).rejects.toThrow(/open|incomplete|closed/);
	});

	it("an abort during a lanes segment cancels immediately", async () => {
		// A source that delivers the lanes opening then hangs (a parked
		// live connection). The abort must cancel the reader without
		// waiting for any settled milestone — lanes segments are always
		// abort-safe.
		let sourceCancelled = false;
		const hanging = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					bytes(
						"seg-0",
						SETTLED,
						NEXT,
						LANES,
						muxFrame("solo", encoder.encode("x")),
					),
				);
				// never closes
			},
			cancel() {
				sourceCancelled = true;
			},
		});
		const abort = new AbortController();
		const iter = splitSegments(hanging, abort.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		if (first.done || first.value.kind !== "payload")
			throw new Error("expected payload");
		await collect(first.value.body);
		const second = await iter.next();
		if (second.done || second.value.kind !== "lanes")
			throw new Error("expected lanes");
		const laneIter = second.value.lanes[Symbol.asyncIterator]();
		const lane = await laneIter.next();
		expect((lane.value as DemuxedLane).partonId).toBe("solo");

		abort.abort();
		// The open lane's body errors (torn — erroring a controller
		// discards its queue, exactly like a torn HTTP body), iteration
		// ends, and the upstream reader is cancelled — the connection is
		// released without waiting for any settled milestone.
		const laneReader = (lane.value as DemuxedLane).body.getReader();
		await expect(
			(async () => {
				// Drain until the tear surfaces; bounded by the two chunks.
				await laneReader.read();
				await laneReader.read();
			})(),
		).rejects.toThrow();
		const end = await iter.next();
		expect(end.done).toBe(true);
		expect(sourceCancelled).toBe(true);
	});

	it("payload segments still parse untouched around a lanes region", async () => {
		// A `next` after lanes returns to payload parsing (grammar
		// completeness — the current server stays in lanes until close).
		const wire = bytes(
			"seg-0",
			SETTLED,
			NEXT,
			LANES,
			muxFrame("a", encoder.encode("a-body")),
			muxEndFrame("a"),
			SETTLED,
			NEXT,
			"seg-2-flight",
			SETTLED,
		);
		const segments = await consumeAll(streamOf(wire));
		expect(segments.map((s) => s.kind)).toEqual([
			"payload",
			"lanes",
			"payload",
		]);
		const last = segments[2];
		if (last.kind !== "payload") throw new Error("expected payload");
		expect(last.body).toBe("seg-2-flight");
	});
});

// Type-level check: the Segment union narrows on `kind`.
const _narrow = (s: Segment): number => (s.kind === "payload" ? 1 : 2);
void _narrow;
