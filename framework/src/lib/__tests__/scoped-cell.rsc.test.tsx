/**
 * Scoped cells — schema-callback factory, compound id derivation,
 * partition inheritance / narrowing, transparent flow into Render's
 * prop bag alongside module-scope cells.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parton,
  ROOT,
  type RenderArgs,
} from "../partial.tsx"
import {
  finalizeScopedCell,
  makeScopedCellFactories,
  type ResolvedCell,
  type ScopedCellDescriptor,
} from "../cell.ts"
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
} from "../../runtime/invalidation-registry.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function seedCell(id: string, varyOutput: object, value: unknown): void {
  const partitionKey = hash(stableStringify(varyOutput))
  getCellStorage().write("default", id, partitionKey, value)
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("scoped cell — schema-callback factory", () => {
  it("descriptor declares shape + default without an id", () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.string({ initial: "hello" })
    expect(d.__scopedCellDescriptor).toBe(true)
    expect(d.shape).toEqual({ kind: "string" })
    expect(d.defaultValue).toBe("hello")
    expect(d.varyFn).toBeUndefined()
  })

  it("finalizes into a Cell<T> with compound id `<partonId>/<schemaKey>`", () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.number({ initial: 0 }) as ScopedCellDescriptor<number>
    const handle = finalizeScopedCell(d, "my-parton", "counter")
    expect(handle.id).toBe("my-parton/counter")
    expect(handle.defaultValue).toBe(0)
    expect(handle.shape).toEqual({ kind: "number" })
  })

  it("validate uses the finalized id in error messages", () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.boolean({ initial: false }) as ScopedCellDescriptor<boolean>
    const handle = finalizeScopedCell(d, "my-parton", "flag")
    expect(() => handle.validate("not a bool")).toThrow(/my-parton\/flag.*expected boolean/)
  })
})

describe("scoped cell — schema resolution in a parton", () => {
  it("threads resolved scoped cell into Render with the default value on storage miss", async () => {
    const Page = parton(
      function Render({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        return <span data-testid="notes">{notes.value || "(default)"}</span>
      },
      {
        match: "/page",
        schema: ({ cell }) => ({ notes: cell.string({ initial: "" }) }),
      },
    )
    const out = await flightAt("http://t/page", <Page parent={ROOT} />)
    expect(out).toContain('"children":"(default)"')
  })

  it("partitions storage by the parton's full vary output by default", async () => {
    const Page = parton(
      function Render({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        return <span data-testid="notes">{notes.value || "(empty)"}</span>
      },
      {
        selector: "scoped-default-partition",
        match: "/p/:id",
        vary: ({ params }) => ({ productId: params.id }),
        schema: ({ cell }) => ({ notes: cell.string({ initial: "" }) }),
      },
    )

    seedCell("scoped-default-partition/notes", { productId: "A" }, "A-notes")
    seedCell("scoped-default-partition/notes", { productId: "B" }, "B-notes")

    const a = await flightAt("http://t/p/A", <Page parent={ROOT} />)
    expect(a).toContain('"children":"A-notes"')
    const b = await flightAt("http://t/p/B", <Page parent={ROOT} />)
    expect(b).toContain('"children":"B-notes"')
  })

  it("narrows the partition via descriptor.vary, sharing values across other dimensions", async () => {
    const Page = parton(
      function Render({
        sharedNotes,
      }: { sharedNotes: ResolvedCell<string> } & RenderArgs) {
        return <span>{sharedNotes.value || "(empty)"}</span>
      },
      {
        selector: "scoped-narrow",
        match: "/p/:id",
        vary: ({ params, search: { lang = "en" } }) => ({
          productId: params.id,
          locale: lang,
        }),
        // Narrowed: share across locales for the same product.
        // Note: the cell's `vary` partonVary type is currently
        // inferred as `object` (the bound on PartialOptions's
        // generic). v2 ships a slightly weaker cascading inference
        // here; an explicit cast is needed when destructuring
        // narrower keys. See cells.md "Type inference" caveat.
        schema: ({ cell }) => ({
          sharedNotes: cell.string({
            initial: "",
            vary: (pv) => ({ productId: (pv as { productId: string }).productId }),
          }),
        }),
      },
    )

    // One stored value at {productId: "A"} — both locales should
    // read it.
    seedCell("scoped-narrow/sharedNotes", { productId: "A" }, "shared-A")

    const en = await flightAt("http://t/p/A?lang=en", <Page parent={ROOT} />)
    expect(en).toContain('"children":"shared-A"')
    const fr = await flightAt("http://t/p/A?lang=fr", <Page parent={ROOT} />)
    expect(fr).toContain('"children":"shared-A"')
  })

  it("scoped descriptors and module-scope cells coexist in the same schema record", async () => {
    // Module-scope cell using the public cell factory
    const { cell: moduleCell } = await import("../cell.ts")
    const palette = moduleCell.enum(["light", "dark"] as const, {
      id: "test.coexist.palette",
      vary: () => ({}),
      initial: "light",
    })

    const Page = parton(
      function Render({
        palette,
        notes,
      }: {
        palette: ResolvedCell<"light" | "dark">
        notes: ResolvedCell<string>
      } & RenderArgs) {
        return (
          <span>
            <em>{palette.value}</em>:<i>{notes.value || "(empty)"}</i>
          </span>
        )
      },
      {
        selector: "scoped-coexist",
        match: "/mixed",
        schema: ({ cell }) => ({
          palette,
          notes: cell.string({ initial: "" }),
        }),
      },
    )

    seedCell("test.coexist.palette", {}, "dark")
    seedCell("scoped-coexist/notes", {}, "scoped note")

    const out = await flightAt("http://t/mixed", <Page parent={ROOT} />)
    expect(out).toContain("dark")
    expect(out).toContain("scoped note")
  })

  it("resolved scoped cell carries partition for the client batcher", async () => {
    let capturedPartition: Record<string, unknown> | undefined = undefined
    const Page = parton(
      function Render({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        capturedPartition = notes.partition
        return <span>{notes.value || "x"}</span>
      },
      {
        selector: "scoped-wire-partition",
        match: "/p/:id",
        vary: ({ params }) => ({ productId: params.id }),
        schema: ({ cell }) => ({ notes: cell.string({ initial: "" }) }),
      },
    )
    await flightAt("http://t/p/42", <Page parent={ROOT} />)
    expect(capturedPartition).toEqual({ productId: "42" })
  })
})
