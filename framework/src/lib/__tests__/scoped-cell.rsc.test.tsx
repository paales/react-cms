/**
 * Scoped cells — the inline `localCell("key", {...})` form: compound id
 * derivation (`<partonId>/<key>`), placement-derived and request-derived
 * partitioning, coexistence with module-scope cells in the same body,
 * `peek` semantics on the finalized handle, and the partition baked
 * into the resolved cell's client `set` ref.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { getCellById, localCell, _clearCellRegistry, type ResolvedCell } from "../cell.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { searchParam } from "../server-hooks.ts"
import { clearRegistry } from "../partial-registry.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(
  url: string,
  node: React.ReactNode,
  headers?: Record<string, string>,
): Promise<string> {
  const { stream } = await renderWithRequest(url, node, { headers })
  return await new Response(stream).text()
}

function seedCell(id: string, partition: object, value: unknown): void {
  const partitionKey = hash(stableStringify(partition))
  getCellStorage().write("default", id, partitionKey, value)
}

function readCell(id: string, partition: object): unknown {
  const partitionKey = hash(stableStringify(partition))
  return getCellStorage().read("default", id, partitionKey)
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
  _clearCellRegistry()
  clearRegistry("all")
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("scoped cell — compound id + registered handle", () => {
  it("finalizes into a registered CellInterface with compound id `<partonId>/<key>`", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const counter = await localCell("counter", { shape: "number", initial: 0 })
        const flag = await localCell("flag", { shape: "boolean", initial: false })
        return <span>{`${counter.value}:${String(flag.value)}`}</span>
      },
      { selector: "my-parton", match: "/x" },
    )
    await flightAt("http://t/x", <Page />)

    const counterHandle = getCellById("my-parton/counter")
    expect(counterHandle).toBeDefined()
    expect(counterHandle!.id).toBe("my-parton/counter")
    expect(counterHandle!.shape).toEqual({ kind: "number" })
    expect(counterHandle!.defaultValue).toBe(0)
  })

  it("validate uses the compound id in error messages", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const flag = await localCell("flag", { shape: "boolean", initial: false })
        return <span>{String(flag.value)}</span>
      },
      { selector: "my-parton", match: "/x" },
    )
    await flightAt("http://t/x", <Page />)

    const handle = getCellById("my-parton/flag")
    expect(handle).toBeDefined()
    expect(() => handle!.validate("not a bool")).toThrow(/my-parton\/flag.*expected boolean/)
  })
})

describe("scoped cell — in-body resolution in a parton", () => {
  it("resolves the default value on a storage miss", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const notes = await localCell("notes", { shape: "string", initial: "" })
        return <span data-testid="notes">{notes.value || "(default)"}</span>
      },
      { selector: "scoped-miss", match: "/page" },
    )
    const out = await flightAt("http://t/page", <Page />)
    expect(out).toContain('"children":"(default)"')
  })

  it("partitions storage by a placement-derived partition (match param)", async () => {
    const Page = parton(
      async function Render({ id }: { id: string } & RenderArgs) {
        const notes = await localCell("notes", {
          shape: "string",
          initial: "",
          partition: { id },
        })
        return <span data-testid="notes">{notes.value || "(empty)"}</span>
      },
      { selector: "scoped-default-partition", match: "/p/:id" },
    )

    seedCell("scoped-default-partition/notes", { id: "A" }, "A-notes")
    seedCell("scoped-default-partition/notes", { id: "B" }, "B-notes")

    const a = await flightAt("http://t/p/A", <Page />)
    expect(a).toContain('"children":"A-notes"')
    const b = await flightAt("http://t/p/B", <Page />)
    expect(b).toContain('"children":"B-notes"')
  })

  it("a narrowed partition shares values across other request dimensions", async () => {
    const Page = parton(
      async function Render({ id }: { id: string } & RenderArgs) {
        // Narrowed: the partition names only the product dimension —
        // one slot per product, shared across every other request
        // dimension (the `?lang=` read below never enters the
        // partition).
        searchParam("lang", "en")
        const sharedNotes = await localCell("sharedNotes", {
          shape: "string",
          initial: "",
          partition: { productId: id },
        })
        return <span>{sharedNotes.value || "(empty)"}</span>
      },
      { selector: "scoped-narrow", match: "/p/:id" },
    )

    // One stored value at {productId: "A"} — both locales should
    // read it.
    seedCell("scoped-narrow/sharedNotes", { productId: "A" }, "shared-A")

    const en = await flightAt("http://t/p/A?lang=en", <Page />)
    expect(en).toContain('"children":"shared-A"')
    const fr = await flightAt("http://t/p/A?lang=fr", <Page />)
    expect(fr).toContain('"children":"shared-A"')
  })

  it("inline and module-scope cells coexist in the same body", async () => {
    const palette = localCell({
      id: "test.coexist.palette",
      shape: { enum: ["light", "dark"] as const },
      partition: () => ({}),
      initial: "light",
    })

    const Page = parton(
      async function Render(_: RenderArgs) {
        const p = await palette.resolve()
        const notes = await localCell("notes", { shape: "string", initial: "" })
        return (
          <span>
            <em>{p.value}</em>:<i>{notes.value || "(empty)"}</i>
          </span>
        )
      },
      { selector: "scoped-coexist", match: "/mixed" },
    )

    seedCell("test.coexist.palette", {}, "dark")
    seedCell("scoped-coexist/notes", {}, "scoped note")

    const out = await flightAt("http://t/mixed", <Page />)
    expect(out).toContain("dark")
    expect(out).toContain("scoped note")
  })

  it("peek reads stored state, not the declared default", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const notes = await localCell("notes", { shape: "string", initial: "(default)" })
        return <span>{notes.value}</span>
      },
      { selector: "peek-parton", match: "/x" },
    )
    // One render finalizes + registers the handle.
    await flightAt("http://t/x", <Page />)
    const handle = getCellById("peek-parton/notes")
    expect(handle).toBeDefined()

    // No-arg peek resolves the `{}` partition — the slot a
    // partition-less inline cell resolves against. Nothing stored yet
    // (a resolve miss without a loader doesn't write storage).
    const { result: coldPeek } = await runWithRequestAsync(new Request("http://t/x"), async () =>
      handle!.peek(),
    )
    expect(coldPeek).toBe("(default)")

    seedCell("peek-parton/notes", {}, "stored!")
    const { result: warmPeek } = await runWithRequestAsync(new Request("http://t/x"), async () =>
      handle!.peek(),
    )
    expect(warmPeek).toBe("stored!")
  })

  it("peek(args) reads the partitioned slot the render resolved against", async () => {
    const Page = parton(
      async function Render({ id }: { id: string } & RenderArgs) {
        const notes = await localCell("notes", {
          shape: "string",
          initial: "",
          partition: { id },
        })
        return <span>{notes.value || "(empty)"}</span>
      },
      { selector: "scoped-peek", match: "/p/:id" },
    )

    seedCell("scoped-peek/notes", { id: "A" }, "A-notes")
    const out = await flightAt("http://t/p/A", <Page />)
    expect(out).toContain('"children":"A-notes"')

    // The render registered the finalized handle; peek at the same
    // partition the parton resolved against sees the stored state.
    const handle = getCellById("scoped-peek/notes")
    expect(handle).toBeDefined()
    const { result } = await runWithRequestAsync(new Request("http://t/p/A"), async () => ({
      partitioned: handle!.peek({ id: "A" }),
      // No-arg peek can't re-derive the parton's partition — it reads
      // the `{}` slot, which nothing wrote. Documented limitation.
      bare: handle!.peek(),
    }))
    expect(result.partitioned).toBe("A-notes")
    expect(result.bare).toBe("")
  })

  it("peek falls back to the default when the stored value fails shape validation", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const count = await localCell("count", { shape: "number", initial: 7 })
        return <span>{count.value}</span>
      },
      { selector: "peek-invalid", match: "/x" },
    )
    await flightAt("http://t/x", <Page />)
    const handle = getCellById("peek-invalid/count")
    expect(handle).toBeDefined()

    seedCell("peek-invalid/count", {}, "not a number")
    const { result } = await runWithRequestAsync(new Request("http://t/x"), async () =>
      handle!.peek(),
    )
    expect(result).toBe(7)
  })

  it("resolved scoped cell carries partition for the client batcher", async () => {
    let capturedPartition: Record<string, unknown> | undefined = undefined
    const Page = parton(
      async function Render({ id }: { id: string } & RenderArgs) {
        const notes = await localCell("notes", {
          shape: "string",
          initial: "",
          partition: { id },
        })
        capturedPartition = notes.partition
        return <span>{notes.value || "x"}</span>
      },
      { selector: "scoped-wire-partition", match: "/p/:id" },
    )
    await flightAt("http://t/p/42", <Page />)
    expect(capturedPartition).toEqual({ id: "42" })
  })

  it("a per-session inline cell's set ref writes at the caller's baked partition", async () => {
    // A request-derived partition (`{sid: session.id}`) resolves at
    // render time; the resolved cell's `set` bakes that partition into
    // the write action ref, so each session's client writes land on
    // its own slot — no clobber across sessions.
    let captured: ResolvedCell<string> | undefined = undefined
    const Page = parton(
      async function Render(_: RenderArgs) {
        const draft = await localCell("draft", {
          shape: "string",
          initial: "",
          partition: ({ session }) => ({ sid: session.id }),
        })
        captured = draft
        return <span>{draft.value || "(empty)"}</span>
      },
      { selector: "session-draft", match: "/x" },
    )

    // Alice's render bakes {sid: "alice"} into her set ref.
    await flightAt("http://t/x", <Page />, { cookie: "__frame_sid=alice" })
    const aliceSet = captured!.set
    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=alice" } }),
      async () => {
        await aliceSet("alice-draft")
      },
    )

    // Bob's render bakes {sid: "bob"}.
    captured = undefined
    await flightAt("http://t/x", <Page />, { cookie: "__frame_sid=bob" })
    const bobSet = captured!.set
    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=bob" } }),
      async () => {
        await bobSet("bob-draft")
      },
    )

    // Separate partitions — no clobber.
    expect(readCell("session-draft/draft", { sid: "alice" })).toBe("alice-draft")
    expect(readCell("session-draft/draft", { sid: "bob" })).toBe("bob-draft")
  })
})
