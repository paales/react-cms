import { describe, expect, it } from "vitest"
import { spliceHoles, scaffoldMeta } from "../flight-graph.ts"

const DEC = new TextDecoder()
const ENC = new TextEncoder()

async function toBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
function bytesOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(ENC.encode(s))
      c.close()
    },
  })
}

// Fault A (literal `$$…` vs ref, `:deref` suffix, `$@`/`$L` prefixes
// through splice) is NOT a fault: REF_RE rejects `$$`-escaped literals
// and `remapRefs`/`refString` preserve prefix + deref suffix while
// renumbering the id. Probed and confirmed safe — no test kept.

// Fault C (a fresh row that references a deduped import BEFORE the
// import's own `I` row arrives, dangling the ref) is NOT reachable: React's
// Flight serializer queues a client-reference's import chunk into
// `completedImportChunks` while serializing the referencing row, and
// `flushCompletedChunks` drains import chunks before regular model chunks
// every pass — so an `I` row always precedes any row that references it.
// The single-pass dedup in `spliceOne` is therefore sound. Confirmed
// against react-server-dom (vendored under @vitejs/plugin-rsc); no test
// kept (a repro would have to feed an ordering React never emits).

// ─── Fault B — hole id-block collisions ────────────────────────────────
describe("flight-graph spliceHoles — id-block collisions (Fault B)", () => {
  it("does not collide when a fresh render emits an id >= ID_BLOCK", async () => {
    // Scaffold: root references two holes via $L1 / $L2.
    const scaffold =
      `0:["$","div",null,{"children":["$L1","$L2"]}]\n` +
      `1:["$","i",null,{"data-partial-id":"hole:a"}]\n` +
      `2:["$","i",null,{"data-partial-id":"hole:b"}]\n`

    const holes = [
      { rowId: "1", partialId: "hole:a" },
      { rowId: "2", partialId: "hole:b" },
    ]

    // Hole A's fresh render uses a LARGE internal id (>= 0x100000) — a
    // realistic case for a deeply-streamed hole. Hole B uses a small id.
    // The two private id-blocks must stay disjoint.
    const renderHole = (h: { partialId: string }) => {
      if (h.partialId === "hole:a") {
        // internal id 0x100005 references content "AAA"
        return bytesOf(`100005:"AAA"\n` + `0:["$","span",null,{"children":"$100005"}]\n`)
      }
      // internal id 5 references content "BBB"
      return bytesOf(`5:"BBB"\n` + `0:["$","span",null,{"children":"$5"}]\n`)
    }

    const scaffoldBytes = ENC.encode(scaffold)
    const meta = scaffoldMeta(scaffoldBytes)
    const out = DEC.decode(await toBytes(spliceHoles(bytesOf(scaffold), holes, meta, renderHole)))
    const rows = out.split("\n").filter((r) => r.length > 0)

    // Each emitted row id must be unique — no two model rows collide.
    const ids = rows.map((r) => r.slice(0, r.indexOf(":")))
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])

    // Both fresh contents survive and resolve through their own refs.
    expect(out).toContain("AAA")
    expect(out).toContain("BBB")
  })
})
