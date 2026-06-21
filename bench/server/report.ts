/**
 * Human-readable table renderer + JSON artifact shape for the server
 * warm-tick benchmark. The artifact is the regression-tracking substrate:
 * every run stamps a git SHA, node version, and Flight `runtime` (dev vs
 * prod build) so two `bench/results/*.json` files are directly comparable
 * over time.
 */

import type { ScenarioResult } from "./runner.tsx"

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
