/**
 * Per-parton multiplexed Flight frames — the live connection's lane
 * transport.
 *
 * Carries multiple INDEPENDENT Flight payloads (one per parton) over a
 * single byte stream, interleaved as each render produces bytes, so no
 * parton's update waits on a slower sibling's Suspense boundary. The
 * live segment driver frames each lane render with `muxFrame` /
 * `muxEndFrame` (`driveLaneStream` in `segmented-response.ts`); the
 * client side of the same grammar lives in `fp-trailer-split.ts`
 * (`Segment.kind === "lanes"`). `muxPartonStreams` /
 * `demuxPartonStreams` compose the full round-trip for in-process use
 * and tests (`__tests__/parton-mux.rsc.test.tsx`).
 *
 * Framing reuses the `\xFF[parton:tag:length]\n` marker grammar from
 * `fp-trailer-marker.ts` (one UTF-8-invalid lead byte, ASCII header,
 * length-prefixed body — unambiguous against Flight bytes):
 *
 *   \xFF[parton:mux:N]\n<parton-id>\n<Flight bytes chunk>
 *   \xFF[parton:muxend:M]\n<parton-id>
 *
 * A `mux` frame's body is the parton id (no `\n` allowed in ids), a
 * `\n` separator, then one chunk of that parton's Flight payload —
 * bytes are forwarded frame-per-source-chunk, so each payload's own
 * streaming pacing survives the mux. `muxend` marks a payload
 * complete. Frames from different partons interleave freely; the
 * stream closes when every source has ended.
 */

import {
	buildMarker,
	TAG_MUX_END,
	TAG_MUX_FRAME,
	tryReadMarker,
} from "./fp-trailer-marker.ts";

export { TAG_MUX_END, TAG_MUX_FRAME };

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export interface PartonSource {
	/** Registered partial id — the client routes the frame's bytes to
	 *  this parton's decoder. Must not contain `\n`. */
	partonId: string;
	/** The parton's own Flight payload (one full document). */
	stream: ReadableStream<Uint8Array>;
}

/** Build one `mux` frame: marker + id line + payload chunk. */
export function muxFrame(partonId: string, chunk: Uint8Array): Uint8Array {
	const idBytes = ENCODER.encode(partonId);
	const marker = buildMarker(
		TAG_MUX_FRAME,
		idBytes.byteLength + 1 + chunk.byteLength,
	);
	const out = new Uint8Array(
		marker.byteLength + idBytes.byteLength + 1 + chunk.byteLength,
	);
	out.set(marker, 0);
	out.set(idBytes, marker.byteLength);
	out[marker.byteLength + idBytes.byteLength] = 0x0a;
	out.set(chunk, marker.byteLength + idBytes.byteLength + 1);
	return out;
}

/** Build one `muxend` frame: marker + id body. */
export function muxEndFrame(partonId: string): Uint8Array {
	const idBytes = ENCODER.encode(partonId);
	const marker = buildMarker(TAG_MUX_END, idBytes.byteLength);
	const out = new Uint8Array(marker.byteLength + idBytes.byteLength);
	out.set(marker, 0);
	out.set(idBytes, marker.byteLength);
	return out;
}

/**
 * Interleave several partons' Flight payloads into one framed byte
 * stream. Each source is pumped concurrently; a chunk is framed and
 * enqueued the moment its source yields it, so a fast parton's payload
 * completes on the wire while a slow sibling is still suspended.
 */
export function muxPartonStreams(
	sources: PartonSource[],
): ReadableStream<Uint8Array> {
	for (const s of sources) {
		if (s.partonId.includes("\n")) {
			throw new Error(
				`parton id must not contain newline: ${JSON.stringify(s.partonId)}`,
			);
		}
	}
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// Concurrent pumps share the controller; JS is single-threaded so
			// whole-frame enqueues interleave safely (same pattern as
			// `spliceHoles` in flight-graph.ts).
			await Promise.all(
				sources.map(async ({ partonId, stream }) => {
					const reader = stream.getReader();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							if (value && value.byteLength > 0)
								controller.enqueue(muxFrame(partonId, value));
						}
					} finally {
						reader.releaseLock();
					}
					controller.enqueue(muxEndFrame(partonId));
				}),
			);
			controller.close();
		},
	});
}

export interface DemuxedParton {
	partonId: string;
	/** That parton's Flight payload, reassembled — hand it to
	 *  `createFromReadableStream` independently of every other parton. */
	body: ReadableStream<Uint8Array>;
}

/**
 * Split a muxed stream back into per-parton Flight payloads. Yields a
 * `DemuxedParton` the first time a parton id appears; its `body`
 * receives that parton's chunks as their frames arrive and closes on
 * the parton's `muxend` frame. Iteration ends when the source ends.
 *
 * The source ending with partons still open errors their bodies — a
 * torn connection must surface to each decoder (whose pending
 * references would otherwise hang), mirroring the Flight client's own
 * "Connection closed." teardown.
 */
export function demuxPartonStreams(
	source: ReadableStream<Uint8Array>,
): AsyncIterable<DemuxedParton> {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = source.getReader();
			const open = new Map<
				string,
				ReadableStreamDefaultController<Uint8Array>
			>();
			let buffer: Uint8Array = new Uint8Array(0);
			let sourceClosed = false;

			const readMore = async (): Promise<boolean> => {
				const { done, value } = await reader.read();
				if (done) {
					sourceClosed = true;
					return false;
				}
				if (value) buffer = concat(buffer, value);
				return true;
			};

			try {
				frames: while (true) {
					// Parse one complete frame (marker + body) off the buffer.
					let parsed = tryReadMarker(buffer);
					while (parsed === "need-more") {
						if (sourceClosed) {
							if (buffer.byteLength === 0) break frames;
							throw new Error("mux stream ended mid-frame header");
						}
						if (!(await readMore()) && buffer.byteLength === 0) break frames;
						parsed = tryReadMarker(buffer);
					}
					if (parsed === "invalid")
						throw new Error("mux stream: invalid frame marker");
					const total = parsed.headerSize + parsed.length;
					while (buffer.byteLength < total) {
						if (!(await readMore()))
							throw new Error("mux stream ended mid-frame body");
					}
					const body = buffer.slice(parsed.headerSize, total);
					buffer = buffer.slice(total);

					if (parsed.tag === TAG_MUX_END) {
						const partonId = DECODER.decode(body);
						open.get(partonId)?.close();
						open.delete(partonId);
						continue;
					}
					if (parsed.tag !== TAG_MUX_FRAME) {
						throw new Error(
							`mux stream: unexpected frame tag ${JSON.stringify(parsed.tag)}`,
						);
					}
					const nl = body.indexOf(0x0a);
					if (nl < 0) throw new Error("mux frame missing id separator");
					const partonId = DECODER.decode(body.slice(0, nl));
					const chunk = body.slice(nl + 1);
					const existing = open.get(partonId);
					if (existing) {
						existing.enqueue(chunk);
						continue;
					}
					let controller!: ReadableStreamDefaultController<Uint8Array>;
					const partonBody = new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						},
					});
					open.set(partonId, controller);
					controller.enqueue(chunk);
					yield { partonId, body: partonBody };
				}
			} finally {
				const torn = new Error(
					"mux stream closed with parton payload incomplete",
				);
				for (const controller of open.values()) {
					try {
						controller.error(torn);
					} catch {}
				}
				open.clear();
				reader.releaseLock();
			}
		},
	};
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.byteLength === 0) return b;
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}
