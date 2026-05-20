/**
 * Cells — schema resolution + storage + invalidation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parton,
  ROOT,
  type RenderArgs,
} from "../partial.tsx"
import { cell, type ResolvedCell } from "../cell.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import {
  _clearInvalidationRegistry,
  refreshSelector,
} from "../../runtime/invalidation-registry.ts"
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

describe("cell — schema resolution", () => {
  it("threads a resolved cell into render props with the default value on miss", async () => {
    const flag = cell.boolean({
      id: "test.flag",
      vary: () => ({}),
      initial: false,
    })
    const Page = parton(
      function FlagPageRender({
        flag,
      }: { flag: ResolvedCell<boolean> } & RenderArgs) {
        return <span data-testid="flag">value={String(flag.value)}</span>
      },
      { match: "/flag", schema: () => ({ flag }) },
    )
    const out = await flightAt("http://t/flag", <Page parent={ROOT} />)
    // Flight serializes JSX children as an array `["value=", "false"]`.
    expect(out).toContain('"value=","false"')
  })

  it("reads the stored cell value from storage", async () => {
    const palette = cell.enum(["light", "dark"] as const, {
      id: "test.palette",
      vary: () => ({}),
      initial: "light",
    })
    seedCell(palette.id, {}, "dark")

    const Page = parton(
      function PaletteRender({
        palette,
      }: { palette: ResolvedCell<"light" | "dark"> } & RenderArgs) {
        return <span data-testid="palette">{palette.value}</span>
      },
      { match: "/palette", schema: () => ({ palette }) },
    )
    const out = await flightAt("http://t/palette", <Page parent={ROOT} />)
    // Single text child serializes as `"children":"dark"` in Flight.
    expect(out).toContain('"children":"dark"')
  })

  it("stamps the cell selector label onto the partial", async () => {
    const counter = cell.number({
      id: "test.counter",
      vary: () => ({}),
      initial: 0,
    })
    const Page = parton(
      function CounterRender({
        counter,
      }: { counter: ResolvedCell<number> } & RenderArgs) {
        return <span data-testid="counter">{counter.value}</span>
      },
      { match: "/counter", selector: "counter-spec", schema: () => ({ counter }) },
    )

    // Render once — fp baked in.
    const first = await flightAt("http://t/counter", <Page parent={ROOT} />)
    const fpMatch = first.match(/partialFingerprint":"([0-9a-f]+)/)
    expect(fpMatch).not.toBeNull()
    const initialFp = fpMatch![1]

    // Refresh by the cell's auto-stamped label — fp must shift even
    // though the cell value is still 0 (the invalidation timestamp
    // contributes via `queryMatchingTs`).
    refreshSelector("cell:test.counter")
    const second = await flightAt("http://t/counter", <Page parent={ROOT} />)
    const secondFp = second.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(secondFp).not.toEqual(initialFp)
  })

  it("partitions storage by the cell's vary output", async () => {
    const notes = cell.string({
      id: "test.notes",
      vary: ({ params }) => ({ productId: params.id ?? "" }),
      initial: "",
    })
    seedCell(notes.id, { productId: "42" }, "notes for 42")
    seedCell(notes.id, { productId: "99" }, "notes for 99")

    const Page = parton(
      function NotesRender({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        return <span data-testid="notes">{notes.value}</span>
      },
      { match: "/product/:id", schema: () => ({ notes }) },
    )
    const at42 = await flightAt("http://t/product/42", <Page parent={ROOT} />)
    expect(at42).toContain('"children":"notes for 42"')
    const at99 = await flightAt("http://t/product/99", <Page parent={ROOT} />)
    expect(at99).toContain('"children":"notes for 99"')
  })
})

describe("cell — runtime validation", () => {
  it("rejects mismatched value at validate", () => {
    const bumps = cell.number({
      id: "test.bumps",
      vary: () => ({}),
      initial: 0,
    })
    expect(() => bumps.validate("not a number")).toThrow(/expected number/)
  })

  it("rejects out-of-set enum values", () => {
    const palette = cell.enum(["light", "dark"] as const, {
      id: "test.palette2",
      vary: () => ({}),
      initial: "light",
    })
    expect(() => palette.validate("midnight")).toThrow(/expected one of/)
  })
})

describe("cell — fp transitive on partition change", () => {
  it("parton fp shifts when navigating to a different partition", async () => {
    const notes = cell.string({
      id: "test.notes-fp",
      vary: ({ params }) => ({ productId: params.id ?? "" }),
      initial: "default",
    })
    seedCell(notes.id, { productId: "A" }, "A-notes")
    seedCell(notes.id, { productId: "B" }, "B-notes")

    const Page = parton(
      function NotesFpRender({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        return <span data-testid="notes-fp">{notes.value}</span>
      },
      { match: "/p/:id", schema: () => ({ notes }) },
    )
    const a = await flightAt("http://t/p/A", <Page parent={ROOT} />)
    const b = await flightAt("http://t/p/B", <Page parent={ROOT} />)
    const fpA = a.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    const fpB = b.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fpA).not.toEqual(fpB)
  })
})
