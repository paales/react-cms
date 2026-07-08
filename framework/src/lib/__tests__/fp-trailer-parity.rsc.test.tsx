/**
 * Fingerprint-trailer ⇆ live-server PARITY.
 *
 * The cold→warm fp-skip optimisation rests on one equality: the warm
 * fp the trailer ships on a COLD visit (`computeFpUpdates` in
 * `fp-trailer.ts`) must equal the fp the server recomputes LIVE on the
 * next, WARM visit (`createSpecComponent` in `partial.tsx`). The two
 * formulas are hand-mirrored across separate files; if they drift, the
 * trailer aliases a `to` fp the server will never accept, the next nav
 * mismatches, and the keepalive fp-skip silently degrades to a fresh
 * re-render (the exact cost the trailer exists to avoid).
 *
 * Each test here drives the REAL production trailer path
 * (`wrapStreamWithFpTrailer`) on a cold render, captures the trailer's
 * `to` fp, then renders the SAME spec on a warm visit and reads the
 * live fp off the wire. They must be equal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam, match } from "../server-hooks.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { splitAtFpTrailer } from "../fp-trailer-split.ts"
import { runWithRequestAsync, _captureCommitHandle } from "../../runtime/context.ts"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import { localCell } from "../cell.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"

// ─── Round-trip harness ─────────────────────────────────────────────
//
// Drive a render through the production trailer wrapper inside a real
// request ALS. Returns the Flight body text (for live-fp extraction)
// and the parsed trailer payload (`{id: {from, to}}`).

interface RoundTrip {
  bodyText: string
  trailer: Record<string, { from: string; to: string }> | null
}

async function renderWithTrailer(
  url: string,
  node: ReactNode,
  headers?: Record<string, string>,
): Promise<RoundTrip> {
  const request = new Request(url, { headers })
  const { result } = await runWithRequestAsync(request, async () => {
    // Mirror the entry's composition exactly: render → wrap with the
    // real fp-trailer (commit handle captured from the request store).
    const raw = renderServerToFlight(node)
    const wrapped = wrapStreamWithFpTrailer(raw, _captureCommitHandle())
    // Split the wrapped stream the way the browser entry does: body
    // bytes vs the parsed fp-update trailer. Draining the body forces
    // the render's microtasks + the trailer flush to run inside the
    // ALS.
    const { mainStream, trailer } = splitAtFpTrailer(wrapped)
    const bodyText = await new Response(mainStream).text()
    const trailerPayload = await trailer
    return {
      bodyText,
      trailer: trailerPayload as Record<string, { from: string; to: string }> | null,
    }
  })
  return result
}

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}

/**
 * The core parity assertion. Cold-render the tree (capturing the
 * trailer's `to`), then warm-render the SAME url and read the live fp.
 * The trailer's `to` must equal the live warm fp the server computes.
 */
async function assertParity(
  url: string,
  tree: ReactNode,
  id: string,
  headers?: Record<string, string>,
): Promise<void> {
  // Cold: first visit of this route in the scope. The trailer ships
  // the warm fp it predicts.
  const cold = await renderWithTrailer(url, tree, headers)
  // Warm: same url, the registry is now populated. The body carries
  // the live warm fp.
  const warm = await renderWithTrailer(url, tree, headers)
  const liveWarmFp = fpById(warm.bodyText).get(id)
  expect(liveWarmFp, `live warm fp for "${id}" should be present`).toBeDefined()

  const predicted = cold.trailer?.[id]?.to
  if (predicted !== undefined) {
    // The trailer shipped a warm fp for this id — it MUST match what
    // the server recomputes live on the warm visit.
    expect(predicted, `trailer "to" fp for "${id}" diverges from the live warm fp`).toBe(liveWarmFp)
  } else {
    // No trailer entry → the cold body fp already equalled the warm
    // fp (no drift). Then the cold body fp must itself equal the live
    // warm fp — otherwise the client never learns the warm fp and the
    // next nav mismatches.
    const coldBodyFp = fpById(cold.bodyText).get(id)
    expect(coldBodyFp, `no trailer entry for "${id}" yet cold fp ≠ live warm fp`).toBe(liveWarmFp)
  }
}

beforeEach(() => {
  clearRegistry("all")
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})
afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

// ─── Axis: a leaf spec resolving a cell in its body ─────────────────
//
// An in-body `cell.resolve()` records a partition-scoped `cell:` dep
// DURING Render (after the live fp is computed), so it folds by
// store-and-reread. The trailer's recompute must fold the identical
// dep re-read, or the warm fp it ships omits the cell term and can
// never match the live warm fp.

const counter = localCell({
  id: "parity.counter",
  shape: "number",
  partition: () => ({}),
  initial: 7,
})

const CellLeaf = parton(
  async function CellLeafRender(_: RenderArgs) {
    const c = await counter.resolve()
    return <span data-testid="cell-leaf">{c.value}</span>
  },
  { selector: "#cell-leaf" },
)

// A wrapper over the cell leaf. The wrapper's fp drifts cold→warm (its
// descendant fold is empty on the cold visit, populated on warm) so its
// trailer entry FIRES — and the leaf below it carries a cell dep.
// Exercises `recomputeFpWithFold` with a live fold AND a cell-resolving
// descendant in the same route.
const CellWrapper = parton(
  function CellWrapperRender(_: RenderArgs) {
    return (
      <div>
        <CellLeaf />
      </div>
    )
  },
  { selector: "#cell-wrapper" },
)

describe("parity — body-resolved cell", () => {
  it("a cell-resolving leaf's trailer fp matches the live warm fp", async () => {
    const tree = (
      <PartialRoot>
        <CellLeaf />
      </PartialRoot>
    )
    await assertParity("http://t/x", tree, "cell-leaf")
  })

  it("a wrapper over a cell leaf keeps both fps in parity", async () => {
    const tree = (
      <PartialRoot>
        <CellWrapper />
      </PartialRoot>
    )
    // The wrapper's trailer entry fires (descendant-fold drift); the
    // leaf carries a cell dep. Both must round-trip.
    await assertParity("http://t/cw", tree, "cell-wrapper")
    await assertParity("http://t/cw", tree, "cell-leaf")
  })
})

// ─── Axis: matchKey across two ids ──────────────────────────────────

const MatchSpec = parton(
  function MatchSpecRender(_: RenderArgs) {
    return <span data-testid="match-spec" />
  },
  { selector: "#match-spec", match: "/m/:id" },
)

describe("parity — matchKey", () => {
  it("holds across two distinct match ids", async () => {
    const tree = (
      <PartialRoot>
        <MatchSpec />
      </PartialRoot>
    )
    await assertParity("http://t/m/alpha", tree, "match-spec")
    await assertParity("http://t/m/beta", tree, "match-spec")
  })
})

// ─── Axis: tracked search-param dep ─────────────────────────────────

const SearchTracked = parton(
  function SearchTrackedRender(_: RenderArgs) {
    return <span data-testid="search-tracked">{searchParam("q") ?? "—"}</span>
  },
  { selector: "#search-tracked" },
)

describe("parity — tracked search dep", () => {
  it("holds across query changes", async () => {
    const tree = (
      <PartialRoot>
        <SearchTracked />
      </PartialRoot>
    )
    await assertParity("http://t/s?q=A", tree, "search-tracked")
    await assertParity("http://t/s?q=B", tree, "search-tracked")
  })
})

// ─── Axis: tracked match() hook dep ─────────────────────────────────

const MatchHook = parton(
  function MatchHookRender(_: RenderArgs) {
    const m = match("/p/:slug")
    return <span data-testid="match-hook">{m?.slug ?? "—"}</span>
  },
  { selector: "#match-hook" },
)

describe("parity — tracked match() hook", () => {
  it("holds across captured-segment changes", async () => {
    const tree = (
      <PartialRoot>
        <MatchHook />
      </PartialRoot>
    )
    await assertParity("http://t/p/one", tree, "match-hook")
    await assertParity("http://t/p/two", tree, "match-hook")
  })
})

// ─── Axis: descendant fold (wrapper over a tracked child) ───────────

const FoldChild = parton(
  function FoldChildRender(_: RenderArgs) {
    return <span data-testid="fold-child">{searchParam("q") ?? "—"}</span>
  },
  { selector: "#fold-child" },
)
const FoldWrapper = parton(
  function FoldWrapperRender(_: RenderArgs) {
    return (
      <div>
        <FoldChild />
      </div>
    )
  },
  { selector: "#fold-wrapper" },
)

describe("parity — descendant fold", () => {
  it("holds for a wrapper whose tracked descendant's dep moved", async () => {
    const tree = (
      <PartialRoot>
        <FoldWrapper />
      </PartialRoot>
    )
    await assertParity("http://t/w?q=A", tree, "fold-wrapper")
    await assertParity("http://t/w?q=B", tree, "fold-wrapper")
  })
})
