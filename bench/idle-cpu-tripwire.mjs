/**
 * Idle-CPU ledger tripwire — asserts the LATEST committed
 * `bench/results/world-idle-cpu.json` entry for the default geometry
 * (2560×1440, no query) is healthy: cornerIdle below a generous ceiling
 * and afterClose at the process floor.
 * Run: `node bench/idle-cpu-tripwire.mjs` — reads the committed artifact
 * only; boots nothing.
 *
 * The MEASUREMENT happens on dev machines (`node bench/world-idle-cpu.mjs`
 * appends to the artifact) — CI runners can't measure CPU meaningfully.
 * What CI can do is guard the LEDGER: a regression that slips into the
 * committed history (a re-measure after a wake-path change that pegs
 * cornerIdle, committed without reading it) trips here visibly instead
 * of silently becoming the new baseline.
 *
 * Ceilings are deliberately generous — measured healthy values are
 * cornerIdle ~4–12% and afterClose ~0.5–5%; the ceilings catch the
 * pathology class (a saturated core re-deciding not to render, ~100%),
 * not machine variance.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const VIEWPORT = "2560x1440"
const CORNER_IDLE_MAX = 15 // %
const AFTER_CLOSE_MAX = 5 // %

const artifact = join(dirname(fileURLToPath(import.meta.url)), "results", "world-idle-cpu.json")
const entries = JSON.parse(readFileSync(artifact, "utf8"))

// Latest default-geometry entry: the canonical viewport, no query
// override (?chunk=128 runs are a different — denser — world).
const latest = entries.filter((e) => e.viewport === VIEWPORT && !e.query).at(-1)
if (!latest) {
  console.error(`✗ no ${VIEWPORT} default-geometry entry in ${artifact}`)
  process.exit(1)
}

let failures = 0
const check = (ok, label, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label} — ${detail}`)
  if (!ok) failures++
}

console.log(`latest ${VIEWPORT} entry: sha ${latest.sha}, ${latest.date}`)
check(
  latest.serverPct.cornerIdle < CORNER_IDLE_MAX,
  `cornerIdle below ${CORNER_IDLE_MAX}%`,
  `${latest.serverPct.cornerIdle}%`,
)
check(
  latest.serverPct.afterClose < AFTER_CLOSE_MAX,
  `afterClose below ${AFTER_CLOSE_MAX}%`,
  `${latest.serverPct.afterClose}%`,
)

process.exit(failures === 0 ? 0 : 1)
