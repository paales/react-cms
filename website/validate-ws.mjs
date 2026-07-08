/**
 * WebSocket-transport end-to-end gate for the website world. Proves the
 * opt-in `?transport=ws` path (the `partonChannelServer()` Vite plugin +
 * the client `WebSocketTransport`) works over a REAL socket in a running
 * server — the live `upgrade` glue the mock-socket rsc test
 * (`channel-ws.rsc.test.tsx`) cannot exercise.
 *
 * Run (preview / prod build, the default):
 *   yarn build:website && node website/validate-ws.mjs
 * Run (dev server, also exercises HMR co-existence):
 *   node website/validate-ws.mjs --dev
 *
 * It starts its own server on PORT below and drives Chromium at
 * `/?transport=ws`, asserting EVERYTHING rides the one socket:
 *
 *   1. establish — the WS to `/__parton/ws` opens, the server-minted
 *      `conn` handshake arrives (so `<html data-parton-live>` is set),
 *      and ZERO POST fires to the fetch endpoints (`/__parton/live`,
 *      `/__parton/channel`) — the whole channel is on the socket.
 *   2. attach    — the initial whole-tree content lands (origin chunk
 *      loaded), tunneled down as BINARY frames (the opaque `\xFF`-marker
 *      wire — never text downstream).
 *   3. stream    — scrolling into fresh territory streams the new
 *      centre chunk in over the socket (binary frames arrive during the
 *      scroll), and the world's pulses keep advancing (live lanes).
 *   4. upstream  — the visibility flips the scroll produces ride UP the
 *      SAME socket as `visible` envelopes (text frames sent), and the
 *      server acts on them (the flipped-in chunk streams down).
 *   5. HMR (dev only) — touching a source file still drives a Vite HMR
 *      update over Vite's OWN WebSocket (its `upgrade` is untouched by
 *      our `/__parton/ws` handler).
 *   6. teardown  — after churn (torn sockets) the server stays
 *      responsive (no zombie drives).
 *
 * The DEFAULT fetch world is gated separately by `validate-world.mjs`;
 * this plugin is additive, so that gate must stay green unchanged.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5187
const BASE = `http://localhost:${PORT}`
const MODE = process.argv.includes("--dev") ? "dev" : "preview"
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS = path.join(HERE, "src/app/styles.css")

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // Socket accounting. `/__parton/ws` frames: binary downstream (the
  // marker tunnel) + text upstream (attach + envelopes). Vite's HMR
  // socket is any OTHER ws — kept separate so the HMR check can watch it.
  const partonRecv = [] // { t, binary, n }
  const partonSent = [] // { t, text }
  const hmrFrames = []
  const socketUrls = []
  page.on("websocket", (ws) => {
    socketUrls.push(ws.url())
    const isParton = ws.url().includes("/__parton/ws")
    ws.on("framereceived", (f) => {
      const binary = typeof f.payload !== "string"
      if (isParton)
        partonRecv.push({
          t: Date.now(),
          binary,
          n: binary ? f.payload.byteLength : f.payload.length,
        })
      else if (typeof f.payload === "string") hmrFrames.push({ t: Date.now(), text: f.payload })
    })
    ws.on("framesent", (f) => {
      if (isParton && typeof f.payload === "string")
        partonSent.push({ t: Date.now(), text: f.payload })
    })
  })
  // The fetch endpoints must NEVER fire under `?transport=ws` — everything
  // rides the one socket.
  const posts = { live: 0, channel: 0 }
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/__parton/live")) posts.live++
    if (r.method() === "POST" && r.url().includes("/__parton/channel")) posts.channel++
  })
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)))
  const netFails = []
  page.on("requestfailed", (r) => {
    if (!r.failure()?.errorText.includes("ERR_ABORTED"))
      netFails.push(`${r.failure()?.errorText} ${r.url().slice(0, 80)}`)
  })

  const scroller = '[data-testid="world-scroller"]'
  const readPulses = () =>
    page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) => {
      const m = {}
      for (const el of els) m[el.closest("[data-testid]").dataset.testid] = el.textContent
      return m
    })

  // ── 1. Establish ──
  await page.goto(`${BASE}/?transport=ws`)
  const bootMs = await until(
    async () => (await page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "origin content",
  )
  await page.waitForTimeout(2500)
  const live = await page
    .$eval("html", (h) => h.hasAttribute("data-parton-live"))
    .catch(() => false)
  const partonSockets = socketUrls.filter((u) => u.includes("/__parton/ws"))
  check(
    partonSockets.length >= 1,
    "WebSocket to /__parton/ws opened",
    `${partonSockets.length} socket(s)`,
  )
  check(live, "conn handshake established (data-parton-live set)")
  check(
    posts.live === 0,
    "no POST to /__parton/live (attach rode the socket)",
    `${posts.live} POSTs`,
  )
  check(
    posts.channel === 0,
    "no POST to /__parton/channel (envelopes ride the socket)",
    `${posts.channel} POSTs`,
  )

  // ── 2. Attach — initial content, tunneled down as binary ──
  check(true, "attach delivered origin content", `${bootMs}ms`)
  const binaryDown = partonRecv.filter((r) => r.binary).length
  const textDown = partonRecv.filter((r) => !r.binary).length
  check(
    binaryDown > 0 && textDown === 0,
    "downstream is opaque binary (the marker tunnel)",
    `${binaryDown} binary / ${textDown} text frames`,
  )
  check(
    partonSent.length > 0,
    "upstream envelopes sent over the socket",
    `${partonSent.length} frames (attach + envelopes)`,
  )

  // ── 3 & 4. Stream + upstream — scroll into fresh territory ──
  const scrollStart = Date.now()
  const sentBefore = partonSent.length
  await page.$eval(scroller, (el) => el.scrollBy(3072, 1600))
  const pos = await page.$eval(scroller, (el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
    w: el.clientWidth,
    h: el.clientHeight,
  }))
  const cx = Math.floor((pos.x + pos.w / 2) / 512) - 32
  const cy = Math.floor((pos.y + pos.h / 2) / 512) - 32
  const centerId = `chunk-${cx},${cy}`
  let streamedMs = null
  try {
    streamedMs = await until(
      async () => (await page.$(`[data-testid="${centerId}"][data-loaded]`)) !== null,
      10000,
      "",
    )
  } catch {}
  await page.waitForTimeout(1000)
  check(
    streamedMs !== null,
    `scroll streams centre ${centerId} in over the socket`,
    streamedMs !== null ? `${streamedMs}ms` : "never loaded",
  )
  const binaryDuringScroll = partonRecv.filter((r) => r.binary && r.t >= scrollStart).length
  check(
    binaryDuringScroll > 0,
    "flipped-in chunks stream down as binary frames",
    `${binaryDuringScroll} frames during scroll`,
  )
  const visibleFrames = partonSent.slice(sentBefore).filter((s) => {
    try {
      return JSON.parse(s.text).frames?.some((f) => f.kind === "visible")
    } catch {
      return false
    }
  })
  check(
    visibleFrames.length > 0,
    "upstream visibility frames delivered over the socket",
    `${visibleFrames.length} visible envelope(s)`,
  )
  const soak = await (async () => {
    const before = await readPulses()
    await page.waitForTimeout(5000)
    const after = await readPulses()
    const ids = Object.keys(before)
    return {
      sampled: ids.length,
      moved: ids.filter((id) => after[id] !== undefined && after[id] !== before[id]).length,
    }
  })()
  check(
    soak.sampled > 0 && soak.moved >= 1,
    "pulses advance (live lanes over the socket)",
    `${soak.moved}/${soak.sampled} in 5s`,
  )
  check(
    posts.live === 0 && posts.channel === 0,
    "still zero fetch-endpoint POSTs after streaming",
    `live=${posts.live} channel=${posts.channel}`,
  )

  // ── 5. HMR co-existence (dev only) ──
  if (MODE === "dev") {
    const hmrBefore = hmrFrames.length
    const original = readFileSync(CSS, "utf8")
    writeFileSync(CSS, `${original}\n/* validate-ws hmr ${Date.now()} */\n`)
    try {
      await until(
        () =>
          hmrFrames
            .slice(hmrBefore)
            .some((f) => /"type":"(update|full-reload)"|css-update|rsc:update/.test(f.text)),
        6000,
        "hmr update",
      )
      check(true, "Vite HMR still works alongside /__parton/ws")
    } catch {
      check(false, "Vite HMR still works alongside /__parton/ws", "no HMR update observed")
    } finally {
      writeFileSync(CSS, original)
    }
  } else {
    check(true, "HMR check skipped (preview has no HMR)")
  }

  // ── 6. Teardown — churn then health ──
  for (let r = 0; r < 3; r++) {
    await page.reload()
    await page.waitForSelector('[data-testid="chunk-0,0"]', { timeout: 15000 })
    await page.waitForTimeout(800)
  }
  await browser.close()
  await new Promise((r) => setTimeout(r, 1000))
  const t0 = Date.now()
  const health = await fetch(BASE)
  const healthMs = Date.now() - t0
  check(
    health.ok && healthMs < 3000,
    "server responsive after socket churn",
    `doc fetch ${healthMs}ms`,
  )

  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))
  check(netFails.length === 0, "no failed client requests", netFails.slice(0, 4).join(" | "))
} finally {
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {
    server.kill("SIGTERM")
  }
}

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
