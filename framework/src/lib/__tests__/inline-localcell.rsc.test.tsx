/**
 * Probe: inline `localCell` — `const v = await localCell("key", {...})`
 * called directly in a parton's Render, the server-hook form of a schema
 * cell. It resolves against the CALLING parton (id `<partonId>/<key>`,
 * via the self-context), reads its value from storage, and folds its
 * invalidation into the fp through the dep-record — so a write to the
 * cell (`refreshSelector(cell:<id>)`) re-renders the parton on the next
 * nav, reusing the cookie()/searchParam() store-and-reread machinery.
 *
 * This is increment 1 (read + client-write): single-slot partition; the
 * server-action cell enumeration (so an `actions` handler can resolve an
 * inline cell without a render) and request-derived partitioning are the
 * follow-ups — see docs/reference/cells.md.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { localCell, _clearCellRegistry } from "../cell.ts"
import { clearRegistry } from "../partial-registry.ts"
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

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}
function seedCell(id: string, partition: object, value: unknown): void {
  getCellStorage().write("default", id, hash(stableStringify(partition)), value)
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  clearRegistry("all")
  _clearInvalidationRegistry()
  _clearCellRegistry()
})
afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

const Counter = parton(
  async function InlineCounterRender(_: RenderArgs) {
    const n = await localCell("n", { shape: "number", initial: 0 })
    return <span data-testid="n">{String(n.value)}</span>
  },
  { selector: "#inline-counter" },
)

describe("inline localCell — read path", () => {
  it("resolves the initial value on a storage miss", async () => {
    const out = await flightAt(
      "http://t/x",
      <PartialRoot>
        <Counter />
      </PartialRoot>,
    )
    expect(out).toContain('"children":"0"')
  })

  it("resolves the stored value at the parton-keyed id `<partonId>/<key>`", async () => {
    seedCell("inline-counter/n", {}, 7)
    const out = await flightAt(
      "http://t/x",
      <PartialRoot>
        <Counter />
      </PartialRoot>,
    )
    expect(out).toContain('"children":"7"')
  })
})

describe("inline localCell — folds into the fp", () => {
  it("a write to the cell moves the parton's fp (store-and-reread)", async () => {
    const tree = (
      <PartialRoot>
        <Counter />
      </PartialRoot>
    )
    // Warm up so the cell dep is recorded on the snapshot and folded on
    // the next render.
    await flightAt("http://t/x", tree)
    const fp1 = fpById(await flightAt("http://t/x", tree)).get("inline-counter")
    refreshSelector("cell:inline-counter/n") // what a cell write fires
    const fp2 = fpById(await flightAt("http://t/x", tree)).get("inline-counter")
    expect(fp1).toBeDefined()
    expect(fp2).not.toBe(fp1) // the cell's invalidation folded into the fp
  })

  it("no write → the fp is stable across renders", async () => {
    const tree = (
      <PartialRoot>
        <Counter />
      </PartialRoot>
    )
    await flightAt("http://t/x", tree)
    const fp1 = fpById(await flightAt("http://t/x", tree)).get("inline-counter")
    const fp2 = fpById(await flightAt("http://t/x", tree)).get("inline-counter")
    expect(fp1).toBeDefined()
    expect(fp2).toBe(fp1)
  })
})
