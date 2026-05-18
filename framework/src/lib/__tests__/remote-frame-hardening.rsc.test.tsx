import { describe, expect, it } from "vitest"
import { Suspense } from "react"
import {
  buildSnapshotTrailer,
  parseSnapshotTrailer,
  splitStreamAtSnapshotTrailer,
} from "../snapshot-trailer.ts"
import { buildMarker } from "../fp-trailer-marker.ts"

const ENC = new TextEncoder()

function stringStream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(ENC.encode(s))
      c.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

describe("snapshot-trailer hardening — malformed inputs", () => {
  it("parseSnapshotTrailer: empty trailer payload — header says length=0", () => {
    // Length=0 means an empty JSON payload. `JSON.parse("")` throws,
    // so the parser falls into the catch branch and returns null.
    // Documenting the contract: a malformed/empty trailer payload
    // returns null, not an empty map.
    const bytes = buildMarker("snapshots", 0)
    const { flightBytes, snapshots } = parseSnapshotTrailer(bytes)
    expect(flightBytes.length).toBe(0)
    expect(snapshots).toBeNull()
  })

  it("parseSnapshotTrailer: marker present but body truncated", () => {
    const marker = buildMarker("snapshots", 100) // claims 100 bytes
    const body = ENC.encode("ab") // only 2 bytes follow
    const bytes = concat(ENC.encode("flight\n"), marker, body)
    const { snapshots } = parseSnapshotTrailer(bytes)
    expect(snapshots).toBeNull()
  })

  it("parseSnapshotTrailer: JSON payload claims a non-object root", () => {
    const json = ENC.encode("[1,2,3]") // valid JSON, wrong shape
    const marker = buildMarker("snapshots", json.length)
    const bytes = concat(ENC.encode("xxxx"), marker, json)
    const { snapshots } = parseSnapshotTrailer(bytes)
    // For a non-object root, Object.entries gives keys "0", "1", "2"
    // with values 1, 2, 3 → deserializeSnapshot would crash. The
    // try/catch around JSON.parse + decode catches that, returns null
    // OR a "best-effort" object. Contract is "don't throw".
    expect(snapshots === null || typeof snapshots === "object").toBe(true)
  })

  it("parseSnapshotTrailer: \\xFF inside Flight content (false positive scan)", () => {
    // Marker leader is `\xFF`, but the snapshot parser only treats it
    // as a marker if the header validates (`[parton:snapshots:...]`).
    // A bare `\xFF` byte from a corrupted stream that doesn't form a
    // valid header is skipped.
    const realTrailer = buildSnapshotTrailer(new Map())
    const fakeFlight = concat(
      ENC.encode("real-flight-bytes\n"),
      // Stray \xFF that looks like a marker start but isn't followed
      // by a valid header. The scanner should skip past it.
      new Uint8Array([0xff, 0x7b, 0x21]), // \xFF { !
      ENC.encode("\nmore flight\n"),
      realTrailer,
    )
    const { snapshots } = parseSnapshotTrailer(fakeFlight)
    // The valid snapshots marker at the end resolves to {} (empty map).
    expect(snapshots).toEqual({})
  })

  it("splitStreamAtSnapshotTrailer: source with no marker resolves trailer to null", async () => {
    const split = splitStreamAtSnapshotTrailer(stringStream("just flight\n"))
    // Drain the main stream so the flush handler fires.
    await readAll(split.mainStream)
    const trailer = await split.trailer
    expect(trailer).toBeNull()
  })

  it("splitStreamAtSnapshotTrailer: source error rejects trailer to null", async () => {
    const errored = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(ENC.encode("partial\n"))
        c.error(new Error("network blew up"))
      },
    })
    const split = splitStreamAtSnapshotTrailer(errored)
    try {
      await readAll(split.mainStream)
    } catch {
      // Expected — propagated through.
    }
    const trailer = await split.trailer
    expect(trailer).toBeNull()
  })

  it("splitStreamAtSnapshotTrailer: passes large payloads through (no holdback)", async () => {
    // 100KB of flight + small trailer. Verify all bytes flow through.
    const flightChunk = "x".repeat(100000) + "\n"
    const trailerBody = ENC.encode("{}")
    const marker = buildMarker("snapshots", trailerBody.length)
    const input = concat(ENC.encode(flightChunk), marker, trailerBody)

    const split = splitStreamAtSnapshotTrailer(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(input)
          c.close()
        },
      }),
    )
    const main = await readAll(split.mainStream)
    expect(main.length).toBe(input.length)
    const snapshots = await split.trailer
    expect(snapshots).toEqual({})
  })

  it("splitStreamAtSnapshotTrailer: trailer split across multiple chunks", async () => {
    const trailerBody = ENC.encode("{}")
    const marker = buildMarker("snapshots", trailerBody.length)
    const beforeMarker = ENC.encode("flight\n")
    const fullMarker = concat(marker, trailerBody)
    // Split the marker across two chunks (worst case for the
    // rolling-tail scanner).
    const split1 = fullMarker.subarray(0, 8)
    const split2 = fullMarker.subarray(8)
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(beforeMarker)
        c.enqueue(split1)
        c.enqueue(split2)
        c.close()
      },
    })
    const result = splitStreamAtSnapshotTrailer(source)
    await readAll(result.mainStream)
    expect(await result.trailer).toEqual({})
  })
})

// Sanity-check that React + Suspense play well with our marker-bearing
// byte sequences — the marker uses an invalid UTF-8 lead, so a
// TextDecoder pass over the bytes shouldn't crash.
describe("snapshot-trailer interop with Flight", () => {
  it("TextDecoder doesn't choke on the marker bytes", () => {
    void Suspense // not used at runtime; pin the import to keep tsx happy.
    const decoder = new TextDecoder("utf-8", { fatal: false })
    const marker = buildMarker("snapshots", 0)
    const decoded = decoder.decode(marker)
    expect(typeof decoded).toBe("string")
    // Plain ASCII header text after the invalid leader.
    expect(decoded).toContain("[parton:snapshots:0]")
  })
})
