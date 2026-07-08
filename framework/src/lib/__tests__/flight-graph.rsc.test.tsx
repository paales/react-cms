import { describe, expect, it } from "vitest"
import { Suspense } from "react"
import { parton, ROOT, type RenderArgs } from "../partial.tsx"
import { renderWithRequest, renderServerToFlight } from "../../test/rsc-server.ts"
import { stripHoles, spliceHoles, scaffoldMeta } from "../flight-graph.ts"

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

// magento-shaped: async, Suspense-wrapped, addressable `.price` partons
// inside a plain grid (the body a `<Cache>` would store).
const Price = parton(
  async function PriceRender({ sku }: { sku: string } & RenderArgs) {
    await new Promise((r) => setTimeout(r, 0))
    return (
      <span data-testid={`price-${sku}`} className="price">
        PRICE_{sku}_CONTENT
      </span>
    )
  },
  { selector: ".price" },
)

function Grid() {
  return (
    <div data-testid="grid" className="grid">
      <h1>Store</h1>
      <Suspense fallback={<span>loading aaa</span>}>
        <Price sku="aaa" />
      </Suspense>
      <Suspense fallback={<span>loading bbb</span>}>
        <Price sku="bbb" />
      </Suspense>
    </div>
  )
}

describe("flight-graph stripHoles (real payload)", () => {
  it("replaces each parton boundary with a placeholder and GCs its content", async () => {
    const { stream } = await renderWithRequest("http://t/x", <Grid />)
    const bytes = await toBytes(stream)
    const before = DEC.decode(bytes)
    // Sanity: the real render has the price content + boundaries.
    // (JSX splits `PRICE_{sku}_CONTENT` into ["PRICE_", sku, "_CONTENT"].)
    expect(before).toContain("price-aaa")
    expect(before).toContain("_CONTENT")
    expect(before).toContain("partialId")

    const { bytes: stripped, holes } = stripHoles(bytes)
    const after = DEC.decode(stripped)

    // Two holes found, both `.price` partons.
    expect(holes.length).toBe(2)
    expect(holes.every((h) => h.partialId.startsWith("price"))).toBe(true)

    // Placeholders present; frozen content GC'd; payload shrank.
    expect(after).toContain("data-partial-id")
    expect(after).not.toContain("price-aaa")
    expect(after).not.toContain("_CONTENT")
    expect(stripped.byteLength).toBeLessThan(bytes.byteLength)

    // The scaffold (grid + h1) survives.
    expect(after).toContain("grid")
    expect(after).toContain("Store")
  })
})

describe("flight-graph stripHoles — sync-inlined safety", () => {
  it("strips an async Activity>PEB row but leaves a content row that inlines a sync parton", () => {
    // root div: children = [ $L1 (async hole, its own row), an inline
    // sync Activity>PEB ]. The async hole must be stripped; the content
    // div (with the sync parton inlined among its children) must NOT be
    // mis-stripped — the sync parton freezes as cached content.
    const payload =
      `2:"$Sreact.activity"\n` +
      `9:I["/peb.tsx#PEB",[],"*"]\n` +
      `5:"ASYNC_CONTENT"\n` +
      `1:["$","$2",null,{"children":["$","$L9","async-key",{"partialId":"async:y","children":"$5"}]}]\n` +
      `0:["$","div",null,{"children":["$L1",["$","$2",null,{"children":["$","$L9","sync-key",{"partialId":"sync:x"}]}]]}]\n`

    const { bytes, holes } = stripHoles(ENC.encode(payload))
    const out = DEC.decode(bytes)

    // Exactly one hole: the async, outlined parton.
    expect(holes.map((h) => h.partialId)).toEqual(["async:y"])

    // Async hole row replaced by a placeholder; its content GC'd.
    expect(out).toContain(`"data-partial-id":"async:y"`)
    expect(out).not.toContain("ASYNC_CONTENT")

    // The content div survives intact, and the inlined sync parton is
    // still there (frozen) — the whole row was NOT swallowed.
    expect(out).toContain(`"$","div",null`)
    expect(out).toContain(`"partialId":"sync:x"`)
  })
})

describe("flight-graph spliceHoles (synthetic rows)", () => {
  it("reuses the seam id, renumbers into a private block, and streams fresh content", async () => {
    // Scaffold: root div references holes via $L1 / $L2; rows 1 & 2 are
    // placeholders. An import (PEB) at id 9 the fresh holes will dedup to.
    const scaffold =
      `9:I["/peb.tsx#PEB",[],"*"]\n` +
      `0:["$","div",null,{"children":["$L1","$L2"]}]\n` +
      `1:["$","i",null,{"data-partial-id":"price:a"}]\n` +
      `2:["$","i",null,{"data-partial-id":"price:b"}]\n`

    const holes = [
      { rowId: "1", partialId: "price:a" },
      { rowId: "2", partialId: "price:b" },
    ]

    // Each fresh render: its own root (0) + an internal ref (1) + the
    // SAME PEB import (different local id 4) that the scaffold already has.
    const renderHole = (h: { partialId: string }) =>
      bytesOf(
        `4:I["/peb.tsx#PEB",[],"*"]\n` +
          `1:"FRESH_${h.partialId}"\n` +
          `0:["$","$L4",null,{"children":"$1"}]\n`,
      )

    const scaffoldBytes = ENC.encode(scaffold)
    const meta = scaffoldMeta(scaffoldBytes)
    const out = DEC.decode(await toBytes(spliceHoles(bytesOf(scaffold), holes, meta, renderHole)))
    const rows = out.split("\n").filter((r) => r.length > 0)

    // Seam preserved: scaffold's $L1 / $L2 still point at ids 1 / 2,
    // which are now the fresh roots (not the placeholders).
    expect(out).toContain(`0:["$","div",null,{"children":["$L1","$L2"]}]`)
    // Placeholder rows are gone (replaced by fresh roots at the same id).
    expect(rows.filter((r) => r.startsWith("1:")).some((r) => r.includes("data-partial-id"))).toBe(
      false,
    )
    // Fresh roots landed on the seam ids 1 and 2.
    expect(out).toContain(`1:["$","$`)
    expect(out).toContain(`2:["$","$`)
    // Fresh content present for both holes.
    expect(out).toContain("FRESH_price:a")
    expect(out).toContain("FRESH_price:b")
    // Dedup: the PEB import appears exactly once (the scaffold's id 9);
    // the fresh holes' import rows were dropped and their refs remapped
    // to $L9 — no payload growth, no $L4 left dangling.
    const importCount = rows.filter((r) => r.includes(`I["/peb.tsx#PEB`)).length
    expect(importCount).toBe(1)
    expect(out).toContain("$L9")
    expect(out).not.toContain("$L4")
  })
})
