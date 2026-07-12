/**
 * The convergence fuzzer's fixture app — a small purpose-built parton
 * surface (match-gated variants, cell readers, cullable pairs, a
 * nested cullable wrapper) plus the harness wiring (`FuzzFixture`)
 * and the isolation reset shared by the CI test and long local runs.
 * See `fuzz-convergence.rsc.test.tsx` and
 * `docs/notes/convergence-fuzzing.md`.
 */

import type { ReactNode } from "react"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"
import type { FuzzFixture } from "../../test/fuzz-harness.ts"
import { localCell } from "../cell.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

// ─── Cells ───────────────────────────────────────────────────────────

const fzTick = localCell({ id: "fz-tick", shape: "number", initial: 0 })
const fzCellA = localCell({ id: "fz-a", shape: "number", initial: 0 })
const fzCellB = localCell({ id: "fz-b", shape: "number", initial: 0 })

// ─── Fixture partons ─────────────────────────────────────────────────
//
// Bodies are pure functions of tracked reads (searchParams, cells) —
// no render counters in emitted content, so a cold render at the same
// request state reproduces every stamp byte-for-byte. Stamps are
// `[S|<id>|<state>]`, the content-level oracle currency.

const Sentinel = parton(
  async function FzSentinelRender(_: RenderArgs) {
    const t = await fzTick.resolve()
    return <div>{`[S|fz-sentinel|t=${t.value}]`}</div>
  },
  { selector: "fz-sentinel" },
)

// Always-on, both request axes: a searchParam + a cell.
const Shared = parton(
  async function FzSharedRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""
    const a = await fzCellA.resolve()
    return <div>{`[S|fz-shared|q=${q}.a=${a.value}]`}</div>
  },
  { selector: "fz-shared" },
)

// Match-gated variants — park/restore across navigations.
const Alpha = parton(
  async function FzAlphaRender(_: RenderArgs) {
    const a = await fzCellA.resolve()
    return <div>{`[S|fz-alpha|a=${a.value}]`}</div>
  },
  { match: "/alpha", selector: "fz-alpha" },
)

const Beta = parton(
  function FzBetaRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""
    return <div>{`[S|fz-beta|q=${q}]`}</div>
  },
  { match: "/beta", selector: "fz-beta" },
)

// Value-conditional existence: only exists while ?q= is present.
const Gated = parton(
  function FzGatedRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""
    return <div>{`[S|fz-gated|q=${q}]`}</div>
  },
  { match: { searchParams: { q: (v) => v !== null } }, selector: "fz-gated" },
)

// Cullable pair — cell reader.
const CullA = parton(
  async function FzCullARender(_: RenderArgs) {
    const b = await fzCellB.resolve()
    return <div>{`[S|fz-cull-a|b=${b.value}]`}</div>
  },
  { selector: "fz-cull-a", cull: { skeleton: SkelBox } },
)

// Cullable pair — searchParam reader.
const CullB = parton(
  function FzCullBRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""
    return <div>{`[S|fz-cull-b|q=${q}]`}</div>
  },
  { selector: "fz-cull-b", cull: { skeleton: SkelBox } },
)

// Nested wrapper: a CULLABLE wrapper parton carrying an addressable
// child — descendant-fold coverage (the wrapper's client fp may drift
// after lane-only child updates: over-fetch, never stale) plus
// ancestor-park cascading (a culled wrapper hides the child).
const Inner = parton(
  async function FzInnerRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""
    const b = await fzCellB.resolve()
    return <div>{`[S|fz-inner|q=${q}.b=${b.value}]`}</div>
  },
  { selector: "fz-inner" },
)

const Wrap = parton(
  async function FzWrapRender(_: RenderArgs) {
    const a = await fzCellA.resolve()
    return (
      <div>
        {`[S|fz-wrap|a=${a.value}]`}
        <Inner />
      </div>
    )
  },
  { selector: "fz-wrap", cull: { skeleton: SkelBox } },
)

function FuzzPage(): ReactNode {
  return (
    <PartialRoot>
      <Sentinel />
      <Shared />
      <Alpha />
      <Beta />
      <Gated />
      <CullA />
      <CullB />
      <Wrap />
    </PartialRoot>
  )
}

// ─── The fixture wiring ──────────────────────────────────────────────

async function writeCell(
  cell: { set: (v: number) => Promise<void> },
  scope: string,
  url: string,
  value: number,
): Promise<void> {
  const request = new Request(`http://localhost${url}`, { headers: { "x-test-scope": scope } })
  await runWithRequestAsync(request, async () => {
    await cell.set(value)
  })
}

export const fixture: FuzzFixture = {
  page: FuzzPage,
  universeIds: [
    "fz-sentinel",
    "fz-shared",
    "fz-alpha",
    "fz-beta",
    "fz-gated",
    "fz-cull-a",
    "fz-cull-b",
    "fz-wrap",
    "fz-inner",
  ],
  cullableIds: ["fz-cull-a", "fz-cull-b", "fz-wrap"],
  initialVisible: ["fz-cull-a", "fz-cull-b", "fz-wrap"],
  parentOf: { "fz-inner": "fz-wrap" },
  foldDriftAllowed: new Set(["fz-wrap"]),
  sentinelId: "fz-sentinel",
  bumpSentinel: (scope, url, tick) => writeCell(fzTick, scope, url, tick),
  sentinelStampFor: (tick) => `t=${tick}`,
  urls: ["/alpha?q=x", "/alpha", "/beta?q=y", "/beta", "/alpha?q=y"],
  refetchLabels: ["fz-shared", "fz-inner", "fz-cull-a"],
  writes: [
    { name: "cellA", apply: (scope, url, v) => writeCell(fzCellA, scope, url, v) },
    { name: "cellB", apply: (scope, url, v) => writeCell(fzCellB, scope, url, v) },
  ],
}

export function isolate(): void {
  clearRegistry("all")
  _clearInvalidationRegistry()
  _resetCellStorage()
  setCellStorage(new MemoryCellStorage())
}
