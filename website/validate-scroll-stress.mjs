/**
 * Adversarial scroll-stress gate — the hole detector that surfaced the
 * ghost-confirmation bug family, promoted to a standing check: drive the
 * DENSE world (?chunk=128, 2560×1440 — the geometry where lane commit
 * order diverges from render order under backpressure) through human-
 * shaped adversarial scroll patterns, and after every stop assert the
 * viewport converges — every viewport-intersecting chunk position shows
 * content, with only known-transient shells on the way there.
 * Run: `yarn build:website && node website/validate-scroll-stress.mjs`
 * (starts its own preview server on PORT below; `--dev` runs the dev
 * server instead).
 *
 * Default transport (auto-upgrade → WebSocket) on purpose: this is the
 * path a real client rides, and it's distinct from validate-world's
 * eastBurst scenario, which pins ?transport=fetch for its byte budgets.
 *
 * Sequence battery (velocity segments integrated over rAF, like a real
 * WASD/drag scroll — bursts, reversals, backtracking, diagonals):
 *   eastBurst      — fast east burst, hard stop
 *   reversal       — accelerate east, reverse mid-flight
 *   diagonalBack   — diagonal out, backtrack over the visited region,
 *                    push out again
 *   southCruise    — sustained cruise at WASD speed
 *   zigzag         — quick stops and direction flips on both axes
 *   longHaulReturn — leave the warm region entirely, return to origin
 *
 * The convergence contract, per stop (the current known-transient
 *   tolerance):
 *   - MISSING chunk positions (no DOM element at a viewport-intersecting
 *     coordinate) and viewport-intersecting QUAD PLACEHOLDERS must clear
 *     within the settle window — a survivor is the clobber class
 *     (a stale ancestor lane committing over flipped-in content) and
 *     fails.
 *   - 1–2 chunk SHELLS (element mounted, content not yet streamed) are
 *     known-transient and OK while they clear within the shell window;
 *     more than 2 lingering shells, or any shell outliving the window,
 *     fails.
 *
 * Prints a timing table — per-sequence time-to-converged — so a
 * regression in "how fast the viewport heals" is visible even while
 * everything stays green.
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5193
const BASE = `http://localhost:${PORT}`
const MODE = process.argv.includes("--dev") ? "dev" : "preview"

// Settle after a sequence's last segment before the first detect: the
// stop's materialization waves need a beat to commit.
const SETTLE_MS = 3000
// Missing coords / quad placeholders must clear within this window after
// the settle (validate-world's eastBurst precedent: only a PERSISTENT
// hole fails — slow fill under CI load is not the bug).
const HOLE_WINDOW_MS = 5000
// Known-transient shells must have streamed their content within this
// window after the settle.
const SHELL_WINDOW_MS = 10000
const SHELL_TOLERANCE = 2

// Refuse a dirty port — a leftover server would silently invalidate the run.
try {
  await fetch(BASE)
  console.error(`Port ${PORT} already serving — kill it first (lsof -ti :${PORT} | xargs kill).`)
  process.exit(2)
} catch {}

const server = spawn(
  "yarn",
  ["workspace", "@parton/website", MODE, "--port", String(PORT), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
)
console.log(`mode: ${MODE}`)
const serverLog = []
server.stdout.on("data", (d) => serverLog.push(d.toString()))
server.stderr.on("data", (d) => serverLog.push(d.toString()))

const until = async (fn, ms, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timeout: ${label}`)
}

let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const timings = []
const timing = (label, ms) => timings.push([label, ms])

/** In-page: integrate velocity segments over rAF frames — a human-like
 *  WASD/drag scroll, not teleporting scrollTo jumps. */
const scrollSegments = (page, segments) =>
  page.evaluate(async (segs) => {
    const el = document.querySelector('[data-testid="world-scroller"]')
    for (const seg of segs) {
      await new Promise((resolve) => {
        const t0 = performance.now()
        let last = t0
        const tick = (now) => {
          const dt = (now - last) / 1000
          last = now
          el.scrollLeft += seg.vx * dt
          el.scrollTop += seg.vy * dt
          if (now - t0 < seg.ms) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
    }
  }, segments)

/** In-page hole detector: every chunk coordinate whose box intersects
 *  the viewport must be materialized. Splits the state three ways —
 *  loaded (content streamed), shells (element mounted, no content yet),
 *  missing (no element at all) — plus viewport-intersecting quad
 *  placeholders (structure not materialized). */
const detectHoles = (page) =>
  page.evaluate(() => {
    const CENTER_PX = 16384
    const el = document.querySelector('[data-testid="world-scroller"]')
    const plane = document.querySelector('[data-testid="world-plane"]')
    const chunkPx = Number(plane.dataset.chunk ?? 512)
    const cx0 = Math.floor((el.scrollLeft - CENTER_PX) / chunkPx)
    const cx1 = Math.ceil((el.scrollLeft + el.clientWidth - CENTER_PX) / chunkPx) - 1
    const cy0 = Math.floor((el.scrollTop - CENTER_PX) / chunkPx)
    const cy1 = Math.ceil((el.scrollTop + el.clientHeight - CENTER_PX) / chunkPx) - 1
    const visible = (n) => {
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const missing = []
    const shells = []
    let loaded = 0
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const els = [...document.querySelectorAll(`[data-testid="chunk-${cx},${cy}"]`)].filter(
          visible,
        )
        if (els.length === 0) missing.push(`${cx},${cy}`)
        else if (els.some((n) => n.hasAttribute("data-loaded"))) loaded++
        else shells.push(`${cx},${cy}`)
      }
    }
    const box = el.getBoundingClientRect()
    const quadShells = [...document.querySelectorAll(".quad__placeholder")]
      .map((n) => n.getBoundingClientRect())
      .filter(
        (r) =>
          r.width > 0 &&
          r.left < box.right &&
          r.right > box.left &&
          r.top < box.bottom &&
          r.bottom > box.top,
      ).length
    return {
      scroll: { x: Math.round(el.scrollLeft - CENTER_PX), y: Math.round(el.scrollTop - CENTER_PX) },
      total: (cx1 - cx0 + 1) * (cy1 - cy0 + 1),
      loaded,
      shells,
      missing,
      quadShells,
    }
  })

// Velocity segments per sequence: {vx, vy} px/s for {ms}.
const SEQS = {
  eastBurst: [{ vx: 3000, vy: 0, ms: 1500 }],
  reversal: [
    { vx: 2000, vy: 0, ms: 1000 },
    { vx: -2000, vy: 0, ms: 700 },
  ],
  diagonalBack: [
    { vx: 1400, vy: 1400, ms: 1500 },
    { vx: -1400, vy: -1400, ms: 1200 },
    { vx: 1400, vy: 1400, ms: 600 },
  ],
  southCruise: [{ vx: 0, vy: 720, ms: 2500 }],
  zigzag: [
    { vx: 2500, vy: 0, ms: 600 },
    { vx: 0, vy: 2500, ms: 600 },
    { vx: -2500, vy: 0, ms: 600 },
    { vx: 2500, vy: -800, ms: 800 },
    { vx: -1000, vy: 2000, ms: 500 },
  ],
  longHaulReturn: [
    { vx: -4000, vy: 0, ms: 2000 },
    { vx: 4000, vy: 0, ms: 2000 },
  ],
}

try {
  await until(
    async () => {
      try {
        return (await fetch(BASE)).ok
      } catch {
        return false
      }
    },
    30000,
    "server up",
  )

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })
  const netFails = []
  const pageErrors = []
  page.on("response", (r) => {
    if (r.status() >= 400) netFails.push(`${r.status()} ${r.url().slice(0, 120)}`)
  })
  page.on("requestfailed", (r) => {
    if (!r.failure()?.errorText.includes("ERR_ABORTED"))
      netFails.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 100)}`)
  })
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)))

  // ── Boot the dense world ──
  const bootStart = Date.now()
  await page.goto(`${BASE}/?chunk=128`)
  await page.waitForSelector('[data-testid="chunk-0,0"][data-loaded]', { timeout: 20000 })
  timing("boot → origin content", Date.now() - bootStart)
  await page.waitForTimeout(2000)

  // ── The battery: scroll, settle, assert convergence ──
  for (const [name, segments] of Object.entries(SEQS)) {
    await scrollSegments(page, segments)
    await page.waitForTimeout(SETTLE_MS)

    // Poll the trajectory from the settle: holes (missing coords, quad
    // placeholders) and beyond-tolerance shells must clear within
    // HOLE_WINDOW_MS; the last 1–2 known-transient shells get until
    // SHELL_WINDOW_MS to stream their content.
    const t0 = Date.now()
    let d = await detectHoles(page)
    let holesClearedAt = null // missing==0 && quad==0 && shells within tolerance
    let convergedAt = null // fully loaded, zero shells
    while (Date.now() - t0 < SHELL_WINDOW_MS) {
      const holesClear = d.missing.length === 0 && d.quadShells === 0
      if (holesClear && d.shells.length <= SHELL_TOLERANCE && holesClearedAt === null)
        holesClearedAt = Date.now() - t0
      if (holesClear && d.shells.length === 0) {
        convergedAt = Date.now() - t0
        break
      }
      if (holesClearedAt === null && Date.now() - t0 >= HOLE_WINDOW_MS) break
      await page.waitForTimeout(250)
      d = await detectHoles(page)
    }
    const detail =
      `scroll=(${d.scroll.x},${d.scroll.y}) chunks=${d.total} loaded=${d.loaded}` +
      ` shells=${d.shells.length} missing=${d.missing.length} quadShells=${d.quadShells}`
    check(
      holesClearedAt !== null,
      `${name}: no hole survives the settle`,
      holesClearedAt !== null ? `${holesClearedAt}ms` : detail,
    )
    check(
      convergedAt !== null,
      `${name}: viewport converges to full content`,
      convergedAt !== null
        ? `${convergedAt}ms`
        : `shells linger: [${d.shells.slice(0, 10).join(" ")}] — ${detail}`,
    )
    if (convergedAt !== null) timing(`converge ${name}`, convergedAt)
    if (holesClearedAt === null || convergedAt === null) {
      console.log(`  missing: ${d.missing.slice(0, 40).join(" ")}`)
    }
  }

  // ── Hygiene after the churn ──
  const errCards = await page
    .$$eval("[data-partial-error], .partial-error", (els) => els.length)
    .catch(() => 0)
  check(errCards === 0, "no error cards after the battery", `${errCards} cards`)
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))
  check(netFails.length === 0, "no failed requests", netFails.slice(0, 4).join(" | "))

  await browser.close()

  console.log("\ntimings:")
  for (const [label, ms] of timings) console.log(`  ${label.padEnd(28)} ${ms}ms`)
} catch (e) {
  failures++
  console.error(`✗ ${e.message}`)
  console.error(serverLog.slice(-20).join(""))
} finally {
  // Kill the whole tree — the yarn wrapper's children (vite) must die too.
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {
    server.kill("SIGTERM")
  }
}

const errLines = serverLog
  .join("")
  .split("\n")
  .filter((l) => /error|Error|ERR/.test(l))
  .slice(0, 8)
if (errLines.length) console.log("server log errors:\n " + errLines.join("\n "))
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
