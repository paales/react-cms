/**
 * Wire-format marker for segmented-Flight trailers.
 *
 * On the wire each segment looks like:
 *
 *     <flight bytes…>
 *     \xFF[parton:fp:256]\n<256-byte JSON body>
 *     \xFF[parton:url:128]\n<128-byte JSON body>
 *     \xFF[parton:next:0]\n
 *     <flight bytes for next segment…>
 *
 * One UTF-8-invalid lead byte (`\xFF`) marks the start of every
 * trailer entry. Flight emits UTF-8 JSON, and `\xFF` is invalid as a
 * UTF-8 lead OR continuation byte — so it cannot occur inside a Flight
 * payload. After the `\xFF` the header is plain ASCII bracketed text
 * terminated by `\n`, then a length-prefixed body of the declared size
 * (or zero, for delimiters like `next`).
 *
 * Header grammar:
 *
 *     "[" "parton:" TAG ":" LENGTH "]" "\n"
 *
 *   TAG     — short ASCII identifier (1–16 chars). Today: `fp`, `url`,
 *             `next`. Reserve new tags by adding a constant below.
 *   LENGTH  — decimal byte count of the body, ≥ 0.
 *
 * The `parton:` prefix makes a packet trivially identifiable in
 * tcpdump / curl output without context. The `\xFF` leader is what
 * keeps Flight bytes unambiguously separable from trailer bytes — a
 * pure-text boundary would risk collision with Flight content.
 */

const PREFIX_BYTE = 0xff;

const HEADER_OPEN = "[parton:";
const HEADER_CLOSE = "]\n";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Build the marker + header bytes for a trailer entry. The caller
 *  enqueues this followed by exactly `bodyLength` body bytes.
 *
 *  Format: `\xFF[parton:tag:length]\n`. `\xFF` is the parser's start
 *  signal (invalid UTF-8 so it cannot appear inside Flight payload);
 *  the rest is plain ASCII so the marker is readable in tcpdump /
 *  curl. Flight rows end with `\n`, so the marker naturally appears
 *  on its own line after the preceding row's terminator. */
export function buildMarker(tag: string, bodyLength: number): Uint8Array {
	if (!/^[a-z][a-z0-9_-]{0,15}$/i.test(tag)) {
		throw new Error(
			`Trailer tag must match /^[a-z][a-z0-9_-]{0,15}$/i, got: ${tag}`,
		);
	}
	if (!Number.isInteger(bodyLength) || bodyLength < 0) {
		throw new Error(
			`Trailer length must be a non-negative integer, got: ${bodyLength}`,
		);
	}
	const header = `${HEADER_OPEN}${tag}:${bodyLength}${HEADER_CLOSE}`;
	const headerBytes = TEXT_ENCODER.encode(header);
	const out = new Uint8Array(1 + headerBytes.byteLength);
	out[0] = PREFIX_BYTE;
	out.set(headerBytes, 1);
	return out;
}

export interface ParsedMarker {
	tag: string;
	length: number;
	/** Total bytes from `\xFF` through the trailing `\n`, inclusive.
	 *  Body starts at the buffer offset + headerSize; total entry size
	 *  is `headerSize + length`. */
	headerSize: number;
}

/**
 * Try to parse a marker starting at `offset`. Returns:
 *   - parsed result if the bytes contain a complete, valid header,
 *   - `"need-more"` if the prefix is there but the header line hasn't
 *     fully arrived yet,
 *   - `"invalid"` if the bytes claim to be a marker but the header
 *     doesn't validate (corrupt stream — caller should error out).
 */
export type ReadMarkerResult = ParsedMarker | "need-more" | "invalid";

export function tryReadMarker(buf: Uint8Array, offset = 0): ReadMarkerResult {
	if (offset >= buf.byteLength) return "need-more";
	if (buf[offset] !== PREFIX_BYTE) return "invalid";
	// Scan for the terminating `]\n` after the prefix.
	// Cap the scan so a corrupted stream with no `\n` doesn't run away.
	const SCAN_LIMIT = 64;
	const start = offset + 1;
	const end = Math.min(start + SCAN_LIMIT, buf.byteLength);
	let nlIdx = -1;
	for (let i = start; i < end; i++) {
		if (buf[i] === 0x0a) {
			nlIdx = i;
			break;
		}
	}
	if (nlIdx < 0) {
		// No newline yet within the scan window.
		if (end - start >= SCAN_LIMIT) return "invalid";
		return "need-more";
	}
	// Header text excludes the trailing `\n` but includes the closing `]`.
	const headerBytes = buf.subarray(start, nlIdx);
	const headerText = TEXT_DECODER.decode(headerBytes);
	if (!headerText.startsWith(HEADER_OPEN)) return "invalid";
	if (!headerText.endsWith("]")) return "invalid";
	const inside = headerText.slice(HEADER_OPEN.length, headerText.length - 1);
	const colonIdx = inside.indexOf(":");
	if (colonIdx <= 0) return "invalid";
	const tag = inside.slice(0, colonIdx);
	const lengthStr = inside.slice(colonIdx + 1);
	if (!/^[a-z][a-z0-9_-]{0,15}$/i.test(tag)) return "invalid";
	if (!/^\d+$/.test(lengthStr)) return "invalid";
	const length = Number(lengthStr);
	return { tag, length, headerSize: 1 + (nlIdx - start) + 1 };
}

/** Tag taxonomy — constants so callers don't have to know the
 *  literals. */
export const TAG_FP_UPDATES = "fp";
export const TAG_URL_UPDATE = "url";
export const TAG_NEXT_SEGMENT = "next";
/** Producer milestone: the segment driver writes this after a segment's
 *  render has fully drained — body bytes plus the `fp`/`url` trailers
 *  are all on the wire. It is the explicit "this iteration is done"
 *  signal: once the client has read it, the segment's Flight body is
 *  wholly delivered, so the reader can be cancelled WITHOUT tearing a
 *  mid-render body (whose pending deferred references would otherwise
 *  reject with "Connection closed."). The live heartbeat's cooperative
 *  abort gates on this — see `SegmentIterator` in `fp-trailer-split.ts`.
 *  Zero-length, like `next`. */
export const TAG_SEGMENT_SETTLED = "settled";
/** Opens a per-parton lane region on a live connection. The segment
 *  driver writes this (zero-length) right after a `next` delimiter to
 *  declare that the rest of the connection carries `mux`/`muxend`
 *  frames — independent per-parton Flight payloads — instead of a
 *  whole-tree Flight document. The client's splitter classifies the
 *  segment off this marker BEFORE handing it to a decoder, so a lanes
 *  segment is never mistaken for an (empty) payload document. */
export const TAG_LANES_OPEN = "lanes";
/** The live connection's SERVER-MINTED id: body is the id (UTF-8).
 *  The segment driver mints it at session open and ships it once per
 *  connection, as the first bytes ahead of the initial segment's
 *  Flight rows (an ENTRY — it interleaves, the body keeps flowing) or
 *  immediately after the `lanes` marker on the catch-up path. The
 *  client's channel transport addresses every upstream envelope with
 *  it — receiving the entry IS the establishment handshake, since the
 *  driver only mints ids for sessions it has opened. Never appears on
 *  one-shot responses. */
export const TAG_CONNECTION_ID = "conn";
/** Per-connection monotonic DELIVERY seq — the ack currency. Every
 *  emission a live connection makes carries one: a payload segment's
 *  entry precedes its Flight rows (body: decimal seq), a lane's is a
 *  framed entry written right before the lane's `muxend` (body:
 *  `<parton-id>\n<seq>`, the mux frames' id-first shape). The client
 *  records the seq at COMMIT time — the lane-chain commit / payload
 *  setPayload, never at decode — and acks the highest contiguously
 *  committed value upstream (`ack` frames). Never appears on one-shot
 *  responses: a delivery seq without a session to ack to is
 *  meaningless. */
export const TAG_DELIVERY_SEQ = "seq";
/** Cumulative "upstream seq applied" — the mirror image of the
 *  client's `ack` frame: body is the decimal highest upstream envelope
 *  seq the connection session has applied (arrival order IS seq order:
 *  the client transport serializes envelopes — one in flight,
 *  retransmits-first on reattach). Emitted whenever the watermark has
 *  advanced past the last announced value, at the driver's next wake.
 *  What prunes the client transport's reliable-envelope retransmit
 *  buffer — a beacon's 204 is acceptance, not proof a future transport
 *  surfaces, so the stream marker is the one pruning signal. */
export const TAG_UPSTREAM_APPLIED = "applied";
/** One chunk of one parton's Flight payload: body is
 *  `<parton-id>\n<bytes>`. Frames from different partons interleave
 *  freely; a parton's own frames arrive in render order. */
export const TAG_MUX_FRAME = "mux";
/** Closes a parton's lane: body is the parton id. The parton's payload
 *  is complete on the wire — the client can decode + commit it. The
 *  same id may open again later (a subsequent re-render of the same
 *  parton on the same connection). */
export const TAG_MUX_END = "muxend";

/**
 * Body shape of an `fp` trailer entry (JSON). Maps each spec id whose
 * fingerprint drifted cold→warm this render to that pair:
 *
 *   - `from` — the COLD fp the spec's body actually emitted. Identifies
 *     WHICH cached node the warm fp belongs to: the client aliases `to`
 *     onto whichever `(id, matchKey)` slot still holds `from`, matched
 *     by content rather than by "most recently rendered".
 *   - `to`   — the WARM fp the server recomputes once descendants have
 *     registered (the value the next `?cached=` should carry).
 *
 * Carrying `from` (not just `to`) is what keeps the advertised fp-set in
 * lockstep with the slot's node: a trailer is async, so a concurrent
 * refetch for a different query against the same stable slot can
 * overwrite — and clear — the slot between this response's body commit
 * and its trailer. Matching by `from` means such a superseded trailer
 * finds no slot and is dropped, so the client never advertises a
 * fingerprint it can no longer correctly restore. See `applyFpUpdates`
 * in `partial-client.tsx` (client) and `computeFpUpdates` in
 * `fp-trailer.ts` (server).
 */
export interface FpUpdate {
	from: string;
	to: string;
}

export type FpUpdatesPayload = Record<string, FpUpdate>;

/** Backward-compat alias the legacy `wrapStreamWithFpTrailer` caller
 *  used to build its sole trailer entry. Kept around for any out-of-
 *  tree code that imported the constant directly; new code should use
 *  `buildMarker(TAG_FP_UPDATES, length)`. */
export const PREFIX_BYTE_VALUE = PREFIX_BYTE;
