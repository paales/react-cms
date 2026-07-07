/**
 * World validation suite — the standing end-to-end gate for the
 * website world, against a PROD build by default.
 * Run: `yarn build:website && node website/validate-world.mjs`
 * (starts its own preview server on PORT below; `--dev` runs the dev
 * server instead).
 *
 * Scenario battery:
 *   1. boot          — cold load, time-to-origin-content, pulse soak,
 *                      live-stream byte budget
 *   2. directions    — scroll east/south/west/north; per-stop
 *                      stream-in latency + pulses advancing at the stop
 *   3. refresh       — reload at origin AND at a far position; pulses
 *                      must advance after every refresh (the
 *                      parked-after-refresh regression: a boundary
 *                      hydrating over dehydrated children never
 *                      reported, so the whole world froze)
 *   4. stress        — 40000px fast scroll; viewport fills; parked
 *                      chunks stay off the live stream (byte budget)
 *   5. steady state  — at rest: no red mount-flashes (red = unexpected
 *                      remount), pulses still live
 *   6. server health — after all the churn (several torn live
 *                      connections): doc fetch stays fast, server CPU
 *                      settles (zombie-connection regression)
 *
 * Prints a timing table at the end — boot, per-direction stream-in,
 * byte windows — so regressions in "how fast things stream in" are
 * visible even while everything stays green.
 */
import { execSync, spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5186
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
const timings = []
const timing = (label, ms) => timings.push([label, ms])

try {
  await until(async () => {
    try {
      return (await fetch(BASE)).ok
    } catch {
      return false
    }
  }, 30000, "server up")

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const netFails = []
  const pageErrors = []
  page.on("response", (r) => { if (r.status() >= 400) netFails.push(`${r.status()} ${r.url().slice(0, 120)}`) })
  page.on("requestfailed", (r) => { if (!r.failure()?.errorText.includes("ERR_ABORTED")) netFails.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 100)}`) })
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)))

  // Live-stream byte accounting: decoded bytes per data event on any
  // held `?live=1` response, timestamped so assertions can budget a
  // window. dataLength (decoded) rather than encodedDataLength so the
  // budget doesn't depend on compression behavior.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Network.enable")
  const liveRequestIds = new Set()
  const liveChunks = []
  const liveUrls = []
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.includes("live=1")) {
      liveRequestIds.add(e.requestId)
      liveUrls.push(e.request.url)
    }
  })
  // Attach statements: each live fire is a POST whose JSON body carries
  // the client statement ({cached, since, visible}); the boot check
  // reads the anchor off the first fire's body.
  const liveFires = []
  page.on("request", (r) => {
    if (r.url().includes("live=1")) {
      liveFires.push({ method: r.method(), post: r.postData() ?? "" })
    }
  })
  cdp.on("Network.dataReceived", (e) => {
    if (liveRequestIds.has(e.requestId)) liveChunks.push({ t: Date.now(), n: e.dataLength })
  })
  const liveBytesSince = (t0) => liveChunks.filter((c) => c.t >= t0).reduce((s, c) => s + c.n, 0)

  // ── Shared probes ──
  const scroller = '[data-testid="world-scroller"]'
  const readPulses = () =>
    page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) => {
      const m = {}
      for (const el of els) m[el.closest("[data-testid]").dataset.testid] = el.textContent
      return m
    })
  /** How many loaded pulses at the current position advance within `ms`. */
  const pulsesAdvance = async (ms) => {
    const before = await readPulses()
    await page.waitForTimeout(ms)
    const after = await readPulses()
    const ids = Object.keys(before)
    return {
      sampled: ids.length,
      moved: ids.filter((id) => after[id] !== undefined && after[id] !== before[id]).length,
    }
  }
  const scrollPos = () =>
    page.$eval(scroller, (el) => ({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight }))
  const centerChunkId = async () => {
    const p = await scrollPos()
    const cx = Math.floor((p.x + p.w / 2) / 512) - 32
    const cy = Math.floor((p.y + p.h / 2) / 512) - 32
    return `chunk-${cx},${cy}`
  }
  /** Scroll by (dx, dy) and time until the viewport-center chunk has content. */
  const scrollAndTime = async (dx, dy, label) => {
    await page.$eval(scroller, (el, d) => el.scrollBy(d.dx, d.dy), { dx, dy })
    const id = await centerChunkId()
    let ms = null
    try {
      ms = await until(async () => (await page.$(`[data-testid="${id}"][data-loaded]`)) !== null, 10000, "")
    } catch {}
    check(ms !== null, `${label}: center ${id} streams in`, ms !== null ? `${ms}ms` : "never loaded")
    if (ms !== null) timing(`stream-in ${label}`, ms)
    return ms
  }

  // ── 1. Boot ──
  const bootStart = Date.now()
  await page.goto(BASE)
  const bootMs = await until(
    async () => (await page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "origin content",
  )
  timing("boot → origin content", bootMs)
  check(true, "origin content at first paint", `${bootMs}ms`)

  await page.waitForTimeout(4000)
  // The live boot must be a CATCH-UP, not a route replay: the document
  // carries a registry anchor (`<!--live-anchor:…-->`), the heartbeat's
  // first fire is an attach POST presenting it as the statement's
  // `since`, and the server opens the connection straight into lanes.
  // A replay here re-ships hundreds of KB the document just delivered
  // (the 370KB-boot regression).
  check(
    liveFires.length > 0 &&
      liveFires[0].method === "POST" &&
      /"since":\{"epoch"/.test(liveFires[0].post),
    "live boot attaches with the document's catch-up anchor",
    liveFires[0]
      ? `${liveFires[0].method} ${liveFires[0].post.replace(/"cached":\[[^\]]*\]/, '"cached":[…]').slice(0, 140)}`
      : "no live fire",
  )
  const errCards = await page.$$eval("[data-partial-error], .partial-error", (els) => els.length).catch(() => 0)
  check(errCards === 0, "no error cards after pulse soak", `${errCards} cards`)
  const soak = await pulsesAdvance(6000)
  check(soak.moved >= 3, "origin pulses advance while resting", `${soak.moved}/${soak.sampled} advanced in 6s`)
  const soakBytes = liveBytesSince(bootStart)
  check(soakBytes < 1_500_000, "live stream lean during pulse soak", `${Math.round(soakBytes / 1024)}KB (budget 1500KB)`)
  timing("soak live bytes", soakBytes)

  // ── 2. Directions — one viewport-ish step each way, content must chase ──
  await scrollAndTime(2560, 0, "east")
  await page.waitForTimeout(500)
  await scrollAndTime(0, 1600, "south")
  await page.waitForTimeout(500)
  await scrollAndTime(-5120, 0, "west")
  await page.waitForTimeout(500)
  await scrollAndTime(0, -3200, "north")
  const dir = await pulsesAdvance(6000)
  check(dir.sampled > 0 && dir.moved >= 1, "pulses live at post-directions position", `${dir.moved}/${dir.sampled} advanced in 6s`)

  // ── 3a. Refresh at position — scroll restoration must not park the world ──
  await page.reload()
  await page.waitForSelector(scroller, { timeout: 15000 })
  const posAfter = await scrollPos()
  await page.waitForTimeout(2500)
  const r1 = await pulsesAdvance(6000)
  check(
    r1.sampled > 0 && r1.moved >= 1,
    "pulses advance after refresh at position",
    `${r1.moved}/${r1.sampled} advanced at (${posAfter.x},${posAfter.y})`,
  )

  // ── 3b. Refresh at origin — the frozen-world regression ──
  await page.$eval(scroller, (el) => { el.scrollTo(16384 - el.clientWidth / 2 + 256, 16384 - el.clientHeight / 2 + 256) })
  await page.waitForTimeout(1500)
  await page.reload()
  await page.waitForSelector('[data-testid="chunk-0,0"]', { timeout: 15000 })
  await page.waitForTimeout(2500)
  const r2 = await pulsesAdvance(6000)
  check(r2.sampled > 0 && r2.moved >= 3, "pulses advance after refresh at origin", `${r2.moved}/${r2.sampled} advanced in 6s`)

  // ── 4. Stress — fast continuous scrolling, like a real user ──
  for (let i = 0; i < 100; i++) {
    await page.$eval(scroller, (el) => el.scrollBy(0, -400))
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(4000)
  const pos = await scrollPos()
  const stressLoaded = await page.$$eval("[data-testid^='chunk-'][data-loaded]", (els) => els.length)
  check(stressLoaded > 0, "cells load after 40000px stress scroll", `${stressLoaded} loaded at y=${pos.y}`)
  const stressCenter = await centerChunkId()
  check(
    (await page.$(`[data-testid="${stressCenter}"][data-loaded]`)) !== null,
    `viewport-center ${stressCenter} is loaded after stress`,
  )

  // ── 5. Steady state: parked chunks quiet on the wire, no red mount-flashes ──
  // Hundreds of chunks were visited and scrolled past; their tickers
  // keep writing server-side, but only the ~dozen chunks at the current
  // position may lane. And at rest, a red flash means something
  // REMOUNTED without cause.
  await page.evaluate(() => {
    window.__redFlashes = 0
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes ?? []) {
          if (n.nodeType === 1 && n.classList?.contains("chunk__light--red")) window.__redFlashes++
        }
        if (m.type === "attributes" && m.target.classList?.contains("chunk__light--red")) window.__redFlashes++
      }
    })
    mo.observe(document.querySelector('[data-testid="world-scroller"]'), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    })
  })
  const quietStart = Date.now()
  await page.waitForTimeout(6000)
  const quietBytes = liveBytesSince(quietStart)
  check(quietBytes < 600_000, "parked chunks stay off the live stream", `${Math.round(quietBytes / 1024)}KB over 6s (budget 600KB)`)
  timing("quiet-window live bytes", quietBytes)
  const redFlashes = await page.evaluate(() => window.__redFlashes)
  check(redFlashes === 0, "no red mount-flashes at rest", `${redFlashes} in 6s`)
  const rest = await pulsesAdvance(5000)
  check(rest.sampled === 0 || rest.moved >= 1, "pulses still live at rest position", `${rest.moved}/${rest.sampled}`)

  // ── 6. Server health after churn (three refreshes = three torn live
  //       connections; zombies would peg the event loop) ──
  const t0 = Date.now()
  const health = await fetch(BASE)
  const healthMs = Date.now() - t0
  check(health.ok && healthMs < 3000, "server responsive after connection churn", `doc fetch ${healthMs}ms`)
  timing("post-churn doc fetch", healthMs)
  let cpu = null
  try {
    const pids = execSync(`lsof -ti :${PORT}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    await new Promise((r) => setTimeout(r, 2000))
    cpu = Math.max(
      ...execSync(`ps -o pcpu= -p ${pids.join(",")}`, { encoding: "utf8" })
        .trim().split("\n").map((l) => Number.parseFloat(l.replace(",", "."))),
    )
    check(cpu < 60, "server CPU settled (no zombie connections)", `${cpu}%`)
  } catch (e) {
    check(false, "server CPU measurable", String(e).slice(0, 80))
  }

  check(netFails.length === 0, "no failed requests", netFails.slice(0, 4).join(" | "))
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))

  await browser.close()

  console.log("\ntimings:")
  for (const [label, ms] of timings) {
    console.log(`  ${label.padEnd(28)} ${typeof ms === "number" && label.includes("bytes") ? `${Math.round(ms / 1024)}KB` : `${ms}ms`}`)
  }
} finally {
  // Kill the whole tree — the yarn wrapper's children (vite) must die too.
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {
    server.kill("SIGTERM")
  }
}

const errLines = serverLog.join("").split("\n").filter((l) => /error|Error|ERR/.test(l)).slice(0, 8)
if (errLines.length) console.log("server log errors:\n " + errLines.join("\n "))
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
