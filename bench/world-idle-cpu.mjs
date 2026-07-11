/**
 * World idle-CPU benchmark — prices the server's STANDING cost of one
 * idle client after a world tour.
 *
 * The scenario that motivated it: load the world, scroll to the top
 * edge, dwell, scroll to the top-left corner, and stop. Every chunk
 * the tour rendered left a snapshot in the route bucket and started a
 * pulse ticker; every ticker bump wakes the held connection's driver
 * into the bump-relevance filter over ALL of those snapshots. The
 * server's idle CPU after the tour is therefore the direct price of
 * the wake-filter path — `_routeMatchingBumpIds` → `queryMatchingTs`
 * over the pulse cell's partition entries — under a realistically
 * large snapshot × partition × bump-rate product.
 *
 * Run: `yarn build:website && node bench/world-idle-cpu.mjs`
 *   [--viewport=2560x1440]   viewport (default 1440p; try 3840x2160)
 *   [--prof]                 boot the preview under --cpu-prof
 *                            (profiles land in /tmp/parton-cpu-prof)
 *
 * Three measured phases, each reporting the server tree's %CPU
 * (sampled per second via ps, last-10s average):
 *
 *   1. baseline    — page idle at the ORIGIN, right after boot. Small
 *                    snapshot set, few tickers: the healthy floor.
 *   2. cornerIdle  — page idle at the TOP-LEFT CORNER after the tour.
 *                    THE number: it must settle near the baseline. A
 *                    saturated core here (~100%) is the wake-filter
 *                    pathology — the server spending its entire budget
 *                    re-deciding NOT to render.
 *   3. afterClose  — zero clients, tickers still firing. Attribution:
 *                    connection-driven burn drops away; what remains
 *                    is the tickers' own write cost.
 *
 * The browser column is the Playwright-launched HEADLESS Chromium
 * tree (software compositor — its paint share overstates a real GPU;
 * read its scripting share via bench/client-scroll.mjs instead).
 *
 * The artifact appends to `bench/results/world-idle-cpu.json`
 * (committed — the regression substrate, like server-warm-tick.json):
 * one entry per run with git SHA, node version, viewport, and the
 * three phase averages, so the corner-idle number is comparable
 * across commits.
 */
import { execSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5189
const BASE = `http://localhost:${PORT}`
const PROF_DIR = "/tmp/parton-cpu-prof"
const RESULTS = new URL("./results/world-idle-cpu.json", import.meta.url).pathname
const vpArg = process.argv.find((a) => a.startsWith("--viewport="))?.split("=")[1] ?? "2560x1440"
const [VW, VH] = vpArg.split("x").map(Number)
const PROF = process.argv.includes("--prof")

// Refuse a dirty port — a leftover server would silently invalidate the run.
try {
  await fetch(BASE)
  console.error(`Port ${PORT} already serving — kill it first (lsof -ti :${PORT} | xargs kill).`)
  process.exit(2)
} catch {}

const server = spawn(
  "yarn",
  ["workspace", "@parton/website", "preview", "--port", String(PORT), "--strictPort"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      ...(PROF ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${PROF_DIR}` } : {}),
    },
  },
)
const serverLog = []
server.stdout.on("data", (d) => serverLog.push(d.toString()))
server.stderr.on("data", (d) => serverLog.push(d.toString()))

const until = async (fn, ms, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timeout: ${label}`)
}
await until(
  async () => {
    try {
      return (await fetch(BASE)).ok
    } catch {
      return false
    }
  },
  30000,
  "preview server up",
)
console.log(`server up — viewport ${VW}x${VH}, prof=${PROF}`)

const descendants = (pid) => {
  const out = execSync(`pgrep -P ${pid} || true`, { encoding: "utf8" }).trim()
  const kids = out ? out.split("\n").map(Number) : []
  return [pid, ...kids.flatMap(descendants)]
}
// ps pcpu uses the locale decimal separator (comma under nl_NL) — normalize.
const cpuOf = (pids) => {
  if (pids.length === 0) return 0
  const out = execSync(`ps -o pcpu= -p ${pids.join(",")} 2>/dev/null || true`, {
    encoding: "utf8",
  }).trim()
  let total = 0
  for (const line of out.split("\n")) {
    const v = parseFloat(line.trim().replace(",", "."))
    if (!Number.isNaN(v)) total += v
  }
  return total
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: VW, height: VH } })

// Only the Playwright-launched Chromium tree (a descendant of this script),
// never the user's own Chrome. The server tree is excluded.
const browserPids = () => {
  const serverTree = new Set(descendants(server.pid))
  return descendants(process.pid).filter((p) => p !== process.pid && !serverTree.has(p))
}
const sampleWindow = async (label, seconds) => {
  console.log(`\n── ${label} (${seconds}s) ──`)
  const srv = []
  const brw = []
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = cpuOf(descendants(server.pid))
    const b = cpuOf(browserPids())
    srv.push(s)
    brw.push(b)
    if (i % 5 === 0 || i === seconds - 1)
      console.log(
        `  t+${String(i + 1).padStart(2)}s  server=${s.toFixed(1)}%  browser=${b.toFixed(1)}%`,
      )
  }
  const avg = (a) =>
    Number((a.slice(-10).reduce((x, y) => x + y, 0) / Math.min(a.length, 10)).toFixed(1))
  console.log(`  → last-10s avg: server=${avg(srv)}%  browser=${avg(brw)}%`)
  return { server: avg(srv), browser: avg(brw) }
}

await page.goto(BASE) // default transport — the auto-upgrade (fetch→ws) path
const scroller = '[data-testid="world-scroller"]'
await page.waitForSelector(scroller, { timeout: 15000 })
await page.waitForTimeout(3000)
console.log("page booted at origin")

const baseline = await sampleWindow("baseline (page idle at origin)", 12)

// Stepped scroll: mimics a human wheel/drag so intermediate chunks render
// (an instant scrollTo would skip the snapshot/ticker accumulation that
// makes the corner state expensive).
const steppedScroll = async (dx, dy, steps, stepMs) => {
  for (let i = 0; i < steps; i++) {
    await page.$eval(scroller, (el, d) => el.scrollBy(d.dx, d.dy), { dx, dy })
    await page.waitForTimeout(stepMs)
  }
}

console.log("\nscrolling to TOP edge…")
await steppedScroll(0, -256, 64, 60)
await page.$eval(scroller, (el) => el.scrollTo(el.scrollLeft, 0))
console.log("at top edge; dwelling 12s")
await page.waitForTimeout(12000)

console.log("scrolling to TOP-LEFT corner…")
await steppedScroll(-256, 0, 64, 60)
await page.$eval(scroller, (el) => el.scrollTo(0, 0))
console.log("at top-left corner")
await page.waitForTimeout(3000)

const cornerIdle = await sampleWindow("page idle at top-left after the tour", 40)

console.log("\nclosing browser (zero clients)…")
await browser.close()
const afterClose = await sampleWindow("after browser closed", 15)

console.log(
  `\nRESULT (${VW}x${VH})  baseline=${baseline.server}%  cornerIdle=${cornerIdle.server}%  afterClose=${afterClose.server}%  (server tree, last-10s avg)`,
)

const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
let history = []
try {
  history = JSON.parse(readFileSync(RESULTS, "utf8"))
} catch {}
history.push({
  sha,
  date: new Date().toISOString(),
  node: process.version,
  viewport: `${VW}x${VH}`,
  serverPct: { baseline: baseline.server, cornerIdle: cornerIdle.server, afterClose: afterClose.server },
  headlessBrowserPct: { baseline: baseline.browser, cornerIdle: cornerIdle.browser },
})
writeFileSync(RESULTS, JSON.stringify(history, null, 2) + "\n")
console.log(`appended → ${RESULTS}`)

console.log("stopping server…")
try {
  process.kill(-server.pid, "SIGINT")
} catch {}
await new Promise((r) => setTimeout(r, 3000))
try {
  process.kill(-server.pid, "SIGKILL")
} catch {}
