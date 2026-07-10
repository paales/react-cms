/**
 * CAPABILITY-GATE gate: proves an UNADVERTISED page opens ZERO
 * `/__parton/ws` sockets and logs NO WebSocket console error, while its
 * fetch channel stays live. This is the fix for the reported bug: before
 * the capability gate the auto-upgrade probed `/__parton/ws` BLIND on
 * every app, so an app without `partonChannelServer()` (Vite has no
 * handler) opened a doomed socket that died with close 1006 — TWICE
 * (`MAX_UPGRADE_PROBES`) — logging a red "WebSocket connection failed" on
 * every load, harmless but real noise.
 *
 * The gate: the server ADVERTISES it serves the socket
 * (`partonChannelServer` sets `PARTON_WS_AVAILABLE`, `renderHTML` reflects
 * it into the bootstrap as `self.__partonWsAvailable`); the client probes
 * ONLY when advertised. No flag → no probe → no socket.
 *
 * Every in-repo app now ships the plugin, so the unadvertised page is
 * produced by SUPPRESSING the advertisement client-side: an init script
 * swallows the bootstrap's `self.__partonWsAvailable = 1` write before
 * the browser entry reads it — exactly the state a plugin-less server
 * leaves the page in. As a control, the served document itself is
 * asserted to CARRY the flag (the suppression is what's under test, not
 * its absence). Drives the e2e-testing preview; build it first (`yarn
 * build` builds e2e-testing):
 *   yarn build && node website/validate-no-ws.mjs
 *
 * It drives Chromium at `/` (NO `?transport=` param) and asserts:
 *
 *   1. fetch live   — the boot attach POSTs `/__parton/live` and the page
 *      goes `<html data-parton-live>` (the fetch channel established and
 *      stays held — the fallback works untouched).
 *   2. no socket    — across the full probe window (past both the 600ms
 *      first probe and its ~2.6s re-probe) NOT ONE `/__parton/ws` socket
 *      is ever opened. The auto-upgrade stood down: unadvertised.
 *   3. no ws error  — no console error / pageerror / failed request that
 *      names WebSocket or `/__parton/ws`. The doomed-socket noise is gone.
 *   4. advert control — the served document's bootstrap DOES carry the
 *      `__partonWsAvailable` flag (the server ships the plugin), so the
 *      zero-socket result above is the CLIENT gate standing down.
 *
 * The ADVERTISED counterpart (the website upgrades to WS) is gated by
 * `validate-upgrade.mjs`; the forced paths by `validate-world.mjs`
 * (fetch) and `validate-ws.mjs` (ws).
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5390
const BASE = `http://localhost:${PORT}`

// Refuse a dirty port — a leftover server would silently invalidate the run.
try {
  await fetch(BASE)
  console.error(`Port ${PORT} already serving — kill it first (lsof -ti :${PORT} | xargs kill).`)
  process.exit(2)
} catch {}

// Drive the e2e-testing app in preview (it ships `partonChannelServer()`;
// the advertisement is suppressed client-side below — the 5173 shape).
const server = spawn(
  "yarn",
  ["workspace", "@parton/e2e-testing", "preview", "--port", String(PORT), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
)
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // Suppress the advertisement BEFORE any page script runs: the
  // bootstrap's `self.__partonWsAvailable = 1` write is swallowed, so
  // the browser entry sees an unadvertised endpoint — the plugin-less
  // server's exact client state.
  await page.addInitScript(() => {
    Object.defineProperty(window, "__partonWsAvailable", {
      get: () => undefined,
      set: () => {},
      configurable: true,
    })
  })

  // Every `/__parton/ws` socket construction + close code, captured
  // in-page (Playwright's own `close` event drops the code). Even a socket
  // that dies with 1006 before Playwright surfaces it lands here.
  await page.addInitScript(() => {
    const w = window
    w.__wslog = []
    const Orig = w.WebSocket
    w.WebSocket = new Proxy(Orig, {
      construct(target, args) {
        const ws = new target(...args)
        const short = String(args[0]).replace(location.origin, "")
        if (short.includes("/__parton/ws")) {
          w.__wslog.push(`OPEN ${short}`)
          ws.addEventListener("close", (e) => w.__wslog.push(`CLOSE code=${e.code}`))
          ws.addEventListener("error", () => w.__wslog.push("ERROR"))
        }
        return ws
      },
    })
  })

  // Playwright-side socket accounting (a second, independent witness).
  const wsOpens = []
  page.on("websocket", (ws) => {
    if (ws.url().includes("/__parton/ws")) wsOpens.push(ws.url())
  })

  // WebSocket-shaped console errors + page errors — the noise the gate
  // removes ("WebSocket connection to 'ws://…/__parton/ws' failed").
  const wsConsole = []
  const otherConsole = []
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/websocket|\/__parton\/ws|ws:\/\//i.test(t)) wsConsole.push(t.slice(0, 160))
    else otherConsole.push(t.slice(0, 120))
  })
  const pageErrors = []
  page.on("pageerror", (e) => {
    if (/websocket|\/__parton\/ws/i.test(e.message)) pageErrors.push(e.message.slice(0, 160))
  })
  const wsNetFails = []
  page.on("requestfailed", (r) => {
    if (r.url().includes("/__parton/ws")) wsNetFails.push(r.failure()?.errorText ?? "failed")
  })

  // Fetch-endpoint POST accounting — the boot attach rides `/__parton/live`.
  const postsLive = []
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/__parton/live")) postsLive.push(Date.now())
  })

  // ── 1. Fetch channel establishes ──
  await page.goto(`${BASE}/`)
  await until(
    async () => (await page.$('[data-testid="page-shell"]')) !== null,
    15000,
    "page shell",
  )
  const liveMs = await until(
    async () => page.$eval("html", (h) => h.hasAttribute("data-parton-live")).catch(() => false),
    15000,
    "data-parton-live",
  )
  check(
    postsLive.length >= 1,
    "boot attaches over fetch (POST /__parton/live)",
    `${postsLive.length} POST(s)`,
  )
  check(true, "fetch channel established (data-parton-live)", `${liveMs}ms`)

  // ── Observe past BOTH probe windows (600ms first, ~2.6s re-probe) ──
  await page.waitForTimeout(6000)

  // ── 2. Zero /__parton/ws sockets — the auto-upgrade stood down ──
  const inPageOpens = await page.evaluate(() => window.__wslog.filter((l) => l.startsWith("OPEN")))
  check(
    wsOpens.length === 0 && inPageOpens.length === 0,
    "ZERO /__parton/ws sockets ever opened (probe stood down)",
    `playwright=${wsOpens.length} in-page=${inPageOpens.length}`,
  )
  const wsLog = await page.evaluate(() => window.__wslog)
  if (wsLog.length) console.log("  in-page ws log:", wsLog.join(" | "))

  // ── 3. No WebSocket console error / pageerror / net fail ──
  check(wsConsole.length === 0, "no WebSocket console error", wsConsole.slice(0, 2).join(" | "))
  check(pageErrors.length === 0, "no WebSocket page error", pageErrors.slice(0, 2).join(" | "))
  check(
    wsNetFails.length === 0,
    "no failed request to /__parton/ws",
    wsNetFails.slice(0, 2).join(" | "),
  )
  if (otherConsole.length)
    console.log(`  (${otherConsole.length} unrelated console error(s), ignored)`)

  // ── 4. Advert control: the served bootstrap DOES carry the flag ──
  // (the server ships the plugin), so the zero-socket result above is
  // the CLIENT gate standing down on a suppressed advertisement.
  const html = await (await fetch(BASE)).text()
  check(
    html.includes("__partonWsAvailable"),
    "document bootstrap carries the __partonWsAvailable flag (control)",
  )

  // ── Fetch channel still live after the window (fallback untouched) ──
  const stillLive = await page
    .$eval("html", (h) => h.hasAttribute("data-parton-live"))
    .catch(() => false)
  check(stillLive, "fetch channel still live after the probe window")

  console.log(`\nfetch-live ${liveMs}ms · 0 ws sockets · ${postsLive.length} live POST(s)`)
  await browser.close()
} finally {
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
  .slice(0, 6)
if (errLines.length) console.log("server log errors:\n " + errLines.join("\n "))
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
