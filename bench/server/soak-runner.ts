/**
 * Held-connection soak runner — what does a HELD live connection cost?
 *
 * Opens N real live subscriptions in-process, each one the production
 * shape end to end: `runWithRequestAsync` opens the connection's
 * request scope, `driveSegmentedResponse` renders the initial
 * whole-tree segment, opens the connection session (`?__conn=`),
 * switches to per-parton lanes, and parks at its wake race. Each
 * connection serves its OWN page (id-prefixed partons) in its OWN
 * state bucket — a per-connection `x-test-scope`, the framework's
 * existing seam for isolating process-wide snapshot buckets (route
 * buckets key on `(scope, routeKey)`, and routeKey derives from match
 * signatures, which selector-only pages don't have). One cell bump is
 * therefore relevant to exactly one connection: the other N−1 wake,
 * run the relevance filter over their own snapshots, and re-arm
 * without rendering — the production N-independent-viewers shape. The
 * scope seam is dev-mode-only, so the category probes it up front and
 * hard-fails under `--prod` rather than silently measuring cross-talk.
 *
 * Kernel-side per-connection cost (sockets, TLS, HTTP framing) is a
 * known constant and deliberately OUT of scope — the client end here is
 * an in-process discarding reader. What's measured is the FRAMEWORK's
 * share: the request ALS scope, the connection session, the parked
 * driver's promise/timer graph, the route's snapshots + cached-override
 * maps, and the per-bump wake-filter scan.
 *
 * Phase structure per scenario (N connections, M of them active):
 *   1. Build N fixtures, gc, sample the heap/RSS baseline.
 *   2. Open all N connections sequentially; wait for each driver's own
 *      `lanes` marker (the wire signal that it switched to lanes — and,
 *      having yielded, is parked at its wake race). gc, sample again:
 *      the delta / N is the per-connection steady-state footprint.
 *   3. Idle-wake phase: fire irrelevant bumps one at a time. Every
 *      parked driver wakes, scans, re-arms; NOTHING may render — the
 *      zero-render gate — and the CPU delta / bumps is the cost of one
 *      irrelevant invalidation against N held connections.
 *   4. Wake ticks (M > 0): each tick bumps M distinct cells (one per
 *      active connection) in one synchronous batch, then waits for M
 *      `settled` markers — the driver's own "this wake's lanes fully
 *      drained" milestone. Wall time to the last marker and process-CPU
 *      per tick are the numbers; each tick's render delta must be
 *      exactly M.
 *   5. Teardown: cancel every client reader, bump every live selector
 *      in one batch — each driver wakes once, its lane render hits the
 *      canceled stream on enqueue, and the drive loop exits.
 *
 * The park/settle signals are the driver's own framing markers. The
 * driver enqueues each marker as ONE whole chunk and the in-process
 * stream preserves chunk boundaries, so whole-chunk byte equality
 * against the exact marker bytes is the producer's explicit milestone,
 * not a scan heuristic. Parked-ness on `lanes` is deterministic: the
 * driver runs synchronously from that enqueue to its first await (the
 * wake race), and the reader's continuation only runs after it yields.
 *
 * The production 20s keepalive is shorter than a large scenario's
 * open+measure span, so the runner widens it via the driver's
 * test-visible `_setKeepaliveMs` for the scenario's duration (restored
 * in a finally). The gate counts connections whose drive loop exited
 * before teardown — any early close fails the run.
 */

import {
  buildMarker,
  TAG_LANES_OPEN,
  TAG_SEGMENT_SETTLED,
} from "@parton/framework/lib/fp-trailer-marker.ts"
import { wrapStreamWithFpTrailer } from "@parton/framework/lib/fp-trailer.ts"
import {
  _setFirstAckDeadlineMs,
  _setKeepaliveMs,
  _setUnackedDeliveryWindow,
  driveSegmentedResponse,
} from "@parton/framework/lib/segmented-response.ts"
import { _resetCellStorage } from "@parton/framework/runtime/cell-storage.ts"
import {
  _captureCommitHandle,
  getScope,
  runWithRequestAsync,
} from "@parton/framework/runtime/context.ts"
import { refreshSelector } from "@parton/framework/runtime/invalidation-registry.ts"
import { renderServerToFlight } from "@parton/framework/test/rsc-server.ts"
import {
  buildDashboardPage,
  type DashboardFixture,
  getRenderCount,
  resetRenderCount,
} from "./fixture.tsx"
import { percentile, resetWorld, yieldEventLoop } from "./runner.tsx"

// ─── Result types ─────────────────────────────────────────────────────

export interface SoakParams {
  /** Held live connections (N): each a driven segmented response parked
   *  between wakes, with its connection session open. */
  connections: number
  /** Active connections (M): each measured tick bumps one distinct
   *  cell per active connection. 0 = pure idle soak (no ticks). */
  active: number
}

export interface SoakGateResult {
  /** Render bodies during the N cold opens — N × (partons + depth). */
  coldRenders: number
  /** Irrelevant bumps fired while all N sat parked. */
  idleBumps: number
  /** Renders during those bumps — MUST be 0: an idle held connection
   *  costs zero renders between wakes. The headline correctness proof. */
  idleRenders: number
  /** Renders in the single gate tick — must equal `active` exactly
   *  (each active connection lanes its one bumped leaf; nothing else,
   *  on no other connection, runs). */
  tickRenders: number
  expectedTickRenders: number
  /** Measured ticks whose render delta deviated from `active`. */
  tickRenderViolations: number
  /** Connections whose drive loop exited before teardown — a held
   *  connection must stay held for the scenario's whole span. */
  closedEarly: number
  faithful: boolean
}

export interface SoakScenarioResult {
  name: string
  params: SoakParams
  /** Wall time to open + park all N connections, milliseconds. */
  openMs: number
  gate: SoakGateResult
  heap: {
    /** Post-gc heapUsed with all fixtures built, no connections open. */
    baselineHeapBytes: number
    /** Post-gc heapUsed with all N connections parked. */
    heldHeapBytes: number
    /** (held − baseline) / N — the per-connection steady-state heap. */
    heapPerConnection: number
    baselineRssBytes: number
    heldRssBytes: number
    /** RSS is page-granular, includes allocator slack, and rarely
     *  shrinks — so it is process-CUMULATIVE: scenarios after the
     *  first in one worker reuse pages an earlier scenario retained
     *  and can report near-zero deltas. Read the worker's FIRST
     *  scenario as the honest RSS bound. */
    rssPerConnection: number
    /** Post-gc heapUsed after the idle bumps + measured ticks. Minus
     *  `heldHeapBytes`, per connection: what a connection accretes
     *  across the measured wake traffic. */
    afterTicksHeapBytes: number
    heapDriftPerConnection: number
    /** Wake rounds each parked connection saw between the two samples —
     *  every idle bump and every tick is one wake per connection. */
    wakesPerConnection: number
    /** heapDriftPerConnection / wakesPerConnection — what one wake
     *  round leaves behind on a parked connection. Non-zero today: each
     *  re-arm of the parked driver's wake race attaches fresh reactions
     *  to the connection's long-lived `laneDrained` / visibility-flip
     *  promises, which only release when those promises settle — so a
     *  parked connection's heap grows with bump traffic (production
     *  bounds it via the 20s keepalive; the soak widens the keepalive,
     *  which is what makes the accumulation measurable). */
    heapDriftPerConnectionPerWake: number
  }
  /** The idle keepalive path: one irrelevant `refreshSelector` wakes
   *  every parked driver's bump arm; each runs the relevance filter
   *  over its route's snapshots and re-arms (fresh wake promises +
   *  keepalive timer) without rendering or shipping a byte. */
  idleWake: {
    bumps: number
    /** Process CPU (user+system) per bump — the cost of ONE irrelevant
     *  invalidation against N held connections. */
    cpuUsPerBump: number
    /** ÷ N — per held connection, per irrelevant bump. */
    cpuNsPerConnectionPerBump: number
  }
  /** Wake-tick numbers (null when M = 0). One tick = M cell bumps in a
   *  synchronous batch → M lane renders across M connections. */
  ticks: {
    measured: number
    lanesPerTick: number
    /** Wall time from firing the bumps to the LAST connection's
     *  `settled` marker — the client-observable wake latency. */
    wall: { p50us: number; p95us: number; p99us: number; meanUs: number }
    /** Process CPU per tick, including the N−M idle wake-filter scans
     *  and the post-drain driver bookkeeping. */
    cpuMeanUs: number
    /** cpuMeanUs / M — amortized CPU per delivered lane. */
    cpuPerLaneUs: number
    /** Mean bytes shipped per tick across all M lanes. */
    bytesMeanPerTick: number
  } | null
}

export interface SoakOptions {
  /** Ticks discarded before measurement (M > 0 only). */
  warmup?: number
  /** Measured ticks (M > 0), and the idle-phase bump count. */
  measure?: number
}

// ─── Fixture shape ────────────────────────────────────────────────────

/** Per-connection page: 1 live leaf + 1 static leaf under 1 wrapper —
 *  the smallest page that still exercises the untouched-sibling and
 *  untouched-ancestor paths. 3 snapshots per connection. */
const PAGE_PARTONS = 2
const PAGE_DEPTH = 1
const PAGE_RENDERS = PAGE_PARTONS + PAGE_DEPTH

/** Keepalive override while a soak scenario runs (see module doc). */
const SOAK_KEEPALIVE_MS = 10 * 60_000

/** A selector no route renders — the irrelevant-bump probe. */
const NOISE_SELECTOR = "soak-noise"

const URL_BASE = "http://bench/soak"

// ─── Wire markers (the driver's own milestones) ───────────────────────

const SETTLED_MARKER = buildMarker(TAG_SEGMENT_SETTLED, 0)
const LANES_OPEN_MARKER = buildMarker(TAG_LANES_OPEN, 0)

function chunkEquals(chunk: Uint8Array, marker: Uint8Array): boolean {
  if (chunk.byteLength !== marker.byteLength) return false
  for (let i = 0; i < marker.byteLength; i++) {
    if (chunk[i] !== marker[i]) return false
  }
  return true
}

// ─── Connection plumbing ──────────────────────────────────────────────

/** Shared wire accounting across all of a scenario's connections. The
 *  settle barrier is how ticks complete: `settlesReach(target)` resolves
 *  when the total `settled`-marker count reaches `target`. */
interface WireCounters {
  bytes: number
  settles: number
  barrier: { target: number; resolve: () => void } | null
}

function onSettled(counters: WireCounters): void {
  counters.settles++
  if (counters.barrier && counters.settles >= counters.barrier.target) {
    const b = counters.barrier
    counters.barrier = null
    b.resolve()
  }
}

function settlesReach(counters: WireCounters, target: number): Promise<void> {
  if (counters.settles >= target) return Promise.resolve()
  return new Promise((resolve) => {
    counters.barrier = { target, resolve }
  })
}

interface SoakConnection {
  /** The partition-scoped selector whose bump wakes this connection's
   *  one live leaf — the exact string a cell write fires. */
  liveSelector: string
  /** Resolves when the driver emitted its `lanes` marker — switched to
   *  per-parton lanes and parked at its wake race. */
  parked: Promise<void>
  /** The drive loop + request scope, and the discarding reader. */
  done: Promise<void>
  /** Set when `done` resolves — read at teardown to count early
   *  closes without awaiting. */
  finished: boolean
  cancelReader: () => Promise<void>
}

function openConnection(
  key: string,
  fixture: DashboardFixture,
  counters: WireCounters,
): SoakConnection {
  const request = new Request(`${URL_BASE}/${key}?live=1&__conn=soak-${key}`, {
    headers: { "x-test-scope": `soak-${key}` },
  })
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const reader = response.getReader()

  let parkedResolve!: () => void
  const parked = new Promise<void>((resolve) => {
    parkedResolve = resolve
  })

  // Discarding client: counts bytes, spots the driver's markers, keeps
  // nothing — buffered chunks in an unread stream would pollute the
  // heap measurement.
  const drain = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      counters.bytes += value.byteLength
      if (chunkEquals(value, LANES_OPEN_MARKER)) parkedResolve()
      else if (chunkEquals(value, SETTLED_MARKER)) onSettled(counters)
    }
  })()

  const drive = runWithRequestAsync(request, async () => {
    const renderOnce = () =>
      wrapStreamWithFpTrailer(renderServerToFlight(fixture.Page()), _captureCommitHandle())
    await driveSegmentedResponse(controller, renderOnce)
    try {
      controller.close()
    } catch {}
  })

  const conn: SoakConnection = {
    liveSelector: fixture.liveSelectors[0],
    parked,
    done: Promise.all([drive, drain]).then(() => {
      conn.finished = true
    }),
    finished: false,
    cancelReader: () => reader.cancel(),
  }
  return conn
}

// ─── Measurement helpers ──────────────────────────────────────────────

/** Post-gc memory sample. Two gc passes with an event-loop turn between
 *  them so finalizable garbage from the first pass is collectable by
 *  the second. Hard-fails without `--expose-gc` — an un-gc'd heap
 *  number is noise, worse than none. */
async function sampleMemory(): Promise<{ heapUsed: number; rss: number }> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc !== "function") {
    throw new Error(
      "soak: global.gc is unavailable — the bench worker must run with " +
        "--expose-gc (the bench:server CLI passes it via NODE_OPTIONS)",
    )
  }
  gc()
  await yieldEventLoop()
  gc()
  const usage = process.memoryUsage()
  return { heapUsed: usage.heapUsed, rss: usage.rss }
}

function cpuNowUs(): number {
  const u = process.cpuUsage()
  return u.user + u.system
}

// ─── Scenario ─────────────────────────────────────────────────────────

export async function runSoakScenario(
  name: string,
  params: SoakParams,
  options: SoakOptions = {},
): Promise<SoakScenarioResult> {
  const warmup = options.warmup ?? 5
  const measure = options.measure ?? 30
  const n = params.connections
  const m = Math.min(params.active, n)
  resetWorld()
  _setKeepaliveMs(SOAK_KEEPALIVE_MS)
  // The in-process discarding reader never acks deliveries. Without
  // these overrides the never-acked degrade would close every active
  // connection FIRST_ACK_DEADLINE after its first tick lane, and the
  // unacked delivery window would coalesce lanes past its cap —
  // shrinking the held set / the per-tick render count under the
  // measurement. The soak prices held connections, not the degrade
  // policy; both restore in the finally.
  _setFirstAckDeadlineMs(SOAK_KEEPALIVE_MS)
  _setUnackedDeliveryWindow(Number.MAX_SAFE_INTEGER)

  const counters: WireCounters = { bytes: 0, settles: 0, barrier: null }
  const conns: SoakConnection[] = []

  try {
    // Per-connection isolation rides the dev-mode `x-test-scope` seam.
    // Probe it before spending anything: if the header doesn't
    // round-trip (the prod build compiles the seam out), every
    // connection would share one snapshot bucket and every bump would
    // lane on every connection — a wrong measurement, so stop here.
    const probe = await runWithRequestAsync(
      new Request(`${URL_BASE}/scope-probe`, { headers: { "x-test-scope": "soak-probe" } }),
      async () => getScope(),
    )
    if (probe.result !== "soak-probe") {
      throw new Error(
        `soak "${name}": per-connection scopes need the dev-mode x-test-scope seam ` +
          "(unavailable under --prod) — run the soak category against the dev Flight build",
      )
    }

    // One throwaway connection before the baseline sample: the first
    // connection a process opens pays one-time lazy initialization
    // (Flight encoder state, module singletons, JIT feedback retained
    // by long-lived closures) that would otherwise be attributed to
    // the N held connections.
    {
      const warmFixture = buildDashboardPage({
        partons: PAGE_PARTONS,
        liveCells: 1,
        depth: PAGE_DEPTH,
        idPrefix: "w-",
      })
      const warm = openConnection("warm", warmFixture, counters)
      await warm.parked
      await warm.cancelReader()
      refreshSelector(warm.liveSelector)
      await warm.done
    }

    // ── Phase 1: fixtures, then the pre-connection baseline. ──
    // One page per connection with disjoint ids/selectors — the spec
    // and cell definitions are the "N routes exist" cost, not the
    // "N connections are held" cost, so they land BEFORE the baseline.
    const fixtures: DashboardFixture[] = []
    for (let i = 0; i < n; i++) {
      fixtures.push(
        buildDashboardPage({
          partons: PAGE_PARTONS,
          liveCells: 1,
          depth: PAGE_DEPTH,
          idPrefix: `c${i}-`,
        }),
      )
    }
    const baseline = await sampleMemory()

    // ── Phase 2: open + park all N. ──
    resetRenderCount()
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      const conn = openConnection(`c${i}`, fixtures[i], counters)
      conns.push(conn)
      await conn.parked
    }
    const openMs = performance.now() - t0
    const coldRenders = getRenderCount()
    if (coldRenders !== n * PAGE_RENDERS) {
      throw new Error(
        `soak "${name}": cold opens rendered ${coldRenders}, expected ${n * PAGE_RENDERS}`,
      )
    }
    const held = await sampleMemory()

    // ── Phase 3: idle keepalive path + the zero-render gate. ──
    // One bump per iteration, with a macrotask turn between them so
    // each bump is a distinct wake round (synchronous bumps coalesce
    // into one). The turn also guarantees every driver's scan-and-re-arm
    // continuation has run before the next sample — event-loop ordering,
    // not a timing guess.
    resetRenderCount()
    const idleBumps = Math.max(1, measure)
    const idleCpu0 = cpuNowUs()
    for (let k = 0; k < idleBumps; k++) {
      refreshSelector(NOISE_SELECTOR)
      await yieldEventLoop()
    }
    const idleCpuUs = cpuNowUs() - idleCpu0
    const idleRenders = getRenderCount()

    // ── Phase 4: wake ticks (M > 0). ──
    // Each tick fires M bumps synchronously (one wake round for every
    // driver: the M active ones lane their leaf, the N−M idle ones scan
    // and re-arm) and completes at the Mth `settled` marker.
    const activeSelectors = conns.slice(0, m).map((c) => c.liveSelector)
    const tick = async (): Promise<void> => {
      const target = counters.settles + activeSelectors.length
      for (const sel of activeSelectors) refreshSelector(sel)
      await settlesReach(counters, target)
    }

    let gateTickRenders = 0
    let tickRenderViolations = 0
    const wallUs: number[] = []
    const cpuUsPerTick: number[] = []
    const bytesPerTick: number[] = []

    if (m > 0) {
      // Gate tick: the render delta must be exactly M — the M bumped
      // leaves lane, and NOTHING else (no sibling, no wrapper, no other
      // connection) runs. The event-loop turn lets the drivers' post-
      // drain bookkeeping (lane-drained wake, re-park) finish before
      // the count is read.
      resetRenderCount()
      await tick()
      await yieldEventLoop()
      gateTickRenders = getRenderCount()

      for (let t = 0; t < warmup; t++) {
        await tick()
        await yieldEventLoop()
      }

      for (let t = 0; t < measure; t++) {
        resetRenderCount()
        const bytes0 = counters.bytes
        const cpu0 = cpuNowUs()
        const w0 = performance.now()
        await tick()
        const w1 = performance.now()
        await yieldEventLoop()
        const cpu1 = cpuNowUs()
        wallUs.push((w1 - w0) * 1000)
        cpuUsPerTick.push(cpu1 - cpu0)
        bytesPerTick.push(counters.bytes - bytes0)
        if (getRenderCount() !== m) tickRenderViolations++
      }
    }

    const afterTicks = await sampleMemory()
    // Every idle bump and every tick woke every parked connection once
    // (a tick's M bumps fire in one synchronous batch, so they coalesce
    // into a single wake round).
    const wakesPerConnection = idleBumps + (m > 0 ? 1 + warmup + measure : 0)

    // ── Phase 5: teardown accounting (the closes happen in finally). ──
    const closedEarly = conns.filter((c) => c.finished).length

    const gate: SoakGateResult = {
      coldRenders,
      idleBumps,
      idleRenders,
      tickRenders: gateTickRenders,
      expectedTickRenders: m,
      tickRenderViolations,
      closedEarly,
      faithful:
        idleRenders === 0 &&
        gateTickRenders === m &&
        tickRenderViolations === 0 &&
        closedEarly === 0,
    }

    const sortedWall = [...wallUs].sort((a, b) => a - b)
    const wallMean =
      wallUs.length > 0 ? wallUs.reduce((s, x) => s + x, 0) / wallUs.length : 0
    const cpuMean =
      cpuUsPerTick.length > 0
        ? cpuUsPerTick.reduce((s, x) => s + x, 0) / cpuUsPerTick.length
        : 0
    const bytesMean =
      bytesPerTick.length > 0
        ? bytesPerTick.reduce((s, x) => s + x, 0) / bytesPerTick.length
        : 0

    return {
      name,
      params,
      openMs,
      gate,
      heap: {
        baselineHeapBytes: baseline.heapUsed,
        heldHeapBytes: held.heapUsed,
        heapPerConnection: (held.heapUsed - baseline.heapUsed) / n,
        baselineRssBytes: baseline.rss,
        heldRssBytes: held.rss,
        rssPerConnection: (held.rss - baseline.rss) / n,
        afterTicksHeapBytes: afterTicks.heapUsed,
        heapDriftPerConnection: (afterTicks.heapUsed - held.heapUsed) / n,
        wakesPerConnection,
        heapDriftPerConnectionPerWake:
          (afterTicks.heapUsed - held.heapUsed) / n / wakesPerConnection,
      },
      idleWake: {
        bumps: idleBumps,
        cpuUsPerBump: idleCpuUs / idleBumps,
        cpuNsPerConnectionPerBump: (idleCpuUs / idleBumps / n) * 1000,
      },
      ticks:
        m > 0
          ? {
              measured: wallUs.length,
              lanesPerTick: m,
              wall: {
                p50us: percentile(sortedWall, 50),
                p95us: percentile(sortedWall, 95),
                p99us: percentile(sortedWall, 99),
                meanUs: wallMean,
              },
              cpuMeanUs: cpuMean,
              cpuPerLaneUs: cpuMean / m,
              bytesMeanPerTick: bytesMean,
            }
          : null,
    }
  } finally {
    // Close every connection: cancel the client readers (so the next
    // enqueue throws), then bump every live selector in ONE synchronous
    // batch — each parked driver wakes once, its lane render hits the
    // canceled stream, and the drive loop exits. The lane renders here
    // are teardown cost, outside every measured window. `allSettled` so
    // a failed drive can't mask an error thrown by the scenario body.
    await Promise.allSettled(conns.map((c) => c.cancelReader()))
    for (const c of conns) refreshSelector(c.liveSelector)
    await Promise.allSettled(conns.map((c) => c.done))
    _setKeepaliveMs()
    _setFirstAckDeadlineMs()
    _setUnackedDeliveryWindow()
    _resetCellStorage()
  }
}

// ─── Scenario matrix ──────────────────────────────────────────────────

export interface SoakSpec {
  name: string
  params: SoakParams
}

/** Held-connection soak: N parked live connections, M of them receiving
 *  cell-bump wakes. The N-sweep prices the steady-state footprint and
 *  the per-bump wake-filter scan; the M rows price a wake tick under a
 *  realistic 10%-active fan-out. */
export const SOAK_SWEEP: SoakSpec[] = [100, 1000, 5000].flatMap((n) => [
  { name: `soak/N=${n}+M=0`, params: { connections: n, active: 0 } },
  { name: `soak/N=${n}+M=${n / 10}`, params: { connections: n, active: n / 10 } },
])
