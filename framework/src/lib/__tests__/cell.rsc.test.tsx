/**
 * Cells — in-body resolution + storage + invalidation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { localCell } from "../cell.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

/** Seed cell storage at a specific partition key without going
 *  through the cell handle's `.set` action (which requires a
 *  request context). Tests use this to set up state before the
 *  render they're asserting on. */
function seedCell(id: string, varyOutput: object, value: unknown): void {
  const partitionKey = hash(stableStringify(varyOutput))
  getCellStorage().write("default", id, partitionKey, value)
}

// Each test gets a fresh memory storage + a clean invalidation
// registry so cell ids don't carry timestamp baggage across tests.
beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("cell — in-body resolution", () => {
  it("resolves the default value on a storage miss", async () => {
    const flag = localCell({
      id: "test.flag",
      shape: "boolean",
      partition: () => ({}),
      initial: false,
    })
    const Page = parton(
      async function FlagPageRender(_: RenderArgs) {
        const f = await flag.resolve()
        return <span data-testid="flag">value={String(f.value)}</span>
      },
      { match: "/flag" },
    )
    const out = await flightAt("http://t/flag", <Page />)
    // Flight serializes JSX children as an array `["value=", "false"]`.
    expect(out).toContain('"value=","false"')
  })

  it("reads the stored cell value from storage", async () => {
    const palette = localCell({
      id: "test.palette",
      shape: { enum: ["light", "dark"] as const },
      partition: () => ({}),
      initial: "light",
    })
    seedCell(palette.id, {}, "dark")

    const Page = parton(
      async function PaletteRender(_: RenderArgs) {
        const p = await palette.resolve()
        return <span data-testid="palette">{p.value}</span>
      },
      { match: "/palette" },
    )
    const out = await flightAt("http://t/palette", <Page />)
    // Single text child serializes as `"children":"dark"` in Flight.
    expect(out).toContain('"children":"dark"')
  })

  it("a selector refresh on the cell label shifts the parton's fp", async () => {
    const counter = localCell({
      id: "test.counter",
      shape: "number",
      partition: () => ({}),
      initial: 0,
    })
    const Page = parton(
      async function CounterRender(_: RenderArgs) {
        const c = await counter.resolve()
        return <span data-testid="counter">{c.value}</span>
      },
      { match: "/counter", selector: "counter-spec" },
    )

    // In-body reads land on the dep record DURING Render — after the
    // fp is computed — so warm up once (inside a PartialRoot, which
    // commits the snapshot the fold re-reads), then capture the
    // settled fp.
    const tree = (
      <PartialRoot>
        <Page />
      </PartialRoot>
    )
    await flightAt("http://t/counter", tree)
    const first = await flightAt("http://t/counter", tree)
    const fpMatch = first.match(/partialFingerprint":"([0-9a-f]+)/)
    expect(fpMatch).not.toBeNull()
    const initialFp = fpMatch![1]

    // Refresh by the cell's recorded label — fp must shift even
    // though the cell value is still 0 (the invalidation timestamp
    // contributes via `queryMatchingTs`).
    refreshSelector("cell:test.counter")
    const second = await flightAt("http://t/counter", tree)
    const secondFp = second.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(secondFp).not.toEqual(initialFp)
  })

  it("partitions storage by explicit resolve args", async () => {
    const notes = localCell({
      id: "test.notes",
      shape: "string",
      initial: "",
    })
    seedCell(notes.id, { productId: "42" }, "notes for 42")
    seedCell(notes.id, { productId: "99" }, "notes for 99")

    const Page = parton(
      async function NotesRender({ id }: { id: string } & RenderArgs) {
        const n = await notes.resolve({ productId: id })
        return <span data-testid="notes">{n.value}</span>
      },
      { match: "/product/:id" },
    )
    const at42 = await flightAt("http://t/product/42", <Page />)
    expect(at42).toContain('"children":"notes for 42"')
    const at99 = await flightAt("http://t/product/99", <Page />)
    expect(at99).toContain('"children":"notes for 99"')
  })
})

describe("cell — runtime validation", () => {
  it("rejects mismatched value at validate", () => {
    const bumps = localCell({
      id: "test.bumps",
      shape: "number",
      partition: () => ({}),
      initial: 0,
    })
    expect(() => bumps.validate("not a number")).toThrow(/expected number/)
  })

  it("rejects out-of-set enum values", () => {
    const palette = localCell({
      id: "test.palette2",
      shape: { enum: ["light", "dark"] as const },
      partition: () => ({}),
      initial: "light",
    })
    expect(() => palette.validate("midnight")).toThrow(/expected one of/)
  })
})

describe("cell — fp transitive on partition change", () => {
  it("parton fp shifts when navigating to a different partition", async () => {
    const notes = localCell({
      id: "test.notes-fp",
      shape: "string",
      initial: "default",
    })
    seedCell(notes.id, { productId: "A" }, "A-notes")
    seedCell(notes.id, { productId: "B" }, "B-notes")

    const Page = parton(
      async function NotesFpRender({ id }: { id: string } & RenderArgs) {
        const n = await notes.resolve({ productId: id })
        return <span data-testid="notes-fp">{n.value}</span>
      },
      { match: "/p/:id" },
    )
    const a = await flightAt("http://t/p/A", <Page />)
    const b = await flightAt("http://t/p/B", <Page />)
    const fpA = a.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    const fpB = b.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fpA).not.toEqual(fpB)
  })
})
