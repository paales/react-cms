import { describe, expect, it } from "vitest"
import {
  SNAPSHOT_TRAILER_MARKER,
  deserializeSnapshot,
  parseSnapshotTrailer,
  serializeSnapshot,
  wrapStreamWithSnapshotTrailer,
} from "../snapshot-trailer.ts"
import type { PartialSnapshot } from "../partial-registry.ts"

const ENC = new TextEncoder()

function makeStream(s: string): ReadableStream<Uint8Array> {
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

function makeSnapshot(overrides: Partial<PartialSnapshot> = {}): PartialSnapshot {
  return {
    type: "test-spec",
    fallback: null,
    labels: ["test-spec"],
    framePath: Object.freeze([]),
    parentFrameChain: Object.freeze([]),
    parentPath: Object.freeze([]),
    ...overrides,
  }
}

describe("serializeSnapshot / deserializeSnapshot", () => {
  it("round-trips a minimal snapshot", () => {
    const orig = makeSnapshot()
    const ser = serializeSnapshot(orig)
    const json = JSON.parse(JSON.stringify(ser))
    const back = deserializeSnapshot(json)
    expect(back.type).toBe(orig.type)
    expect(back.labels).toEqual(orig.labels)
    expect(back.framePath).toEqual([])
    expect(back.parentFrameChain).toEqual([])
    expect(back.parentPath).toEqual([])
  })

  it("preserves optional fields when present", () => {
    const orig = makeSnapshot({
      labels: ["a", "b"],
      framePath: Object.freeze(["frame1"]),
      parentPath: Object.freeze(["root", "wrap"]),
      props: { foo: "bar", n: 42 },
      varyKey: "vk123",
      matchKey: "mk456",
      emittedFp: "fp789",
      sessionDeps: ["dep1", "dep2"],
    })
    const back = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(orig))))
    expect(back.framePath).toEqual(["frame1"])
    expect(back.parentPath).toEqual(["root", "wrap"])
    expect(back.props).toEqual({ foo: "bar", n: 42 })
    expect(back.varyKey).toBe("vk123")
    expect(back.matchKey).toBe("mk456")
    expect(back.emittedFp).toBe("fp789")
    expect(back.sessionDeps).toEqual(["dep1", "dep2"])
  })

  it("drops non-serializable fields", () => {
    const orig = makeSnapshot({
      fallback: "would be JSX in real life",
      cache: { maxAge: 60 },
    })
    const ser = serializeSnapshot(orig)
    expect("fallback" in ser).toBe(false)
    expect("cache" in ser).toBe(false)
  })

  it("omits absent optional fields from the serialized form", () => {
    const orig = makeSnapshot()
    const ser = serializeSnapshot(orig)
    expect("props" in ser).toBe(false)
    expect("varyKey" in ser).toBe(false)
    expect("matchKey" in ser).toBe(false)
    expect("emittedFp" in ser).toBe(false)
    expect("sessionDeps" in ser).toBe(false)
  })

  it("deserialized snapshot has fallback: null", () => {
    const back = deserializeSnapshot(serializeSnapshot(makeSnapshot()))
    expect(back.fallback).toBeNull()
  })
})

describe("wrapStreamWithSnapshotTrailer + parseSnapshotTrailer", () => {
  it("round-trips an empty trailer", async () => {
    const source = makeStream('5:"hello"\n')
    const wrapped = wrapStreamWithSnapshotTrailer(source, () => new Map())
    const bytes = await readAll(wrapped)
    const { flightBytes, snapshots } = parseSnapshotTrailer(bytes)
    expect(new TextDecoder().decode(flightBytes)).toBe('5:"hello"\n')
    expect(snapshots).toEqual({})
  })

  it("round-trips a trailer with snapshots", async () => {
    const sourceText = '0:{"v":"$L1"}\n1:"data"\n'
    const source = makeStream(sourceText)
    const snap = makeSnapshot({
      type: "demo",
      labels: ["demo", "extra"],
      matchKey: "mk-abc",
      emittedFp: "fp-xyz",
    })
    const wrapped = wrapStreamWithSnapshotTrailer(
      source,
      () => new Map([["demo", snap]]),
    )
    const bytes = await readAll(wrapped)
    const { flightBytes, snapshots } = parseSnapshotTrailer(bytes)
    expect(new TextDecoder().decode(flightBytes)).toBe(sourceText)
    expect(snapshots).not.toBeNull()
    expect(Object.keys(snapshots!)).toEqual(["demo"])
    expect(snapshots!.demo.type).toBe("demo")
    expect(snapshots!.demo.labels).toEqual(["demo", "extra"])
    expect(snapshots!.demo.matchKey).toBe("mk-abc")
    expect(snapshots!.demo.emittedFp).toBe("fp-xyz")
  })

  it("marker bytes are at the boundary between Flight and trailer", async () => {
    const source = makeStream('xyz\n')
    const wrapped = wrapStreamWithSnapshotTrailer(source, () => new Map())
    const bytes = await readAll(wrapped)
    const idx = indexOfMarker(bytes, SNAPSHOT_TRAILER_MARKER)
    expect(idx).toBe(4) // 'xyz\n' is 4 bytes
  })

  it("returns null snapshots when input has no marker", () => {
    const input = ENC.encode("just flight bytes, no trailer\n")
    const { flightBytes, snapshots } = parseSnapshotTrailer(input)
    expect(flightBytes).toBe(input)
    expect(snapshots).toBeNull()
  })

  it("returns null snapshots when trailer length exceeds remaining bytes", () => {
    // Construct a buffer with the marker + an absurd length declaration.
    const flight = ENC.encode("flight\n")
    const lenBytes = new Uint8Array(4)
    new DataView(lenBytes.buffer).setUint32(0, 99999, false)
    const out = new Uint8Array(
      flight.length + SNAPSHOT_TRAILER_MARKER.length + 4 + 2,
    )
    out.set(flight, 0)
    out.set(SNAPSHOT_TRAILER_MARKER, flight.length)
    out.set(lenBytes, flight.length + SNAPSHOT_TRAILER_MARKER.length)
    // Only 2 bytes of trailer payload follow.
    const { snapshots } = parseSnapshotTrailer(out)
    expect(snapshots).toBeNull()
  })

  it("returns null snapshots on JSON parse failure", () => {
    const flight = ENC.encode("flight\n")
    const junk = ENC.encode("not json {{{")
    const lenBytes = new Uint8Array(4)
    new DataView(lenBytes.buffer).setUint32(0, junk.length, false)
    const out = new Uint8Array(
      flight.length + SNAPSHOT_TRAILER_MARKER.length + 4 + junk.length,
    )
    out.set(flight, 0)
    out.set(SNAPSHOT_TRAILER_MARKER, flight.length)
    out.set(lenBytes, flight.length + SNAPSHOT_TRAILER_MARKER.length)
    out.set(junk, flight.length + SNAPSHOT_TRAILER_MARKER.length + 4)
    const { snapshots } = parseSnapshotTrailer(out)
    expect(snapshots).toBeNull()
  })

  it("handles multiple snapshots in one trailer", async () => {
    const wrapped = wrapStreamWithSnapshotTrailer(
      makeStream("0:x\n"),
      () =>
        new Map([
          ["a", makeSnapshot({ type: "a", labels: ["a"] })],
          ["b", makeSnapshot({ type: "b", labels: ["b", "shared"] })],
          ["c", makeSnapshot({ type: "c", labels: ["c"] })],
        ]),
    )
    const { snapshots } = parseSnapshotTrailer(await readAll(wrapped))
    expect(Object.keys(snapshots ?? {}).sort()).toEqual(["a", "b", "c"])
    expect(snapshots!.b.labels).toEqual(["b", "shared"])
  })
})

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
