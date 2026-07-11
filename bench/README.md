# Server warm-tick benchmark

Puts hard numbers on the per-update server CPU cost of a live "tick" —
the framework's "recalculate the world" path that re-renders the page on
every relevant change and emits fp-skip placeholders for unchanged
subtrees. It exists to profile, optimize, and regression-track that cost.

**The headline question:** when only ONE cell changes, how does the
warm-tick cost grow with world size N? A curve that grows with N proves
that *proving a subtree unchanged costs O(tree)* — the tax we want to
target.

```bash
yarn bench:server                 # full matrix, DEV Flight → table + JSON
yarn bench:server --prod          # full matrix, PRODUCTION Flight → .prod.json
yarn bench:server --prof          # profile scaling/N=1000 under Node --cpu-prof
yarn bench:server --prod --prof   # profile the PRODUCTION runtime
yarn bench:server --only=depth    # one category (scaling | dashboard | depth | pulse | soak)
yarn bench:server --only=scaling/N=1000   # one exact scenario
yarn bench:server --warmup=20 --measure=200   # shorter run while iterating
```

**Dev vs prod, and which is canonical.** Dev is the DEFAULT; `--prod`
measures the production react-server-dom build. They answer different
questions and are NOT comparable in absolute terms — see
[Dev vs prod Flight](#dev-vs-prod-flight) below. Rule of thumb: **dev**
is the stable signal for hunting framework slop and tracking regressions
(it amplifies the framework's own fingerprint/fold/encode work and is
unaffected by React's debug-channel churn between versions); **prod** is
the honest absolute number — what a deployed tick actually costs.

It is **not** part of `yarn test`: the rsc test project's include glob
covers `*.rsc.test.tsx` under the package dirs, never `bench/**`. The only
entry point is `yarn bench:server`. It is typechecked, though —
`bench/tsconfig.json` is wired into `yarn typecheck`.

## What a "warm tick" is (and why it must be exact)

The production live loop is `driveSegmentedResponse` in
`framework/src/lib/segmented-response.ts`. Inside ONE request scope it
calls `renderSegment()` repeatedly, calling
`promoteSnapshotsToCachedOverride()` between segments so unchanged partons
fp-skip on the next render. The benchmark replicates that **inner loop**
without the wake/keepalive timing:

1. Open ONE request scope via `runWithRequestAsync`.
2. Render segment 0 (cold — every parton renders). Drain the Flight
   stream fully (`await new Response(stream).arrayBuffer()`) — the
   vendored Flight server renders lazily, so without draining you would
   time the queueing call, not the render.
3. `promoteSnapshotsToCachedOverride()`.
4. Warm-tick loop, each tick: bump exactly one live cell's partition
   (`refreshSelector("cell:<id>?<args>")`, the same selector a real cell
   write fires), render, drain, record elapsed + bytes, promote.

A subtlety the loop handles: the **first** warm tick still re-renders
everything. A leaf's cell dependency is only recorded *during* its
render, so its warm fingerprint differs from its cold fingerprint until
one warm pass folds it in — only from the second warm tick does the
fp-skip steady state hold. The runner runs one settling tick, then
discards a generous warmup window (≥50) before measuring.

## The correctness gate (proven before any number is trusted)

A warm tick MUST re-render only the bumped parton plus its wrapper
ancestors — never all N. The runner proves this every run via a
module-level render counter in the fixture:

- **Steady-state warm renders ≈ `changed + depth`**, NOT N. For the
  scaling sweep (one cell, depth 2) that is **3** re-renders whether N is
  10 or 1000. The run **hard-fails** if this doesn't hold — a benchmark
  that secretly measures cold renders is worse than none.
- The table's `rndr` column shows `warm / cold` re-renders, e.g. `3/1002`
  at N=1000: 3 warm vs 1002 cold. The chasm between them is the proof.

Emitted **bytes** are reported but do **not** gate. Under the in-process
dev Flight runtime the wire carries debug metadata (component source,
server stacks) that inflates both cold and warm payloads and can make the
warm placeholder wire comparable to — or larger than — the cold body at
large N. That is a real observation about the fp-skip wire, not a
measurement fault; production Flight (`--prod`) omits the debug channel.
The render-count gate is the load-bearing faithfulness proof.

## Dev vs prod Flight

The vendored Flight entry
(`node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/server.edge.js`)
branches on `process.env.NODE_ENV` at require-time: the **development**
build emits debug-model chunks (component source, server stacks, `jsxDEV`
provenance); the **production** build omits them. Both run the same
render + fp-skip path — only React's serialization differs.

`--prod` sets `NODE_ENV=production` in the spawned bench process so the
vitest worker requires the production build. Vitest's `NODE_ENV ??=
"test"` is a *nullish* assignment, so an explicit value survives; the
worker hard-fails the run if `--prod` was requested but `NODE_ENV` is not
`production` at render time, so a clobbered env can never masquerade as a
prod result. The Flight build in effect is stamped into the artifact's
`runtime` field and the table header (`dev Flight` / `prod Flight`).

What changes, measured (post-fold master, node v24, M=1, D=2):

- **Payload bytes collapse.** At N=10 the dev cold body is ~78 KB; under
  `--prod` it is ~3 KB — a ~25× drop, entirely the debug-model chunks the
  production build omits. The ratio shrinks as the page's real content
  grows (at N=1000, ~1.48 MB dev → ~252 KB prod, ~6×), but the absolute
  debug overhead the prod build strips is large at every N. This byte
  drop is the objective proof the production build actually loaded (the
  env var reaching the conditional is necessary, not sufficient — the
  bytes are the evidence).
- **Warm-tick latency drops ~4–5×.** A large slice of the dev warm-tick
  cost is React's debug serialization (`emitOutlinedDebugModelChunk`,
  `renderDebugModel`, `collectStackTrace`, `jsxDEV` — ~40% of self-time
  at N=1000); under `--prod` those frames are absent from the flame
  graph, so the residual is the framework's own render +
  fingerprint/fold + Flight encode work plus GC. Prod's scaling curve
  bends less than dev's — the debug channel was a meaningful contributor
  to the dev curve's large-N super-linearity, though both still grow
  super-linearly (the O(tree) fold tax lives in both).

Which to use:

- **dev (default) — framework-slop hunting + regression tracking.** It
  amplifies the framework's own per-subtree work and is a stable signal:
  it does not shift when React's debug channel changes between versions.
  The committed `server-warm-tick.json` is the dev baseline.
- **prod (`--prod`) — honest absolute numbers.** What a deployed tick
  actually costs. The committed `server-warm-tick.prod.json` is the prod
  baseline. Do NOT compare a dev p50 against a prod p50 — they measure
  different runtimes.

## Scenarios

| Category | Sweep | Holds | Measures |
|---|---|---|---|
| **scaling** (headline) | N ∈ {10, 50, 100, 500, 1000} | M=1, D=2 | warm-tick µs vs world size — the O(tree) tax curve |
| **dashboard** | M ∈ {1, 10, 50, 200} | N=200, D=2 | cost per tick as change-density rises; each tick bumps ALL M cells so one segment carries M changes and the fixed overhead amortizes |
| **depth** | D ∈ {1, 4, 16} | N=100, M=1 | descendant-fold cost of proving a deep subtree unchanged |
| **pulse** | bump history ∈ {512, 20k} | N=M=512, D=2, one shared cell | invalidation-registry query cost under ticker history — the two rows must cost the same |
| **soak** | N ∈ {100, 1000, 5000} × M ∈ {0, N/10} | 3 partons/connection | per-HELD-CONNECTION cost: steady-state heap/RSS, idle wake-filter CPU, per-wake tick CPU — see [soak](#soak--what-a-held-live-connection-costs) |

The fixture is `buildDashboardPage({ partons: N, liveCells: M, depth: D })`
(`bench/server/fixture.tsx`): N addressable leaf partons, M of them live
(each reading a DISTINCT inline `localCell`, so bumping cell i shifts only
leaf i's fingerprint), nested D wrappers deep. Each Render is trivial (a
span with the cell value) so the measurement isolates framework overhead,
not user work.

The **pulse** category flips the fixture's cell topology
(`sharedPulseCell: true`): all 512 live leaves read partitions
`{part: i}` of ONE shared module cell — the website world-pulse shape
(`world.pulse` partitioned per chunk coordinate), where every leaf's
fold queries the SAME selector name in the invalidation registry.
Both rows pre-fire ticker bumps (`soakBumps`) before the request's
first render so every partition is populated; they differ only in
history length — one bump per partition (`P=512`) vs ~39 per
partition (`+20k`, a few minutes of 512 tickers at 0.1–5s each). The
pair is the registry-compaction gate: the registry stores one entry
per (name, constraints) pair, so bump history must not change fold
cost — if `+20k` costs more than `P=512`, registry queries are
scaling with bump count instead of partition cardinality.

## soak — what a held live connection costs

The warm-tick categories price a TICK; the soak category prices a
CONNECTION — the number a channel-as-primary-transport decision needs.
It opens N real live subscriptions in-process (each the full production
shape: `runWithRequestAsync` request scope, `driveSegmentedResponse`,
connection session via `?__conn=`, per-parton lanes, parked at the wake
race) and holds them while measuring. Kernel-side per-connection cost
(sockets, TLS, HTTP framing) is a known constant and deliberately OUT
of scope — the client end is an in-process discarding reader; what's
measured is the FRAMEWORK's share: the request ALS scope, the
connection session, the parked driver's promise/timer graph, the
route's snapshots + cached-override maps, and the per-bump wake-filter
scan.

Each connection serves its own 3-parton page (1 live leaf + 1 static
leaf + 1 wrapper, id-prefixed) in its own state bucket — a
per-connection `x-test-scope`, the framework's existing seam for
isolating process-wide snapshot buckets — so one cell bump is relevant
to exactly one connection; the other N−1 wake, run the relevance
filter over their own snapshots, and re-arm without rendering. The
scope seam is dev-only, so **soak is a dev-Flight category**: it probes
the seam up front and hard-fails under `--prod` rather than silently
measuring cross-talk (the dev→prod lane-render ratio is already
characterized by the main table).

Per scenario (N connections, M = N/10 or 0 active):

- **heap/c, rss/c** — post-gc per-connection footprint: heapUsed / RSS
  delta between "fixtures built" and "all N parked", ÷ N. A throwaway
  connection opens (and closes) before the baseline so one-time lazy
  initialization isn't attributed to the held set. RSS is
  page-granular, includes allocator slack, and rarely shrinks — it is
  process-CUMULATIVE, so scenarios after the first in one worker can
  report near-zero deltas (they reuse pages an earlier scenario
  retained); read the worker's FIRST scenario as the honest RSS bound.
  Post-gc heap needs a real `global.gc`; the CLI passes `--expose-gc`
  via NODE_OPTIONS.
- **idle µs** — the idle keepalive path: CPU per IRRELEVANT
  `refreshSelector` across all N. Every bump wakes every parked
  driver's bump arm; each scans its own snapshots
  (`routeHasRelevantBump`), misses, and re-arms fresh wake promises +
  keepalive timer without rendering a thing. This is the standing tax
  bump traffic levies on every held connection.
- **p50 / cpu / µs/lane / tick B** — a wake tick: M cell bumps fired in
  one synchronous batch (one wake round for every driver), completing
  at the Mth `settled` marker. Wall p50 is the client-observable wake
  latency; cpu is process-CPU per tick (including the N−M idle scans);
  µs/lane amortizes it per delivered lane.
- **B/wake** — heap a parked connection accretes per wake round
  (post-gc drift ÷ wakes). ≈0, gc noise: every wake arm is a
  disposer-registered listener released when its race iteration
  settles, so a parked connection's heap doesn't grow with bump
  traffic. This column is the regression detector for that invariant
  — a promise-shaped arm (a `.then` reaction frees only when its
  promise settles, and irrelevant bumps re-arm the race inside one
  park) reads directly as hundreds of B/wake. The soak widens the
  keepalive (`_setKeepaliveMs`, a bench-visible override in
  `segmented-response.ts` — the production window is shorter than a
  5000-connection scenario's span), which is what makes the drift
  measurable at all.

The correctness gate, in the spirit of the warm-tick one, proves the
measurement is what it claims before any number is trusted:

- **Idle connections render NOTHING between wakes** — the module-level
  render counter must not move across the idle-bump phase. Zero, not
  "small".
- **A tick renders exactly M bodies** — the M bumped leaves lane;
  no sibling, no wrapper, no other connection runs. Checked on the gate
  tick and on every measured tick.
- **Every connection stays held to teardown** — a drive loop exiting
  early (keepalive, crash) would silently shrink N under the
  measurement.

The run **hard-fails** on any violation. Park and tick completion are
detected from the driver's own wire milestones — the `lanes` marker
(switched to per-parton lanes, parked at the wake race) and the
`settled` marker (a wake's lanes fully drained) — never from timing.

Soak ticks are far heavier than warm ticks (one tick = M lane renders
plus N−M wake-filter scans), so the category has its own defaults
(warmup=5, measure=30); explicit `--warmup`/`--measure` apply to soak
too. The `measure` count doubles as the idle-phase bump count.

## Reading the numbers

The stdout table (and the JSON artifact) report, per scenario:

- `cold ms` — wall time of the cold segment 0 (all N render).
- `p50/p95/p99 µs` — warm-tick latency percentiles over the measured
  window. **This is the number.** In the scaling sweep, watch p50 climb
  with N while `rndr` stays flat at 3 — same render work, rising cost.
- `ticks/s` — throughput (from mean warm-tick latency).
- `warm B` / `cold B` — mean warm payload / cold payload (KiB). Reported,
  not gated (see above).
- `rndr` — `warm/cold` re-render counts (the gate).
- `gate` — `ok` / `FAIL`.

## The JSON artifact (regression substrate)

Each run writes a JSON artifact with every scenario's numbers plus a
**git SHA** + **node version** + **`runtime`** (dev/prod) + warmup/measure
settings, so two runs are directly comparable over time. Soak results
ride the same artifact in their own `soak` array (their axes differ
from the warm-tick scenarios). The path depends
on the runtime so the dev and prod baselines coexist:

- dev (default) → `bench/results/server-warm-tick.json`
- `--prod` → `bench/results/server-warm-tick.prod.json`

Both are committed. To track a change, compare against the SAME runtime's
baseline:

```bash
git stash && yarn bench:server   # baseline → note the SHA in the JSON
mv bench/results/server-warm-tick.json bench/results/baseline.json
git stash pop && yarn bench:server   # your change
# diff the p50/p99 columns between baseline.json and the new file
```

Wiring this into CI as a regression gate is a deliberate follow-on — it
needs the CI context (where to store baselines, what regression threshold
trips a failure, how to handle hardware variance between runners).

## `--prof` — the flame graph

`yarn bench:server --prof` runs ONE scenario (`scaling/N=1000`) in a
single forked worker whose `execArgv` carries Node's `--cpu-prof`, writing
`bench/results/prof/warm-tick.cpuprofile`. Add `--prod` to profile the
production runtime instead; it writes a distinct
`warm-tick.prod.cpuprofile` so the dev and prod profiles coexist. (The
fork `execArgv` is the seam that reaches the render work —
`NODE_OPTIONS=--cpu-prof` on the launcher would only profile the launcher
blocking in `spawnSync`; thread pools don't honor `--cpu-prof` cleanly,
forks do. The fork inherits the launcher's env, so `--prod`'s
`NODE_ENV=production` reaches it. Node writes one profile per process; the
CLI keeps the largest — the render worker — and drops the near-empty
manager profiles.) Profiles stay local (`bench/results/prof/` is
gitignored).

Open it:

- Chrome DevTools → Performance → "Load profile…" → pick the
  `.cpuprofile`.
- or `npx speedscope bench/results/prof/warm-tick.cpuprofile`.

Where the time goes (N=1000, M=1):

- **dev Flight.** The self-time is dominated by React's *dev-only* debug
  serialization — `emitOutlinedDebugModelChunk` (~20%), `renderDebugModel`
  (~8%), `jsxDEV` (~6%), `collectStackTrace` (~5%), `outlineComponentInfo`
  — together roughly 40% of samples, plus ~15% GC churning the debug
  objects. The framework's own work is a thin slice on top: the parton
  `Component` body (`partial.tsx`) and fingerprint hashing (`hash.ts`) are
  each ~2%. So at large N the dev curve is mostly measuring React's debug
  channel, not framework slop — which is exactly why dev is the *stable*
  signal for slop hunting (framework work stands out against a fixed dev
  backdrop) but not the honest absolute cost.
- **prod Flight (`--prod`).** The entire debug-serialization band is gone
  (those frames are absent from the flame graph), so what remains is the
  framework's render + fingerprint/fold + Flight encode path and GC. This
  is the profile to read when targeting the genuine per-tick cost.

A coarse render-vs-fp-vs-encode phase split was deliberately left out: a
clean split needs invasive instrumentation of framework internals that
would pollute the hot path. The cpu-prof flame graph already attributes
the cost by frame, which is enough to target.

---

# Client-scroll harness

`node bench/client-scroll.mjs` — the standing tool for profiling the
website world's **scroll frame on the client**. Where `bench:server`
measures the per-tick server CPU and `website/validate-world.mjs`
asserts correctness + wire budgets, this one answers: *where do the
milliseconds of a scroll frame go?* It boots the prod website preview on
its own port (mirroring `validate-world.mjs`), drives a fixed scripted
scroll with Playwright, and captures three views through the Chrome
DevTools Protocol.

```bash
node bench/client-scroll.mjs            # build (sourcemapped) + preview + measure
node bench/client-scroll.mjs --no-build # reuse the current dist (must be a
                                        #   PARTON_BENCH_SOURCEMAP build for symbols)
node bench/client-scroll.mjs --dev      # drive the dev server (readable names,
                                        #   but dev-Flight overhead — smoke only)
node bench/client-scroll.mjs --soak     # also profile an idle pulse-soak window
node bench/client-scroll.mjs --viewport=2560x1440   # denser world → more observers
node bench/client-scroll.mjs --port=5187 --out=bench/results/client
```

Default rebuilds the website with `PARTON_BENCH_SOURCEMAP=1` (hidden
client sourcemaps — the prod bundle mangles every function name, so the
profile can't be read without them). `--no-build` reuses the current
`website/dist` (which must be a sourcemap build).

## The workload

A deterministic rAF-driven scroll — east / south / diagonal, each a fixed
**px per second for a fixed wall-time** — so every run covers the same
world-distance in the same duration regardless of the frame rate
achieved. Fast enough (2200 px/s) that many cull flips + lane commits
land per frame: the regime the over-budget frames live in. The driver
runs inside the page (`requestAnimationFrame`), not over the CDP wire, so
there is no per-step protocol overhead skewing the cadence; its frames
are named `__benchStep` and excluded from the app's scripting total.

## What it captures

1. **DevTools performance trace** (`Tracing`, `ReturnAsStream`, the full
   `disabled-by-default-devtools.timeline,…,disabled-by-default-v8.cpu_profiler,…`
   category set) → `trace-<ts>.json`, loadable in DevTools Performance /
   `chrome://tracing`. The harness also parses it for the **main-thread
   self-time by rendering phase** (scripting / style / layout /
   intersection / paint / composite / gc / network — computed by
   ts-containment on the busiest `CrRendererMain` thread so nested
   timeline events don't double-count) and the **per-frame main-thread
   self-time** binned into `BeginMainThreadFrame` windows.
2. **CPU sampling profile** (`Profiler`, 50µs interval) → self-time
   aggregated per function, **symbolicated** through the client bundle's
   hidden sourcemaps (Node's `module.SourceMap`) so the hotspot list
   reads as `name (source:line)` and rolls up per subsystem (React /
   cull+visibility / partial cache / channel / app telemetry).
3. **Frame stats** from an injected `PerformanceObserver` (rAF-delta
   buckets, `longtask`, `layout-shift` / CLS).

## Reading the numbers — two frame metrics, and why

- **MAIN-THREAD FRAME COST** (per-frame self-time from the trace) is the
  headline. It is **present-independent**: it counts only the work the
  main thread does per frame, so it reflects what a fast-GPU device (an
  M-series Mac, where the compositor is never the bottleneck) actually
  pays. This is the metric to target.
- **FRAME PACING** (rAF deltas) is wall-clock frame spacing. In **headless
  Chromium the compositor is software (SwiftShader)**, so a fast scroll is
  usually present/GPU-bound, not main-thread-bound — the rAF `>8.33ms`
  count mostly measures the software compositor, not framework cost. Read
  it as a sanity check, not the target. (On a real 120Hz display the two
  converge, because there present is nearly free and the main thread sets
  the frame time.)

Because the multi-agent / loaded-machine CPU contention that a bench box
often runs under adds noise to *absolute* self-time, the robust
before/after signal is a **function's or subsystem's share of scripting**
(`% of scripting`) — that ratio is stable across runs even when the
absolute total swings. The harness prints it and saves it.

## Artifacts

`bench/results/client/` (gitignored — large + machine-local):
`trace-<ts>.json` (open in DevTools) and `client-scroll-<ts>.json` +
`client-scroll.latest.json` (the machine-readable summary: phases,
per-frame buckets, rAF buckets, subsystem rollups, top-40 functions). A
before/after pass is a diff of two summaries.

## What a run of it found (2026-07, e8c60b5)

The over-budget scroll frames are **not** dominated by framework slop.
Per-frame main-thread self-time tops out at ~4–5ms (p95 ~2.5ms), 63% of
which is scripting; the rest of the wall-clock frame is the rendering
pipeline (paint / style / composite) + software present. Within
scripting, the biggest single leaf is the app's own scroll telemetry
handler (`website/src/app/world/scroller.tsx` — reading scroll position
every frame), then React reconciliation of the real DOM churn as chunks
stream and park, then the template merge (`substituteNested`, already
batched by React to ~one walk per commit and spine-bound, not
content-bound). The cull/visibility machinery is a thin ~4% of scripting.
In short: the scroll path is already lean and the residual cost is
largely inherent (real reconciliation + pipeline) rather than reducible
framework overhead — a useful negative result the harness makes legible.

---

# World idle-CPU benchmark

`yarn build:website && node bench/world-idle-cpu.mjs` — prices the
server's **standing cost of one idle client after a world tour**. Where
`bench:server`'s soak category prices held connections against
synthetic per-connection pages, this one drives the REAL website world
through the scenario that first exposed the wake-filter pathology: load
at the origin, scroll to the top edge, dwell, scroll to the top-left
corner, stop. The tour leaves hundreds of chunk/quad snapshots in the
route bucket and hundreds of pulse tickers bumping at 0.1–5s each; the
server's idle CPU afterwards is the direct price of the per-bump
relevance filter (`_routeMatchingBumpIds` → `queryMatchingTs`) over
that snapshot × partition × bump-rate product.

Three phases, each the server tree's %CPU (per-second `ps` samples,
last-10s average):

- **baseline** — idle at the origin right after boot: the healthy floor.
- **cornerIdle** — idle at the top-left corner after the tour. **The
  number.** It must settle near the baseline; a saturated core (~100%)
  means the server spends its budget re-deciding NOT to render.
- **afterClose** — zero clients, tickers still firing: attribution.
  Connection-driven burn drops away; the remainder is the tickers' own
  write cost.

`--viewport=3840x2160` scales the visible set; `--prof` boots the
preview under `--cpu-prof` (profiles in `/tmp/parton-cpu-prof`). The
browser column is the harness's own headless Chromium tree only —
software compositor, so its paint share overstates a real GPU; use
`client-scroll.mjs` for the client-side story.

Each run APPENDS to the committed artifact
`bench/results/world-idle-cpu.json` (git SHA, node version, viewport,
phase averages), so the corner-idle number is directly comparable
across commits — the regression substrate for the wake-filter path.
