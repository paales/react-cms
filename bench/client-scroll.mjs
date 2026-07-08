/**
 * Client-scroll performance harness — the standing tool for profiling
 * the website world's SCROLL FRAME on the client. Mirrors
 * `website/validate-world.mjs`'s self-contained boot (builds/serves the
 * prod preview on its own port, drives with Playwright), but where the
 * validator asserts correctness + wire budgets, this one MEASURES
 * client CPU: where the scroll frame's milliseconds go.
 *
 * Run:
 *   node bench/client-scroll.mjs            # build (sourcemapped) + preview + measure
 *   node bench/client-scroll.mjs --no-build # reuse the current dist (must be a
 *                                           #   PARTON_BENCH_SOURCEMAP build for symbols)
 *   node bench/client-scroll.mjs --dev      # drive the dev server (readable names,
 *                                           #   but dev-Flight overhead — smoke only)
 *   node bench/client-scroll.mjs --soak     # also profile an idle pulse-soak window
 *   node bench/client-scroll.mjs --viewport=2560x1440   # denser world → more observers
 *   node bench/client-scroll.mjs --port=5187 --out=bench/results/client
 *
 * What it captures (over ONE deterministic workload — a scripted fast
 * scroll east / south / diagonal across the world, rAF-driven at a fixed
 * px/second so world-distance and wall-time are identical every run):
 *
 *   1. A DevTools PERFORMANCE TRACE (CDP `Tracing`, ReturnAsStream) →
 *      `trace-<ts>.json`, loadable in DevTools Performance / chrome://
 *      tracing. The harness also parses it for the per-task main-thread
 *      cost: `RunTask` durations on `CrRendererMain`, bucketed
 *      >3/>5/>8.33/>16.7ms — the vsync-independent "scroll frame cost"
 *      distribution (headless caps rAF at the display's refresh, so raw
 *      rAF deltas floor at ~16.7ms; RunTask durations do not).
 *   2. A CPU SAMPLING PROFILE (CDP `Profiler`, 50µs interval) →
 *      self-time aggregated per function, SYMBOLICATED through the
 *      client bundle's hidden sourcemaps (prod mangles every name), and
 *      printed as the top-20 hotspots with `source:line`. This is the
 *      hotspot list AND the before/after substrate.
 *   3. FRAME STATS from an injected PerformanceObserver (addInitScript):
 *      rAF-delta buckets, `longtask` entries, `layout-shift` (CLS).
 *
 * Prints a compact summary and writes a machine-readable
 * `client-scroll-<ts>.json` (+ `client-scroll.latest.json`) next to the
 * trace, so a before/after pass is a diff of two summaries. Artifacts
 * land in `bench/results/client/` (gitignored — large + machine-local).
 *
 * Not part of `yarn test`; the only entry point is this file. See
 * bench/README.md § Client-scroll harness.
 */

import { execSync, spawn } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { SourceMap } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST_ASSETS = path.join(REPO_ROOT, "website/dist/client/assets")

// ── CLI ──
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
if (has("--help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].slice(3))
  process.exit(0)
}
const MODE = has("--dev") ? "dev" : "preview"
const NO_BUILD = has("--no-build") || has("--dev")
const SOAK = has("--soak")
const PORT = Number(opt("port", process.env.PORT ?? 5187))
const BASE = `http://localhost:${PORT}`
const OUT_DIR = path.resolve(REPO_ROOT, opt("out", "bench/results/client"))
// Viewport — bigger viewports place more chunks, so more cullable
// observers, so the cull machinery's per-flip work scales with it.
const [VW, VH] = opt("viewport", "1440x900")
  .split("x")
  .map((n) => Number(n))
const VIEWPORT = { width: VW || 1440, height: VH || 900 }

// The exact category set the task prescribes — DevTools timeline + frame
// track + user timing + v8 execute + the CPU profiler + loading/latency.
const TRACE_CATEGORIES = [
  "disabled-by-default-devtools.timeline",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "v8.execute",
  "disabled-by-default-v8.cpu_profiler",
  "loading",
  "latencyInfo",
].join(",")

// The workload: a fixed route in px/second × milliseconds, so every run
// covers the same world-distance in the same wall-time regardless of the
// achieved frame rate. Fast enough that many cull flips + lane commits
// land per frame (the regime the 3–9ms frames live in).
const WORKLOAD = [
  { dir: "east", vx: 2200, vy: 0, ms: 2600 },
  { dir: "south", vx: 0, vy: 2200, ms: 2000 },
  { dir: "diagonal", vx: 1800, vy: 1800, ms: 2600 },
]
const CENTER_PX = 16384 // WORLD_PX / 2 — chunk 0,0's top-left; the boot position.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return Date.now() - t0
    await sleep(100)
  }
  throw new Error(`timeout: ${label}`)
}

// ── Injected: frame stats via PerformanceObserver + a gated rAF loop ──
// Longtask + layout-shift observers record continuously into rolling
// buffers `mark()` resets; the rAF-delta loop runs only between
// startFrames()/stopFrames() so an idle window never free-spins rAF (and
// never pollutes the profile with the harness's own loop).
function installFrameStats() {
  const S = { frames: [], longtasks: [], cls: 0, framesOn: false, lastRAF: 0 }
  window.__bench = {
    mark() {
      S.longtasks = []
      S.cls = 0
    },
    startFrames() {
      S.frames = []
      S.lastRAF = 0
      S.framesOn = true
      const loop = (t) => {
        if (!S.framesOn) return
        if (S.lastRAF) S.frames.push(t - S.lastRAF)
        S.lastRAF = t
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    },
    stopFrames() {
      S.framesOn = false
    },
    read() {
      return { frames: S.frames.slice(), longtasks: S.longtasks.slice(), cls: S.cls }
    },
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) S.longtasks.push({ start: e.startTime, duration: e.duration })
    }).observe({ entryTypes: ["longtask"] })
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) S.cls += e.value
    }).observe({ type: "layout-shift", buffered: false })
  } catch {}
}

// ── Injected: the scroll driver — rAF-stepped, velocity × duration ──
async function driveWorkload(steps) {
  const scroller = document.querySelector('[data-testid="world-scroller"]')
  if (!scroller) throw new Error("no world-scroller")
  for (const s of steps) {
    await new Promise((resolve) => {
      const t0 = performance.now()
      let last = t0
      // Distinctive name so the harness's own driver frames are
      // identifiable in the CPU profile and excluded from the app's
      // scripting denominator (see aggregateProfile).
      const __benchStep = (now) => {
        const dt = Math.min((now - last) / 1000, 0.05)
        last = now
        scroller.scrollLeft += s.vx * dt
        scroller.scrollTop += s.vy * dt
        if (now - t0 >= s.ms) return resolve()
        requestAnimationFrame(__benchStep)
      }
      requestAnimationFrame(__benchStep)
    })
  }
}

// ── Symbolication: minified client call frame → source:line via maps ──
function makeSymbolicator() {
  const cache = new Map() // basename → SourceMap | null
  const mapFor = (url) => {
    const m = /\/assets\/([^/?#]+\.js)/.exec(url ?? "")
    if (!m) return null
    const base = m[1]
    if (cache.has(base)) return cache.get(base)
    let sm = null
    try {
      sm = new SourceMap(JSON.parse(readFileSync(path.join(DIST_ASSETS, `${base}.map`), "utf8")))
    } catch {}
    cache.set(base, sm)
    return sm
  }
  const shorten = (src) => (src ?? "").replace(/^.*?(framework\/src\/|website\/src\/|copies\/src\/|node_modules\/)/, "$1")
  return (cf) => {
    const sm = mapFor(cf.url)
    if (!sm) return null
    let entry
    try {
      entry = sm.findEntry(cf.lineNumber ?? 0, cf.columnNumber ?? 0)
    } catch {
      return null
    }
    if (!entry || entry.originalSource === undefined) return null
    return {
      name: entry.name || cf.functionName || "(anonymous)",
      source: shorten(entry.originalSource),
      line: (entry.originalLine ?? 0) + 1,
    }
  }
}

// ── CPU profile → self-time per function, symbolicated ──
function aggregateProfile(profile, symbolicate) {
  const { nodes, samples, timeDeltas } = profile
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const selfByNode = new Map()
  let totalUs = 0
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] ?? 0
    if (dt < 0) continue
    totalUs += dt
    selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + dt)
  }
  // Coalesce nodes that share a (symbolicated, else raw) call frame.
  const byFn = new Map()
  for (const [id, us] of selfByNode) {
    const n = nodeById.get(id)
    if (!n) continue
    const cf = n.callFrame
    const sym = cf.url ? symbolicate(cf) : null
    const label = sym
      ? `${sym.name} (${sym.source}:${sym.line})`
      : cf.functionName || `(${cf.url ? "anon" : cf.functionName || "program"})`
    const cur = byFn.get(label) ?? { label, us: 0, raw: cf.functionName, url: cf.url }
    cur.us += us
    byFn.set(label, cur)
  }
  // The harness's own rAF scroll driver runs in page context during the
  // profiled workload — split it out so the app's scripting denominator
  // and top list reflect the app, not the measurement.
  const isHarness = (r) => /^__bench/.test(r.raw ?? "")
  const harnessUs = [...byFn.values()].filter(isHarness).reduce((s, r) => s + r.us, 0)
  const rows = [...byFn.values()].filter((r) => !isHarness(r)).sort((a, b) => b.us - a.us)
  // Scripting = everything the VM ran, minus pure idle and the harness.
  const idle = byFn.get("(idle)")?.us ?? 0
  const scriptingUs = totalUs - idle - harnessUs
  return { rows, totalUs, scriptingUs, idleUs: idle, harnessUs }
}

// ── Trace → main-thread self-time by rendering PHASE ──
// The CPU profiler attributes JS to functions; the trace attributes the
// rest of the frame — style recalc, layout, IntersectionObserver
// (`ComputeIntersections`), paint, composite — which JS self-time can't
// see. Self-time = a complete event's `dur` minus its children's (built
// from ts-containment on the busiest CrRendererMain thread), so nested
// timeline events don't double-count. `BeginMainFrame` count is the
// frame denominator for the per-frame figures.
// Maps a main-thread trace event name to a rendering phase. Order
// matters — the first hit wins. Names are the raw Blink/V8 event names
// (`IntersectionObserverController::computeIntersections`, `Layerize`,
// `UpdateLayoutTree`, …), matched by substring so trace-version drift
// doesn't silently drop a category into "other".
const PHASE_OF = (name) => {
  if (/[Ii]ntersect/.test(name)) return "intersection"
  if (/UpdateLayoutTree|RecalculateStyles|StyleRecalc|ParseAuthorStyleSheet|StyleInvalidation/.test(name)) return "style"
  if (/^Layout$|HitTest|UpdateLayerTree|LayoutShift/.test(name)) return "layout"
  if (/Paint|Rasterize|DecodeImage|DecodeLazyPixelRef|GPUTask/.test(name)) return "paint"
  if (/Commit|Composite|Layerize|Layer$|ScrollLayer|UpdateLayer|DrawFrame|BeginFrame|BeginMainThreadFrame|ActivateLayerTree|RequestMainThreadFrame/.test(name)) return "composite"
  if (/GC|GarbageCollect/.test(name)) return "gc"
  if (/URLLoader|Mojo|ResourceRequest|ResourceLoad|ResourceFetch|ResourceReceive/.test(name)) return "network"
  if (/FunctionCall|EvaluateScript|RunMicrotasks|EventDispatch|TimerFire|FireAnimationFrame|FireIdleCallback|XHR|V8\.|ParseHTML|CompileScript|ProfileCall/.test(name)) return "scripting"
  return "other"
}

function analyzeTrace(traceText) {
  const events = JSON.parse(traceText).traceEvents ?? []
  const rendererTids = new Set()
  const frameStarts = []
  for (const e of events) {
    if (e.name === "thread_name" && e.args?.name === "CrRendererMain") rendererTids.add(`${e.pid}:${e.tid}`)
    if (e.name === "BeginMainThreadFrame") frameStarts.push(e.ts)
  }
  frameStarts.sort((a, b) => a - b)
  const frames = frameStarts.length
  // Group complete events per thread; keep the busiest renderer thread.
  const perThread = new Map()
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number") continue
    const key = `${e.pid}:${e.tid}`
    if (!rendererTids.has(key)) continue
    let arr = perThread.get(key)
    if (!arr) perThread.set(key, (arr = []))
    arr.push(e)
  }
  let main = []
  let bestSum = -1
  for (const arr of perThread.values()) {
    const s = arr.reduce((a, b) => a + (b.name === "RunTask" ? b.dur : 0), 0)
    if (s > bestSum) {
      bestSum = s
      main = arr
    }
  }
  // Self-time (dur − children's dur) per phase via a ts-containment stack
  // that tallies each event at pop; dur is µs. `main` is ts-sorted, ties
  // broken by longer dur first so a parent precedes its children.
  main.sort((a, b) => a.ts - b.ts || b.dur - a.dur)
  const phases = { scripting: 0, style: 0, layout: 0, intersection: 0, paint: 0, composite: 0, gc: 0, network: 0, other: 0 }
  const runTasks = []
  let mainBusyUs = 0
  // Per-frame main-thread self-time: bin each event's self-time into the
  // BeginMainThreadFrame window it starts in. This is the present-
  // independent "scroll frame cost" — what a fast-GPU device (where the
  // compositor isn't the bottleneck) actually pays per frame.
  const perFrameMs = new Array(frames).fill(0)
  const frameIdx = (ts) => {
    let lo = 0
    let hi = frameStarts.length - 1
    let r = -1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (frameStarts[m] <= ts) {
        r = m
        lo = m + 1
      } else hi = m - 1
    }
    return r
  }
  const stack = []
  const tally = (done) => {
    const self = (done.dur - done.childDur) / 1000
    phases[PHASE_OF(done.name)] += self
    const i = frameIdx(done.ts)
    if (i >= 0) perFrameMs[i] += self
  }
  for (const e of main) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) tally(stack.pop())
    if (stack.length) stack[stack.length - 1].childDur += e.dur
    if (e.name === "RunTask") {
      mainBusyUs += e.dur
      runTasks.push(e.dur / 1000)
    }
    stack.push({ ts: e.ts, end: e.ts + e.dur, childDur: 0, name: e.name, dur: e.dur })
  }
  while (stack.length) tally(stack.pop())
  return {
    phases,
    frames,
    mainBusyMs: mainBusyUs / 1000,
    runTasks: bucketize(runTasks),
    perFrame: bucketize(perFrameMs.filter((v) => v > 0)),
  }
}

function bucketize(durs) {
  const b = { count: durs.length, total: 0, max: 0, over3: 0, over5: 0, over8_33: 0, over16_7: 0, over33_3: 0 }
  const sorted = durs.slice().sort((a, b) => a - b)
  for (const d of durs) {
    b.total += d
    if (d > b.max) b.max = d
    if (d > 3) b.over3++
    if (d > 5) b.over5++
    if (d > 8.33) b.over8_33++
    if (d > 16.7) b.over16_7++
    if (d > 33.3) b.over33_3++
  }
  b.p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
  b.p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  return b
}

async function readTraceStream(cdp, handle) {
  let out = ""
  for (;;) {
    const { data, base64Encoded, eof } = await cdp.send("IO.read", { handle, size: 1 << 20 })
    out += base64Encoded ? Buffer.from(data, "base64").toString("utf8") : data
    if (eof) break
  }
  await cdp.send("IO.close", { handle })
  return out
}

// ── Passes over the workload ──
async function resetAndSettle(page) {
  await page.evaluate((center) => {
    const s = document.querySelector('[data-testid="world-scroller"]')
    if (s) s.scrollTo(center - s.clientWidth / 2, center - s.clientHeight / 2)
  }, CENTER_PX)
  await sleep(900)
}

// ── Main ──
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
mkdirSync(OUT_DIR, { recursive: true })

// Refuse a dirty port — a leftover server silently invalidates the run.
try {
  await fetch(BASE)
  console.error(`Port ${PORT} already serving — kill it first (lsof -ti :${PORT} | xargs kill).`)
  process.exit(2)
} catch {}

if (!NO_BUILD) {
  console.log("building website (PARTON_BENCH_SOURCEMAP=1)…")
  execSync("yarn build:website", {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, PARTON_BENCH_SOURCEMAP: "1" },
  })
}

const server = spawn("yarn", ["workspace", "@parton/website", MODE, "--port", String(PORT), "--strictPort"], {
  cwd: REPO_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
const serverLog = []
server.stdout.on("data", (d) => serverLog.push(d.toString()))
server.stderr.on("data", (d) => serverLog.push(d.toString()))

let browser
try {
  await until(async () => {
    try {
      return (await fetch(BASE)).ok
    } catch {
      return false
    }
  }, 40000, "server up")
  console.log(`mode: ${MODE}  ${BASE}`)

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.addInitScript(installFrameStats)
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)))

  // Boot + settle: origin content, live boot, first flips quiesced.
  await page.goto(BASE)
  await until(async () => (await page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null, 20000, "origin content")
  await sleep(3500)

  const runWorkload = () => page.evaluate(driveWorkload, WORKLOAD)

  // 0. Warmup — a discarded pass so JIT + caches are hot for the measured ones.
  await resetAndSettle(page)
  await runWorkload()

  // 1. Measure pass (clean) — the injected PerformanceObserver stats.
  await resetAndSettle(page)
  await page.evaluate(() => window.__bench.mark())
  await page.evaluate(() => window.__bench.startFrames())
  await runWorkload()
  await page.evaluate(() => window.__bench.stopFrames())
  const frameStats = await page.evaluate(() => window.__bench.read())
  const rafBuckets = bucketize(frameStats.frames)
  const longtaskTotal = frameStats.longtasks.reduce((s, t) => s + t.duration, 0)
  const longtaskMax = frameStats.longtasks.reduce((m, t) => Math.max(m, t.duration), 0)

  // 2. Profile pass — CPU self-time, symbolicated.
  const cdp = await page.context().newCDPSession(page)
  await resetAndSettle(page)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 50 })
  await cdp.send("Profiler.start")
  await runWorkload()
  const { profile } = await cdp.send("Profiler.stop")
  await cdp.send("Profiler.disable")
  const symbolicate = makeSymbolicator()
  const agg = aggregateProfile(profile, symbolicate)

  // 3. Trace pass — save the DevTools trace + parse RunTask buckets.
  await resetAndSettle(page)
  await cdp.send("Tracing.start", { transferMode: "ReturnAsStream", categories: TRACE_CATEGORIES })
  await runWorkload()
  const complete = new Promise((res) => cdp.once("Tracing.tracingComplete", res))
  await cdp.send("Tracing.end")
  const { stream } = await complete
  const traceText = await readTraceStream(cdp, stream)
  const tracePath = path.join(OUT_DIR, `trace-${ts}.json`)
  writeFileSync(tracePath, traceText)
  const trace = analyzeTrace(traceText)

  // 4. Optional soak — an idle window, pulses streaming, Profiler on.
  let soakAgg = null
  if (SOAK) {
    await resetAndSettle(page)
    await page.evaluate(() => window.__bench.mark())
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 50 })
    await cdp.send("Profiler.start")
    await sleep(8000)
    const { profile: soakProfile } = await cdp.send("Profiler.stop")
    await cdp.send("Profiler.disable")
    soakAgg = aggregateProfile(soakProfile, symbolicate)
  }

  // ── Report ──
  const pct = (us) => ((us / agg.scriptingUs) * 100).toFixed(1)
  const ms = (us) => (us / 1000).toFixed(1)
  // Subsystem rollups — self-time of every function whose symbolicated
  // label matches, so the JS cost lands as "cull/visibility = X%",
  // "React = Y%" rather than scattered across mangled leaves.
  const roll = (re) => agg.rows.filter((r) => re.test(r.label)).reduce((s, r) => s + r.us, 0)
  const rollups = {
    "cull + visibility": roll(/visibility\.tsx|cull-park|cull-pair|cull-slot|cull-key/),
    "React (react-dom)": roll(/react-dom/),
    "Flight decode": roll(/react-server-dom/),
    "channel client": roll(/channel-client|channel-transport/),
    "partial cache/template": roll(/partial-cache|partial-template|partial-client|refetch\.ts/),
    "app: scroller/telemetry": roll(/scroller\.tsx|telemetry\.ts|pulse\.ts|warm\.ts/),
  }
  const printBuckets = (b) =>
    `  >3ms: ${b.over3}  >5ms: ${b.over5}  >8.33ms: ${b.over8_33}  >16.7ms: ${b.over16_7}  >33.3ms: ${b.over33_3}`

  console.log(`\n${"═".repeat(72)}\nCLIENT-SCROLL  (${MODE}, viewport ${VIEWPORT.width}×${VIEWPORT.height}, workload east/south/diagonal)\n${"═".repeat(72)}`)

  const pf = trace.perFrame
  console.log(`\nMAIN-THREAD FRAME COST  (per-frame self-time from the trace — present-independent;`)
  console.log(`                         what a fast-GPU device pays per scroll frame)`)
  console.log(
    `  ${pf.count} frames · p50 ${pf.p50.toFixed(2)} · p95 ${pf.p95.toFixed(2)} · max ${pf.max.toFixed(2)}ms`,
  )
  console.log(printBuckets(pf))

  console.log(`\nFRAME PACING  (rAF deltas — wall-clock; in headless this is present/GPU-bound)`)
  console.log(
    `  ${rafBuckets.count} frames · p50 ${rafBuckets.p50.toFixed(1)} · p95 ${rafBuckets.p95.toFixed(1)} · max ${rafBuckets.max.toFixed(1)}ms · over-8.33 ${((rafBuckets.over8_33 / rafBuckets.count) * 100 || 0).toFixed(0)}%`,
  )
  console.log(printBuckets(rafBuckets))
  console.log(`  longtasks: ${frameStats.longtasks.length} · total ${longtaskTotal.toFixed(0)}ms · max ${longtaskMax.toFixed(0)}ms · CLS ${frameStats.cls.toFixed(3)}`)

  const P = trace.phases
  const perFrame = (v) => (trace.frames ? (v / trace.frames).toFixed(2) : "?")
  console.log(`\nMAIN-THREAD PHASES  (self-time from the trace, ${trace.frames} BeginMainFrames, busy ${trace.mainBusyMs.toFixed(0)}ms)`)
  console.log(`                       total ms     ms/frame`)
  for (const [k, v] of Object.entries(P).sort((a, b) => b[1] - a[1])) {
    if (v < 0.5) continue
    console.log(`  ${k.padEnd(14)} ${v.toFixed(0).padStart(8)}ms   ${perFrame(v).padStart(7)}`)
  }

  console.log(
    `\nCPU SELF-TIME  (scripting ${ms(agg.scriptingUs)}ms of ${ms(agg.totalUs)}ms wall; idle ${ms(agg.idleUs)}ms)`,
  )
  console.log(`  subsystem rollups (% of scripting):`)
  for (const [k, us] of Object.entries(rollups).sort((a, b) => b[1] - a[1])) {
    if (us < 200) continue
    console.log(`    ${ms(us).padStart(7)}ms  ${pct(us).padStart(5)}%  ${k}`)
  }
  console.log(`  top 20 functions:`)
  for (const r of agg.rows.filter((r) => r.label !== "(idle)").slice(0, 20)) {
    console.log(`    ${ms(r.us).padStart(7)}ms  ${pct(r.us).padStart(5)}%  ${r.label}`)
  }

  if (soakAgg) {
    console.log(`\nSOAK (idle 8s, pulses live) — top 12 by self-time (scripting ${ms(soakAgg.scriptingUs)}ms):`)
    for (const r of soakAgg.rows.filter((r) => r.label !== "(idle)").slice(0, 12)) {
      console.log(`    ${ms(r.us).padStart(7)}ms  ${r.label}`)
    }
  }

  console.log(`\ntrace: ${tracePath}`)
  console.log(`  open in DevTools → Performance → Load profile, or chrome://tracing`)

  const summary = {
    ts,
    mode: MODE,
    workload: WORKLOAD,
    viewport: VIEWPORT,
    frames: trace.frames,
    perFrame: trace.perFrame,
    phases: P,
    mainBusyMs: trace.mainBusyMs,
    runTasks: trace.runTasks,
    rafBuckets,
    longtasks: { count: frameStats.longtasks.length, total: longtaskTotal, max: longtaskMax },
    cls: frameStats.cls,
    scripting: { totalUs: agg.totalUs, scriptingUs: agg.scriptingUs, idleUs: agg.idleUs },
    rollups: Object.fromEntries(Object.entries(rollups).map(([k, us]) => [k, { us, pct: Number(pct(us)) }])),
    top: agg.rows
      .filter((r) => r.label !== "(idle)")
      .slice(0, 40)
      .map((r) => ({ label: r.label, us: r.us, pct: Number(pct(r.us)) })),
    soak: soakAgg
      ? { top: soakAgg.rows.filter((r) => r.label !== "(idle)").slice(0, 20).map((r) => ({ label: r.label, us: r.us })) }
      : null,
    tracePath,
    pageErrors,
  }
  const summaryPath = path.join(OUT_DIR, `client-scroll-${ts}.json`)
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  writeFileSync(path.join(OUT_DIR, "client-scroll.latest.json"), JSON.stringify(summary, null, 2))
  console.log(`summary: ${summaryPath}`)
  if (pageErrors.length) console.log(`\n⚠ page errors: ${pageErrors.slice(0, 3).join(" | ")}`)

  await browser.close()
} finally {
  if (browser) await browser.close().catch(() => {})
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {
    server.kill("SIGTERM")
  }
}
