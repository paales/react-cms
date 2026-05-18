/**
 * Snapshot trailer for `<RemoteFrame>` wire format.
 *
 * A remote endpoint renders a parton inside its own request scope
 * (separate from the host). PartialBoundary's `registerPartial`
 * side effect runs against the REMOTE's request registry — so the
 * host's snapshot map never sees the remote's partial ids, and
 * `nav.reload({selector: "<remote-id>"})` resolves to a registry
 * miss → streaming-mode fallback.
 *
 * Fix: after the remote's render completes, collect the snapshots
 * it produced and ship them to the host as a trailing entry after
 * the Flight bytes. The host's `<RemoteFrame>` splits the stream,
 * decodes Flight as usual, parses the trailer, and re-registers each
 * snapshot in its own request registry.
 *
 * Wire format (concatenated, in order):
 *
 *   <Flight bytes…>
 *   \n\xFF[parton:snapshots:N]\n
 *   <N bytes of UTF-8 JSON {id → serialized snapshot}>
 *
 * Same shape as the fp / url / next trailer entries. Leading `\n`
 * separates the marker visually in dumps; `\xFF` is the actual
 * parse-time discriminator (invalid UTF-8 so it can't occur inside
 * Flight payload bytes).
 */

import type { PartialSnapshot } from "./partial-registry.ts"
import { buildMarker, tryReadMarker } from "./fp-trailer-marker.ts"

const TAG_SNAPSHOTS = "snapshots"

// ─── Snapshot serialization ────────────────────────────────────────────

/**
 * The PartialSnapshot interface carries a few fields that can't
 * (or shouldn't) cross the wire:
 *
 * - `fallback: ReactNode` — arbitrary JSX. Drop it; the host can
 *   look up the spec's fallback locally via the spec catalog if
 *   the spec is registered (same-origin) or accept that fallback
 *   shows fresh-render-only (cross-origin).
 * - `cache: CacheOptions` — drop it; cache decisions are made by
 *   the rendering side, not the calling side.
 *
 * Everything else serializes as JSON.
 */
export interface SerializedSnapshot {
  type: string
  labels: string[]
  framePath: readonly string[]
  parentFrameChain: readonly string[]
  parentPath: readonly string[]
  props?: Record<string, unknown>
  varyKey?: string
  matchKey?: string
  emittedFp?: string
  sessionDeps?: readonly string[]
}

export function serializeSnapshot(snap: PartialSnapshot): SerializedSnapshot {
  const out: SerializedSnapshot = {
    type: snap.type,
    labels: [...snap.labels],
    framePath: [...snap.framePath],
    parentFrameChain: [...snap.parentFrameChain],
    parentPath: [...snap.parentPath],
  }
  if (snap.props !== undefined) out.props = snap.props
  if (snap.varyKey !== undefined) out.varyKey = snap.varyKey
  if (snap.matchKey !== undefined) out.matchKey = snap.matchKey
  if (snap.emittedFp !== undefined) out.emittedFp = snap.emittedFp
  if (snap.sessionDeps !== undefined) out.sessionDeps = [...snap.sessionDeps]
  return out
}

export function deserializeSnapshot(ser: SerializedSnapshot): PartialSnapshot {
  return {
    type: ser.type,
    fallback: null,
    labels: ser.labels,
    framePath: Object.freeze([...ser.framePath]),
    parentFrameChain: Object.freeze([...ser.parentFrameChain]),
    parentPath: Object.freeze([...ser.parentPath]),
    ...(ser.props !== undefined ? { props: ser.props } : {}),
    ...(ser.varyKey !== undefined ? { varyKey: ser.varyKey } : {}),
    ...(ser.matchKey !== undefined ? { matchKey: ser.matchKey } : {}),
    ...(ser.emittedFp !== undefined ? { emittedFp: ser.emittedFp } : {}),
    ...(ser.sessionDeps !== undefined ? { sessionDeps: ser.sessionDeps } : {}),
  }
}

/**
 * Build the snapshot trailer bytes for `snapshots`. Returns a single
 * Uint8Array containing the marker + JSON body, ready to enqueue.
 * Exported so test fixtures can construct fake wire bytes.
 */
export function buildSnapshotTrailer(
  snapshots: Map<string, PartialSnapshot>,
): Uint8Array {
  const serializable: Record<string, SerializedSnapshot> = {}
  for (const [id, snap] of snapshots) {
    serializable[id] = serializeSnapshot(snap)
  }
  const json = JSON.stringify(serializable)
  const jsonBytes = new TextEncoder().encode(json)
  const header = buildMarker(TAG_SNAPSHOTS, jsonBytes.byteLength)
  const out = new Uint8Array(header.byteLength + jsonBytes.byteLength)
  out.set(header, 0)
  out.set(jsonBytes, header.byteLength)
  return out
}

// ─── Server-side wrap ──────────────────────────────────────────────────

/**
 * Appends a snapshot trailer to the source stream. The snapshots
 * argument is a `Map<id, PartialSnapshot>` (typically the remote
 * request registry's `pendingWrites` after render completes).
 *
 * Pass-through: every source chunk forwards immediately. The
 * trailer is only emitted on stream close.
 */
export function wrapStreamWithSnapshotTrailer(
  source: ReadableStream<Uint8Array>,
  getSnapshots: () => Map<string, PartialSnapshot>,
): ReadableStream<Uint8Array> {
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
    },
    flush(controller) {
      const snapshots = getSnapshots()
      controller.enqueue(buildSnapshotTrailer(snapshots))
    },
  })
  source.pipeTo(transformer.writable).catch(() => {
    // Source errored; the transformer closes its own readable side.
  })
  return transformer.readable
}

// ─── Host-side parse ───────────────────────────────────────────────────

export interface SplitBuffer {
  /** Flight bytes (everything before the marker). */
  flightBytes: Uint8Array
  /** Decoded snapshot map, or `null` if no trailer was present. */
  snapshots: Record<string, PartialSnapshot> | null
}

/**
 * Splits a buffered response into Flight bytes + snapshot map.
 *
 * Scans for the first `\xFF` byte (the marker prefix), then parses
 * the header to find the body length. Bytes before `\xFF` are Flight
 * payload; bytes from the marker through the body terminate the
 * trailer. Anything past that is ignored.
 */
export function parseSnapshotTrailer(bytes: Uint8Array): SplitBuffer {
  const ffIdx = findSnapshotMarker(bytes)
  if (ffIdx < 0) return { flightBytes: bytes, snapshots: null }
  const flightBytes = bytes.subarray(0, ffIdx)
  // We need the byte AT `\xFF` as the marker start. Pre-`\xFF` bytes
  // (including the leading `\n` from buildMarker) are Flight.
  const parsed = tryReadMarker(bytes, ffIdx)
  if (typeof parsed !== "object") return { flightBytes, snapshots: null }
  if (parsed.tag !== TAG_SNAPSHOTS) return { flightBytes, snapshots: null }
  const bodyStart = ffIdx + parsed.headerSize
  const bodyEnd = bodyStart + parsed.length
  if (bytes.length < bodyEnd) return { flightBytes, snapshots: null }
  try {
    const raw = JSON.parse(
      new TextDecoder().decode(bytes.subarray(bodyStart, bodyEnd)),
    ) as Record<string, SerializedSnapshot>
    const out: Record<string, PartialSnapshot> = {}
    for (const [id, ser] of Object.entries(raw)) {
      out[id] = deserializeSnapshot(ser)
    }
    return { flightBytes, snapshots: out }
  } catch {
    return { flightBytes, snapshots: null }
  }
}

// ─── Host-side streaming split ─────────────────────────────────────────

export interface SnapshotStreamSplit {
  /** Pass-through main stream — Flight bytes flow through immediately
   *  so the decoder can resolve lazies as they arrive (within-remote
   *  Suspense streams to the host). */
  mainStream: ReadableStream<Uint8Array>
  /** Resolves on source-end with the decoded snapshot map (or `null`
   *  if no trailer was present). Subscribe to register snapshots in
   *  the host's request registry once the remote has finished. */
  trailer: Promise<Record<string, PartialSnapshot> | null>
}

/**
 * Streaming version of `parseSnapshotTrailer`. Pass-through main
 * stream lets the host decode the remote's Flight bytes
 * incrementally (preserves Suspense pacing within the remote
 * payload). The trailer promise resolves on source-end with the
 * snapshot map for host-side registration.
 *
 * Implementation: every source chunk forwards through immediately
 * to the main stream. A bounded tail buffer holds the last bytes
 * for marker scanning at end-of-stream. The marker bytes leak
 * through to Flight; Flight ignores trailing non-Flight noise
 * after its root row resolves.
 */
export function splitStreamAtSnapshotTrailer(
  source: ReadableStream<Uint8Array>,
): SnapshotStreamSplit {
  let resolveTrailer!: (v: Record<string, PartialSnapshot> | null) => void
  let settled = false
  const trailerPromise = new Promise<Record<string, PartialSnapshot> | null>((r) => {
    resolveTrailer = (v) => {
      if (settled) return
      settled = true
      r(v)
    }
  })

  // Cap the tail buffer at the largest plausible snapshot payload.
  // 256 KB covers a few hundred snapshots; if a remote exceeds this
  // its trailer won't parse and the host falls back to "no snapshots."
  const TAIL_CAP = 256 * 1024

  let tail = new Uint8Array(0)
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (chunk.length >= TAIL_CAP) {
        tail = chunk.subarray(chunk.length - TAIL_CAP).slice()
      } else {
        const combined = new Uint8Array(tail.length + chunk.length)
        combined.set(tail, 0)
        combined.set(chunk, tail.length)
        if (combined.length > TAIL_CAP) {
          tail = combined.subarray(combined.length - TAIL_CAP).slice()
        } else {
          tail = combined
        }
      }
    },
    flush() {
      const result = parseSnapshotTrailer(tail)
      resolveTrailer(result.snapshots)
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

// ─── Internal ──────────────────────────────────────────────────────────

/** Locate the marker for a snapshots trailer — scans for the first
 *  `\xFF` followed by a valid `[parton:snapshots:` header. Returns
 *  the offset of the `\xFF` byte, or -1 if no valid marker present. */
function findSnapshotMarker(bytes: Uint8Array): number {
  let from = 0
  while (from < bytes.length) {
    const idx = bytes.indexOf(0xff, from)
    if (idx < 0) return -1
    const parsed = tryReadMarker(bytes, idx)
    if (typeof parsed === "object" && parsed.tag === TAG_SNAPSHOTS) {
      return idx
    }
    from = idx + 1
  }
  return -1
}
