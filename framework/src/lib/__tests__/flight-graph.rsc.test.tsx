import { describe, expect, it } from "vitest"
import { Suspense } from "react"
import { parton, ROOT, type RenderArgs } from "../partial.tsx"
import { renderWithRequest, renderServerToFlight } from "../../test/rsc-server.ts"
import {
  stripHoles,
  spliceHoles,
  scaffoldMeta,
  spliceMarkers,
  spliceMarkerStream,
} from "../flight-graph.ts"

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

function Grid({ parent }: RenderArgs) {
  return (
    <div data-testid="grid" className="grid">
      <h1>Store</h1>
      <Suspense fallback={<span>loading aaa</span>}>
        <Price parent={parent} sku="aaa" />
      </Suspense>
      <Suspense fallback={<span>loading bbb</span>}>
        <Price parent={parent} sku="bbb" />
      </Suspense>
    </div>
  )
}

describe("flight-graph stripHoles (real payload)", () => {
  it("replaces each parton boundary with a placeholder and GCs its content", async () => {
    const { stream } = await renderWithRequest("http://t/x", <Grid parent={ROOT} />)
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
    const out = DEC.decode(
      await toBytes(spliceHoles(bytesOf(scaffold), holes, meta, renderHole)),
    )
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

describe("flight-graph spliceMarkers (recursive boundary reassembly)", () => {
  const resolver = (m: Record<string, string>) => (bid: string): Uint8Array | null =>
    bid in m ? ENC.encode(m[bid]) : null

  it("splices a body onto its marker's seam", () => {
    const root = ENC.encode(
      `1:["$","i",null,{"hidden":true,"data-boundary-id":"B1"}]\n` +
        `0:["$","div",null,{"children":[["$","h1",null,{"children":"HDR"}],"$L1"]}]\n`,
    )
    const out = DEC.decode(
      spliceMarkers(root, resolver({ B1: `0:["$","span",null,{"children":"BODY_B1"}]\n` })),
    )
    expect(out).toContain("BODY_B1")
    expect(out).not.toContain("data-boundary-id") // marker consumed
    expect(out).toContain(`1:["$","span"`) // body root took the seam id (1)
    expect(out).toContain("$L1") // parent ref intact → resolves to the body
  })

  it("recursively splices nested markers", () => {
    const root = ENC.encode(
      `1:["$","i",null,{"data-boundary-id":"B1"}]\n` +
        `0:["$","div",null,{"children":["$L1"]}]\n`,
    )
    const out = DEC.decode(
      spliceMarkers(
        root,
        resolver({
          B1:
            `2:["$","i",null,{"data-boundary-id":"B2"}]\n` +
            `0:["$","section",null,{"children":["$L2"]}]\n`,
          B2: `0:["$","b",null,{"children":"DEEP_B2"}]\n`,
        }),
      ),
    )
    expect(out).toContain("DEEP_B2")
    expect(out).toContain("section")
    expect(out).not.toContain("data-boundary-id") // every marker consumed
  })

  it("leaves an unresolved marker inert", () => {
    const root = ENC.encode(
      `1:["$","i",null,{"data-boundary-id":"B9"}]\n` +
        `0:["$","div",null,{"children":["$L1"]}]\n`,
    )
    const out = DEC.decode(spliceMarkers(root, () => null))
    expect(out).toContain("B9") // preserved when resolve returns null
  })
})

describe("flight-graph spliceMarkerStream (streaming recursive reassembly)", () => {
  const streamResolver =
    (m: Record<string, string>) =>
    (bid: string): ReadableStream<Uint8Array> | null =>
      bid in m ? bytesOf(m[bid]) : null

  function rowsByPrefix(out: string, prefix: string): string[] {
    return out.split("\n").filter((r) => r.startsWith(prefix))
  }

  it("splices a body stream onto its marker's seam", async () => {
    const root =
      `1:["$","i",null,{"hidden":true,"data-boundary-id":"B1"}]\n` +
      `0:["$","div",null,{"children":[["$","h1",null,{"children":"HDR"}],"$L1"]}]\n`
    const out = DEC.decode(
      await toBytes(
        spliceMarkerStream(
          bytesOf(root),
          streamResolver({ B1: `0:["$","span",null,{"children":"BODY_B1"}]\n` }),
        ),
      ),
    )
    expect(out).toContain("BODY_B1")
    expect(out).not.toContain("data-boundary-id") // marker consumed
    expect(out).toContain(`1:["$","span"`) // body root took the seam id (1)
    expect(out).toContain("$L1") // parent ref intact → resolves to the body
    expect(out).toContain("HDR") // scaffold passthrough preserved
  })

  it("recursively splices nested markers", async () => {
    const root =
      `1:["$","i",null,{"data-boundary-id":"B1"}]\n` +
      `0:["$","div",null,{"children":["$L1"]}]\n`
    const out = DEC.decode(
      await toBytes(
        spliceMarkerStream(
          bytesOf(root),
          streamResolver({
            B1:
              `2:["$","i",null,{"data-boundary-id":"B2"}]\n` +
              `0:["$","section",null,{"children":["$L2"]}]\n`,
            B2: `0:["$","b",null,{"children":"DEEP_B2"}]\n`,
          }),
        ),
      ),
    )
    expect(out).toContain("DEEP_B2")
    expect(out).toContain("section")
    expect(out).not.toContain("data-boundary-id") // every marker consumed
  })

  it("leaves an unresolved marker inert", async () => {
    const root =
      `1:["$","i",null,{"data-boundary-id":"B9"}]\n` +
      `0:["$","div",null,{"children":["$L1"]}]\n`
    const out = DEC.decode(await toBytes(spliceMarkerStream(bytesOf(root), () => null)))
    expect(out).toContain("B9") // preserved when resolve returns null
    expect(out).toContain("$L1") // ref to the inert marker still resolves
  })

  it("splices sibling bodies into disjoint id blocks (no collision)", async () => {
    // Two markers, two bodies — each body has its own root (0) + an
    // internal row (1). Without disjoint blocks the two bodies' id-1
    // rows would collide; with per-body blocks they don't.
    const root =
      `1:["$","i",null,{"data-boundary-id":"A"}]\n` +
      `2:["$","i",null,{"data-boundary-id":"B"}]\n` +
      `0:["$","div",null,{"children":["$L1","$L2"]}]\n`
    const out = DEC.decode(
      await toBytes(
        spliceMarkerStream(
          bytesOf(root),
          streamResolver({
            A: `1:"INNER_A"\n` + `0:["$","span",null,{"children":"$1"}]\n`,
            B: `1:"INNER_B"\n` + `0:["$","span",null,{"children":"$1"}]\n`,
          }),
        ),
      ),
    )
    // Both bodies present, both inner strings survive.
    expect(out).toContain("INNER_A")
    expect(out).toContain("INNER_B")
    // Seams reused: body roots land on ids 1 and 2 (the marker seams).
    expect(rowsByPrefix(out, "1:").some((r) => r.includes("span"))).toBe(true)
    expect(rowsByPrefix(out, "2:").some((r) => r.includes("span"))).toBe(true)
    // The two bodies' internal id-1 rows renumbered into disjoint blocks,
    // so no single id hosts both inner strings.
    const idOfInnerA = out
      .split("\n")
      .find((r) => r.includes(`"INNER_A"`))!
      .split(":")[0]
    const idOfInnerB = out
      .split("\n")
      .find((r) => r.includes(`"INNER_B"`))!
      .split(":")[0]
    expect(idOfInnerA).not.toBe(idOfInnerB)
    expect(out).not.toContain("data-boundary-id")
  })
})
