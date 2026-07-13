/**
 * Bidding proof — the composed-write (`cell.update`) end-to-end gate:
 * THREE independent browser contexts on ONE auction lot, against a
 * PROD build.
 * Run: `yarn build:website && node website/validate-bidding.mjs`
 * (starts its own preview server on PORT below; `--dev` runs the dev
 * server instead).
 *
 * What it proves:
 *   1. shared state — every viewer boots to the same lot value;
 *   2. broadcast fan-out — ONE bid reaches every watcher, and the
 *      server renders the lot body at most twice for it (the bidder's
 *      POST response + one shared broadcast render consumed by both
 *      watchers), counted off the lot's `[world] lot … render` log
 *      lines (per-connection lanes would render once per watcher);
 *   3. zero lost updates — a 50-bid storm fired concurrently from two
 *      contexts lands EXACTLY: `amount += 50 × 5`, `bids += 50` (the
 *      reducer runs in the write path's synchronous section, so
 *      overlapping updates compose — a read-modify-write around `set`
 *      loses bids here);
 *   4. convergence — all three viewers show the exact final value on
 *      screen, and a neighbouring lot's partition is untouched;
 *   5. hygiene — no error cards, page errors, or failed requests.
 *
 * Starting values are read OFF THE SCREEN, not assumed: lot bids
 * persist in website/data/cells.json across runs.
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5294
const BASE = `http://localhost:${PORT}`
const MODE = process.argv.includes("--dev") ? "dev" : "preview"

const LOT = "0,0"
const NEIGHBOUR_LOT = "1,1"
const BID_STEP = 5
const STORM_PER_VIEWER = 25

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
  /** On-screen lot value, or null while the lot hasn't rendered. */
  const readLot = (page, lot) =>
    page.evaluate((lot) => {
      const amount = document.querySelector(`[data-testid="lot-${lot}-amount"]`)?.textContent
      const bids = document.querySelector(`[data-testid="lot-${lot}-bids"]`)?.textContent
      return amount == null || bids == null
        ? null
        : { amount: Number(amount), bids: Number.parseInt(bids, 10) }
    }, lot)
  const errCards = (page) =>
    page.$$eval("[data-partial-error], .partial-error", (els) => els.length).catch(() => 0)
  /** `[world] lot <LOT> render amount=<amount>` lines since log index `i0`. */
  const lotRenderLines = (i0, amount) =>
    serverLog
      .slice(i0)
      .join("")
      .split("\n")
      .filter((l) => l.includes(`[world] lot ${LOT} render amount=${amount}`)).length

  // ── Boot three viewers onto the district (900px east of the origin
  //    puts all four lots in the 1280×800 viewport; same URL for all
  //    three, so their live connections share one broadcast route) ──
  const viewers = [await openViewer("A"), await openViewer("B"), await openViewer("C")]
  const [A, B, C] = viewers
  for (const v of viewers) {
    await v.page.goto(`${BASE}/`)
    await v.page.waitForSelector(scroller, { timeout: 15000 })
    await v.page.$eval(scroller, (el) => el.scrollBy(900, 0))
    await until(
      async () => (await readLot(v.page, LOT)) !== null,
      15000,
      `viewer ${v.name} lot ${LOT} content`,
    )
  }
  const boot = await Promise.all(viewers.map((v) => readLot(v.page, LOT)))
  check(
    boot.every((b) => b.amount === boot[0].amount && b.bids === boot[0].bids),
    "all viewers boot to the same lot value",
    boot.map((b, i) => `${viewers[i].name} ${b.amount}/${b.bids}`).join(" · "),
  )

  // ── 1. Broadcast fan-out: one bid, every watcher, ≤2 server renders ──
  // Let boot lanes settle so the log window contains only this bid.
  await A.page.waitForTimeout(2000)
  const probeLogStart = serverLog.length
  const probeAmount = boot[0].amount + BID_STEP
  await A.page.click(`[data-testid="lot-${LOT}"] .lot__bid`)
  const fanoutMs = await until(
    async () =>
      (await Promise.all([B, C].map((v) => readLot(v.page, LOT)))).every(
        (l) => l?.amount === probeAmount,
      ),
    10000,
    "single bid reaches both watchers",
  )
  check(true, "one bid fans out to both watching viewers", `${fanoutMs}ms`)
  await A.page.waitForTimeout(1500) // count the window's trailing renders
  const probeRenders = lotRenderLines(probeLogStart, probeAmount)
  check(
    probeRenders >= 1 && probeRenders <= 2,
    "bid lane is broadcast: at most 2 server renders for 3 viewers",
    `${probeRenders} render(s) at amount=${probeAmount} (POST response + 1 shared lane; ` +
      `per-connection would be 3)`,
  )

  // ── 2. The storm: 50 concurrent bids from two contexts, zero lost ──
  const start = await readLot(A.page, LOT)
  const neighbourStart = await readLot(A.page, NEIGHBOUR_LOT)
  const storm = (page) =>
    page.$eval(
      `[data-testid="lot-${LOT}"] .lot__bid`,
      (el, n) => {
        for (let i = 0; i < n; i++) el.click()
      },
      STORM_PER_VIEWER,
    )
  const stormStart = Date.now()
  await Promise.all([storm(A.page), storm(B.page)])
  const accepted = 2 * STORM_PER_VIEWER
  const finalAmount = start.amount + accepted * BID_STEP
  const finalBids = start.bids + accepted
  const convergeMs = await until(
    async () =>
      (await Promise.all(viewers.map((v) => readLot(v.page, LOT)))).every(
        (l) => l?.amount === finalAmount && l?.bids === finalBids,
      ),
    30000,
    `all viewers converge on ${finalAmount}/${finalBids}`,
  )
  const finals = await Promise.all(viewers.map((v) => readLot(v.page, LOT)))
  check(
    finals.every((l) => l.amount === finalAmount && l.bids === finalBids),
    `zero lost updates: ${accepted} concurrent bids all composed`,
    `${start.amount}/${start.bids} → ${finalAmount}/${finalBids} exactly, ` +
      `converged on all 3 viewers in ${Date.now() - stormStart}ms (${convergeMs}ms after last click)`,
  )
  const neighbourEnd = await readLot(A.page, NEIGHBOUR_LOT)
  check(
    neighbourEnd.amount === neighbourStart.amount && neighbourEnd.bids === neighbourStart.bids,
    `neighbouring lot ${NEIGHBOUR_LOT} untouched (partition-scoped writes)`,
    `${neighbourEnd.amount}/${neighbourEnd.bids}`,
  )

  // ── 3. Hygiene ──
  for (const v of viewers) {
    check((await errCards(v.page)) === 0, `no error cards on viewer ${v.name}`)
    check(v.pageErrors.length === 0, `no page errors on viewer ${v.name}`, v.pageErrors.join(" | "))
    check(v.netFails.length === 0, `no failed requests on viewer ${v.name}`, v.netFails.join(" | "))
  }

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
