/**
 * Selector ↔ partition-key encoding must AGREE on type.
 *
 * The cell PARTITION key is `hash(stableStringify(args))` — JSON-typed,
 * so `{uid: 123}` (number) and `{uid: "123"}` (string) are DISTINCT
 * partitions with distinct storage slots. The invalidation SELECTOR
 * encodes via `String(v)`, collapsing both to `uid=123`, and
 * `matchesConstraints` compares with `String(v)` too — so a write to
 * the number partition fires a selector that ALSO matches a placement
 * bound to the string partition.
 *
 * That asymmetry is wrong granularity: the string placement's storage
 * slot was never touched by the number write, yet its fingerprint
 * shifts and it refetches. The selector encoding must preserve the type
 * distinction the partition key already makes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { localCell, type ResolvedCell } from "../cell.ts"
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
  buildCellSelector,
  refreshSelector,
} from "../../runtime/invalidation-registry.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function seedCell(id: string, args: object, value: unknown): void {
  getCellStorage().write("default", id, hash(stableStringify(args)), value)
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("selector ↔ partition-key type agreement", () => {
  it("a write at the NUMBER partition does not refetch a STRING-partition placement", async () => {
    const line = localCell({
      id: "test.asym.line",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })

    // String-partition placement reads its own slot.
    seedCell("test.asym.line", { uid: "123" }, { qty: 5 })

    const Line = parton(
      function AsymLineRender({
        item,
      }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span>{item.value?.qty ?? "—"}</span>
      },
      { selector: "asym-line", match: "/c" },
    )

    const before = await flightAt("http://t/c", <Line item={line.with({ uid: "123" })} />)
    const fpBefore = before.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // A write lands in the NUMBER partition (distinct storage slot —
    // the string placement's value is untouched). Fire the EXACT
    // selector such a write emits (`buildCellSelector` is the write
    // path's emitter) for `{uid: 123}` (number).
    refreshSelector(buildCellSelector("test.asym.line", { uid: 123 }))

    const after = await flightAt("http://t/c", <Line item={line.with({ uid: "123" })} />)
    const fpAfter = after.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // The string placement's storage slot didn't change, so its
    // fingerprint must hold — a number-partition write must not drag a
    // string-partition placement into a refetch.
    expect(fpAfter).toBe(fpBefore)
  })

  it("a write at the NUMBER partition DOES refetch a number-partition placement", async () => {
    const line = localCell({
      id: "test.asym.num",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })
    seedCell("test.asym.num", { uid: 123 }, { qty: 5 })

    const Line = parton(
      function AsymNumRender({
        item,
      }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span>{item.value?.qty ?? "—"}</span>
      },
      { selector: "asym-num", match: "/c" },
    )

    const before = await flightAt("http://t/c", <Line item={line.with({ uid: 123 })} />)
    const fpBefore = before.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    refreshSelector(buildCellSelector("test.asym.num", { uid: 123 }))

    const after = await flightAt("http://t/c", <Line item={line.with({ uid: 123 })} />)
    const fpAfter = after.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // Same number partition → the touched placement must refetch.
    expect(fpAfter).not.toBe(fpBefore)
  })

  it("a hand-authored bare selector still matches a string vary input", async () => {
    const line = localCell({
      id: "test.asym.bare",
      shape: "opaque",
      initial: null as { qty: number } | null,
    })
    seedCell("test.asym.bare", { uid: "123" }, { qty: 5 })

    const Line = parton(
      function AsymBareRender({
        item,
      }: { item: ResolvedCell<{ qty: number } | null> } & RenderArgs) {
        return <span>{item.value?.qty ?? "—"}</span>
      },
      { selector: "asym-bare", match: "/c" },
    )

    const before = await flightAt("http://t/c", <Line item={line.with({ uid: "123" })} />)
    const fpBefore = before.match(/partialFingerprint":"([0-9a-f]+)/)![1]

    // A bare, hand-authored selector token (no type tag) must still
    // match a STRING vary input of equal text — the legacy contract.
    refreshSelector("cell:test.asym.bare?uid=123")

    const after = await flightAt("http://t/c", <Line item={line.with({ uid: "123" })} />)
    const fpAfter = after.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fpAfter).not.toBe(fpBefore)
  })
})
