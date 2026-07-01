/**
 * Wire-format tests for the segmented-Flight trailer protocol.
 *
 * Exercises the `splitSegments` splitter against synthetic byte
 * sequences that mirror what the server emits in production. The
 * goal is to lock down the round-trip behavior at the byte level so
 * server-emit and client-parse stay in lockstep across changes.
 */

import { describe, expect, it } from "vitest";
import { splitAtFpTrailer, splitSegments } from "../fp-trailer-split.ts";

/** Narrow a segment to the payload variant — every wire fixture in
 *  this file is payload-shaped; a lanes segment here is a test bug. */
function asPayload(seg: import("../fp-trailer-split.ts").Segment) {
	if (seg.kind !== "payload") throw new Error("expected a payload segment");
	return seg;
}

import {
	buildMarker,
	TAG_FP_UPDATES,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
	TAG_URL_UPDATE,
} from "../fp-trailer-marker.ts";

function bytes(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return concat(...parts);
}

function emitTrailerEntry(tag: string, body: string): Uint8Array {
	const bodyBytes = bytes(body);
	return concat(buildMarker(tag, bodyBytes.byteLength), bodyBytes);
}

describe("buildMarker — readable wire format", () => {
	it("produces a marker readable in an ASCII dump", () => {
		const marker = buildMarker("fp", 42);
		const text = new TextDecoder("utf-8", { fatal: false }).decode(marker);
		// `\xFF` decodes to the replacement char; plain ASCII header
		// and a trailing `\n` make the marker grep-able.
		expect(text).toContain("[parton:fp:42]");
		expect(text.endsWith("\n")).toBe(true);
	});

	it("rejects malformed tags", () => {
		expect(() => buildMarker("with space", 0)).toThrow();
		expect(() => buildMarker("123leadingDigit", 0)).toThrow();
		expect(() => buildMarker("ThisTagIsWayTooLong", 0)).toThrow();
	});

	it("rejects negative or non-integer lengths", () => {
		expect(() => buildMarker("fp", -1)).toThrow();
		expect(() => buildMarker("fp", 1.5)).toThrow();
	});
});

// Marker has a leading `\n` for visual separation in dumps. The
// `\n` lands in the body stream (Flight tolerates trailing
// whitespace). Tests strip it from body assertions for clarity.
function bodyText(bytes: Uint8Array): string {
	let s = new TextDecoder().decode(bytes);
	while (s.endsWith("\n")) s = s.slice(0, -1);
	return s;
}

describe("splitSegments — single segment", () => {
	it("yields one segment with no trailers when source has only Flight bytes", async () => {
		const wire = bytes("flight-payload-bytes");
		const segments: { body: Uint8Array; trailers: Map<string, Uint8Array> }[] =
			[];
		for await (const rawSeg of splitSegments(streamOf(wire))) {
			const seg = asPayload(rawSeg);
			segments.push({
				body: await collect(seg.body),
				trailers: await seg.trailers,
			});
		}
		expect(segments).toHaveLength(1);
		expect(bodyText(segments[0].body)).toBe("flight-payload-bytes");
		expect(segments[0].trailers.size).toBe(0);
	});

	it("yields one segment with an fp-updates trailer", async () => {
		const wire = concat(
			bytes("flight-payload-bytes"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"id":"warm-fp"}'),
		);
		const segments: { body: Uint8Array; trailers: Map<string, Uint8Array> }[] =
			[];
		for await (const rawSeg of splitSegments(streamOf(wire))) {
			const seg = asPayload(rawSeg);
			segments.push({
				body: await collect(seg.body),
				trailers: await seg.trailers,
			});
		}
		expect(segments).toHaveLength(1);
		expect(bodyText(segments[0].body)).toBe("flight-payload-bytes");
		const fp = segments[0].trailers.get(TAG_FP_UPDATES);
		expect(fp).toBeDefined();
		expect(new TextDecoder().decode(fp!)).toBe('{"id":"warm-fp"}');
	});

	it("accumulates fp-updates and url-update trailers on one segment", async () => {
		const wire = concat(
			bytes("flight"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"a":"1"}'),
			emitTrailerEntry(TAG_URL_UPDATE, '{"window":"/new"}'),
		);
		const segments: { body: Uint8Array; trailers: Map<string, Uint8Array> }[] =
			[];
		for await (const rawSeg of splitSegments(streamOf(wire))) {
			const seg = asPayload(rawSeg);
			segments.push({
				body: await collect(seg.body),
				trailers: await seg.trailers,
			});
		}
		expect(segments).toHaveLength(1);
		expect(segments[0].trailers.get(TAG_FP_UPDATES)).toBeDefined();
		expect(segments[0].trailers.get(TAG_URL_UPDATE)).toBeDefined();
		expect(
			new TextDecoder().decode(segments[0].trailers.get(TAG_URL_UPDATE)!),
		).toBe('{"window":"/new"}');
	});
});

describe("splitSegments — multi-segment", () => {
	it("yields N segments separated by `next` delimiters", async () => {
		const wire = concat(
			bytes("flight-1"),
			buildMarker(TAG_NEXT_SEGMENT, 0),
			bytes("flight-2"),
			buildMarker(TAG_NEXT_SEGMENT, 0),
			bytes("flight-3"),
		);
		const bodies: string[] = [];
		for await (const rawSeg of splitSegments(streamOf(wire))) {
			const seg = asPayload(rawSeg);
			bodies.push(bodyText(await collect(seg.body)));
			await seg.trailers;
		}
		expect(bodies).toEqual(["flight-1", "flight-2", "flight-3"]);
	});

	it("preserves per-segment trailers across the delimiter", async () => {
		const wire = concat(
			bytes("seg-1"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"seg":"1"}'),
			buildMarker(TAG_NEXT_SEGMENT, 0),
			bytes("seg-2"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"seg":"2"}'),
			emitTrailerEntry(TAG_URL_UPDATE, '{"window":"/two"}'),
		);
		const out: { body: string; trailers: Map<string, string> }[] = [];
		for await (const rawSeg of splitSegments(streamOf(wire))) {
			const seg = asPayload(rawSeg);
			const body = bodyText(await collect(seg.body));
			const trailers = new Map<string, string>();
			for (const [k, v] of await seg.trailers) {
				trailers.set(k, new TextDecoder().decode(v));
			}
			out.push({ body, trailers });
		}
		expect(out).toHaveLength(2);
		expect(out[0].body).toBe("seg-1");
		expect(out[0].trailers.get(TAG_FP_UPDATES)).toBe('{"seg":"1"}');
		expect(out[0].trailers.has(TAG_URL_UPDATE)).toBe(false);
		expect(out[1].body).toBe("seg-2");
		expect(out[1].trailers.get(TAG_FP_UPDATES)).toBe('{"seg":"2"}');
		expect(out[1].trailers.get(TAG_URL_UPDATE)).toBe('{"window":"/two"}');
	});
});

describe("splitSegments — chunk-boundary handling", () => {
	it("detects a header that straddles two source chunks", async () => {
		const trailerEntry = emitTrailerEntry(TAG_FP_UPDATES, '{"x":"y"}');
		const wire = concat(bytes("flight"), trailerEntry);
		// Split inside the marker header.
		const splitAt = bytes("flight").byteLength + 5;
		const chunkA = wire.subarray(0, splitAt);
		const chunkB = wire.subarray(splitAt);
		const segments: { body: Uint8Array; trailers: Map<string, Uint8Array> }[] =
			[];
		for await (const rawSeg of splitSegments(
			streamOf(new Uint8Array(chunkA), new Uint8Array(chunkB)),
		)) {
			const seg = asPayload(rawSeg);
			segments.push({
				body: await collect(seg.body),
				trailers: await seg.trailers,
			});
		}
		expect(segments).toHaveLength(1);
		expect(bodyText(segments[0].body)).toBe("flight");
		expect(
			new TextDecoder().decode(segments[0].trailers.get(TAG_FP_UPDATES)!),
		).toBe('{"x":"y"}');
	});

	it("handles tiny one-byte chunks (worst case)", async () => {
		const wire = concat(
			bytes("ab"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"k":"v"}'),
			buildMarker(TAG_NEXT_SEGMENT, 0),
			bytes("cd"),
		);
		const oneByteChunks: Uint8Array[] = [];
		for (const b of wire) oneByteChunks.push(new Uint8Array([b]));
		const bodies: string[] = [];
		const trailerMaps: Map<string, string>[] = [];
		for await (const rawSeg of splitSegments(streamOf(...oneByteChunks))) {
			const seg = asPayload(rawSeg);
			bodies.push(bodyText(await collect(seg.body)));
			const map = new Map<string, string>();
			for (const [k, v] of await seg.trailers) {
				map.set(k, new TextDecoder().decode(v));
			}
			trailerMaps.push(map);
		}
		expect(bodies).toEqual(["ab", "cd"]);
		expect(trailerMaps[0].get(TAG_FP_UPDATES)).toBe('{"k":"v"}');
		expect(trailerMaps[1].size).toBe(0);
	});
});

describe("splitAtFpTrailer — legacy single-segment shim", () => {
	it("returns mainStream + fp trailer for the first segment only", async () => {
		const wire = concat(
			bytes("flight-payload"),
			emitTrailerEntry(TAG_FP_UPDATES, '{"foo":"bar"}'),
		);
		const { mainStream, trailer } = splitAtFpTrailer(streamOf(wire));
		const body = await collect(mainStream);
		const fp = await trailer;
		expect(bodyText(body)).toBe("flight-payload");
		expect(fp).toEqual({ foo: "bar" });
	});

	it("returns null trailer when no fp-updates entry present", async () => {
		const wire = bytes("flight-only-bytes");
		const { mainStream, trailer } = splitAtFpTrailer(streamOf(wire));
		const body = await collect(mainStream);
		const fp = await trailer;
		expect(new TextDecoder().decode(body)).toBe("flight-only-bytes");
		expect(fp).toBe(null);
	});
});

describe("splitSegments — abort gated on `settled`", () => {
	// Bounded timer for hang/leak assertions: an iterator op that never
	// settles loses the race, so a proven hang is "the timer won." The
	// test itself always terminates.
	function timeout(ms: number): Promise<"timeout"> {
		return new Promise((r) => setTimeout(() => r("timeout"), ms));
	}

	it("cancels immediately when aborted while parked after a settled segment", async () => {
		// The realistic steady state: the server emits a segment, writes its
		// `settled` marker, then parks holding the connection open awaiting
		// the next bump (the live heartbeat sitting idle between segments).
		// The body is wholly delivered, so an abort here cancels the reader
		// straight away — no deadlock, connection released.
		let cancelCount = 0;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(bytes("seg-1"));
				c.enqueue(emitTrailerEntry(TAG_FP_UPDATES, '{"id":"warm"}'));
				c.enqueue(buildMarker(TAG_SEGMENT_SETTLED, 0));
				// Now silent: parked awaiting `next`, never closes.
			},
			cancel() {
				cancelCount++;
			},
		});
		const ac = new AbortController();
		const iter = splitSegments(source, ac.signal)[Symbol.asyncIterator]();

		const first = await iter.next();
		expect(bodyText(await collect(first.value!.body))).toBe("seg-1");
		// Trailers resolve at the `settled` marker, not deferred to `next`.
		const trailers = await first.value!.trailers;
		expect(new TextDecoder().decode(trailers.get(TAG_FP_UPDATES)!)).toBe(
			'{"id":"warm"}',
		);

		// The drive is parked post-settled awaiting `next`. Abort releases it.
		const advance = iter.next();
		ac.abort();
		const winner = await Promise.race([advance, timeout(500)]);
		expect(winner).not.toBe("timeout");
		expect((winner as IteratorResult<unknown>).done).toBe(true);
		expect(cancelCount).toBe(1);
	});

	it("defers the cancel until the in-flight segment settles (no mid-render tear)", async () => {
		// An abort lands while the segment's render is still streaming. The
		// reader must NOT be cancelled yet — closing the body before its
		// remaining (deferred) bytes arrive would reject the committed
		// payload's pending references ("Connection closed."). Instead the
		// body keeps draining; the cancel fires the instant the `settled`
		// marker arrives, by which point the body has closed cleanly.
		let cancelCount = 0;
		let ctrl!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(c) {
				ctrl = c;
			},
			cancel() {
				cancelCount++;
			},
		});
		const ac = new AbortController();
		const iter = splitSegments(source, ac.signal)[Symbol.asyncIterator]();

		// Render begins: first half of the body.
		ctrl.enqueue(bytes("body-part-1:"));
		const first = await iter.next();
		expect(first.done).toBe(false);
		const bodyReader = first.value!.body.getReader();
		expect(new TextDecoder().decode((await bodyReader.read()).value!)).toBe(
			"body-part-1:",
		);

		// Abort mid-render — the segment has not settled yet, so the reader
		// must stay open.
		ac.abort();
		expect(cancelCount).toBe(0);

		// The render completes: rest of the body, then the `settled` marker.
		ctrl.enqueue(bytes("body-part-2"));
		ctrl.enqueue(buildMarker(TAG_SEGMENT_SETTLED, 0));

		// The remaining body bytes are still delivered (clean close, no tear).
		expect(new TextDecoder().decode((await bodyReader.read()).value!)).toBe(
			"body-part-2",
		);
		expect((await bodyReader.read()).done).toBe(true);

		// Now the deferred cancel fires: iteration settles, reader released.
		const winner = await Promise.race([iter.next(), timeout(500)]);
		expect(winner).not.toBe("timeout");
		expect((winner as IteratorResult<unknown>).done).toBe(true);
		expect(cancelCount).toBe(1);
	});
});
