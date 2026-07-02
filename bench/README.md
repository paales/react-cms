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
yarn bench:server --only=depth    # one category (scaling | dashboard | depth | pulse)
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
| **pulse** | soak ∈ {512, 20k} | N=M=512, D=2, one shared cell | invalidation-registry query cost under ticker history — the two rows must cost the same |

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
settings, so two runs are directly comparable over time. The path depends
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
