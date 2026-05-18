/**
 * Client-side splitter for the segmented-Flight wire format.
 *
 * Pairs with `lib/fp-trailer.ts` (server). The server emits a stream
 * shaped as one or more segments, each terminated by zero-or-more
 * trailer entries:
 *
 *   ┌─ Flight document 1 bytes ────────────────────────────────────┐
 *   │ <Flight rows…>                                               │
 *   │ <12-byte marker tag="fp"><4-byte length><JSON body>          │   ← trailer entry
 *   │ <12-byte marker tag="url"><4-byte length><JSON body>         │   ← trailer entry
 *   ├─ optional segment delimiter ─────────────────────────────────┤
 *   │ <12-byte marker tag="next"><4-byte length=0>                 │
 *   ├─ Flight document 2 bytes ────────────────────────────────────┤
 *   │ <Flight rows…>                                               │
 *   │ <fp-trailer for segment 2>                                   │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Single-segment streams (no `next` delimiter) parse as one segment,
 * matching the legacy fp-trailer flow.
 *
 * Per segment the splitter exposes:
 *   - `body`     — a ReadableStream of the Flight bytes for THAT
 *                  segment, ready to hand to `createFromReadableStream`.
 *   - `trailers` — a Promise<Map<tag, body bytes>> resolving once the
 *                  segment's trailer block (zero or more entries) is
 *                  fully read.
 *
 * Streaming-safe with bounded buffering. Flight bytes are forwarded
 * to the body stream as they arrive; the splitter keeps at most
 * `MARKER_LENGTH-1` trailing bytes in a tail buffer to catch a marker
 * that straddles a chunk boundary.
 */

import { MARKER_LENGTH, readMarkerTag } from "./fp-trailer-marker.ts"

export interface Segment {
  /** Flight bytes for this segment. Closes when the segment's body
   *  block ends (either at the first trailer marker or at end-of-stream
   *  if no trailers follow). */
  body: ReadableStream<Uint8Array>
  /** Resolves with a tag → body-bytes map once the segment's trailer
   *  block is fully read. Trailers without bodies (e.g. `next`) are
   *  not included — they affect framing only. */
  trailers: Promise<Map<string, Uint8Array>>
}

/**
 * Consume a segmented-Flight stream and produce an async iterable of
 * its segments. The caller iterates with `for await (const seg of …)`,
 * piping each `seg.body` through `createFromReadableStream` and
 * awaiting `seg.trailers` for metadata.
 */
export function splitSegments(source: ReadableStream<Uint8Array>): AsyncIterable<Segment> {
  return {
    [Symbol.asyncIterator]() {
      return new SegmentIterator(source)
    },
  }
}

/**
 * Convenience wrapper for the legacy single-segment flow. Resolves
 * with `{mainStream, trailer}` where `trailer` is the parsed fp-update
 * JSON (the legacy shape) and `mainStream` is the first segment's
 * Flight body. Any segments past the first are dropped on the floor —
 * callers that want segmented behavior should use `splitSegments`
 * directly.
 */
export interface SplitResult {
  mainStream: ReadableStream<Uint8Array>
  trailer: Promise<Record<string, string> | null>
}

export function splitAtFpTrailer(source: ReadableStream<Uint8Array>): SplitResult {
  const iter = splitSegments(source)[Symbol.asyncIterator]()
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  const mainStream = new ReadableStream<Uint8Array>({
    start(c) {
      bodyController = c
    },
  })
  const trailerPromise: Promise<Record<string, string> | null> = (async () => {
    const first = await iter.next()
    if (first.done) {
      bodyController.close()
      return null
    }
    const seg = first.value
    seg.body
      .pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            bodyController.enqueue(chunk)
          },
          close() {
            try {
              bodyController.close()
            } catch {}
          },
          abort(err) {
            try {
              bodyController.error(err)
            } catch {}
          },
        }),
      )
      .catch(() => {})
    const trailers = await seg.trailers
    const fpBytes = trailers.get("fp")
    if (!fpBytes) return null
    try {
      return JSON.parse(new TextDecoder().decode(fpBytes)) as Record<string, string>
    } catch {
      return null
    }
  })()
  return { mainStream, trailer: trailerPromise }
}

// ─── Internal state machine ─────────────────────────────────────────

class SegmentIterator implements AsyncIterator<Segment> {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  /** Bytes pulled from source but not yet processed. Always a freshly
   *  allocated buffer when non-empty, never a subarray view of a
   *  larger buffer (so callers can safely retain references). */
  private leftover: Uint8Array = new Uint8Array(0)
  private sourceClosed = false
  /** Exhausted = both source is closed AND the final segment has been
   *  delivered. Subsequent `next()` calls return done:true. */
  private exhausted = false
  /** Promise of the in-flight `driveSegment` for the current segment.
   *  The next `next()` call awaits this before starting another drive,
   *  ensuring the shared source reader isn't contended. */
  private currentDrive: Promise<void> | null = null

  constructor(source: ReadableStream<Uint8Array>) {
    this.reader = source.getReader()
  }

  async next(): Promise<IteratorResult<Segment>> {
    // Wait for the previous segment's drive to finish (which transitions
    // either to body→trailer→`next` delimiter, ending the segment but
    // leaving the source open, OR to EOS, marking exhausted).
    if (this.currentDrive) {
      try {
        await this.currentDrive
      } catch {}
      this.currentDrive = null
    }
    if (this.exhausted) return { value: undefined, done: true }

    const active = new ActiveSegment()
    const segment: Segment = {
      body: active.bodyStream,
      trailers: active.trailersPromise,
    }
    // Run the drive in the background. The caller consumes body
    // bytes as they arrive (preserving Flight's Suspense streaming
    // timing); trailers resolve when the drive transitions out of
    // body phase.
    this.currentDrive = this.driveSegment(active).catch((err) => {
      active.closeBody(err instanceof Error ? err : new Error(String(err)))
      active.resolveTrailers()
      this.exhausted = true
    })
    return { value: segment, done: false }
  }

  /** Run the state machine until the active segment is fully delivered
   *  (body closed + trailers resolved). Sets `exhausted` if the source
   *  ends with this segment.
   *
   *  Body phase emits source bytes to the segment's body stream with
   *  minimal holdback. Markers always start with `\xFF` (invalid UTF-8
   *  lead byte), and Flight emits valid UTF-8 — so any byte run that
   *  doesn't contain `\xFF` is forwarded immediately, preserving
   *  Suspense streaming timing. Only when `\xFF` appears do we hold
   *  back to accumulate the 12 marker bytes and verify the pattern. */
  private async driveSegment(seg: ActiveSegment): Promise<void> {
    bodyLoop: while (true) {
      const buf = await this.pullMore()
      if (buf.length === 0) {
        // EOS reached without a marker — segment ends here.
        seg.closeBody()
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      // Find the first `\xFF` — the only byte that can start a marker.
      const ffIdx = buf.indexOf(0xff)
      if (ffIdx < 0) {
        // No marker can be in this chunk. Forward in full.
        seg.enqueueBody(buf)
        continue
      }
      // Forward everything before the `\xFF` immediately.
      if (ffIdx > 0) seg.enqueueBody(copySlice(buf, 0, ffIdx))
      // Accumulate enough bytes (≥ MARKER_LENGTH) to validate.
      this.leftover = copySlice(buf, ffIdx, buf.length)
      while (this.leftover.length < MARKER_LENGTH && !this.sourceClosed) {
        const chunk = await this.readChunk()
        if (chunk == null) break
        this.leftover = concat(this.leftover, chunk)
      }
      const tag = this.leftover.length >= MARKER_LENGTH ? readMarkerTag(this.leftover) : null
      if (tag != null) {
        // Confirmed marker. Close body; trailer phase reads from
        // leftover (which still starts with the 12-byte marker).
        seg.closeBody()
        break bodyLoop
      }
      // Not a marker. Either source closed (leftover is final data)
      // or false-positive `\xFF` at offset 0 with more bytes ahead.
      if (this.sourceClosed) {
        if (this.leftover.length > 0) seg.enqueueBody(this.leftover)
        this.leftover = new Uint8Array(0)
        seg.closeBody()
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      // False positive: the leading `\xFF` is data. Emit everything up
      // to the NEXT `\xFF` (the next candidate marker start) and keep
      // from there onward in leftover.
      const nextFf = this.leftover.indexOf(0xff, 1)
      if (nextFf < 0) {
        seg.enqueueBody(this.leftover)
        this.leftover = new Uint8Array(0)
      } else {
        seg.enqueueBody(copySlice(this.leftover, 0, nextFf))
        this.leftover = copySlice(this.leftover, nextFf, this.leftover.length)
      }
      // Loop again to validate at the new `\xFF`.
    }

    // Trailer phase: parse markers back-to-back. Each marker is
    // followed by a 4-byte big-endian length and a body of that
    // length. `next` is a delimiter (length=0) and ends this segment.
    while (true) {
      // Need at least a marker + length to make progress.
      while (this.leftover.length < MARKER_LENGTH + 4 && !this.sourceClosed) {
        const chunk = await this.readChunk()
        if (chunk == null) break
        this.leftover = concat(this.leftover, chunk)
      }
      if (this.leftover.length < MARKER_LENGTH + 4) {
        // Truncated trailer — resolve and bail.
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const tag = readMarkerTag(this.leftover)
      if (tag == null) {
        // Corrupt — not a valid marker.
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const len = new DataView(
        this.leftover.buffer,
        this.leftover.byteOffset + MARKER_LENGTH,
        4,
      ).getUint32(0, false)
      const needed = MARKER_LENGTH + 4 + len
      while (this.leftover.length < needed && !this.sourceClosed) {
        const chunk = await this.readChunk()
        if (chunk == null) break
        this.leftover = concat(this.leftover, chunk)
      }
      if (this.leftover.length < needed) {
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const bodyBytes = copySlice(this.leftover, MARKER_LENGTH + 4, needed)
      this.leftover = copySlice(this.leftover, needed, this.leftover.length)
      if (tag === "next") {
        // Segment boundary. Resolve trailers, leave state ready for
        // the next segment (body mode), and return.
        seg.resolveTrailers()
        return
      }
      seg.addTrailer(tag, bodyBytes)
      // Continue trailer loop — another trailer entry may follow,
      // or EOS will end the segment.
      if (this.leftover.length === 0 && this.sourceClosed) {
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
    }
  }

  /** Return any pending leftover, or pull the next chunk from source.
   *  Empty buffer on EOS. */
  private async pullMore(): Promise<Uint8Array> {
    if (this.leftover.length > 0) {
      const out = this.leftover
      this.leftover = new Uint8Array(0)
      return out
    }
    if (this.sourceClosed) return new Uint8Array(0)
    const chunk = await this.readChunk()
    return chunk ?? new Uint8Array(0)
  }

  private async readChunk(): Promise<Uint8Array | null> {
    if (this.sourceClosed) return null
    const { done, value } = await this.reader.read()
    if (done) {
      this.sourceClosed = true
      return null
    }
    return value
  }

  async return(): Promise<IteratorResult<Segment>> {
    try {
      await this.reader.cancel()
    } catch {}
    this.exhausted = true
    return { value: undefined, done: true }
  }
}

class ActiveSegment {
  bodyStream: ReadableStream<Uint8Array>
  private bodyController!: ReadableStreamDefaultController<Uint8Array>
  private bodyOpen = true
  private trailersResolved = false
  private trailers = new Map<string, Uint8Array>()
  trailersPromise: Promise<Map<string, Uint8Array>>
  private resolveTrailersFn!: (m: Map<string, Uint8Array>) => void

  constructor() {
    this.bodyStream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.bodyController = c
      },
    })
    this.trailersPromise = new Promise((r) => {
      this.resolveTrailersFn = r
    })
  }

  enqueueBody(bytes: Uint8Array): void {
    if (!this.bodyOpen) return
    if (bytes.length > 0) this.bodyController.enqueue(bytes)
  }

  closeBody(err?: Error): void {
    if (!this.bodyOpen) return
    this.bodyOpen = false
    try {
      if (err) this.bodyController.error(err)
      else this.bodyController.close()
    } catch {}
  }

  addTrailer(tag: string, bytes: Uint8Array): void {
    this.trailers.set(tag, bytes)
  }

  resolveTrailers(): void {
    if (this.trailersResolved) return
    this.trailersResolved = true
    this.resolveTrailersFn(this.trailers)
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function copySlice(src: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start)
  out.set(src.subarray(start, end), 0)
  return out
}
