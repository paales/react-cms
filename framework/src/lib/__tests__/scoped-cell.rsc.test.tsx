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
  getCellById,
  makeScopedCellFactories,
  type ResolvedCell,
  type ScopedCellDescriptor,
} from "../cell.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
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
    const d = factories.localCell({ shape: "string", initial: "hello" })
    expect(d.__scopedCellDescriptor).toBe(true)
    expect(d.shape).toEqual({ kind: "string" })
    expect(d.defaultValue).toBe("hello")
    expect(d.varyFn).toBeUndefined()
  })

  it("finalizes into a CellInterface<T> with compound id `<partonId>/<schemaKey>`", () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.localCell({ shape: "number", initial: 0 }) as ScopedCellDescriptor<number>
    const handle = finalizeScopedCell(d, "my-parton", "counter")
    expect(handle.id).toBe("my-parton/counter")
    expect(handle.defaultValue).toBe(0)
    expect(handle.shape).toEqual({ kind: "number" })
  })

  it("validate uses the finalized id in error messages", () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.localCell({ shape: "boolean", initial: false }) as ScopedCellDescriptor<boolean>
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
        schema: ({ localCell }) => ({ notes: localCell({ shape: "string", initial: "" }) }),
      },
    )
    const out = await flightAt("http://t/page", <Page />)
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
        schema: ({ localCell }) => ({ notes: localCell({ shape: "string", initial: "" }) }),
      },
    )

    seedCell("scoped-default-partition/notes", { productId: "A" }, "A-notes")
    seedCell("scoped-default-partition/notes", { productId: "B" }, "B-notes")

    const a = await flightAt("http://t/p/A", <Page />)
    expect(a).toContain('"children":"A-notes"')
    const b = await flightAt("http://t/p/B", <Page />)
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
        schema: ({ localCell }) => ({
          sharedNotes: localCell({
            shape: "string",
            initial: "",
            vary: (pv) => ({ productId: (pv as { productId: string }).productId }),
          }),
        }),
      },
    )

    // One stored value at {productId: "A"} — both locales should
    // read it.
    seedCell("scoped-narrow/sharedNotes", { productId: "A" }, "shared-A")

    const en = await flightAt("http://t/p/A?lang=en", <Page />)
    expect(en).toContain('"children":"shared-A"')
    const fr = await flightAt("http://t/p/A?lang=fr", <Page />)
    expect(fr).toContain('"children":"shared-A"')
  })

  it("scoped descriptors and module-scope cells coexist in the same schema record", async () => {
    // Module-scope cell using the public localCell constructor
    const { localCell: moduleLocalCell } = await import("../cell.ts")
    const palette = moduleLocalCell({
      id: "test.coexist.palette",
      shape: { enum: ["light", "dark"] as const },
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
        schema: ({ localCell }) => ({
          palette,
          notes: localCell({ shape: "string", initial: "" }),
        }),
      },
    )

    seedCell("test.coexist.palette", {}, "dark")
    seedCell("scoped-coexist/notes", {}, "scoped note")

    const out = await flightAt("http://t/mixed", <Page />)
    expect(out).toContain("dark")
    expect(out).toContain("scoped note")
  })

  it("peek reads stored state, not the declared default", async () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.localCell({
      shape: "string",
      initial: "(default)",
    }) as ScopedCellDescriptor<string>
    const handle = finalizeScopedCell(d, "peek-parton", "notes")

    // No-arg peek resolves the `{}` partition — the slot a vary-less,
    // match-param-less parton's schema resolution writes to.
    const { result: coldPeek } = await runWithRequestAsync(
      new Request("http://t/x"),
      async () => handle.peek(),
    )
    expect(coldPeek).toBe("(default)")

    seedCell("peek-parton/notes", {}, "stored!")
    const { result: warmPeek } = await runWithRequestAsync(
      new Request("http://t/x"),
      async () => handle.peek(),
    )
    expect(warmPeek).toBe("stored!")
  })

  it("peek(args) reads the parton-partitioned slot the schema resolution used", async () => {
    const Page = parton(
      function Render({
        notes,
      }: { notes: ResolvedCell<string> } & RenderArgs) {
        return <span>{notes.value || "(empty)"}</span>
      },
      {
        selector: "scoped-peek",
        match: "/p/:id",
        vary: ({ params }) => ({ productId: params.id }),
        schema: ({ localCell }) => ({ notes: localCell({ shape: "string", initial: "" }) }),
      },
    )

    seedCell("scoped-peek/notes", { productId: "A" }, "A-notes")
    const out = await flightAt("http://t/p/A", <Page />)
    expect(out).toContain('"children":"A-notes"')

    // The render registered the finalized handle; peek at the same
    // partition the parton resolved against sees the stored state.
    const handle = getCellById("scoped-peek/notes")
    expect(handle).toBeDefined()
    const { result } = await runWithRequestAsync(new Request("http://t/p/A"), async () => ({
      partitioned: handle!.peek({ productId: "A" }),
      // No-arg peek can't re-derive the parton's partition — it reads
      // the `{}` slot, which nothing wrote. Documented limitation.
      bare: handle!.peek(),
    }))
    expect(result.partitioned).toBe("A-notes")
    expect(result.bare).toBe("")
  })

  it("peek falls back to the default when the stored value fails shape validation", async () => {
    const factories = makeScopedCellFactories<object>()
    const d = factories.localCell({
      shape: "number",
      initial: 7,
    }) as ScopedCellDescriptor<number>
    const handle = finalizeScopedCell(d, "peek-invalid", "count")

    seedCell("peek-invalid/count", {}, "not a number")
    const { result } = await runWithRequestAsync(
      new Request("http://t/x"),
      async () => handle.peek(),
    )
    expect(result).toBe(7)
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
        schema: ({ localCell }) => ({ notes: localCell({ shape: "string", initial: "" }) }),
      },
    )
    await flightAt("http://t/p/42", <Page />)
    expect(capturedPartition).toEqual({ productId: "42" })
  })
})
