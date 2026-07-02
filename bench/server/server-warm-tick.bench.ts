/**
 * Server warm-tick benchmark — vitest entry.
 *
 * Runs under the `rsc` transform environment (the `react-server`
 * condition + `vitePluginRscMinimal`, same as the rsc test tier) but is
 * NOT part of `yarn test`: the rsc project's include glob covers
 * `*.rsc.test.tsx` under the package dirs, never `bench/**` or
 * `*.bench.ts`. This file only runs via `yarn bench:server`, which points
 * vitest at `bench/vitest.bench.config.ts`.
 *
 * Env knobs (set by the `bench:server` CLI wrapper):
 *   BENCH_WARMUP   — warmup ticks discarded   (default 50)
 *   BENCH_MEASURE  — measured ticks            (default 500)
 *   BENCH_ONLY     — run only scenarios whose name includes this substring
 *                    (used by `--prof` to profile just `scaling/N=1000`)
 *   BENCH_OUT      — JSON artifact path        (default depends on runtime)
 *   BENCH_PROD     — "1" under `--prod`: the production react-server-dom
 *                    build is loaded (NODE_ENV=production), and the
 *                    default artifact path is the `.prod.json` sibling.
 */

import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "vitest"
import { type BenchArtifact, renderTable } from "./report.ts"
import { ALL_SCENARIOS, runScenario, type ScenarioResult } from "./runner.tsx"

const WARMUP = Number(process.env.BENCH_WARMUP ?? 50)
const MEASURE = Number(process.env.BENCH_MEASURE ?? 500)
const ONLY = process.env.BENCH_ONLY?.trim() || null
// Which react-server-dom build the worker actually loaded. The vendored
// entry keys off `process.env.NODE_ENV` at require-time, so reading it
// here in the same worker reports the build that is genuinely in effect
// — not merely what the CLI requested. `--prod` sets it to "production".
const RUNTIME = process.env.NODE_ENV === "production" ? "prod" : "dev"
const OUT =
  process.env.BENCH_OUT?.trim() ||
  (RUNTIME === "prod"
    ? "bench/results/server-warm-tick.prod.json"
    : "bench/results/server-warm-tick.json")

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

// One vitest `test` hosts the whole sweep so timing isn't fragmented
// across test boundaries. The default per-test timeout is far too short
// for ~9 scenarios × (warmup + measure) renders, so widen it generously.
test(
  "server warm-tick benchmark",
  async () => {
    // Fail loud if `--prod` was requested but the worker's NODE_ENV is not
    // "production" — that would mean something (a future vitest, the
    // environment) clobbered it before the vendored Flight entry was
    // required, so the worker is silently running the DEV build. A
    // mislabeled prod artifact is worse than a hard stop.
    if (process.env.BENCH_PROD === "1" && process.env.NODE_ENV !== "production") {
      throw new Error(
        `--prod requested but NODE_ENV="${process.env.NODE_ENV}" in the worker; ` +
          "the production react-server-dom build was NOT loaded. " +
          "Set NODE_ENV=production before the vendored Flight entry is imported.",
      )
    }

    // `BENCH_ONLY` matches by exact scenario name (`scaling/N=1000`) or by
    // category prefix (`scaling` → every `scaling/*`). Exact-first avoids
    // the substring trap where `scaling/N=10` would also catch `N=100`.
    const matches = (specName: string): boolean => {
      if (!ONLY) return true
      if (specName === ONLY) return true
      return specName.split("/")[0] === ONLY
    }
    const scenarios = ALL_SCENARIOS.filter((s) => matches(s.name))
    if (scenarios.length === 0) {
      throw new Error(`BENCH_ONLY="${ONLY}" matched no scenarios`)
    }

    const results: ScenarioResult[] = []
    for (const spec of scenarios) {
      const r = await runScenario(spec.name, spec.params, {
        warmup: WARMUP,
        measure: MEASURE,
        ...spec.options,
      })
      results.push(r)
    }

    const artifact: BenchArtifact = {
      generatedAt: new Date().toISOString(),
      gitSha: gitSha(),
      nodeVersion: process.version,
      runtime: RUNTIME,
      warmup: WARMUP,
      measure: MEASURE,
      results,
    }

    // Human-readable table to stdout.
    // eslint-disable-next-line no-console
    console.log("\n" + renderTable(artifact) + "\n")

    // JSON artifact (regression-tracking substrate).
    const outPath = resolve(process.cwd(), OUT)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8")
    // eslint-disable-next-line no-console
    console.log(`wrote ${OUT}`)

    // Hard-fail if any scenario's correctness gate did not hold — a wrong
    // measurement is worse than none.
    const unfaithful = results.filter((r) => !r.gate.faithful)
    if (unfaithful.length > 0) {
      throw new Error(`correctness gate FAILED for: ${unfaithful.map((r) => r.name).join(", ")}`)
    }
  },
  // Plain timeout (ms): ~14 scenarios × (warmup + measure) renders, with
  // N=1000 ticks at tens of ms each, runs minutes — far past the 5s default.
  600_000,
)
