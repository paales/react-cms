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
 * therefore relevant to exactly one connection: the wake index
 * delivers it there and the other N−1 parked drivers never wake at
 * all (the bump misses their registrations) — the production
 * N-independent-viewers shape. The
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
 *   3. Idle-wake phase: fire irrelevant bumps one at a time. The bump
 *      misses every connection's wake-index registration, so NO parked
 *      driver wakes and NOTHING may render — the zero-render gate —
 *      and the CPU delta / bumps is the cost of one irrelevant
 *      invalidation against N held connections (one index miss plus
 *      the store write; independent of N by construction).
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
 *
 * The SHARED variant (`runSharedSoakScenario`) inverts the isolation:
 * N connections all subscribed to the SAME page in the SAME scope
 * bucket — every connection stamps ONE `x-test-scope` value, so all N
 * share one route bucket (sharing is the default the seam exists to
 * prevent; here it is the point, and the probe proves the bucket is a
 * deliberately-named shared one, not an accident of the default
 * scope). One fixture, P partons, M of them bumped per tick — and
 * every bump is relevant to ALL N connections, so a tick renders
 * exactly N×M bodies: each bumped leaf lanes once PER CONNECTION.
 * That N×M is the "N viewers, one world" fan-out baseline broadcast
 * lanes exist to collapse to M (delivery-plane.md §D2) — the gate
 * pins it exactly so the baseline is proven, not assumed.
 */

import {
  buildMarker,
  TAG_LANES_OPEN,
  TAG_SEGMENT_SETTLED,
} from "@parton/framework/lib/fp-trailer-marker.ts"
import { bindAttachStatement } from "@parton/framework/lib/connection-session.ts"
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

export interface SharedSoakGateResult {
  /** Render bodies during the N cold opens — N × (partons + depth):
   *  a fresh connection presents no cached fps, so every body runs
   *  even though the route bucket is shared. */
  coldRenders: number
  /** Irrelevant bumps fired while all N sat parked. */
  idleBumps: number
  /** Renders during those bumps — MUST be 0, same as the isolated
   *  soak: an irrelevant bump misses every registration. */
  idleRenders: number
  /** Renders in the single gate tick — must equal N×M EXACTLY: every
   *  bumped leaf is relevant to all N connections, so each lanes once
   *  per connection. This is the fan-out baseline the measurement
   *  exists to price; the gate proves it measures what it claims. */
  tickRenders: number
  expectedTickRenders: number
  /** Measured ticks whose render delta deviated from N×M. */
  tickRenderViolations: number
  /** Wake rounds every connection must have drained by the end of the
   *  measurement: the gate tick + warmup + measured ticks. */
  expectedRoundsPerConnection: number
  /** Connections whose own `settled`-marker count ≠ expected rounds —
   *  a delivery shortfall (a connection missed a bumped parton's wake
   *  round) or over-delivery (a round split). */
  deliveryViolations: number
  /** Connections whose drive loop exited before teardown. */
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
    /** Bump rounds fired between the two samples — every idle bump and
     *  every tick is one delivery pass against the wake index (a
     *  parked connection an irrelevant bump misses does no work at
     *  all; the denominator is the traffic, not observed wakes). */
    wakesPerConnection: number
    /** heapDriftPerConnection / wakesPerConnection — what one bump
     *  round leaves behind on a parked connection. ≈0 (gc noise): an
     *  irrelevant bump never touches a parked connection, and every
     *  armed wake listener is disposer-released when its race settles
     *  (the wake-arm release invariant). */
    heapDriftPerConnectionPerWake: number
  }
  /** The idle keepalive path: one irrelevant `refreshSelector` misses
   *  every connection's wake-index registration — no parked driver
   *  wakes, nothing renders; the cost is the store write plus one
   *  index miss, independent of N. */
  idleWake: {
    bumps: number
    /** Process CPU (user+system) per bump — the cost of ONE irrelevant
     *  invalidation against N held connections. */
    cpuUsPerBump: number
    /** ÷ N — per held connection, per irrelevant bump. */
    cpuNsPerConnectionPerBump: number
  }
  /** Wake-tick numbers (null when M = 0). One tick = M cell bumps in a
   *  synchronous batch → M lane renders across M connections (the
   *  index delivers each bump to exactly its one subscriber). */
  ticks: {
    measured: number
    lanesPerTick: number
    /** Wall time from firing the bumps to the LAST connection's
     *  `settled` marker — the client-observable wake latency. */
    wall: { p50us: number; p95us: number; p99us: number; meanUs: number }
    /** Process CPU per tick, including the post-drain driver
     *  bookkeeping. */
    cpuMeanUs: number
    /** cpuMeanUs / M — amortized CPU per delivered lane. */
    cpuPerLaneUs: number
    /** Mean bytes shipped per tick across all M lanes. */
    bytesMeanPerTick: number
  } | null
}

/** Shared-scope soak result: the same axes as the isolated soak (its
 *  heap / idle-wake / tick blocks carry identical meanings), with the
 *  fan-out gate in place of the isolation gate. `ticks.lanesPerTick`
 *  is N×M here — every bump lanes on every connection. */
export interface SharedSoakScenarioResult extends Omit<SoakScenarioResult, "gate"> {
  gate: SharedSoakGateResult
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

/** The shared-soak page: ONE route all N connections subscribe to.
 *  8 live leaves + 2 static leaves under 1 wrapper — a handful of
 *  shared partons mirroring the per-connection page's shape (live +
 *  untouched-sibling + untouched-ancestor paths all present), big
 *  enough that M ∈ {1, 4} bumps a strict subset. */
const SHARED_PAGE_PARTONS = 10
const SHARED_PAGE_LIVE = 8
const SHARED_PAGE_DEPTH = 1
const SHARED_PAGE_RENDERS = SHARED_PAGE_PARTONS + SHARED_PAGE_DEPTH

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
  /** This connection's own `settled`-marker count — one per drained
   *  wake round. The shared soak's delivery gate reads it per
   *  connection; a shortfall means a bump's wake round never reached
   *  this connection's wire. */
  settled: { rounds: number }
  /** The drive loop + request scope, and the discarding reader. */
  done: Promise<void>
  /** Set when `done` resolves — read at teardown to count early
   *  closes without awaiting. */
  finished: boolean
  cancelReader: () => Promise<void>
}

function openConnection(
  fixture: DashboardFixture,
  counters: WireCounters,
  /** The wire identity: the isolated soak gives every connection its
   *  own url + scope (per-connection buckets); the shared soak gives
   *  all N the SAME pair (one route, one bucket). */
  wire: { url: string; scope: string },
): SoakConnection {
  const request = new Request(wire.url, {
    headers: { "x-test-scope": wire.scope },
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
  const settled = { rounds: 0 }
  const drain = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      counters.bytes += value.byteLength
      if (chunkEquals(value, LANES_OPEN_MARKER)) parkedResolve()
      else if (chunkEquals(value, SETTLED_MARKER)) {
        settled.rounds++
        onSettled(counters)
      }
    }
  })()

  const drive = runWithRequestAsync(request, async () => {
    // The attach statement is the live-subscription signal — bind a
    // bare one (nothing to state) so the driver opens a session and
    // parks, exactly as a browser's attach would.
    bindAttachStatement({
      url: new URL(wire.url).pathname,
      cached: [],
      since: null,
      visible: null,
    })
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
    settled,
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
      const warm = openConnection(warmFixture, counters, {
        url: `${URL_BASE}/warm`,
        scope: "soak-warm",
      })
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
      const conn = openConnection(fixtures[i], counters, {
        url: `${URL_BASE}/c${i}`,
        scope: `soak-c${i}`,
      })
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
    // each bump is a distinct delivery round. The turn also guarantees
    // any continuation a bump could have scheduled has run before the
    // next sample — event-loop ordering, not a timing guess (with the
    // wake index, an irrelevant bump schedules none: it misses every
    // registration and no parked driver wakes).
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
    const wallMean = wallUs.length > 0 ? wallUs.reduce((s, x) => s + x, 0) / wallUs.length : 0
    const cpuMean =
      cpuUsPerTick.length > 0 ? cpuUsPerTick.reduce((s, x) => s + x, 0) / cpuUsPerTick.length : 0
    const bytesMean =
      bytesPerTick.length > 0 ? bytesPerTick.reduce((s, x) => s + x, 0) / bytesPerTick.length : 0

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

// ─── Shared-scope scenario (N viewers, ONE world) ─────────────────────

/**
 * Shared-scope soak: N connections all subscribed to the SAME page in
 * the SAME scope bucket — one route, one fixture, one world. Every one
 * of the M cells a tick bumps is relevant to ALL N connections, so
 * each bumped leaf lanes once PER CONNECTION: a tick renders exactly
 * N×M bodies. That N×M curve is the fan-out baseline broadcast lanes
 * (delivery-plane.md §D2) exist to collapse to M — render once,
 * personalize framing — and the gate pins it exactly so the baseline
 * is proven, not assumed.
 *
 * The phase structure, memory accounting, idle gate, and wire-marker
 * mechanics are the isolated soak's; only the sharing inverts. The
 * one extra gate is delivery correctness: each connection's OWN
 * `settled`-marker count must equal the wake rounds fired — every
 * connection received every bumped parton's lane, none was skipped
 * and none double-woke.
 */
export async function runSharedSoakScenario(
  name: string,
  params: SoakParams,
  options: SoakOptions = {},
): Promise<SharedSoakScenarioResult> {
  const warmup = options.warmup ?? 5
  const measure = options.measure ?? 30
  const n = params.connections
  const m = Math.min(params.active, SHARED_PAGE_LIVE)
  if (m <= 0) {
    throw new Error(`shared soak "${name}": needs at least one bumped parton per tick`)
  }
  resetWorld()
  _setKeepaliveMs(SOAK_KEEPALIVE_MS)
  // Same rationale as the isolated soak: the discarding reader never
  // acks, and the degrade policy is not what's being priced.
  _setFirstAckDeadlineMs(SOAK_KEEPALIVE_MS)
  _setUnackedDeliveryWindow(Number.MAX_SAFE_INTEGER)

  const counters: WireCounters = { bytes: 0, settles: 0, barrier: null }
  const conns: SoakConnection[] = []
  // ONE url + ONE scope for every connection. Sharing a snapshot
  // bucket is what the x-test-scope seam exists to PREVENT — here it
  // is the measurement, opted back into deliberately by stamping the
  // same value on all N. The seam is still what names the bucket, so
  // the category stays dev-Flight like the isolated soak.
  const wire = { url: `${URL_BASE}/shared`, scope: "soak-shared" }

  try {
    // Probe the scope seam before spending anything — without it every
    // request lands in the ambient default scope. That would still be
    // "shared", but shared with whatever else the worker has run, not
    // the deliberately-named bucket the scenario claims to measure.
    const probe = await runWithRequestAsync(
      new Request(`${URL_BASE}/scope-probe`, { headers: { "x-test-scope": "soak-probe" } }),
      async () => getScope(),
    )
    if (probe.result !== "soak-probe") {
      throw new Error(
        `shared soak "${name}": the shared bucket needs the dev-mode x-test-scope seam ` +
          "(unavailable under --prod) — run the shared category against the dev Flight build",
      )
    }

    // Throwaway connection (own scope): absorbs one-time lazy
    // initialization so it isn't attributed to the held set.
    {
      const warmFixture = buildDashboardPage({
        partons: PAGE_PARTONS,
        liveCells: 1,
        depth: PAGE_DEPTH,
        idPrefix: "w-",
      })
      const warm = openConnection(warmFixture, counters, {
        url: `${URL_BASE}/warm`,
        scope: "soak-warm",
      })
      await warm.parked
      await warm.cancelReader()
      refreshSelector(warm.liveSelector)
      await warm.done
    }

    // ── Phase 1: the ONE fixture — the world all N subscribe to. ──
    const fixture = buildDashboardPage({
      partons: SHARED_PAGE_PARTONS,
      liveCells: SHARED_PAGE_LIVE,
      depth: SHARED_PAGE_DEPTH,
      idPrefix: "sh-",
    })
    const baseline = await sampleMemory()

    // ── Phase 2: open + park all N on the same url/scope/fixture. ──
    // A fresh connection presents no cached fps, so each cold open
    // renders the full page even though the route bucket is shared.
    resetRenderCount()
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      const conn = openConnection(fixture, counters, wire)
      conns.push(conn)
      await conn.parked
    }
    const openMs = performance.now() - t0
    const coldRenders = getRenderCount()
    if (coldRenders !== n * SHARED_PAGE_RENDERS) {
      throw new Error(
        `shared soak "${name}": cold opens rendered ${coldRenders}, ` +
          `expected ${n * SHARED_PAGE_RENDERS}`,
      )
    }
    const held = await sampleMemory()
    // The initial whole-tree segment emitted one `settled` marker per
    // connection before parking; zero the per-connection counters so
    // the delivery gate reads pure wake rounds.
    for (const c of conns) c.settled.rounds = 0

    // ── Phase 3: idle keepalive path + the zero-render gate. ──
    // Identical to the isolated soak: an irrelevant bump misses every
    // registration, no parked driver wakes, nothing renders — on ANY
    // of the N connections.
    resetRenderCount()
    const idleBumps = Math.max(1, measure)
    const idleCpu0 = cpuNowUs()
    for (let k = 0; k < idleBumps; k++) {
      refreshSelector(NOISE_SELECTOR)
      await yieldEventLoop()
    }
    const idleCpuUs = cpuNowUs() - idleCpu0
    const idleRenders = getRenderCount()

    // ── Phase 4: wake ticks. ──
    // Each tick bumps M distinct cells of the ONE world in a
    // synchronous batch. Every bump is relevant to every connection:
    // all N parked drivers wake once (the M bumps land in each pending
    // set before its microtask continuation runs, so they drain in ONE
    // round), each renders its M lanes, each emits one `settled`
    // marker — the tick completes at the Nth marker.
    const activeSelectors = fixture.liveSelectors.slice(0, m)
    const expectedTickRenders = n * m
    const tick = async (): Promise<void> => {
      const target = counters.settles + n
      for (const sel of activeSelectors) refreshSelector(sel)
      await settlesReach(counters, target)
    }

    // Gate tick: the render delta must be exactly N×M — each bumped
    // leaf laned once per connection; no sibling, no wrapper, nothing
    // else ran. THE number this category exists to pin: the fan-out
    // baseline broadcast has to collapse.
    resetRenderCount()
    await tick()
    await yieldEventLoop()
    const gateTickRenders = getRenderCount()

    for (let t = 0; t < warmup; t++) {
      await tick()
      await yieldEventLoop()
    }

    let tickRenderViolations = 0
    const wallUs: number[] = []
    const cpuUsPerTick: number[] = []
    const bytesPerTick: number[] = []
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
      if (getRenderCount() !== expectedTickRenders) tickRenderViolations++
    }

    const afterTicks = await sampleMemory()
    const rounds = 1 + warmup + measure
    const wakesPerConnection = idleBumps + rounds

    // ── Phase 5: gates (the closes happen in finally). ──
    const closedEarly = conns.filter((c) => c.finished).length
    // Delivery correctness: every connection's own wire carried every
    // wake round — its `settled` count says so, per connection, not in
    // aggregate (an aggregate could hide one connection double-woken
    // and another skipped).
    const deliveryViolations = conns.filter((c) => c.settled.rounds !== rounds).length

    const gate: SharedSoakGateResult = {
      coldRenders,
      idleBumps,
      idleRenders,
      tickRenders: gateTickRenders,
      expectedTickRenders,
      tickRenderViolations,
      expectedRoundsPerConnection: rounds,
      deliveryViolations,
      closedEarly,
      faithful:
        idleRenders === 0 &&
        gateTickRenders === expectedTickRenders &&
        tickRenderViolations === 0 &&
        deliveryViolations === 0 &&
        closedEarly === 0,
    }

    const sortedWall = [...wallUs].sort((a, b) => a - b)
    const wallMean = wallUs.length > 0 ? wallUs.reduce((s, x) => s + x, 0) / wallUs.length : 0
    const cpuMean =
      cpuUsPerTick.length > 0 ? cpuUsPerTick.reduce((s, x) => s + x, 0) / cpuUsPerTick.length : 0
    const bytesMean =
      bytesPerTick.length > 0 ? bytesPerTick.reduce((s, x) => s + x, 0) / bytesPerTick.length : 0

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
      ticks: {
        measured: wallUs.length,
        // Every bump lanes on every connection: N×M lanes per tick.
        lanesPerTick: expectedTickRenders,
        wall: {
          p50us: percentile(sortedWall, 50),
          p95us: percentile(sortedWall, 95),
          p99us: percentile(sortedWall, 99),
          meanUs: wallMean,
        },
        cpuMeanUs: cpuMean,
        cpuPerLaneUs: cpuMean / expectedTickRenders,
        bytesMeanPerTick: bytesMean,
      },
    }
  } finally {
    // Close every connection: cancel the client readers, then ONE bump
    // on the shared world's first live leaf — relevant to all N, so
    // every parked driver wakes once, its lane render hits the
    // canceled stream on enqueue, and the drive loop exits.
    await Promise.allSettled(conns.map((c) => c.cancelReader()))
    if (conns.length > 0) refreshSelector(conns[0].liveSelector)
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

/** Shared-scope soak: N viewers of ONE world (one route, one scope
 *  bucket), M of its partons bumped per tick — every bump relevant to
 *  all N. The N-sweep at fixed M prints the fan-out curve (renders/tick
 *  = N×M today) that broadcast lanes must collapse to M; the M axis
 *  shows how the per-tick fixed overhead amortizes across lanes. */
export const SHARED_SWEEP: SoakSpec[] = [10, 100, 500].flatMap((n) =>
  [1, 4].map((m) => ({
    name: `shared/N=${n}+M=${m}`,
    params: { connections: n, active: m },
  })),
)
