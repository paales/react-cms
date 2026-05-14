/**
 * Client-side splitter for the fp-trailer wire format.
 *
 * Pairs with `lib/fp-trailer.ts` (server). The server appends, after
 * the main Flight bytes, a 12-byte sentinel (`FP_TRAILER_MARKER`)
 * followed by a 4-byte big-endian length and a JSON object. This
 * splitter consumes the response stream, routes everything before
 * the sentinel into a returned ReadableStream the consumer can pass
 * to `createFromReadableStream`, and resolves a promise with the
 * parsed JSON object once the trailer is complete (or `null` when
 * the response carries no trailer).
 *
 * Streaming-safe with NO per-chunk holdback. Each incoming source
 * chunk is forwarded to the main stream immediately, so progressive
 * Flight rows arrive at the parser with their original timing. The
 * marker is detected by scanning a fixed-size "tail" buffer (the
 * concatenation of the last few chunks bounded by the marker
 * length) — when the source closes, if the tail contains the
 * sentinel, the bytes after it are parsed as the trailer. The Flight
 * parser tolerates the marker+JSON trailing bytes because, by then,
 * the root row has long resolved and Flight ignores trailing
 * non-Flight noise.
 *
 * Trade-off: the marker bytes leak through to Flight on every
 * cold→warm response. Flight ignores them. If a Flight implementation
 * ever became strict about trailing bytes, this would need to change
 * back to a holdback approach (and pay the streaming cost).
 */

import { FP_TRAILER_MARKER } from "./fp-trailer-marker.ts"

export interface SplitResult {
  mainStream: ReadableStream<Uint8Array>
  trailer: Promise<Record<string, string> | null>
}

export function splitAtFpTrailer(source: ReadableStream<Uint8Array>): SplitResult {
  let resolveTrailer!: (value: Record<string, string> | null) => void
  let settled = false
  const trailerPromise = new Promise<Record<string, string> | null>((r) => {
    resolveTrailer = (v) => {
      if (settled) return
      settled = true
      r(v)
    }
  })

  const marker = FP_TRAILER_MARKER
  // Tail buffer: the last few chunks concatenated. Bounded — we only
  // need enough bytes to find the marker (which appears once, at the
  // end). Keep enough room for a marker that spans up to one chunk
  // boundary plus a reasonable trailer payload.
  let tail = new Uint8Array(0)
  const TAIL_CAP = marker.length + 4 + 64 * 1024 // marker + length + up to 64KB trailer

  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Pass through immediately — no holdback, no buffering between
      // the source and the consumer.
      controller.enqueue(chunk)
      // Update the rolling tail buffer for end-of-stream marker scan.
      if (chunk.length >= TAIL_CAP) {
        const trimmed = new Uint8Array(TAIL_CAP)
        trimmed.set(chunk.subarray(chunk.length - TAIL_CAP), 0)
        tail = trimmed
      } else {
        const combined = concat(tail, chunk)
        if (combined.length > TAIL_CAP) {
          const trimmed = new Uint8Array(TAIL_CAP)
          trimmed.set(combined.subarray(combined.length - TAIL_CAP), 0)
          tail = trimmed
        } else {
          tail = combined
        }
      }
    },
    flush() {
      // Source closed. Scan the tail for the marker. If found, parse
      // the trailer. Bytes before the marker were ALREADY forwarded
      // to the consumer (Flight); same for the marker bytes
      // themselves and the trailer bytes — Flight ignores them.
      const idx = indexOfMarker(tail, marker)
      if (idx < 0) {
        resolveTrailer(null)
        return
      }
      const trailerBytes = tail.subarray(idx + marker.length)
      if (trailerBytes.length < 4) {
        resolveTrailer(null)
        return
      }
      const len = new DataView(
        trailerBytes.buffer,
        trailerBytes.byteOffset,
        4,
      ).getUint32(0, false)
      if (trailerBytes.length < 4 + len) {
        resolveTrailer(null)
        return
      }
      const jsonBytes = trailerBytes.subarray(4, 4 + len)
      try {
        const updates = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, string>
        resolveTrailer(updates)
      } catch {
        resolveTrailer(null)
      }
    },
  })

  source.pipeTo(transformer.writable).catch(() => {
    resolveTrailer(null)
  })

  return {
    mainStream: transformer.readable,
    trailer: trailerPromise,
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function indexOfMarker(buffer: Uint8Array, marker: Uint8Array): number {
  const last = buffer.length - marker.length
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (buffer[i + j] !== marker[j]) continue outer
    }
    return i
  }
  return -1
}
