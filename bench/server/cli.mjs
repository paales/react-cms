#!/usr/bin/env node
/**
 * `yarn bench:server` entry point.
 *
 * Spawns vitest against `bench/vitest.bench.config.ts` with the
 * `react-server` condition (so the vendored Flight server resolves its
 * hook-less build) — the same transform env the rsc test tier uses, but
 * pointed only at the bench file. This wrapper is the seam where the
 * `--prof` flag and env knobs get applied; the actual benchmark logic
 * lives in the `.bench.ts` file vitest runs.
 *
 * Usage:
 *   yarn bench:server                 full matrix (DEV Flight) → table + JSON
 *   yarn bench:server --prod          full matrix against the PRODUCTION
 *                                     react-server-dom build → .prod.json
 *   yarn bench:server --prof          ONE scenario (scaling/N=1000) under
 *                                     Node --cpu-prof → bench/results/prof/
 *   yarn bench:server --prod --prof   profile the PRODUCTION runtime
 *   yarn bench:server --only=depth    run only scenarios matching a name
 *   yarn bench:server --warmup=20 --measure=200
 *
 * Dev vs prod (see bench/README.md): the vendored Flight entry
 * (`node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/
 * server.edge.js`) branches on `process.env.NODE_ENV` at require-time,
 * loading the development build (debug-model chunks, source stacks) or
 * the production build (those omitted). `--prod` sets NODE_ENV=production
 * in this spawned process so the worker requires the production build —
 * vitest's `NODE_ENV ??= "test"` is a nullish assign, so an explicit
 * value survives. Dev stays the default.
 *
 * Flags map to BENCH_* env vars the bench file reads (see
 * server-warm-tick.bench.ts).
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const val = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const prof = has("--prof")
const prod = has("--prod")
const env = { ...process.env }

if (val("warmup")) env.BENCH_WARMUP = val("warmup")
if (val("measure")) env.BENCH_MEASURE = val("measure")
if (val("only")) env.BENCH_ONLY = val("only")
if (val("out")) env.BENCH_OUT = val("out")

// `--prod`: load the PRODUCTION react-server-dom build instead of the
// development one. The vendored Flight entry branches on
// `process.env.NODE_ENV` at require-time (in the worker), so setting it
// here in the spawned env is the whole lever — it propagates to the
// vitest worker (and, under --prof, the fork, which inherits parent
// env). Vitest's `NODE_ENV ??= "test"` is a nullish assign, so this
// explicit value survives. BENCH_PROD lets the bench file stamp the
// artifact's `runtime` field and pick the prod JSON path by default.
if (prod) {
  env.NODE_ENV = "production"
  env.BENCH_PROD = "1"
}

// The vendored Flight server's internal `require("react")` goes through
// Node's CJS resolver, which ignores Vite conditions — so set the
// condition process-wide, exactly as `test:rsc` does. (The prof fork
// also sets it via execArgv; harmless to set both.) `--expose-gc` gives
// the soak category's post-gc heap samples a real `global.gc` — it is
// one of the V8 flags NODE_OPTIONS accepts, and it reaches the vitest
// worker the same way the condition does.
const baseNodeOptions = ["--conditions=react-server", "--expose-gc"]

// Pick the config: the prof variant runs in a single forked child whose
// execArgv carries --cpu-prof (so the profile captures the render work,
// not this launcher). See bench/vitest.prof.config.ts.
const configPath = prof ? "bench/vitest.prof.config.ts" : "bench/vitest.bench.config.ts"

const profDir = resolve(process.cwd(), "bench/results/prof")
if (prof) {
  // Profile a single, large scenario so the flame graph is dominated by
  // steady-state warm-tick work, not scenario churn.
  env.BENCH_ONLY = env.BENCH_ONLY ?? "scaling/N=1000"
  // Keep the measured window meaty so the profile has signal, but bounded
  // — --cpu-prof slows execution, and N=1000 ticks are ~80ms each.
  env.BENCH_WARMUP = env.BENCH_WARMUP ?? "20"
  env.BENCH_MEASURE = env.BENCH_MEASURE ?? "400"
  mkdirSync(profDir, { recursive: true })
  // Start clean so `pickLargestProfile` can't pick up a stale loose
  // profile, but preserve the OTHER mode's stable artifact so a dev and
  // a prod profile can coexist side by side.
  const otherStable = prod ? "warm-tick.cpuprofile" : "warm-tick.prod.cpuprofile"
  for (const f of readdirSync(profDir)) {
    // Drop loose node-generated profiles and this mode's prior artifact;
    // keep the other mode's so a dev and a prod profile coexist.
    if (f.endsWith(".cpuprofile") && f !== otherStable) {
      rmSync(join(profDir, f), { force: true })
    }
  }
  console.log(
    `[bench] --prof: profiling "${env.BENCH_ONLY}" (${prod ? "prod" : "dev"} Flight) → ${profDir}/`,
  )
}

env.NODE_OPTIONS = [env.NODE_OPTIONS, ...baseNodeOptions].filter(Boolean).join(" ")

const vitestArgs = ["vitest", "run", "--config", configPath]

const res = spawnSync("yarn", vitestArgs, { stdio: "inherit", env })

if (prof) {
  // Node emitted one CPU.*.cpuprofile per profiled process. The render
  // worker's profile is by far the largest; rename it to a stable name
  // and drop the near-empty manager profiles.
  const target = pickLargestProfile(profDir)
  if (target) {
    // Prod and dev profiles get distinct names so both can coexist.
    const stable = join(profDir, prod ? "warm-tick.prod.cpuprofile" : "warm-tick.cpuprofile")
    if (target !== stable) renameSync(target, stable)
    // Drop only the near-empty manager profiles (Node's loose CPU.*
    // files), keeping BOTH stable artifacts so a dev and a prod profile
    // survive across runs.
    const keep = new Set(["warm-tick.cpuprofile", "warm-tick.prod.cpuprofile"])
    for (const f of readdirSync(profDir)) {
      if (f.endsWith(".cpuprofile") && !keep.has(f)) {
        rmSync(join(profDir, f), { force: true })
      }
    }
    console.log(`\n[bench] CPU profile: ${stable}`)
    console.log(
      "[bench] open in Chrome DevTools (Performance → Load profile) or `npx speedscope " +
        stable +
        "`",
    )
  } else {
    console.log("[bench] WARNING: no .cpuprofile produced — check the fork execArgv")
  }
}

process.exit(res.status ?? 1)

/** Return the path of the largest FRESH profile in `dir` (the render
 *  worker), or null if none. Only loose `CPU.*.cpuprofile` files Node
 *  just emitted are considered — never the preserved `warm-tick*` stable
 *  artifacts from a prior run, which would otherwise poison the pick (a
 *  big dev profile could masquerade as this run's prod render worker). */
function pickLargestProfile(dir) {
  let best = null
  let bestSize = -1
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("CPU.") || !f.endsWith(".cpuprofile")) continue
    const p = join(dir, f)
    const size = statSync(p).size
    if (size > bestSize) {
      bestSize = size
      best = p
    }
  }
  return best
}
