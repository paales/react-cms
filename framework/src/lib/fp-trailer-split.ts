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
 *   ├─ optional segment delimiter ─────────────────────────────────┤
 *   │ \xFF[parton:next:0]\n                                        │
 *   ├─ Flight document 2 bytes ────────────────────────────────────┤
 *   │ <Flight rows…>                                               │
 *   │ <fp-trailer for segment 2>                                   │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Single-segment streams (no `next` delimiter) parse as one segment,
 * matching the legacy single-trailer flow.
 *
 * Per segment the splitter exposes:
 *   - `body`     — a ReadableStream of the Flight bytes for THAT
 *                  segment, ready to hand to `createFromReadableStream`.
 *   - `trailers` — a Promise<Map<tag, body bytes>> resolving once the
 *                  segment's trailer block (zero or more entries) is
 *                  fully read.
 *
 * Streaming-safe with minimal holdback. Flight bytes are forwarded
 * to the body stream as they arrive; the splitter only holds back
 * once it sees a `\xFF` (the marker prefix — invalid as UTF-8, so it
 * never occurs inside Flight payload bytes).
 */

import { tryReadMarker } from "./fp-trailer-marker.ts"

export interface Segment {
  body: ReadableStream<Uint8Array>
  trailers: Promise<Map<string, Uint8Array>>
}

/**
 * Consume a segmented-Flight stream and produce an async iterable of
 * its segments. The caller iterates with `for await (const seg of …)`,
 * piping each `seg.body` through `createFromReadableStream` and
 * awaiting `seg.trailers` for metadata.
 */
export function splitSegments(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Segment> {
  return {
    [Symbol.asyncIterator]() {
      return new SegmentIterator(source, signal)
    },
  }
}

/**
 * Convenience wrapper for the legacy single-segment flow. Resolves
 * with `{mainStream, trailer}` where `trailer` is the parsed fp-update
 * JSON (the legacy shape) and `mainStream` is the first segment's
 * Flight body. Any segments past the first are dropped — callers that
 * want segmented behavior should use `splitSegments` directly.
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
  private leftover: Uint8Array = new Uint8Array(0)
  private sourceClosed = false
  private exhausted = false
  private currentDrive: Promise<void> | null = null
  private signal?: AbortSignal
  private cancelled = false

  constructor(source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    this.reader = source.getReader()
    this.signal = signal
    // Abort can land while `driveSegment` is parked in `readChunk`
    // awaiting bytes from a long-lived-but-silent source (an infinite
    // heartbeat / chat segment-loop that has stopped producing). That
    // read only resolves when the source delivers or closes — neither
    // happens — so awaiting `currentDrive` in `next` would deadlock and
    // the boundary cancel below would never run. Cancelling the reader
    // the instant the signal fires settles the parked read (`done:
    // true`), so the body drains via a clean close (not a torn
    // `error()`) and `currentDrive` resolves.
    if (signal) {
      if (signal.aborted) this.cancelReader()
      else signal.addEventListener("abort", () => this.cancelReader(), { once: true })
    }
  }

  /** Cancel the source reader exactly once — releasing the upstream
   *  connection. Invoked from the abort listener, the boundary check,
   *  and `return`; the `cancelled` guard keeps it single. */
  private cancelReader(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.reader.cancel().catch(() => {})
  }

  async next(): Promise<IteratorResult<Segment>> {
    if (this.currentDrive) {
      try {
        await this.currentDrive
      } catch {}
      this.currentDrive = null
    }
    if (this.exhausted) return { value: undefined, done: true }

    // Cooperative abort at the SEGMENT BOUNDARY. A supersede (newer
    // nav, heartbeat teardown on navigate) aborts the signal, but we
    // never interrupt a segment whose body is mid-flight — that would
    // error the response body and tear the partially-committed tree
    // (the `BodyStreamBuffer was aborted` crash). Instead the in-flight
    // segment above finished draining via `currentDrive`; now, before
    // producing the NEXT segment, honor the abort and end iteration
    // cleanly. The reader is cancelled (idempotently — the abort
    // listener may already have done it) so the server connection is
    // released.
    if (this.signal?.aborted) {
      this.cancelReader()
      this.exhausted = true
      return { value: undefined, done: true }
    }

    const active = new ActiveSegment()
    const segment: Segment = {
      body: active.bodyStream,
      trailers: active.trailersPromise,
    }
    this.currentDrive = this.driveSegment(active).catch((err) => {
      active.closeBody(err instanceof Error ? err : new Error(String(err)))
      active.resolveTrailers()
      this.exhausted = true
    })
    return { value: segment, done: false }
  }

  /** Body phase: forward bytes to the segment's body stream, watching
   *  for a `\xFF` marker prefix that ends the body block. Pure UTF-8
   *  Flight content never contains `\xFF`, so byte runs without
   *  `\xFF` are forwarded immediately — preserves Suspense streaming
   *  pacing. */
  private async driveSegment(seg: ActiveSegment): Promise<void> {
    bodyLoop: while (true) {
      const buf = await this.pullMore()
      if (buf.length === 0) {
        seg.closeBody()
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const ffIdx = buf.indexOf(0xff)
      if (ffIdx < 0) {
        seg.enqueueBody(buf)
        continue
      }
      if (ffIdx > 0) seg.enqueueBody(copySlice(buf, 0, ffIdx))
      this.leftover = copySlice(buf, ffIdx, buf.length)
      // Accumulate until tryReadMarker can decide.
      while (true) {
        const result = tryReadMarker(this.leftover)
        if (result === "invalid") {
          // The leading `\xFF` doesn't begin a valid marker. Could be
          // junk from a torn stream; advance past it as a body byte and
          // resume scanning. In practice this never fires in
          // well-formed streams.
          if (this.sourceClosed && this.leftover.length === 1) {
            seg.enqueueBody(this.leftover)
            this.leftover = new Uint8Array(0)
            seg.closeBody()
            seg.resolveTrailers()
            this.exhausted = true
            return
          }
          // Emit the lone byte to body, drop it from leftover, restart
          // the body-phase loop so we scan for the next `\xFF` (if any).
          seg.enqueueBody(copySlice(this.leftover, 0, 1))
          this.leftover = copySlice(this.leftover, 1, this.leftover.length)
          continue bodyLoop
        }
        if (result === "need-more") {
          if (this.sourceClosed) {
            // Truncated trailer header. Treat as garbage; flush
            // remaining bytes to body and close out.
            if (this.leftover.length > 0) seg.enqueueBody(this.leftover)
            this.leftover = new Uint8Array(0)
            seg.closeBody()
            seg.resolveTrailers()
            this.exhausted = true
            return
          }
          const chunk = await this.readChunk()
          if (chunk == null) continue
          this.leftover = concat(this.leftover, chunk)
          continue
        }
        // Confirmed marker. Close body; trailer phase reads from
        // leftover (which still starts at the `\xFF` prefix).
        seg.closeBody()
        break bodyLoop
      }
    }

    // Trailer phase: parse markers + bodies back-to-back. Each marker
    // is parsed by `tryReadMarker`; we then consume the body bytes.
    // `next` is a delimiter (length=0) and ends this segment.
    while (true) {
      let parsed = tryReadMarker(this.leftover)
      while (parsed === "need-more" && !this.sourceClosed) {
        const chunk = await this.readChunk()
        if (chunk == null) break
        this.leftover = concat(this.leftover, chunk)
        parsed = tryReadMarker(this.leftover)
      }
      if (parsed === "need-more" || parsed === "invalid") {
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const totalSize = parsed.headerSize + parsed.length
      while (this.leftover.length < totalSize && !this.sourceClosed) {
        const chunk = await this.readChunk()
        if (chunk == null) break
        this.leftover = concat(this.leftover, chunk)
      }
      if (this.leftover.length < totalSize) {
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
      const bodyBytes =
        parsed.length > 0
          ? copySlice(this.leftover, parsed.headerSize, totalSize)
          : new Uint8Array(0)
      this.leftover = copySlice(this.leftover, totalSize, this.leftover.length)
      if (parsed.tag === "next") {
        seg.resolveTrailers()
        return
      }
      seg.addTrailer(parsed.tag, bodyBytes)
      if (this.leftover.length === 0 && this.sourceClosed) {
        seg.resolveTrailers()
        this.exhausted = true
        return
      }
    }
  }

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
    this.cancelReader()
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
