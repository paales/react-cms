/**
 * In-body cell resolution — `handle.resolve(args?)` inside a Render:
 * reads the value (loader on miss), records the partition-scoped
 * `cell:` dep on the rendering parton (so a write re-renders it and
 * the boundary surfaces the refetch label), and returns the same
 * Flight-portable ResolvedCell the prop path produces.
 *
 * Plus `atomic()` — N writes commit together with ONE invalidation
 * fan-out, and a throw discards them all.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { computeRouteKey, parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { localCell } from "../cell.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, _currentTs } from "../../runtime/invalidation-registry.ts"
import { atomic } from "../cell.ts"
import { clearRegistry, enterRequestRegistry, lookupPartial } from "../partial-registry.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"

const counter = localCell({ id: "resolve-counter", shape: "number", initial: 0 })
const flavor = localCell({
  id: "resolve-flavor",
  shape: "string",
  initial: "plain",
})

const InBody = parton(
  async function InBodyRender(_: RenderArgs) {
    const c = await counter.resolve()
    return <span>{`in-body-count:${c.value}`}</span>
  },
  { selector: "#cell-resolve" },
)

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

beforeEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
  _resetCellStorage()
  setCellStorage(new MemoryCellStorage())
})

describe("handle.resolve() — in-body cells", () => {
  it("resolves the value and records the cell dep + refetch label", async () => {
    const url = "http://t/cell-resolve"
    const out = await flightAt(
      url,
      <PartialRoot>
        <InBody />
      </PartialRoot>,
    )
    expect(out).toContain("in-body-count:0")
    const { result: snap } = await runWithRequestAsync(new Request(url), async () => {
      enterRequestRegistry(computeRouteKey(url), "cache")
      return lookupPartial("cell-resolve")
    })
    expect(snap).toBeDefined()
    expect([...(snap!.deps ?? [])].some((d) => d.startsWith("cell:resolve-counter"))).toBe(true)
    expect(snap!.labels).toContain("cell:resolve-counter")
  })

  it("a write re-renders the parton with the fresh value", async () => {
    const url = "http://t/cell-resolve"
    const tree = (
      <PartialRoot>
        <InBody />
      </PartialRoot>
    )
    await flightAt(url, tree)
    await runWithRequestAsync(new Request(url), async () => {
      await counter.set(7)
    })
    expect(await flightAt(url, tree)).toContain("in-body-count:7")
  })
})

describe("atomic() — one commit, one fan-out", () => {
  it("N writes commit together; a throw discards them all", async () => {
    const url = "http://t/atomic"
    await runWithRequestAsync(new Request(url), async () => {
      const before = _currentTs()
      await atomic(async () => {
        await counter.set(1)
        await flavor.set("cherry")
      })
      // Both writes committed together (the fan-out batches into one
      // driver wake; each selector still gets its own timestamp).
      expect(_currentTs()).toBeGreaterThan(before)
      expect(counter.peek()).toBe(1)
      expect(flavor.peek()).toBe("cherry")

      await expect(
        atomic(async () => {
          await counter.set(99)
          await flavor.set("poison")
          throw new Error("boom")
        }),
      ).rejects.toThrow("boom")
      // The failed transaction discarded both writes.
      expect(counter.peek()).toBe(1)
      expect(flavor.peek()).toBe("cherry")
    })
  })

  it("commits and rolls back at the caller's session partition", async () => {
    // Per-session cells: the partition callback re-derives from the
    // WRITING request's scope, so an atomic multi-cell commit lands on
    // the caller's own slots — and a rollback discards exactly those.
    const name = localCell({
      id: "resolve-tx-name",
      shape: "string",
      initial: "",
      partition: ({ session }) => ({ sid: session.id }),
    })
    const saves = localCell({
      id: "resolve-tx-saves",
      shape: "number",
      initial: 0,
      partition: ({ session }) => ({ sid: session.id }),
    })

    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=alice" } }),
      async () => {
        await atomic(async () => {
          await name.set("Alice")
          await saves.set(1)
        })
        expect(name.peek()).toBe("Alice")
        expect(saves.peek()).toBe(1)

        await expect(
          atomic(async () => {
            await name.set("should-not-stick")
            await saves.set(100)
            throw new Error("nope")
          }),
        ).rejects.toThrow("nope")
        // Rollback discarded both writes; the committed values stand.
        expect(name.peek()).toBe("Alice")
        expect(saves.peek()).toBe(1)
      },
    )

    // Bob's partition is untouched by Alice's transaction.
    await runWithRequestAsync(
      new Request("http://t/x", { headers: { cookie: "__frame_sid=bob" } }),
      async () => {
        expect(name.peek()).toBe("")
        expect(saves.peek()).toBe(0)
      },
    )
  })
})
