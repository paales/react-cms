/**
 * Shared sentinel-marker bytes for the segmented-Flight wire format.
 * Server and client both import this so the byte sequence stays in
 * lockstep without either side needing the other's runtime imports.
 *
 * Format (12 bytes): `\xFF\xFE` + 8 ASCII tag bytes (space-padded to 8)
 * + `\xFD\xFC`. The leading `\xFF\xFE` are invalid UTF-8 lead bytes —
 * they cannot appear at the start of a valid UTF-8 sequence, and Flight
 * emits UTF-8 JSON, so the sentinel cannot occur by accident inside the
 * upstream Flight bytes. The ASCII tag in the middle discriminates
 * segment types; the trailing `\xFD\xFC` closes the sentinel
 * deterministically so a partial match cannot be misread as a marker
 * start.
 *
 * Tag taxonomy:
 *   `fp`    — length-prefixed JSON of cold→warm fp updates, applied
 *             to the client's fingerprint registry.
 *   `url`   — length-prefixed JSON describing window/frame URL pushes
 *             from server-side `getNavigation(scope).navigate(...)`.
 *   `next`  — zero-length delimiter announcing that the bytes that
 *             follow are a new Flight document (a new segment). The
 *             client peels each segment into its own
 *             `createFromReadableStream` + `setPayload` call.
 *
 * The framing generalises trivially to other trailer types — see
 * `docs/notes/IDEAS.md`. Reserve the tag, pick a body format (length-
 * prefixed JSON for metadata, zero-length for delimiters), and the
 * splitter dispatches by tag.
 */

export const MARKER_LENGTH = 12
const TAG_LENGTH = 8

/** Build a 12-byte marker for the given tag. */
export function buildMarker(tag: string): Uint8Array {
  if (tag.length > TAG_LENGTH) {
    throw new Error(`Trailer tag must be ≤ ${TAG_LENGTH} chars, got ${tag.length}: ${tag}`)
  }
  const bytes = new Uint8Array(MARKER_LENGTH)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  const padded = tag.padEnd(TAG_LENGTH, " ")
  const tagBytes = new TextEncoder().encode(padded)
  bytes.set(tagBytes, 2)
  bytes[10] = 0xfd
  bytes[11] = 0xfc
  return bytes
}

/**
 * Read the tag from a 12-byte buffer. Returns the trimmed tag string
 * if the buffer is a valid marker, `null` otherwise. Used by the
 * splitter to discriminate marker types on the wire.
 */
export function readMarkerTag(bytes: Uint8Array, offset = 0): string | null {
  if (bytes.length < offset + MARKER_LENGTH) return null
  if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xfe) return null
  if (bytes[offset + 10] !== 0xfd || bytes[offset + 11] !== 0xfc) return null
  const tagBytes = bytes.subarray(offset + 2, offset + 10)
  return new TextDecoder().decode(tagBytes).trimEnd()
}

/** Locate the first marker in `buffer` starting at `from`. Returns
 *  the offset of the marker, or -1 if none found. */
export function findMarker(buffer: Uint8Array, from = 0): number {
  const last = buffer.length - MARKER_LENGTH
  outer: for (let i = from; i <= last; i++) {
    if (buffer[i] !== 0xff || buffer[i + 1] !== 0xfe) continue
    if (buffer[i + 10] !== 0xfd || buffer[i + 11] !== 0xfc) continue
    // Validate tag region is ASCII (defensive: random bytes that
    // happen to match `\xFF\xFE...\xFD\xFC` would otherwise be
    // misread). All defined tags are 7-bit ASCII printable.
    for (let j = 2; j < 10; j++) {
      const b = buffer[i + j]
      if (b < 0x20 || b > 0x7e) continue outer
    }
    return i
  }
  return -1
}

/** Tag taxonomy — exported constants so callers don't have to know
 *  the string literals. */
export const TAG_FP_UPDATES = "fp"
export const TAG_URL_UPDATE = "url"
export const TAG_NEXT_SEGMENT = "next"

/** Backward-compat for callers still importing the bare fp-updates
 *  marker bytes. Equivalent to `buildMarker(TAG_FP_UPDATES)`. */
export const FP_TRAILER_MARKER: Readonly<Uint8Array> = buildMarker(TAG_FP_UPDATES)
