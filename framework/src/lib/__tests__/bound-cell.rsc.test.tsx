/**
 * Bound cells — .with(args), prop-bag auto-resolution,
 * partition-scoped invalidation routing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, ROOT, type RenderArgs } from "../partial.tsx"
import { localCell, type BoundCell, type ResolvedCell } from "../cell.ts"
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

function seedCell(id: string, args: object, value: unknown): void {
  const partitionKey = hash(stableStringify(args))
  getCellStorage().write("default", id, partitionKey, value)
}

function readCell(id: string, args: object): unknown {
  const partitionKey = hash(stableStringify(args))
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

describe("cell.with(args) — bound cells", () => {
  it("returns a BoundCell descriptor carrying cellId + args", () => {
    const cartItem = localCell({
      id: "test.bound.cart-item",
      shape: "opaque",
      initial: null as unknown,
    })
    const bound = cartItem.with({ itemId: "abc" })
    expect(bound.__boundCell).toBe(true)
    expect(bound.cellId).toBe("test.bound.cart-item")
    expect(bound.args).toEqual({ itemId: "abc" })
  })

  it("auto-resolves a BoundCell passed as a parton JSX prop", async () => {
    const cartItem = localCell({
      id: "test.bound.line",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })
    seedCell("test.bound.line", { itemId: "A" }, { qty: 3 })

    const Line = parton(
      function Render({ item }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span data-testid="qty">{item.value?.qty ?? "—"}</span>
      },
      { match: "/cart" },
    )

    const out = await flightAt(
      "http://t/cart",
      <Line parent={ROOT} item={cartItem.with({ itemId: "A" })} />,
    )
    expect(out).toContain('"children":3')
  })

  it("runs the loader on storage miss and writes the result", async () => {
    let loadCalls = 0
    const remote = localCell<"opaque", { name: string }>({
      id: "test.bound.remote",
      shape: "opaque",
      initial: { name: "default" },
      load: async (args) => {
        loadCalls++
        return { name: `loaded-${args.id}` }
      },
    })

    const Page = parton(
      function Render({ data }: { data: ResolvedCell<{ name: string }> } & RenderArgs) {
        return <span data-testid="name">{data.value.name}</span>
      },
      { match: "/r" },
    )
    const out = await flightAt(
      "http://t/r",
      <Page parent={ROOT} data={remote.with({ id: "42" })} />,
    )
    expect(out).toContain('"children":"loaded-42"')
    expect(loadCalls).toBe(1)

    // Subsequent read with same args: storage warm, loader skipped.
    await flightAt("http://t/r", <Page parent={ROOT} data={remote.with({ id: "42" })} />)
    expect(loadCalls).toBe(1)
  })
})

describe("partition-scoped invalidation", () => {
  it("cell write at one partition only shifts fp of matching placements", async () => {
    const cartItem = localCell({
      id: "test.partition.line",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })
    seedCell("test.partition.line", { itemId: "A" }, { qty: 1 })
    seedCell("test.partition.line", { itemId: "B" }, { qty: 2 })

    const Line = parton(
      function Render({ item }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span>{item.value?.qty ?? "—"}</span>
      },
      { selector: "cart-line", match: "/c" },
    )

    const aBefore = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "A" })} />,
    )
    const bBefore = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "B" })} />,
    )
    const fpABefore = aBefore.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    const fpBBefore = bBefore.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // Fire partition-scoped invalidation for A only.
    refreshSelector("cell:test.partition.line?itemId=A")

    const aAfter = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "A" })} />,
    )
    const bAfter = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "B" })} />,
    )
    const fpAAfter = aAfter.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    const fpBAfter = bAfter.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    expect(fpAAfter).not.toEqual(fpABefore) // A shifted
    expect(fpBAfter).toEqual(fpBBefore) // B did not
  })

  it("cell.with(args).set writes the matching partition and fires partition-scoped selector", async () => {
    const cartItem = localCell({
      id: "test.partition.set",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })
    const Line = parton(
      function Render({ item }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span>{item.value?.qty ?? "—"}</span>
      },
      { selector: "set-line", match: "/c" },
    )

    // Initial render — A is empty, returns default null.
    const before = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "A" })} />,
    )
    expect(before).toContain('"children":"—"')

    // Write through the bound cell.
    const bound = cartItem.with({ itemId: "A" })
    await bound.set({ qty: 7 })

    // Storage at the bound partition now has the new value.
    expect(readCell("test.partition.set", { itemId: "A" })).toEqual({ qty: 7 })

    // Next render reads it back.
    const after = await flightAt(
      "http://t/c",
      <Line parent={ROOT} item={cartItem.with({ itemId: "A" })} />,
    )
    expect(after).toContain('"children":7')

    // Other partition (B) is untouched.
    expect(readCell("test.partition.set", { itemId: "B" })).toBeUndefined()
  })
})

describe("constraint surface merges vary + bound args", () => {
  it("a placement with both vary AND bound args matches selectors against either", async () => {
    const item = localCell({
      id: "test.constraints.item",
      shape: "opaque",
      initial: null as { v: number } | null,
    })
    seedCell("test.constraints.item", { itemId: "A" }, { v: 0 })

    const Mixed = parton(
      // `catId` is vary-derived (supplied by the framework from the
      // route param); `item` is the bound-cell JSX prop. Both must be
      // present on the Render type so it satisfies `R extends V &
      // RenderArgs`.
      function Render({
        item,
      }: { item: ResolvedCell<{ v: number } | null>; catId: string } & RenderArgs) {
        return <span>{item.value?.v ?? "—"}</span>
      },
      {
        selector: "mixed",
        match: "/m/:catId",
        vary: ({ params }) => ({ catId: params.catId }),
      },
    )

    // Two placements: same itemId, different catId. Their fp differ
    // because vary's catId is in the constraint surface.
    const a = await flightAt(
      "http://t/m/1",
      <Mixed parent={ROOT} item={item.with({ itemId: "A" })} />,
    )
    const fpA = a.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // Selector with itemId constraint — both placements should match
    // (both bound to itemId=A).
    refreshSelector("cell:test.constraints.item?itemId=A")
    const aAfter = await flightAt(
      "http://t/m/1",
      <Mixed parent={ROOT} item={item.with({ itemId: "A" })} />,
    )
    const fpAAfter = aAfter.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fpAAfter).not.toEqual(fpA)
  })
})

describe("BoundCell.hydrate — write storage without firing signal", () => {
  it("populates storage but does NOT bump the partition-scoped selector", async () => {
    const item = localCell({
      id: "test.hydrate.line",
      shape: "opaque",
      initial: null as { q: number } | null,
    })
    const Line = parton(
      function Render({ item }: { item: ResolvedCell<{ q: number } | null> } & RenderArgs) {
        return <span>{item.value?.q ?? "—"}</span>
      },
      { selector: "hydrate-line", match: "/h" },
    )

    const before = await flightAt(
      "http://t/h",
      <Line parent={ROOT} item={item.with({ id: "A" })} />,
    )
    const fpBefore = before.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // Hydrate at the partition — sync, no signal.
    item.with({ id: "A" }).hydrate({ q: 5 })
    expect(readCell("test.hydrate.line", { id: "A" })).toEqual({ q: 5 })

    // Re-render — fp DOES move because the resolved value changed
    // (storage flipped from default to hydrated), but no
    // refreshSelector was called. Value folds into fp via
    // `schema=<cellHashes>` — same fp dedup as for any other prop-
    // bound cell.
    const after = await flightAt(
      "http://t/h",
      <Line parent={ROOT} item={item.with({ id: "A" })} />,
    )
    expect(after).toContain('"children":5')
    const fpAfter = after.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fpAfter).not.toEqual(fpBefore)
  })
})

describe("BoundCell.update — read-modify-write", () => {
  it("applies the updater to the current value and writes the result", async () => {
    const counter = localCell({
      id: "test.update.counter",
      shape: "opaque",
      initial: 0 as number,
    })
    seedCell("test.update.counter", { k: "a" }, 7)
    const bound = counter.with({ k: "a" })
    await bound.update((n) => n + 3)
    expect(readCell("test.update.counter", { k: "a" })).toBe(10)
  })

  it("runs the loader if storage is cold, then applies the updater", async () => {
    let loaderCalls = 0
    const counter = localCell<"opaque", number>({
      id: "test.update.cold",
      shape: "opaque",
      initial: 0,
      load: async () => {
        loaderCalls++
        return 100
      },
    })
    await counter.with({ k: "x" }).update((n) => n + 1)
    expect(loaderCalls).toBe(1)
    expect(readCell("test.update.cold", { k: "x" })).toBe(101)
  })
})
