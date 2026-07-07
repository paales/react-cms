/**
 * Client-side splitter for the segmented-Flight wire format.
 *
 * Pairs with `lib/fp-trailer.ts` (server). The server emits a stream
 * shaped as one or more segments, each terminated by zero-or-more
 * trailer entries:
 *
 *   ┌─ Flight document 1 bytes ────────────────────────────────────┐
 *   │ <Flight rows…>                                               │
 *   │ \xFF[parton:fp:N]\n<N-byte JSON body>                        │   ← trailer entry
 *   │ \xFF[parton:url:M]\n<M-byte JSON body>                       │   ← trailer entry
 *   │ \xFF[parton:settled:0]\n                                     │   ← render-done milestone
 *   ├─ optional segment delimiter ─────────────────────────────────┤
 *   │ \xFF[parton:next:0]\n                                        │
 *   ├─ Flight document 2 bytes ────────────────────────────────────┤
 *   │ <Flight rows…>                                               │
 *   │ <fp-trailer + settled for segment 2>                         │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Single-segment streams (no `next` delimiter) parse as one segment,
 * matching the legacy single-trailer flow.
 *
 * The `settled` marker closes every segment's trailer block: the server
 * writes it once the segment's render has fully drained. It is the
 * "safe to abort here" signal — the abort listener cancels the reader
 * immediately if the in-flight segment is already settled, and DEFERS
 * until the marker arrives if the render is still mid-flight, so an
 * abort never closes a body before its deferred references land. See
 * `onAbortSignal` below.
 *
 * Per segment the splitter exposes:
 *   - `body`     — a ReadableStream of the Flight bytes for THAT
 *                  segment, ready to hand to `createFromReadableStream`.
 *   - `trailers` — a Promise<Map<tag, body bytes>> resolving once the
 *                  segment's trailer block is fully read (at the latest
 *                  by its `settled` marker).
 *
 * Streaming-safe with minimal holdback. Flight bytes are forwarded
 * to the body stream as they arrive; the splitter only holds back
 * once it sees a `\xFF` (the marker prefix — invalid as UTF-8, so it
 * never occurs inside Flight payload bytes).
 */

import {
	TAG_LANES_OPEN,
	TAG_MUX_END,
	TAG_MUX_FRAME,
	TAG_NEXT_SEGMENT,
	TAG_SEGMENT_SETTLED,
	tryReadMarker,
} from "./fp-trailer-marker.ts";

/** One parton's complete Flight payload peeled off a lanes segment.
 *  `body` carries the lane's Flight bytes AND its own fp-trailer
 *  entries (the server wraps each lane render with
 *  `wrapStreamWithFpTrailer`), so consumers run `splitAtFpTrailer`
 *  on it before decoding. Closes on the lane's `muxend`; errors if
 *  the connection tears mid-lane — the tear rejects only this lane's
 *  un-committed decode, never a committed tree. */
export interface DemuxedLane {
	partonId: string;
	body: ReadableStream<Uint8Array>;
}

/**
 * A segment is either a whole Flight document (`payload` — every
 * navigation, refetch, and the first segment of a live connection) or
 * a per-parton lane region (`lanes` — a live connection after its
 * initial segment; see `driveLaneStream` in `segmented-response.ts`).
 * The server announces a lanes segment with a zero-length
 * `\xFF[parton:lanes:0]` marker as its first bytes, so the splitter
 * classifies BEFORE the consumer picks a decoder.
 */
export type Segment =
	| {
			kind: "payload";
			body: ReadableStream<Uint8Array>;
			trailers: Promise<Map<string, Uint8Array>>;
	  }
	| {
			kind: "lanes";
			lanes: AsyncIterable<DemuxedLane>;
	  };

/** Progressive entry surface: called with each trailer ENTRY the
 *  moment it is read off the wire — payload-segment entries (which
 *  also land in the segment's trailer map) and lanes-region framed
 *  entries (which have no map) alike. Milestone tags never fire it.
 *  What makes it exist: some entries are handshakes, not metadata —
 *  the server-minted connection id (`conn`) must reach the channel
 *  transport when it ARRIVES (ahead of the first segment's body),
 *  not when the segment settles and its trailer map resolves. */
export type OnWireEntry = (tag: string, body: Uint8Array) => void;

/**
 * Consume a segmented-Flight stream and produce an async iterable of
 * its segments. The caller iterates with `for await (const seg of …)`,
 * piping each `seg.body` through `createFromReadableStream` and
 * awaiting `seg.trailers` for metadata.
 */
export function splitSegments(
	source: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEntry?: OnWireEntry,
): AsyncIterable<Segment> {
	return {
		[Symbol.asyncIterator]() {
			return new SegmentIterator(source, signal, onEntry);
		},
	};
}

/**
 * Convenience wrapper for the legacy single-segment flow. Resolves
 * with `{mainStream, trailer}` where `trailer` is the parsed fp-update
 * JSON (the legacy shape) and `mainStream` is the first segment's
 * Flight body. Any segments past the first are dropped — callers that
 * want segmented behavior should use `splitSegments` directly.
 */
export interface SplitResult {
	mainStream: ReadableStream<Uint8Array>;
	trailer: Promise<Record<string, string> | null>;
}

export function splitAtFpTrailer(
	source: ReadableStream<Uint8Array>,
): SplitResult {
	const iter = splitSegments(source)[Symbol.asyncIterator]();
	let bodyController!: ReadableStreamDefaultController<Uint8Array>;
	const mainStream = new ReadableStream<Uint8Array>({
		start(c) {
			bodyController = c;
		},
	});
	const trailerPromise: Promise<Record<string, string> | null> = (async () => {
		const first = await iter.next();
		if (first.done || first.value.kind !== "payload") {
			bodyController.close();
			return null;
		}
		const seg = first.value;
		seg.body
			.pipeTo(
				new WritableStream<Uint8Array>({
					write(chunk) {
						bodyController.enqueue(chunk);
					},
					close() {
						try {
							bodyController.close();
						} catch {}
					},
					abort(err) {
						try {
							bodyController.error(err);
						} catch {}
					},
				}),
			)
			.catch(() => {});
		const trailers = await seg.trailers;
		const fpBytes = trailers.get("fp");
		if (!fpBytes) return null;
		try {
			return JSON.parse(new TextDecoder().decode(fpBytes)) as Record<
				string,
				string
			>;
		} catch {
			return null;
		}
	})();
	return { mainStream, trailer: trailerPromise };
}

/** Tags that end a segment's body block (phase transitions). Every
 *  other tag is a data ENTRY that may interleave with body bytes —
 *  recorded into the segment's trailer map wherever it appears. */
const MILESTONE_TAGS = new Set<string>([
	TAG_SEGMENT_SETTLED,
	TAG_NEXT_SEGMENT,
	TAG_LANES_OPEN,
	TAG_MUX_FRAME,
	TAG_MUX_END,
]);

// ─── Internal state machine ─────────────────────────────────────────

class SegmentIterator implements AsyncIterator<Segment> {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private leftover: Uint8Array = new Uint8Array(0);
	private sourceClosed = false;
	private exhausted = false;
	private currentDrive: Promise<void> | null = null;
	private signal?: AbortSignal;
	private cancelled = false;
	// Whether the in-flight segment's render has fully drained — set when
	// its `settled` marker is read, reset when the next segment begins.
	// The abort gate (`onAbortSignal`) reads it to decide whether it can
	// cancel NOW or must wait.
	private bodySettled = false;
	// An abort that arrived mid-render and is waiting for `settled`.
	private abortPending = false;
	// The in-flight segment is a lanes segment. Aborts cancel immediately
	// here regardless of `bodySettled`: tearing a lane mid-payload rejects
	// only that lane's un-committed decode (dropped by the consumer),
	// never a committed tree — unlike a whole payload document, whose
	// pending deferred references belong to content React already
	// committed.
	private lanesActive = false;
	private onEntry?: OnWireEntry;

	constructor(
		source: ReadableStream<Uint8Array>,
		signal?: AbortSignal,
		onEntry?: OnWireEntry,
	) {
		this.reader = source.getReader();
		this.signal = signal;
		this.onEntry = onEntry;
		if (signal) {
			// Already aborted at construction: no segment is in flight, so
			// there is nothing to tear — cancel straight away. `next`'s
			// boundary check then ends iteration cleanly.
			if (signal.aborted) this.cancelReader();
			else
				signal.addEventListener("abort", () => this.onAbortSignal(), {
					once: true,
				});
		}
	}

	/**
	 * Honor an abort — but only at a point where cancelling the reader
	 * won't tear a partially-delivered Flight body.
	 *
	 * If the in-flight segment is already `settled` (its render fully
	 * drained, the connection now parked awaiting the next bump), cancel
	 * immediately: the body is wholly delivered, and the parked
	 * `readChunk` would otherwise deadlock `currentDrive`. This is the
	 * common case — the live heartbeat tears down on navigate while its
	 * `?streaming=1` connection sits idle between segments.
	 *
	 * If the segment is mid-render, DEFER: cancelling now would close the
	 * body before its deferred references arrive, rejecting them with
	 * "Connection closed." and tearing the committed tree through the
	 * error boundary. Record the intent; `driveSegment` cancels the
	 * instant it reads the `settled` marker, by which point the body has
	 * drained via a clean close. The wait is bounded by the current
	 * render completing — exactly "abort, but only once this iteration is
	 * finished."
	 */
	private onAbortSignal(): void {
		if (this.bodySettled || this.lanesActive) this.cancelReader();
		else this.abortPending = true;
	}

	/** Cancel the source reader exactly once — releasing the upstream
	 *  connection. Invoked from the abort listener, the boundary check,
	 *  and `return`; the `cancelled` guard keeps it single. */
	private cancelReader(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		this.reader.cancel().catch(() => {});
	}

	async next(): Promise<IteratorResult<Segment>> {
		if (this.currentDrive) {
			try {
				await this.currentDrive;
			} catch {}
			this.currentDrive = null;
		}
		if (this.exhausted) return { value: undefined, done: true };

		// Cooperative abort at the SEGMENT BOUNDARY. A supersede (newer
		// nav, heartbeat teardown on navigate) aborted the signal; the
		// prior segment above finished draining via `currentDrive` (it was
		// `settled` before it ended, so the abort gate could release). Now,
		// before producing the NEXT segment, honor the abort and end
		// iteration cleanly. The reader is cancelled idempotently (the abort
		// gate may already have done it) so the server connection is freed.
		if (this.signal?.aborted) {
			this.cancelReader();
			this.exhausted = true;
			return { value: undefined, done: true };
		}

		// A fresh segment starts un-settled: an abort from here must wait
		// for its render to drain before cancelling.
		this.bodySettled = false;
		this.lanesActive = false;

		// Classify the upcoming segment BEFORE handing it to a consumer:
		// a lanes segment opens with the zero-length `lanes` marker as its
		// very first bytes, a payload segment opens with Flight bytes (or,
		// degenerately, a bare trailer). Consumers pick their decode path
		// off `kind`, so an (empty-bodied) lanes segment is never fed to
		// `createFromReadableStream`.
		const kind = await this.classifyNext();
		if (kind === "end") {
			this.exhausted = true;
			return { value: undefined, done: true };
		}
		if (kind === "lanes") {
			this.lanesActive = true;
			// A parked lanes region is always safe to abort (see
			// `onAbortSignal`); release any abort that was deferred while a
			// prior payload segment drained.
			if (this.abortPending) {
				this.cancelReader();
				this.exhausted = true;
				return { value: undefined, done: true };
			}
			const queue = new LaneQueue();
			const segment: Segment = { kind: "lanes", lanes: queue };
			this.currentDrive = this.driveLanes(queue).catch((err) => {
				queue.fail(err instanceof Error ? err : new Error(String(err)));
				this.exhausted = true;
			});
			return { value: segment, done: false };
		}

		const active = new ActiveSegment();
		const segment: Segment = {
			kind: "payload",
			body: active.bodyStream,
			trailers: active.trailersPromise,
		};
		this.currentDrive = this.driveSegment(active).catch((err) => {
			active.closeBody(err instanceof Error ? err : new Error(String(err)));
			active.resolveTrailers();
			this.exhausted = true;
		});
		return { value: segment, done: false };
	}

	/**
	 * Peek the next segment's opening bytes: `"lanes"` when they parse as
	 * the `lanes` marker (which is consumed), `"payload"` for anything
	 * else (bytes left untouched), `"end"` when the source closed with
	 * nothing left.
	 */
	private async classifyNext(): Promise<"payload" | "lanes" | "end"> {
		while (true) {
			if (this.leftover.length === 0) {
				const chunk = await this.readChunk();
				if (chunk == null)
					return this.leftover.length === 0 ? "end" : "payload";
				this.leftover = concat(this.leftover, chunk);
			}
			if (this.leftover[0] !== 0xff) return "payload";
			const parsed = tryReadMarker(this.leftover);
			if (parsed === "need-more") {
				if (this.sourceClosed) return "payload";
				const chunk = await this.readChunk();
				if (chunk == null) return "payload";
				this.leftover = concat(this.leftover, chunk);
				continue;
			}
			if (parsed === "invalid") return "payload";
			if (parsed.tag !== TAG_LANES_OPEN) return "payload";
			this.leftover = copySlice(
				this.leftover,
				parsed.headerSize + parsed.length,
				this.leftover.length,
			);
			return "lanes";
		}
	}

	/**
	 * Drive a lanes segment: every byte from here is framed (`mux` /
	 * `muxend` / `settled` / `next`), no raw Flight content. `mux` frames
	 * route each parton's chunks into its own body stream; `muxend`
	 * closes it — the same id may open again for a later re-render of
	 * the same parton. A source close with lanes still open errors those
	 * bodies (torn connection → each open lane's decoder rejects,
	 * dropped by the consumer); a clean close (or a `next` delimiter)
	 * ends the queue.
	 */
	private async driveLanes(queue: LaneQueue): Promise<void> {
		const open = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
		const torn = (message: string): void => {
			const err = new Error(message);
			for (const controller of open.values()) {
				try {
					controller.error(err);
				} catch {}
			}
			open.clear();
		};
		try {
			while (true) {
				let parsed = tryReadMarker(this.leftover);
				while (parsed === "need-more" && !this.sourceClosed) {
					const chunk = await this.readChunk();
					if (chunk == null) break;
					this.leftover = concat(this.leftover, chunk);
					parsed = tryReadMarker(this.leftover);
				}
				if (parsed === "need-more") {
					// Source closed. Clean end iff nothing is mid-frame and no
					// lane is open.
					if (this.leftover.length > 0)
						torn("lanes segment ended mid-frame header");
					else if (open.size > 0)
						torn("connection closed with parton lanes open");
					this.exhausted = true;
					return;
				}
				if (parsed === "invalid") {
					torn("lanes segment: invalid frame marker");
					this.exhausted = true;
					return;
				}
				const totalSize = parsed.headerSize + parsed.length;
				while (this.leftover.length < totalSize) {
					const chunk = await this.readChunk();
					if (chunk == null) {
						torn("lanes segment ended mid-frame body");
						this.exhausted = true;
						return;
					}
					this.leftover = concat(this.leftover, chunk);
				}
				const body =
					parsed.length > 0
						? copySlice(this.leftover, parsed.headerSize, totalSize)
						: new Uint8Array(0);
				this.leftover = copySlice(
					this.leftover,
					totalSize,
					this.leftover.length,
				);

				if (parsed.tag === TAG_MUX_FRAME) {
					const nl = body.indexOf(0x0a);
					if (nl < 0) {
						torn("mux frame missing id separator");
						this.exhausted = true;
						return;
					}
					const partonId = new TextDecoder().decode(body.subarray(0, nl));
					const chunk = copySlice(body, nl + 1, body.length);
					const existing = open.get(partonId);
					if (existing) {
						existing.enqueue(chunk);
						continue;
					}
					let controller!: ReadableStreamDefaultController<Uint8Array>;
					const laneBody = new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						},
					});
					open.set(partonId, controller);
					controller.enqueue(chunk);
					queue.push({ partonId, body: laneBody });
					continue;
				}
				if (parsed.tag === TAG_MUX_END) {
					const partonId = new TextDecoder().decode(body);
					const controller = open.get(partonId);
					if (controller) {
						try {
							controller.close();
						} catch {}
						open.delete(partonId);
					}
					continue;
				}
				if (parsed.tag === TAG_SEGMENT_SETTLED) {
					// Quiesce milestone: every lane drained. Nothing to release —
					// lanes segments are always abort-safe — but keep the marker
					// flowing for symmetry with the payload grammar.
					this.bodySettled = true;
					continue;
				}
				if (parsed.tag === "next") {
					// Next segment follows — the driver's scheduled whole-tree
					// reconcile ends the lanes region this way (a payload
					// segment flows, then `next` + `lanes` reopens the region).
					// A lane still open here ended mid-payload — error its body
					// so its decode rejects like any other torn lane, instead
					// of hanging on a stream nothing will ever close. (The
					// server only reconciles at quiesce, so a well-formed
					// stream never hits that arm.)
					if (open.size > 0)
						torn("lanes segment ended with parton lanes open");
					return;
				}
				// Framed ENTRY (the connection-id handshake on a catch-up
				// boot, future data tags) — surface it and keep demuxing;
				// entries a consumer doesn't handle are skipped, never errors.
				this.onEntry?.(parsed.tag, body);
			}
		} finally {
			queue.end();
		}
	}

	/** Body phase: forward bytes to the segment's body stream, watching
	 *  for a `\xFF` marker prefix that ends the body block. Pure UTF-8
	 *  Flight content never contains `\xFF`, so byte runs without
	 *  `\xFF` are forwarded immediately — preserves Suspense streaming
	 *  pacing. */
	private async driveSegment(seg: ActiveSegment): Promise<void> {
		bodyLoop: while (true) {
			const buf = await this.pullMore();
			if (buf.length === 0) {
				seg.closeBody();
				seg.resolveTrailers();
				this.exhausted = true;
				return;
			}
			const ffIdx = buf.indexOf(0xff);
			if (ffIdx < 0) {
				seg.enqueueBody(buf);
				continue;
			}
			if (ffIdx > 0) seg.enqueueBody(copySlice(buf, 0, ffIdx));
			this.leftover = copySlice(buf, ffIdx, buf.length);
			// Accumulate until tryReadMarker can decide.
			while (true) {
				const result = tryReadMarker(this.leftover);
				if (result === "invalid") {
					// The leading `\xFF` doesn't begin a valid marker. Could be
					// junk from a torn stream; advance past it as a body byte and
					// resume scanning. In practice this never fires in
					// well-formed streams.
					if (this.sourceClosed && this.leftover.length === 1) {
						seg.enqueueBody(this.leftover);
						this.leftover = new Uint8Array(0);
						seg.closeBody();
						seg.resolveTrailers();
						this.exhausted = true;
						return;
					}
					// Emit the lone byte to body, drop it from leftover, restart
					// the body-phase loop so we scan for the next `\xFF` (if any).
					seg.enqueueBody(copySlice(this.leftover, 0, 1));
					this.leftover = copySlice(this.leftover, 1, this.leftover.length);
					continue bodyLoop;
				}
				if (result === "need-more") {
					if (this.sourceClosed) {
						// Truncated trailer header. Treat as garbage; flush
						// remaining bytes to body and close out.
						if (this.leftover.length > 0) seg.enqueueBody(this.leftover);
						this.leftover = new Uint8Array(0);
						seg.closeBody();
						seg.resolveTrailers();
						this.exhausted = true;
						return;
					}
					const chunk = await this.readChunk();
					if (chunk == null) continue;
					this.leftover = concat(this.leftover, chunk);
					continue;
				}
				// Confirmed marker. ENTRY tags (fp / url / future data tags)
				// interleave with body bytes — the server emits a parton's
				// warm-fp entry the moment its subtree settles, between body
				// chunks — so they're recorded here and the body continues.
				// MILESTONE tags (settled / next / lanes / mux) end the body
				// block; the trailer phase owns those.
				if (!MILESTONE_TAGS.has(result.tag)) {
					const totalSize = result.headerSize + result.length;
					let truncated = false;
					while (this.leftover.length < totalSize && !this.sourceClosed) {
						const chunk = await this.readChunk();
						if (chunk == null) break;
						this.leftover = concat(this.leftover, chunk);
					}
					if (this.leftover.length < totalSize) truncated = true;
					if (truncated) {
						// Torn mid-entry: nothing usable. Close out like the
						// truncated-header case.
						this.leftover = new Uint8Array(0);
						seg.closeBody();
						seg.resolveTrailers();
						this.exhausted = true;
						return;
					}
					const entryBody =
						result.length > 0
							? copySlice(this.leftover, result.headerSize, totalSize)
							: new Uint8Array(0);
					seg.addTrailer(result.tag, entryBody);
					this.onEntry?.(result.tag, entryBody);
					this.leftover = copySlice(this.leftover, totalSize, this.leftover.length);
					continue bodyLoop;
				}
				// Milestone: close body; trailer phase reads from leftover
				// (which still starts at the `\xFF` prefix).
				seg.closeBody();
				break bodyLoop;
			}
		}

		// Trailer phase: parse markers + bodies back-to-back. Each marker
		// is parsed by `tryReadMarker`; we then consume the body bytes.
		// `next` is a delimiter (length=0) and ends this segment.
		while (true) {
			let parsed = tryReadMarker(this.leftover);
			while (parsed === "need-more" && !this.sourceClosed) {
				const chunk = await this.readChunk();
				if (chunk == null) break;
				this.leftover = concat(this.leftover, chunk);
				parsed = tryReadMarker(this.leftover);
			}
			if (parsed === "need-more" || parsed === "invalid") {
				seg.resolveTrailers();
				this.exhausted = true;
				return;
			}
			const totalSize = parsed.headerSize + parsed.length;
			while (this.leftover.length < totalSize && !this.sourceClosed) {
				const chunk = await this.readChunk();
				if (chunk == null) break;
				this.leftover = concat(this.leftover, chunk);
			}
			if (this.leftover.length < totalSize) {
				seg.resolveTrailers();
				this.exhausted = true;
				return;
			}
			const bodyBytes =
				parsed.length > 0
					? copySlice(this.leftover, parsed.headerSize, totalSize)
					: new Uint8Array(0);
			this.leftover = copySlice(this.leftover, totalSize, this.leftover.length);
			if (parsed.tag === TAG_SEGMENT_SETTLED) {
				// The render fully drained — body + fp/url trailers are all
				// delivered and the body stream is already closed. Resolve
				// trailers now (the consumer's fp registration fires promptly,
				// not deferred to the next segment) and mark the segment
				// settled. If an abort arrived mid-render and was deferred,
				// release it here: cancelling now frees the connection with no
				// pending reference left to tear. Otherwise keep reading for a
				// `next` delimiter or stream close — the connection is parked,
				// and any abort from here cancels immediately (bodySettled).
				this.bodySettled = true;
				seg.resolveTrailers();
				if (this.abortPending) {
					this.cancelReader();
					this.exhausted = true;
					return;
				}
				continue;
			}
			if (parsed.tag === "next") {
				seg.resolveTrailers();
				return;
			}
			seg.addTrailer(parsed.tag, bodyBytes);
			this.onEntry?.(parsed.tag, bodyBytes);
			if (this.leftover.length === 0 && this.sourceClosed) {
				seg.resolveTrailers();
				this.exhausted = true;
				return;
			}
		}
	}

	private async pullMore(): Promise<Uint8Array> {
		if (this.leftover.length > 0) {
			const out = this.leftover;
			this.leftover = new Uint8Array(0);
			return out;
		}
		if (this.sourceClosed) return new Uint8Array(0);
		const chunk = await this.readChunk();
		return chunk ?? new Uint8Array(0);
	}

	private async readChunk(): Promise<Uint8Array | null> {
		if (this.sourceClosed) return null;
		const { done, value } = await this.reader.read();
		if (done) {
			this.sourceClosed = true;
			return null;
		}
		return value;
	}

	async return(): Promise<IteratorResult<Segment>> {
		this.cancelReader();
		this.exhausted = true;
		return { value: undefined, done: true };
	}
}

/** Push-queue backing a lanes segment's `AsyncIterable<DemuxedLane>`.
 *  The drive loop pushes a lane the first time its id appears; the
 *  consumer's `for await` pulls in arrival order. `end()` completes
 *  iteration; `fail(err)` rejects a pending pull (a torn source). */
class LaneQueue implements AsyncIterable<DemuxedLane> {
	private buffered: DemuxedLane[] = [];
	private waiters: Array<{
		resolve: (r: IteratorResult<DemuxedLane>) => void;
		reject: (err: Error) => void;
	}> = [];
	private ended = false;
	private error: Error | null = null;

	push(lane: DemuxedLane): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value: lane, done: false });
		else this.buffered.push(lane);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(err: Error): void {
		if (this.ended) return;
		this.ended = true;
		this.error = err;
		for (const waiter of this.waiters.splice(0)) waiter.reject(err);
	}

	[Symbol.asyncIterator](): AsyncIterator<DemuxedLane> {
		return {
			next: (): Promise<IteratorResult<DemuxedLane>> => {
				const lane = this.buffered.shift();
				if (lane) return Promise.resolve({ value: lane, done: false });
				if (this.error) return Promise.reject(this.error);
				if (this.ended)
					return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve, reject) => {
					this.waiters.push({ resolve, reject });
				});
			},
		};
	}
}

class ActiveSegment {
	bodyStream: ReadableStream<Uint8Array>;
	private bodyController!: ReadableStreamDefaultController<Uint8Array>;
	private bodyOpen = true;
	private trailersResolved = false;
	private trailers = new Map<string, Uint8Array>();
	trailersPromise: Promise<Map<string, Uint8Array>>;
	private resolveTrailersFn!: (m: Map<string, Uint8Array>) => void;

	constructor() {
		this.bodyStream = new ReadableStream<Uint8Array>({
			start: (c) => {
				this.bodyController = c;
			},
		});
		this.trailersPromise = new Promise((r) => {
			this.resolveTrailersFn = r;
		});
	}

	enqueueBody(bytes: Uint8Array): void {
		if (!this.bodyOpen) return;
		if (bytes.length > 0) this.bodyController.enqueue(bytes);
	}

	closeBody(err?: Error): void {
		if (!this.bodyOpen) return;
		this.bodyOpen = false;
		try {
			if (err) this.bodyController.error(err);
			else this.bodyController.close();
		} catch {}
	}

	addTrailer(tag: string, bytes: Uint8Array): void {
		this.trailers.set(tag, bytes);
	}

	resolveTrailers(): void {
		if (this.trailersResolved) return;
		this.trailersResolved = true;
		this.resolveTrailersFn(this.trailers);
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function copySlice(src: Uint8Array, start: number, end: number): Uint8Array {
	const out = new Uint8Array(end - start);
	out.set(src.subarray(start, end), 0);
	return out;
}
