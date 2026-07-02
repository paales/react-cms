/**
 * Parton actions — dispatch, args auto-write, transaction rollback,
 * scoped cell composition with the action surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parton,
  ROOT,
  type RenderArgs,
} from "../partial.tsx"
import type { ResolvedCell } from "../cell.ts"
import type { ResolvedAction } from "../parton-actions.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { __partonAction } from "../../runtime/parton-actions.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
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

function readCell(id: string, varyOutput: object): unknown {
  const partitionKey = hash(stableStringify(varyOutput))
  return getCellStorage().read("default", id, partitionKey)
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("parton actions — Render-prop injection", () => {
  it("injects each declared action into Render's prop bag as ResolvedAction", async () => {
    let capturedSave: unknown = undefined
    const Page = parton(
      function Render({
        save,
      }: {
        save: ResolvedAction<{ name?: string }, void>
      } & RenderArgs) {
        capturedSave = save
        return <span>ok</span>
      },
      {
        selector: "action-prop-injection",
        match: "/x",
        schema: ({ localCell }) => ({ name: localCell({ shape: "string", initial: "" }) }),
        actions: {
          save: async () => undefined,
        },
      },
    )
    await flightAt("http://t/x", <Page />)
    expect(capturedSave).toBeDefined()
    expect((capturedSave as { __partonAction?: boolean }).__partonAction).toBe(true)
    expect(typeof (capturedSave as { ref?: unknown }).ref).toBe("function")
    const writes = (capturedSave as { writes?: Record<string, string> }).writes
    expect(writes).toEqual({ name: "action-prop-injection/name" })
  })
})

describe("parton actions — dispatch + auto-write", () => {
  it("auto-writes args to matching schema cells inside the transaction", async () => {
    const Page = parton(
      function Render({ name }: { name: ResolvedCell<string> } & RenderArgs) {
        return <span>{name.value || "(none)"}</span>
      },
      {
        selector: "action-auto-write",
        match: "/x",
        schema: ({ localCell }) => ({ name: localCell({ shape: "string", initial: "" }) }),
        actions: {
          // Pure auto-write: handler does nothing.
          save: async () => undefined,
        },
      },
    )

    // Force registration by rendering once
    await flightAt("http://t/x", <Page />)

    // Invoke the action against the bound partition (empty — no vary)
    const req = new Request("http://t/x")
    await runWithRequestAsync(req, async () => {
      await __partonAction("action-auto-write/save", {}, { name: "Foo" })
    })

    expect(readCell("action-auto-write/name", {})).toBe("Foo")
  })

  it("handler-declared cell writes (not in args) commit alongside auto-writes", async () => {
    const Page = parton(
      function Render({
        name,
        saves,
      }: {
        name: ResolvedCell<string>
        saves: ResolvedCell<number>
      } & RenderArgs) {
        return <span>{name.value}:{saves.value}</span>
      },
      {
        selector: "action-handler-write",
        match: "/x",
        schema: ({ localCell }) => ({
          name: localCell({ shape: "string", initial: "" }),
          saves: localCell({ shape: "number", initial: 0 }),
        }),
        actions: {
          save: async ({ saves }: { saves: ResolvedCell<number> }) => {
            await saves.set(saves.value + 1)
          },
        },
      },
    )
    await flightAt("http://t/x", <Page />)
    seedCell("action-handler-write/saves", {}, 4)

    const req = new Request("http://t/x")
    await runWithRequestAsync(req, async () => {
      await __partonAction("action-handler-write/save", {}, { name: "Alice" })
    })

    expect(readCell("action-handler-write/name", {})).toBe("Alice")
    expect(readCell("action-handler-write/saves", {})).toBe(5)
  })

  it("rolls back the entire transaction when the handler throws", async () => {
    const Page = parton(
      function Render({
        name,
        saves,
      }: {
        name: ResolvedCell<string>
        saves: ResolvedCell<number>
      } & RenderArgs) {
        return <span>{name.value}:{saves.value}</span>
      },
      {
        selector: "action-rollback",
        match: "/x",
        schema: ({ localCell }) => ({
          name: localCell({ shape: "string", initial: "prior" }),
          saves: localCell({ shape: "number", initial: 0 }),
        }),
        actions: {
          save: async ({ saves }: { saves: ResolvedCell<number> }) => {
            await saves.set(saves.value + 100)
            throw new Error("nope")
          },
        },
      },
    )
    await flightAt("http://t/x", <Page />)
    seedCell("action-rollback/name", {}, "prior")
    seedCell("action-rollback/saves", {}, 7)

    const req = new Request("http://t/x")
    await expect(
      runWithRequestAsync(req, async () => {
        await __partonAction("action-rollback/save", {}, { name: "should-not-stick" })
      }),
    ).rejects.toThrow(/nope/)

    // Transactional semantic: explicit handler writes via `cell.set`
    // are staged in a pending map, NOT written to storage. The commit
    // phase (after a successful handler return) drains the pending
    // map. A throw skips the commit phase entirely — storage stays
    // untouched. Args auto-writes are also staged before the handler
    // runs, and discarded the same way on throw.
    expect(readCell("action-rollback/saves", {})).toBe(7)
    expect(readCell("action-rollback/name", {})).toBe("prior")
  })

  it("handler sees args overlaid on cell .value (post-args view)", async () => {
    let observedNameValue: string | undefined = undefined
    const Page = parton(
      function Render({ name }: { name: ResolvedCell<string> } & RenderArgs) {
        return <span>{name.value}</span>
      },
      {
        selector: "action-overlay",
        match: "/x",
        schema: ({ localCell }) => ({ name: localCell({ shape: "string", initial: "" }) }),
        actions: {
          save: async ({ name }: { name: ResolvedCell<string> }) => {
            observedNameValue = name.value
          },
        },
      },
    )
    await flightAt("http://t/x", <Page />)
    seedCell("action-overlay/name", {}, "stored")

    const req = new Request("http://t/x")
    await runWithRequestAsync(req, async () => {
      await __partonAction("action-overlay/save", {}, { name: "from-args" })
    })

    expect(observedNameValue).toBe("from-args")
  })
})
