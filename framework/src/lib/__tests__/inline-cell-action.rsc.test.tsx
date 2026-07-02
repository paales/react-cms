/**
 * Inline-cell increment 2 — action enumeration.
 *
 * An inline `localCell("key", …)` is declared inside a parton's Render, so
 * the schema-callback path the action dispatcher uses can't see it. This
 * probes the increment-2 mechanism: the wrapper records each inline cell
 * `(key, descriptor, partition)` on the parton's snapshot at render, and
 * `resolveSchemaForAction` reads that record so an `actions` handler
 * resolves the cell BY KEY without a render — auto-write, explicit handler
 * write, and transactional rollback all work exactly as they do for a
 * schema cell. This is the gate for an action-bound inline cell
 * (forms-demo's `save`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { localCell, type ResolvedCell } from "../cell.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { __partonAction } from "../../runtime/parton-actions.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { _clearCellRegistry } from "../cell.ts"
import { _clearActionRegistry } from "../parton-actions.ts"
import { clearRegistry } from "../partial-registry.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function seedCell(id: string, partition: object, value: unknown): void {
  getCellStorage().write("default", id, hash(stableStringify(partition)), value)
}

function readCell(id: string, partition: object): unknown {
  return getCellStorage().read("default", id, hash(stableStringify(partition)))
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
  _clearCellRegistry()
  _clearActionRegistry()
  clearRegistry("all")
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("inline-cell action enumeration (increment 2)", () => {
  it("an action resolves + writes an inline cell declared in Render (no schema)", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const saves = await localCell("saves", { shape: "number", initial: 0 })
        return <span>{saves.value}</span>
      },
      {
        selector: "inline-action-write",
        match: "/x",
        actions: {
          save: async ({ saves }: { saves: ResolvedCell<number> }) => {
            await saves.set(saves.value + 1)
          },
        },
      },
    )
    // Render once — records the inline cell on the snapshot.
    await flightAt("http://t/x", <Page />)
    seedCell("inline-action-write/saves", {}, 4)

    const req = new Request("http://t/x")
    await runWithRequestAsync(req, async () => {
      await __partonAction("inline-action-write/save", {}, {})
    })

    // Handler read the seeded value (4) and wrote 5 — resolved by key,
    // no render.
    expect(readCell("inline-action-write/saves", {})).toBe(5)
  })

  it("auto-writes an arg to a matching inline cell key", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const notes = await localCell("notes", { shape: "string", initial: "" })
        return <span>{notes.value}</span>
      },
      {
        selector: "inline-action-autowrite",
        match: "/x",
        // Pure auto-write — the handler does nothing; the framework writes
        // args whose key matches an inline cell.
        actions: { save: async () => undefined },
      },
    )
    await flightAt("http://t/x", <Page />)

    const req = new Request("http://t/x")
    await runWithRequestAsync(req, async () => {
      await __partonAction("inline-action-autowrite/save", {}, { notes: "hello" })
    })

    expect(readCell("inline-action-autowrite/notes", {})).toBe("hello")
  })

  it("rolls back an inline-cell write when the handler throws", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const saves = await localCell("saves", { shape: "number", initial: 0 })
        return <span>{saves.value}</span>
      },
      {
        selector: "inline-action-rollback",
        match: "/x",
        actions: {
          save: async ({ saves }: { saves: ResolvedCell<number> }) => {
            await saves.set(saves.value + 100)
            throw new Error("nope")
          },
        },
      },
    )
    await flightAt("http://t/x", <Page />)
    seedCell("inline-action-rollback/saves", {}, 7)

    const req = new Request("http://t/x")
    await expect(
      runWithRequestAsync(req, async () => {
        await __partonAction("inline-action-rollback/save", {}, {})
      }),
    ).rejects.toThrow(/nope/)

    // Staged write discarded on throw — storage untouched.
    expect(readCell("inline-action-rollback/saves", {})).toBe(7)
  })

  it("re-derives a vary-partitioned inline cell per-session in the action", async () => {
    const Page = parton(
      async function Render(_: RenderArgs) {
        const draft = await localCell("draft", {
          shape: "string",
          initial: "",
          vary: ({ session }) => ({ sid: session.id }),
        })
        return <span>{draft.value}</span>
      },
      {
        selector: "inline-session-cell",
        match: "/x",
        actions: {
          save: async ({ draft }: { draft: ResolvedCell<string> }, args: { text?: string }) => {
            await draft.set(args.text ?? "")
          },
        },
      },
    )
    // One render records the cell + its vary callback (the recorded
    // partition is this anon render's, {sid: ""}).
    await flightAt("http://t/x", <Page />)

    // Two actions from two different sessions. Each must resolve the cell
    // at ITS OWN session — re-derived from the action's request, not the
    // single recorded partition.
    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=alice" } }),
      async () => {
        await __partonAction("inline-session-cell/save", {}, { text: "alice-draft" })
      },
    )
    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=bob" } }),
      async () => {
        await __partonAction("inline-session-cell/save", {}, { text: "bob-draft" })
      },
    )

    // Separate partitions — no clobber.
    expect(readCell("inline-session-cell/draft", { sid: "alice" })).toBe("alice-draft")
    expect(readCell("inline-session-cell/draft", { sid: "bob" })).toBe("bob-draft")
  })
})
