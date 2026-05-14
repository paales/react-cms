/**
 * Shared sentinel bytes for the fp-trailer wire format. Server and
 * client both import this so the byte sequence stays in lockstep
 * without either side needing access to the other's runtime imports.
 *
 * Format: `\xFF\xFE` + 8 ASCII tag bytes (`fp-updates`) + `\xFD\xFC`.
 * The leading `\xFF\xFE` are invalid UTF-8 lead bytes — they cannot
 * appear at the start of a valid UTF-8 sequence, and Flight emits
 * UTF-8 JSON, so the sentinel cannot occur by accident inside the
 * upstream Flight bytes. The ASCII tag in the middle lets us add
 * other trailer segment types later by varying the tag (`render-stats`,
 * `cache-control`, etc.) — see `docs/notes/IDEAS.md`. The trailing
 * `\xFD\xFC` closes the sentinel deterministically so a partial
 * match cannot be misread as a trailer start.
 */
const FP_TRAILER_TAG = "fp-updates"

function buildMarker(): Uint8Array {
  const bytes = new Uint8Array(12)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  const tag = new TextEncoder().encode(FP_TRAILER_TAG)
  bytes.set(tag, 2)
  bytes[10] = 0xfd
  bytes[11] = 0xfc
  return bytes
}

export const FP_TRAILER_MARKER: Readonly<Uint8Array> = buildMarker()
