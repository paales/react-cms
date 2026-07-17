/**
 * Auto-UPGRADE end-to-end gate: proves the default (unforced) live
 * channel boots on fetch and PROMOTES itself to the WebSocket transport
 * where the socket works — the socket.io-shaped default, built on the
 * framework's re-attach machinery (`armTransportUpgrade` in the browser
 * entry + `probeWebSocketTransport` + `_channelRequestReattach`). The
 * website ships `partonChannelServer()`, so `/__parton/ws` is live and
 * the probe confirms.
 *
 * Run (preview / prod build, the default):
 *   yarn build:website && node website/validate-upgrade.mjs
 * Run (dev server):
 *   node website/validate-upgrade.mjs --dev
 *
 * It drives Chromium at `/` with NO `?transport=` param and asserts:
 *
 *   1. fetch first — the FIRST content arrives over fetch: a
 *      `POST /__parton/live` attach fires and origin content lands, all
 *      BEFORE any `/__parton/ws` socket opens. No handshake wait, works
 *      everywhere.
 *   2. upgrade     — within a short window the connection UPGRADES: the
 *      throwaway PROBE socket confirms and closes, then a HELD
 *      `/__parton/ws` socket (the re-attach) streams binary and stays
 *      open, `<html data-parton-live>` set. The handover is NO-TEAR:
 *      the held fetch attach is never torn before the socket is up —
 *      it closes CLEANLY (a server-side park-exit wind-down, observed
 *      as `requestfinished`, never `requestfailed`) and only after the
 *      probe confirmed.
 *   3. rides the socket — AFTER the upgrade, streaming + culling stay
 *      intact ACROSS the switch: scrolling into fresh territory streams
 *      the new centre chunk in over the SOCKET (binary frames), the
 *      visibility flips ride UP the socket (text frames), pulses keep
 *      advancing (live lanes) — and ZERO further fetch-endpoint POSTs
 *      fire (`/__parton/live`, `/__parton/channel`): everything is on WS.
 *   4. no tear     — no error cards, no page errors across the switch.
 *
 * The forced-transport gates are separate: `validate-world.mjs`
 * (`?transport=fetch`) and `validate-ws.mjs` (`?transport=ws`).
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5188
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  // Fetch-endpoint POST accounting, timestamped — the boot attach rides
  // `/__parton/live`; upstream envelopes pre-upgrade ride
  // `/__parton/channel`. After the upgrade NONE of these may fire.
  const postsLive = [] // { t, request, endT, how }
  const postsChannel = [] // { t }
  page.on("request", (r) => {
    if (r.method() !== "POST") return
    if (r.url().includes("/__parton/live"))
      postsLive.push({ t: Date.now(), request: r, endT: null, how: null })
    else if (r.url().includes("/__parton/channel")) postsChannel.push({ t: Date.now() })
  })
  // The held live POST's lifecycle — the no-tear proof: the handover
  // must close it CLEANLY (server-side park-exit → `requestfinished`),
  // never tear it (`requestfailed`), and only after the socket opened.
  const endLive = (r, how) => {
    const entry = postsLive.find((e) => e.request === r && e.endT === null)
    if (entry) {
      entry.endT = Date.now()
      entry.how = how
    }
  }
  page.on("requestfinished", (r) => {
    if (r.method() === "POST" && r.url().includes("/__parton/live")) endLive(r, "finished")
  })
  page.on("requestfailed", (r) => {
    if (r.method() === "POST" && r.url().includes("/__parton/live")) endLive(r, "failed")
  })

  // Per-socket lifecycle: the PROBE socket confirms and CLOSES; the
  // re-attach socket streams and stays OPEN (held). Tracking each lets
  // the upgrade key off the HELD socket, not the throwaway probe.
  const sockets = [] // { openAt, closed, recv: [{t,binary,n}], sent: [{t,text}] }
  let firstWsOpenAt = null
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/__parton/ws")) return
    if (firstWsOpenAt === null) firstWsOpenAt = Date.now()
    const rec = { openAt: Date.now(), closed: false, recv: [], sent: [] }
    sockets.push(rec)
    ws.on("framereceived", (f) => {
      const binary = typeof f.payload !== "string"
      rec.recv.push({ t: Date.now(), binary, n: binary ? f.payload.byteLength : f.payload.length })
    })
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string") rec.sent.push({ t: Date.now(), text: f.payload })
    })
    ws.on("close", () => {
      rec.closed = true
    })
  })
  /** The HELD live socket after the switch: open, receiving binary. */
  const heldSocket = () => sockets.find((s) => !s.closed && s.recv.some((r) => r.binary))

  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)))
  const netFails = []
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? ""
    if (err.includes("ERR_ABORTED")) return
    if (r.url().includes("/__parton/ws")) return // probe teardown noise
    netFails.push(`${err} ${r.url().slice(0, 80)}`)
  })

  const scroller = '[data-testid="world-scroller"]'
  const readPulses = () =>
    page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) => {
      const m = {}
      for (const el of els) m[el.closest("[data-testid]").dataset.testid] = el.textContent
      return m
    })

  // ── 1. Fetch first ──
  await page.goto(`${BASE}/`)
  const bootMs = await until(
    async () => (await page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "origin content",
  )
  // The live layer loads from a post-commit effect (hydrate-first boot),
  // then fires the fetch attach — so SSR origin content is already on
  // screen a beat before the `POST /__parton/live` lands. Wait for the
  // attach explicitly rather than sample it at content-paint; the
  // ordering checks below still prove it rode fetch, before any WS.
  try {
    await until(async () => postsLive.length > 0, 5000, "boot live attach")
  } catch {}
  const firstLiveAt = postsLive[0]?.t ?? null
  check(
    firstLiveAt !== null,
    "boot attaches over fetch (POST /__parton/live)",
    `${postsLive.length} live POST(s)`,
  )
  check(true, "origin content delivered over fetch", `${bootMs}ms`)
  check(
    firstWsOpenAt === null || (firstLiveAt !== null && firstLiveAt <= firstWsOpenAt),
    "first content rode fetch, before any WebSocket opened",
    firstWsOpenAt === null
      ? "ws not open yet at first content"
      : `ws opened ${firstWsOpenAt - firstLiveAt}ms after first live POST`,
  )

  // ── 2. Upgrade — wait for the HELD re-attach socket + establishment ──
  let upgradeMs = null
  try {
    upgradeMs = await until(
      async () =>
        heldSocket() !== undefined &&
        (await page.$eval("html", (h) => h.hasAttribute("data-parton-live")).catch(() => false)),
      15000,
      "",
    )
  } catch {}
  check(
    upgradeMs !== null,
    "connection upgrades to a HELD /__parton/ws socket",
    upgradeMs !== null ? `${upgradeMs}ms after boot` : "never upgraded",
  )
  const held = heldSocket()
  const probeClosed = sockets.some((s) => s.closed && s.recv.some((r) => r.binary))
  check(
    probeClosed,
    "the throwaway probe socket confirmed and closed",
    `${sockets.length} socket(s) total`,
  )
  const binaryDown = held ? held.recv.filter((r) => r.binary).length : 0
  const textDown = held ? held.recv.filter((r) => !r.binary).length : 0
  check(
    binaryDown > 0 && textDown === 0,
    "held socket downstream is opaque binary (the marker tunnel)",
    `${binaryDown} binary / ${textDown} text`,
  )

  // ── 2b. No tear across the handover — the held fetch attach closed
  // CLEANLY (the park-exit wind-down), never failed, and only after the
  // socket was up. `requestfailed` here would mean the client tore the
  // held stream (the abort path) instead of the server winding it down.
  const heldLive = postsLive.find((e) => e.how !== null)
  check(
    heldLive !== undefined && heldLive.how === "finished",
    "held fetch attach closed CLEANLY at the handover (never torn)",
    heldLive === undefined ? "still open / unobserved" : `ended: ${heldLive.how}`,
  )
  check(
    heldLive !== undefined && firstWsOpenAt !== null && heldLive.endT >= firstWsOpenAt,
    "fetch attach outlived the socket's open — no dead gap",
    heldLive !== undefined && firstWsOpenAt !== null
      ? `fetch closed ${heldLive.endT - firstWsOpenAt}ms after ws open`
      : "unobserved",
  )

  // Let the handover fully settle, then snapshot: from here NOTHING may
  // ride a fetch endpoint (every statement is on the socket).
  await page.waitForTimeout(1500)
  const liveAtSwitch = postsLive.length
  const channelAtSwitch = postsChannel.length

  // ── 3. Rides the socket — scroll into fresh territory AFTER the switch ──
  const scrollStart = Date.now()
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
  const binaryDuringScroll = sockets
    .flatMap((s) => s.recv)
    .filter((r) => r.binary && r.t >= scrollStart).length
  check(
    binaryDuringScroll > 0,
    "flipped-in chunks stream down as binary frames (culling intact)",
    `${binaryDuringScroll} frames during scroll`,
  )
  const visibleFrames = sockets
    .flatMap((s) => s.sent)
    .filter((s) => s.t >= scrollStart)
    .filter((s) => {
      try {
        return JSON.parse(s.text).frames?.some((f) => f.kind === "visible")
      } catch {
        return false
      }
    })
  check(
    visibleFrames.length > 0,
    "upstream visibility flips ride UP the socket",
    `${visibleFrames.length} visible envelope(s)`,
  )
  const liveAfter = postsLive.length - liveAtSwitch
  const channelAfter = postsChannel.length - channelAtSwitch
  check(liveAfter === 0, "no further POST /__parton/live after the upgrade", `${liveAfter} new`)
  check(
    channelAfter === 0,
    "no further POST /__parton/channel after the upgrade (envelopes on WS)",
    `${channelAfter} new`,
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
    postsLive.length - liveAtSwitch === 0 && postsChannel.length - channelAtSwitch === 0,
    "still zero fetch-endpoint POSTs after streaming",
    `live=${postsLive.length - liveAtSwitch} channel=${postsChannel.length - channelAtSwitch}`,
  )

  // ── 4. No tear ──
  const errCards = await page
    .$$eval("[data-partial-error], .partial-error", (els) => els.length)
    .catch(() => 0)
  check(errCards === 0, "no error cards across the switch", `${errCards} cards`)
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))
  check(netFails.length === 0, "no failed client requests", netFails.slice(0, 4).join(" | "))

  console.log(
    `\nboot→origin ${bootMs}ms · upgrade ${upgradeMs}ms after boot · ${sockets.length} ws socket(s)`,
  )
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
