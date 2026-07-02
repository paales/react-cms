/**
 * Parameterized dashboard fixture for the server warm-tick benchmark.
 *
 * `buildDashboardPage({ partons, liveCells, depth })` constructs a page
 * of `partons` addressable leaf partons, `liveCells` of which read a
 * DISTINCT inline `localCell` (so bumping cell i shifts only leaf i's
 * fingerprint), nested `depth` levels deep under wrapper partons. The
 * wrappers carry a `selector` so they're addressable and fp-skippable, and
 * the descendant-fold re-instantiates a wrapper subtree only when one of
 * its descendants' invalidation timestamps moves.
 *
 * Each leaf's Render is intentionally trivial — a span with the cell
 * value — so a warm tick measures framework overhead (fingerprint folds,
 * fp-skip placeholder emission, Flight encode), not user work.
 *
 * A module-level render counter (`getRenderCount` / `resetRenderCount`)
 * lets the runner prove the correctness gate: a steady-state warm tick
 * increments it by a small constant (≈ 1 + depth), never by N.
 */

import { localCell, type LocalCell } from "@parton/framework/lib/cell.ts"
import { PartialRoot, parton, type RenderArgs } from "@parton/framework/lib/partial.tsx"
import { buildCellSelector } from "@parton/framework/runtime/invalidation-registry.ts"
import type { ReactNode } from "react"

// ─── Render accounting ────────────────────────────────────────────────

let renderCount = 0

/** Total Render-function invocations since the last reset. The runner
 *  reads this around a single warm tick to prove only the bumped subtree
 *  (+ its ancestors) re-ran. */
export function getRenderCount(): number {
  return renderCount
}

export function resetRenderCount(): void {
  renderCount = 0
}

// ─── Fixture parameters ───────────────────────────────────────────────

export interface DashboardParams {
  /** Total leaf partons placed on the page. */
  partons: number
  /** How many leaves are "live" (read a distinct cell). The rest are
   *  static. Clamped to `partons`. */
  liveCells: number
  /** Wrapper nesting depth around the leaves. `0` places leaves directly
   *  under PartialRoot; `D` wraps them under D addressable wrappers. */
  depth: number
  /** Live leaves read partitions `{part: i}` of ONE shared module cell
   *  instead of a distinct inline cell each — the website world-pulse
   *  shape (`world.pulse` partitioned per chunk coordinate), where every
   *  leaf's fold queries the SAME selector name in the invalidation
   *  registry. Exercises registry query cost under sustained ticker
   *  bumps against one name. */
  sharedPulseCell?: boolean
}

export interface DashboardFixture {
  /** The full page element, ready to render under a request scope. */
  Page: () => ReactNode
  /** Partition-scoped selectors for each live leaf's cell — the exact
   *  string a cell write fires. Bump index i to shift only leaf i. */
  liveSelectors: string[]
  /** Resolved parameters (live clamped to partons). */
  params: Required<DashboardParams>
}

// ─── Leaf + wrapper construction ──────────────────────────────────────

/** A live leaf reads a distinct inline cell, folding `cell:<id>/value`
 *  into its fp. The cell id is `<partonId>/value`; partonId derives from
 *  the leaf's first selector label (`leaf-<i>`). */
function makeLiveLeaf(i: number) {
  return parton(
    async function LiveLeafRender(_: RenderArgs) {
      renderCount++
      const v = await localCell("value", { shape: "number", initial: 0 })
      return <span data-leaf={i}>{String(v.value)}</span>
    },
    { selector: `#leaf-${i}` },
  )
}

/** The shared-cell id every pulse leaf partitions — one selector name
 *  (`cell:bench.pulse`) carrying every partition's bumps, exactly like
 *  the website's `world.pulse`. */
const PULSE_CELL_ID = "bench.pulse"

/** A pulse leaf reads partition `{part: i}` of the ONE shared cell —
 *  mirrors the website's chunk pulse (`chunkPulse.resolve({cx, cy})`).
 *  Its fp dep is `cell:bench.pulse?part=<i>`: partition-scoped, so a
 *  bump for partition i re-renders only leaf i, but every leaf's fold
 *  queries the same `cell:bench.pulse` name in the registry. */
function makePulseLeaf(i: number, pulse: LocalCell<number>) {
  return parton(
    async function PulseLeafRender(_: RenderArgs) {
      renderCount++
      const v = await pulse.resolve({ part: i })
      return <span data-leaf={i}>{String(v.value)}</span>
    },
    { selector: `#leaf-${i}` },
  )
}

/** A static leaf has no cell — its fp never moves, so it fp-skips every
 *  warm tick. Still addressable (selector) so it participates in the
 *  fp-skip placeholder path exactly like a live leaf that didn't change. */
function makeStaticLeaf(i: number) {
  return parton(
    function StaticLeafRender(_: RenderArgs) {
      renderCount++
      return <span data-leaf={i}>static-{i}</span>
    },
    { selector: `#leaf-${i}` },
  )
}

/** A wrapper parton — addressable (so fp-skippable) and counted. Its
 *  the own-surface is constant: the descendant-fold is what carries
 *  a descendant's invalidation into the wrapper's fp, so a changed leaf
 *  re-instantiates its wrapper chain while unchanged siblings stay
 *  parked. */
function makeWrapper(level: number) {
  return parton(
    function WrapperRender({ children }: RenderArgs) {
      renderCount++
      return <div data-wrapper={level}>{children}</div>
    },
    { selector: `#wrap-${level}` },
  )
}

/** Nest `inner` under `depth` distinct wrapper partons. Each wrapper id
 *  is unique per level so they're distinct catalog entries. */
function nest(inner: ReactNode, depth: number): ReactNode {
  let node = inner
  for (let level = depth - 1; level >= 0; level--) {
    const Wrapper = makeWrapper(level)
    node = <Wrapper>{node}</Wrapper>
  }
  return node
}

// ─── Page builder ─────────────────────────────────────────────────────

export function buildDashboardPage(params: DashboardParams): DashboardFixture {
  const partons = Math.max(0, params.partons)
  const liveCells = Math.min(Math.max(0, params.liveCells), partons)
  const depth = Math.max(0, params.depth)
  const sharedPulseCell = params.sharedPulseCell ?? false

  // The shared cell all pulse leaves partition. Constructed per fixture
  // build (after the runner's resetWorld) so scenario runs don't collide
  // in the cell registry.
  const pulse = sharedPulseCell
    ? localCell({ id: PULSE_CELL_ID, shape: "number", initial: 0 })
    : null

  const liveSelectors: string[] = []
  const leaves: ReactNode[] = []
  for (let i = 0; i < partons; i++) {
    if (i < liveCells) {
      if (pulse) {
        const Leaf = makePulseLeaf(i, pulse)
        leaves.push(<Leaf key={i} />)
        // The exact selector a `pulse.set(v, {partition: {part: i}})` fires.
        liveSelectors.push(buildCellSelector(PULSE_CELL_ID, { part: i }))
      } else {
        const Leaf = makeLiveLeaf(i)
        leaves.push(<Leaf key={i} />)
        // Inline cell id is `<partonId>/value`; single-slot partition `{}`.
        liveSelectors.push(buildCellSelector(`leaf-${i}/value`, {}))
      }
    } else {
      const Leaf = makeStaticLeaf(i)
      leaves.push(<Leaf key={i} />)
    }
  }

  const body = nest(<>{leaves}</>, depth)
  const Page = () => <PartialRoot>{body}</PartialRoot>

  return {
    Page,
    liveSelectors,
    params: { partons, liveCells, depth, sharedPulseCell },
  }
}
