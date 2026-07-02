/**
 * Server warm-tick benchmark runner.
 *
 * Replicates the production live loop's INNER cycle without the
 * wake/keepalive timing. The production driver
 * (`driveSegmentedResponse` in segmented-response.ts) holds ONE request
 * scope open and calls `renderSegment()` repeatedly, promoting each
 * segment's snapshots into the cached-override carrier between renders so
 * unchanged partons fp-skip. We do exactly that, but drive the loop K
 * times back-to-back and time each render — measuring the per-tick server
 * CPU cost of "recalculate the world" when only one cell changed.
 *
 * The faithful warm tick (matching the driver's inner loop):
 *   1. Open ONE request scope via `runWithRequestAsync`.
 *   2. Render segment 0 (cold — every parton renders). Drain fully.
 *   3. `promoteSnapshotsToCachedOverride()`.
 *   4. Warm-tick loop: bump exactly one live cell's partition, render,
 *      DRAIN (so the lazy Flight render actually completes), record
 *      elapsed + bytes, promote.
 *
 * Draining is load-bearing: the vendored Flight server renders lazily —
 * `renderToReadableStream` returns immediately and queues every server
 * component onto microtasks that only run as the stream is pulled. Timing
 * a render without draining would time the queueing call, not the render.
 */

import { _clearCellRegistry } from "@parton/framework/lib/cell.ts"
import { _clearRouteKeyCache } from "@parton/framework/lib/partial.tsx"
import { clearRegistry } from "@parton/framework/lib/partial-registry.ts"
import { promoteSnapshotsToCachedOverride } from "@parton/framework/lib/segmented-response.ts"
import {
  _resetCellStorage,
  MemoryCellStorage,
  setCellStorage,
} from "@parton/framework/runtime/cell-storage.ts"
import { runWithRequestAsync } from "@parton/framework/runtime/context.ts"
import {
  _clearInvalidationRegistry,
  refreshSelector,
} from "@parton/framework/runtime/invalidation-registry.ts"
import { renderServerToFlight } from "@parton/framework/test/rsc-server.ts"
import type { ReactNode } from "react"
import {
  buildDashboardPage,
  type DashboardParams,
  getRenderCount,
  resetRenderCount,
} from "./fixture.tsx"

// ─── Result types ─────────────────────────────────────────────────────

export interface GateResult {
  /** Renders during the cold segment 0 — equals N + wrappers. */
  coldRenders: number
  /** Bytes of the cold segment 0. */
  coldBytes: number
  /** Renders during a single STEADY-STATE warm tick — must be a small
   *  constant (≈ 1 + depth), NOT N. The headline correctness proof. */
  warmRenders: number
  /** Bytes of a steady-state warm tick. Reported for the wire-size
   *  observation; not part of the faithfulness gate. */
  warmBytes: number
  /** True iff the measurement is faithful: the warm tick re-rendered
   *  only the changed subtree(s) plus ancestors (≈ `changed + depth`),
   *  far below N — proving we time warm ticks, not cold renders. */
  faithful: boolean
}

export interface ScenarioResult {
  name: string
  params: Required<DashboardParams>
  /** Cold segment-0 wall time, milliseconds. */
  coldMs: number
  coldBytes: number
  gate: GateResult
  /** Measured warm ticks (after warmup discard). */
  measuredTicks: number
  /** Warm-tick latency percentiles, microseconds. */
  warm: {
    p50us: number
    p95us: number
    p99us: number
    meanUs: number
    minUs: number
    maxUs: number
  }
  /** Mean emitted bytes per warm tick. */
  warmBytesMean: number
  /** Throughput: warm ticks per second (from mean latency). */
  ticksPerSec: number
}

export interface RunOptions {
  /** Ticks discarded before measurement (cold→warm transition needs
   *  ≥2; default generous). */
  warmup?: number
  /** Measured ticks after warmup. */
  measure?: number
  /** How many live cells each tick bumps. `"single"` round-robins one
   *  cell per tick (the scaling/depth case: cost of one change against a
   *  world of size N). `"all"` bumps EVERY live cell each tick (the
   *  dashboard amortization case: one segment carrying M changes, so the
   *  fixed per-tick overhead is shared across M re-renders). */
  bumpMode?: "single" | "all"
  /** Historical `refreshSelector` bumps fired (round-robin across the
   *  live selectors) BEFORE the cold render — a server whose tickers
   *  have been running long before this request lands. The website's
   *  world pulse produces ~100–5000 bumps/s across up to 512 partitions
   *  of one selector name; the registry must answer fold queries at the
   *  same cost regardless of how many bumps preceded the request. */
  soakBumps?: number
}

// ─── Harness ──────────────────────────────────────────────────────────

const URL_BASE = "http://bench/dashboard"

/** Reset all process-global framework state so scenarios don't leak into
 *  each other (registries, route-key cache, cell storage). */
function resetWorld(): void {
  setCellStorage(new MemoryCellStorage())
  clearRegistry("all")
  _clearInvalidationRegistry()
  _clearCellRegistry()
  _clearRouteKeyCache()
  resetRenderCount()
}

/** Render a node to Flight and DRAIN it fully (forcing the lazy render to
 *  complete), returning the emitted byte length. */
async function renderAndDrain(node: ReactNode): Promise<number> {
  const bytes = await new Response(renderServerToFlight(node)).arrayBuffer()
  return bytes.byteLength
}

/** Yield a full macrotask so the host's event loop (timers, worker RPC)
 *  gets a turn between batches of ticks. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx]
}

/**
 * Run one scenario end to end. Builds the fixture, opens ONE request
 * scope, renders the cold segment, captures the correctness gate on the
 * first steady-state tick, then runs warmup + measured warm ticks
 * round-robining a different live cell each tick.
 */
export async function runScenario(
  name: string,
  params: DashboardParams,
  options: RunOptions = {},
): Promise<ScenarioResult> {
  const warmup = options.warmup ?? 50
  const measure = options.measure ?? 500
  const bumpMode = options.bumpMode ?? "single"
  resetWorld()

  const fixture = buildDashboardPage(params)
  const { Page, liveSelectors } = fixture
  if (liveSelectors.length === 0) {
    throw new Error(`scenario "${name}": needs at least 1 live cell to bump`)
  }

  // Pre-request ticker history: the registry state a long-up server has
  // accumulated before this request's first render.
  const soakBumps = options.soakBumps ?? 0
  for (let i = 0; i < soakBumps; i++) {
    refreshSelector(liveSelectors[i % liveSelectors.length])
  }

  // Bump the live cell(s) this tick. `"single"` round-robins one cell;
  // `"all"` fires every live selector so one segment carries M changes.
  let cursor = 0
  const bump = (): void => {
    if (bumpMode === "all") {
      for (const sel of liveSelectors) refreshSelector(sel)
    } else {
      refreshSelector(liveSelectors[cursor % liveSelectors.length])
      cursor++
    }
  }

  const durationsUs: number[] = []
  const byteSamples: number[] = []
  let coldMs = 0
  let coldBytes = 0
  let gate: GateResult | null = null

  await runWithRequestAsync(new Request(URL_BASE), async () => {
    // ── Segment 0: cold render (every parton runs). ──
    resetRenderCount()
    const c0 = performance.now()
    coldBytes = await renderAndDrain(<Page />)
    coldMs = performance.now() - c0
    const coldRenders = getRenderCount()
    promoteSnapshotsToCachedOverride()

    // The very first warm tick still re-renders everything (cold→warm fp
    // drift: a leaf's cell dep is only recorded DURING its render, so the
    // warm fp differs from the cold fp until one warm pass folds it in).
    // From the second warm tick the fp-skip steady state holds. Run one
    // settling tick before capturing the gate.
    const settleTick = async () => {
      bump()
      await renderAndDrain(<Page />)
      promoteSnapshotsToCachedOverride()
    }
    await settleTick()

    // ── Correctness gate: a single steady-state warm tick. ──
    resetRenderCount()
    bump()
    const warmBytes = await renderAndDrain(<Page />)
    const warmRenders = getRenderCount()
    promoteSnapshotsToCachedOverride()
    // Expected steady-state re-renders: the `changed` leaves plus the
    // shared wrapper ancestor chain (depth wrappers, re-instantiated once
    // because all leaves share them and any descendant's fold moves the
    // chain). `single` changes one leaf → `1 + depth`; `all` changes M
    // leaves → `M + depth`. The M=N "all" case legitimately re-renders
    // every leaf — that's the amortization extreme, not an unfaithful
    // measurement, so the gate bounds on `changed + depth` (+ slack), not
    // on `< N`.
    const changed = bumpMode === "all" ? liveSelectors.length : 1
    const expectedWarm = changed + params.depth
    gate = {
      coldRenders,
      coldBytes,
      warmRenders,
      warmBytes,
      // Faithful when the warm tick re-rendered ≈ the changed subtrees
      // (+ ancestors), far below N. THIS is the proof we're timing warm
      // ticks (one changed subtree) and not cold renders (all N).
      //
      // Byte size is reported but does NOT gate: under the in-process
      // dev Flight runtime the wire carries debug metadata (component
      // source, server stacks) that inflates both cold and warm and can
      // make the warm placeholder wire comparable to or larger than the
      // cold body at large N. That's a real observation about the
      // fp-skip wire, not a measurement fault — see bench/README.md.
      faithful: warmRenders <= expectedWarm + params.depth,
    }

    // ── Warmup: discard the cold→warm settling region entirely. ──
    for (let t = 0; t < warmup; t++) await settleTick()

    // ── Measured warm ticks. ──
    for (let t = 0; t < measure; t++) {
      bump()
      const t0 = performance.now()
      const bytes = await renderAndDrain(<Page />)
      const t1 = performance.now()
      durationsUs.push((t1 - t0) * 1000)
      byteSamples.push(bytes)
      promoteSnapshotsToCachedOverride()
      // Yield to the macrotask queue periodically — OUTSIDE the timed
      // region — so the long render loop doesn't starve vitest's worker
      // RPC heartbeat (`onTaskUpdate`), which otherwise times out and
      // flips the process exit code despite the test passing. The yield
      // lands after the measurement is recorded, so it never pollutes a
      // tick's timing.
      if ((t & 0x1f) === 0x1f) await yieldEventLoop()
    }
  })

  _resetCellStorage()

  if (!gate) throw new Error(`scenario "${name}": gate not captured`)

  const sorted = [...durationsUs].sort((a, b) => a - b)
  const mean = durationsUs.reduce((s, x) => s + x, 0) / durationsUs.length
  const bytesMean = byteSamples.reduce((s, x) => s + x, 0) / byteSamples.length

  return {
    name,
    params: fixture.params,
    coldMs,
    coldBytes,
    gate,
    measuredTicks: durationsUs.length,
    warm: {
      p50us: percentile(sorted, 50),
      p95us: percentile(sorted, 95),
      p99us: percentile(sorted, 99),
      meanUs: mean,
      minUs: sorted[0],
      maxUs: sorted[sorted.length - 1],
    },
    warmBytesMean: bytesMean,
    ticksPerSec: mean > 0 ? 1_000_000 / mean : 0,
  }
}

// ─── Scenario matrix ──────────────────────────────────────────────────

export interface ScenarioSpec {
  name: string
  params: DashboardParams
  options?: RunOptions
}

/** Scaling sweep (HEADLINE): warm-tick cost vs world size N, M=1, D=2.
 *  A curve that grows with N is the "proving-unchanged costs O(tree)" tax. */
export const SCALING_SWEEP: ScenarioSpec[] = [10, 50, 100, 500, 1000].map((n) => ({
  name: `scaling/N=${n}`,
  params: { partons: n, liveCells: 1, depth: 2 },
}))

/** Dashboard (amortized): N=200, change-density M rising. Each tick bumps
 *  ALL M live cells (`bumpMode: "all"`), so one segment carries M changes
 *  and the fixed per-tick overhead is amortized across them. */
export const DASHBOARD_SWEEP: ScenarioSpec[] = [1, 10, 50, 200].map((m) => ({
  name: `dashboard/M=${m}`,
  params: { partons: 200, liveCells: m, depth: 2 },
  options: { bumpMode: "all" },
}))

/** Depth sweep: N=100, M=1, varying wrapper depth. Isolates the
 *  descendant-fold cost of proving a deep subtree unchanged. */
export const DEPTH_SWEEP: ScenarioSpec[] = [1, 4, 16].map((d) => ({
  name: `depth/D=${d}`,
  params: { partons: 100, liveCells: 1, depth: d },
}))

/** Pulse soak (registry compaction): the website world-pulse shape —
 *  P live leaves reading partitions of ONE shared cell, so every leaf's
 *  fold queries the SAME selector name (`cell:bench.pulse`). Both rows
 *  start with every partition populated (soak ≥ P); they differ ONLY in
 *  how much ticker history preceded the request — one bump per
 *  partition vs ~39 (a few minutes of the website's 512 tickers at
 *  0.1–5s each). The pair is the invalidation-registry gate: warm
 *  ticks must cost the same in both rows — registry queries bounded by
 *  partition cardinality, never by how long the server has been
 *  ticking. */
export const PULSE_SWEEP: ScenarioSpec[] = [
  {
    name: "pulse/P=512",
    params: { partons: 512, liveCells: 512, depth: 2, sharedPulseCell: true },
    options: { soakBumps: 512 },
  },
  {
    name: "pulse/P=512+20k",
    params: { partons: 512, liveCells: 512, depth: 2, sharedPulseCell: true },
    options: { soakBumps: 20_000 },
  },
]

export const ALL_SCENARIOS: ScenarioSpec[] = [
  ...SCALING_SWEEP,
  ...DASHBOARD_SWEEP,
  ...DEPTH_SWEEP,
  ...PULSE_SWEEP,
]
