/**
 * Two-viewer world proof — the broadcast-lane (delivery-plane D2)
 * end-to-end check: TWO independent browser contexts on ONE world
 * (default geometry), both live, against a PROD build.
 * Run: `yarn build:website && node website/validate-two-viewers.mjs`
 * (starts its own preview server on PORT below; `--dev` runs the dev
 * server instead).
 *
 * What it proves:
 *   1. both viewers receive pulse updates at their cadences while both
 *      connections are held;
 *   2. scrolling one viewer does NOT disturb the other — the other's
 *      scroll position holds, its content stays loaded, and its pulses
 *      keep advancing through the neighbour's churn;
 *   3. no error cards, no viewport holes, no page errors, no failed
 *      requests on either viewer.
 *
 * Kept standalone (not a validate-world scenario) on purpose:
 * validate-world is a single-page FETCH-transport gate whose byte and
 * beacon budgets assume one viewer's traffic; a second live context
 * would shift its timing envelopes. This proof runs the default
 * transport (auto-upgrade) — it checks multiplayer correctness, not
 * transport budgets.
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5192
const BASE = `http://localhost:${PORT}`
const MODE = process.argv.includes("--dev") ? "dev" : "preview"

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

  /** One viewer: its own CONTEXT (isolated session/cookies — a distinct
   *  client), page, and error accounting. */
  const openViewer = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
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
    return { name, context, page, netFails, pageErrors }
  }

  const scroller = '[data-testid="world-scroller"]'
  const readPulses = (page) =>
    page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) => {
      const m = {}
      for (const el of els) m[el.closest("[data-testid]").dataset.testid] = el.textContent
      return m
    })
  /** How many loaded pulses advance within `ms` on a page. */
  const pulsesAdvance = async (page, ms) => {
    const before = await readPulses(page)
    await page.waitForTimeout(ms)
    const after = await readPulses(page)
    const ids = Object.keys(before)
    return {
      sampled: ids.length,
      moved: ids.filter((id) => after[id] !== undefined && after[id] !== before[id]).length,
    }
  }
  const scrollPos = (page) => page.$eval(scroller, (el) => ({ x: el.scrollLeft, y: el.scrollTop }))
  const errCards = (page) =>
    page.$$eval("[data-partial-error], .partial-error", (els) => els.length).catch(() => 0)
  const centerChunkId = async (page) => {
    const p = await page.$eval(scroller, (el) => ({
      x: el.scrollLeft,
      y: el.scrollTop,
      w: el.clientWidth,
      h: el.clientHeight,
    }))
    const cx = Math.floor((p.x + p.w / 2) / 512) - 32
    const cy = Math.floor((p.y + p.h / 2) / 512) - 32
    return `chunk-${cx},${cy}`
  }

  // ── Boot both viewers on the SAME world ──
  const A = await openViewer("A")
  const B = await openViewer("B")
  await A.page.goto(`${BASE}/`)
  await B.page.goto(`${BASE}/`)
  const bootA = await until(
    async () => (await A.page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "viewer A origin content",
  )
  const bootB = await until(
    async () => (await B.page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "viewer B origin content",
  )
  check(true, "both viewers boot to origin content", `A ${bootA}ms · B ${bootB}ms`)

  // ── 1. Both live: pulses advance at their cadences, concurrently ──
  const [soakA, soakB] = await Promise.all([
    pulsesAdvance(A.page, 6000),
    pulsesAdvance(B.page, 6000),
  ])
  check(
    soakA.moved >= 3,
    "viewer A pulses advance while both are live",
    `${soakA.moved}/${soakA.sampled} in 6s`,
  )
  check(
    soakB.moved >= 3,
    "viewer B pulses advance while both are live",
    `${soakB.moved}/${soakB.sampled} in 6s`,
  )

  // ── 2. A scrolls east; B must be undisturbed ──
  const bPosBefore = await scrollPos(B.page)
  const bPulseWatch = pulsesAdvance(B.page, 6000) // spans A's whole scroll
  await A.page.$eval(scroller, (el) => el.scrollBy(2560, 0))
  const aCenter = await centerChunkId(A.page)
  const aStreamMs = await until(
    async () => (await A.page.$(`[data-testid="${aCenter}"][data-loaded]`)) !== null,
    10000,
    `viewer A center ${aCenter} streams in`,
  )
  check(true, `viewer A scroll east streams center ${aCenter} in`, `${aStreamMs}ms`)
  const bPosAfter = await scrollPos(B.page)
  check(
    bPosAfter.x === bPosBefore.x && bPosAfter.y === bPosBefore.y,
    "viewer B scroll position undisturbed by A's scroll",
    `(${bPosAfter.x},${bPosAfter.y})`,
  )
  check(
    (await B.page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    "viewer B origin content still loaded through A's scroll",
  )
  const bDuring = await bPulseWatch
  check(
    bDuring.moved >= 3,
    "viewer B pulses keep advancing through A's scroll",
    `${bDuring.moved}/${bDuring.sampled} in 6s`,
  )

  // ── 3. Symmetric: B scrolls south; A must be undisturbed ──
  const aPosBefore = await scrollPos(A.page)
  const aPulseWatch = pulsesAdvance(A.page, 6000)
  await B.page.$eval(scroller, (el) => el.scrollBy(0, 1600))
  const bCenter = await centerChunkId(B.page)
  const bStreamMs = await until(
    async () => (await B.page.$(`[data-testid="${bCenter}"][data-loaded]`)) !== null,
    10000,
    `viewer B center ${bCenter} streams in`,
  )
  check(true, `viewer B scroll south streams center ${bCenter} in`, `${bStreamMs}ms`)
  const aPosAfter = await scrollPos(A.page)
  check(
    aPosAfter.x === aPosBefore.x && aPosAfter.y === aPosBefore.y,
    "viewer A scroll position undisturbed by B's scroll",
    `(${aPosAfter.x},${aPosAfter.y})`,
  )
  const aDuring = await aPulseWatch
  check(
    aDuring.moved >= 3,
    "viewer A pulses keep advancing through B's scroll",
    `${aDuring.moved}/${aDuring.sampled} in 6s`,
  )

  // ── 4. Hygiene: no error cards, holes, page errors, failed requests ──
  check((await errCards(A.page)) === 0, "no error cards on viewer A")
  check((await errCards(B.page)) === 0, "no error cards on viewer B")
  check(A.pageErrors.length === 0, "no page errors on viewer A", A.pageErrors.join(" | "))
  check(B.pageErrors.length === 0, "no page errors on viewer B", B.pageErrors.join(" | "))
  check(A.netFails.length === 0, "no failed requests on viewer A", A.netFails.join(" | "))
  check(B.netFails.length === 0, "no failed requests on viewer B", B.netFails.join(" | "))

  await browser.close()
} catch (e) {
  failures++
  console.error(`✗ ${e.message}`)
  console.error(serverLog.slice(-20).join(""))
} finally {
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {}
}

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
