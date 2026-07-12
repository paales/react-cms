/**
 * Human-readable table renderer + JSON artifact shape for the server
 * warm-tick benchmark. The artifact is the regression-tracking substrate:
 * every run stamps a git SHA, node version, and Flight `runtime` (dev vs
 * prod build) so two `bench/results/*.json` files are directly comparable
 * over time.
 */

import type { ScenarioResult } from "./runner.tsx"
import type { SharedSoakScenarioResult, SoakScenarioResult } from "./soak-runner.ts"

export interface BenchArtifact {
  generatedAt: string
  gitSha: string
  nodeVersion: string
  /** Which react-server-dom build the numbers were measured against:
   *  `"dev"` (debug-model chunks present) or `"prod"` (`--prod`, those
   *  omitted). The two are NOT comparable in absolute terms — see
   *  bench/README.md. */
  runtime: "dev" | "prod"
  warmup: number
  measure: number
  results: ScenarioResult[]
  /** Held-connection soak category (its axes differ from the warm-tick
   *  scenarios, so it rides its own array + table). */
  soak: SoakScenarioResult[]
  /** Shared-scope soak category: N viewers of ONE world — the fan-out
   *  baseline broadcast lanes must beat (renders/tick = N×M today). */
  shared: SharedSoakScenarioResult[]
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length)
}
function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s
}
function fix(n: number, d = 1): string {
  return n.toFixed(d)
}
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}k`
}

const COLS: Array<{ head: string; width: number }> = [
  { head: "scenario", width: 16 },
  { head: "N", width: 5 },
  { head: "M", width: 4 },
  { head: "D", width: 3 },
  { head: "cold ms", width: 8 },
  { head: "p50 µs", width: 9 },
  { head: "p95 µs", width: 9 },
  { head: "p99 µs", width: 9 },
  { head: "ticks/s", width: 9 },
  { head: "warm B", width: 8 },
  { head: "cold B", width: 8 },
  { head: "rndr", width: 6 },
  { head: "gate", width: 5 },
]

export function renderTable(artifact: BenchArtifact): string {
  const lines: string[] = []
  lines.push(
    `server warm-tick benchmark  ·  ${artifact.gitSha}  ·  node ${artifact.nodeVersion}  ·  ` +
      `${artifact.runtime} Flight  ·  warmup=${artifact.warmup} measure=${artifact.measure}`,
  )
  const header = COLS.map((c) => pad(c.head, c.width)).join("  ")
  lines.push(header)
  lines.push("-".repeat(header.length))

  for (const r of artifact.results) {
    const cells = [
      pad(r.name, COLS[0].width),
      padLeft(String(r.params.partons), COLS[1].width),
      padLeft(String(r.params.liveCells), COLS[2].width),
      padLeft(String(r.params.depth), COLS[3].width),
      padLeft(fix(r.coldMs, 2), COLS[4].width),
      padLeft(fix(r.warm.p50us, 1), COLS[5].width),
      padLeft(fix(r.warm.p95us, 1), COLS[6].width),
      padLeft(fix(r.warm.p99us, 1), COLS[7].width),
      padLeft(fix(r.ticksPerSec, 0), COLS[8].width),
      padLeft(kb(r.warmBytesMean), COLS[9].width),
      padLeft(kb(r.coldBytes), COLS[10].width),
      padLeft(`${r.gate.warmRenders}/${r.gate.coldRenders}`, COLS[11].width),
      padLeft(r.gate.faithful ? "ok" : "FAIL", COLS[12].width),
    ]
    lines.push(cells.join("  "))
  }

  lines.push("")
  lines.push(
    "rndr = warm re-renders / cold re-renders (gate: warm « cold proves O(1)-ish, not O(tree), render work)",
  )
  return lines.join("\n")
}

const SOAK_COLS: Array<{ head: string; width: number }> = [
  { head: "scenario", width: 18 },
  { head: "N", width: 6 },
  { head: "M", width: 5 },
  { head: "open ms", width: 9 },
  { head: "heap/c", width: 8 },
  { head: "rss/c", width: 8 },
  { head: "B/wake", width: 7 },
  { head: "idle µs", width: 8 },
  { head: "p50 µs", width: 10 },
  { head: "cpu µs", width: 10 },
  { head: "µs/lane", width: 8 },
  { head: "tick B", width: 8 },
  { head: "rndr", width: 9 },
  { head: "gate", width: 5 },
]

export function renderSoakTable(artifact: BenchArtifact): string {
  const lines: string[] = []
  lines.push(
    `held-connection soak  ·  ${artifact.gitSha}  ·  node ${artifact.nodeVersion}  ·  ` +
      `${artifact.runtime} Flight`,
  )
  const header = SOAK_COLS.map((c) => pad(c.head, c.width)).join("  ")
  lines.push(header)
  lines.push("-".repeat(header.length))

  for (const r of artifact.soak) {
    const t = r.ticks
    const cells = [
      pad(r.name, SOAK_COLS[0].width),
      padLeft(String(r.params.connections), SOAK_COLS[1].width),
      padLeft(String(r.params.active), SOAK_COLS[2].width),
      padLeft(fix(r.openMs, 0), SOAK_COLS[3].width),
      padLeft(kb(r.heap.heapPerConnection), SOAK_COLS[4].width),
      padLeft(kb(r.heap.rssPerConnection), SOAK_COLS[5].width),
      padLeft(fix(r.heap.heapDriftPerConnectionPerWake, 0), SOAK_COLS[6].width),
      padLeft(fix(r.idleWake.cpuUsPerBump, 1), SOAK_COLS[7].width),
      padLeft(t ? fix(t.wall.p50us, 0) : "-", SOAK_COLS[8].width),
      padLeft(t ? fix(t.cpuMeanUs, 0) : "-", SOAK_COLS[9].width),
      padLeft(t ? fix(t.cpuPerLaneUs, 1) : "-", SOAK_COLS[10].width),
      padLeft(t ? kb(t.bytesMeanPerTick) : "-", SOAK_COLS[11].width),
      padLeft(`${r.gate.tickRenders}/${r.gate.coldRenders}`, SOAK_COLS[12].width),
      padLeft(r.gate.faithful ? "ok" : "FAIL", SOAK_COLS[13].width),
    ]
    lines.push(cells.join("  "))
  }

  lines.push("")
  lines.push(
    "heap/c, rss/c = post-gc per-connection footprint · B/wake = heap a parked connection accretes per wake round · " +
      "idle µs = CPU per irrelevant bump across all N · rndr = gate-tick renders / cold renders " +
      "(gate additionally proves 0 renders across the idle bumps and 0 early closes)",
  )
  return lines.join("\n")
}

const SHARED_COLS: Array<{ head: string; width: number }> = [
  { head: "scenario", width: 18 },
  { head: "N", width: 5 },
  { head: "M", width: 4 },
  { head: "rndr/tick", width: 9 },
  { head: "open ms", width: 9 },
  { head: "heap/c", width: 8 },
  { head: "rss/c", width: 8 },
  { head: "B/wake", width: 7 },
  { head: "idle µs", width: 8 },
  { head: "p50 µs", width: 10 },
  { head: "cpu µs", width: 10 },
  { head: "µs/lane", width: 8 },
  { head: "tick B", width: 9 },
  { head: "gate", width: 5 },
]

export function renderSharedSoakTable(artifact: BenchArtifact): string {
  const lines: string[] = []
  lines.push(
    `shared-scope soak (N viewers, ONE world)  ·  ${artifact.gitSha}  ·  node ${artifact.nodeVersion}  ·  ` +
      `${artifact.runtime} Flight`,
  )
  const header = SHARED_COLS.map((c) => pad(c.head, c.width)).join("  ")
  lines.push(header)
  lines.push("-".repeat(header.length))

  for (const r of artifact.shared) {
    const t = r.ticks
    const cells = [
      pad(r.name, SHARED_COLS[0].width),
      padLeft(String(r.params.connections), SHARED_COLS[1].width),
      padLeft(String(r.params.active), SHARED_COLS[2].width),
      padLeft(String(r.gate.tickRenders), SHARED_COLS[3].width),
      padLeft(fix(r.openMs, 0), SHARED_COLS[4].width),
      padLeft(kb(r.heap.heapPerConnection), SHARED_COLS[5].width),
      padLeft(kb(r.heap.rssPerConnection), SHARED_COLS[6].width),
      padLeft(fix(r.heap.heapDriftPerConnectionPerWake, 0), SHARED_COLS[7].width),
      padLeft(fix(r.idleWake.cpuUsPerBump, 1), SHARED_COLS[8].width),
      padLeft(t ? fix(t.wall.p50us, 0) : "-", SHARED_COLS[9].width),
      padLeft(t ? fix(t.cpuMeanUs, 0) : "-", SHARED_COLS[10].width),
      padLeft(t ? fix(t.cpuPerLaneUs, 1) : "-", SHARED_COLS[11].width),
      padLeft(t ? kb(t.bytesMeanPerTick) : "-", SHARED_COLS[12].width),
      padLeft(r.gate.faithful ? "ok" : "FAIL", SHARED_COLS[13].width),
    ]
    lines.push(cells.join("  "))
  }

  lines.push("")
  lines.push(
    "rndr/tick = gate-tick renders — must equal N×M exactly: every bumped parton lanes once PER connection. " +
      "THE fan-out baseline broadcast lanes must collapse to M · tick B = downstream bytes/tick across all N wires · " +
      "µs/lane = tick CPU / (N×M) · gate additionally proves 0 idle renders, every connection settled every wake round, 0 early closes",
  )
  return lines.join("\n")
}
