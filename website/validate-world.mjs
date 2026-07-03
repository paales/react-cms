/**
 * World validation suite — Paul's repro, automated, against a PROD
 * build. Run: `yarn build:website && node website/validate-world.mjs`
 * (starts its own preview server on PORT below).
 *
 * Scenario: load → let pulses run → scroll to load cells → keep
 * scrolling → refresh. Asserts at every step: no error cards, chunks
 * in the runway actually load, no failed requests, no page errors,
 * and the post-interaction refresh renders a non-blank world.
 */
import { spawn } from "node:child_process"
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
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout: ${label}`)
}

let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

try {
  await until(async () => {
    try {
      const r = await fetch(BASE)
      return r.ok
    } catch {
      return false
    }
  }, 30000, "preview server up")

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const netFails = []
  const pageErrors = []
  page.on("response", (r) => { if (r.status() >= 400) netFails.push(`${r.status()} ${r.url().slice(0, 120)}`) })
  page.on("requestfailed", (r) => { if (!r.failure()?.errorText.includes("ERR_ABORTED")) netFails.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 100)}`) })
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)))

  // ── Step 1: load, let pulses run a few seconds ──
  await page.goto(BASE)
  await page.waitForSelector('[data-testid="chunk-0,0"][data-loaded]', { timeout: 15000 })
  await page.waitForTimeout(5000)
  const errCards1 = await page.$$eval("[data-partial-error], .partial-error", (els) => els.length).catch(() => 0)
  check(errCards1 === 0, "no error cards after 5s of pulses", `${errCards1} cards`)
  const pulse1 = await page.$eval('[data-testid="chunk-0,0"] .chunk__pulse', (el) => el.textContent).catch(() => null)
  check(pulse1 !== null, "origin pulse rendering", String(pulse1))

  // ── Step 2: scroll up a bit — cells should load ──
  await page.evaluate(() => document.querySelector('[data-testid="world-scroller"]').scrollBy(0, -900))
  let loadedUp = false
  try {
    await until(async () => (await page.$('[data-testid="chunk-0,-3"][data-loaded]')) !== null, 10000, "")
    loadedUp = true
  } catch {}
  check(loadedUp, "chunk 0,-3 loads after scrolling up")

  // ── Step 3: keep scrolling in steps; every stop must load its cells ──
  const stops = []
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(() => document.querySelector('[data-testid="world-scroller"]').scrollBy(0, -1024))
    await page.waitForTimeout(1800)
    const cy = -3 - i * 2
    const sel = `[data-testid="chunk-0,${cy}"][data-loaded]`
    const ok = (await page.$(sel)) !== null
    stops.push(`0,${cy}:${ok ? "ok" : "MISS"}`)
  }
  const misses = stops.filter((s) => s.includes("MISS"))
  check(misses.length === 0, "every scroll stop loaded its cells", stops.join(" "))

  // ── Step 4: pulses still updating AT the current position? ──
  const here = await page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) =>
    els.slice(0, 3).map((el) => [el.closest("[data-testid]").dataset.testid, el.textContent]),
  )
  check(here.length > 0, "loaded chunks with pulses at current position", `${here.length}`)
  await page.waitForTimeout(6000)
  const after = await page.$$eval("[data-testid^='chunk-'][data-loaded] .chunk__pulse", (els) => {
    const m = {}
    for (const el of els) m[el.closest("[data-testid]").dataset.testid] = el.textContent
    return m
  })
  const moved = here.filter(([id, v]) => after[id] !== undefined && after[id] !== v)
  check(moved.length > 0, "pulses still live after scrolling", `${moved.length}/${here.length} advanced`)

  // ── Step 4b: STRESS — fast continuous scrolling, like a real user ──
  for (let i = 0; i < 100; i++) {
    await page.evaluate(() => document.querySelector('[data-testid="world-scroller"]').scrollBy(0, -400))
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(4000)
  const pos = await page.$eval('[data-testid="world-scroller"]', (el) => ({ x: el.scrollLeft, y: el.scrollTop, h: el.clientHeight }))
  const stressLoaded = await page.$$eval("[data-testid^='chunk-'][data-loaded]", (els) => els.length)
  check(stressLoaded > 0, "cells load after 40000px stress scroll", `${stressLoaded} loaded at y=${pos.y}`)
  // Do chunks IN the viewport actually have content?
  const cyHere = Math.floor((pos.y + pos.h / 2) / 512) - 32
  const inView = await page.$(`[data-testid="chunk-0,${cyHere}"][data-loaded]`)
  check(inView !== null, `viewport-center chunk 0,${cyHere} is loaded after stress`)

  // ── Step 5: refresh after interaction — page must not be blank ──
  await page.reload()
  let refreshOk = false
  try {
    await page.waitForSelector('[data-testid="world-scroller"]', { timeout: 15000 })
    refreshOk = (await page.$$eval("[data-testid^='chunk-']", (els) => els.length)) > 0
  } catch {}
  check(refreshOk, "refresh after interaction renders the world (not blank)")
  if (!refreshOk) {
    const body = await page.evaluate(() => document.body?.innerHTML.slice(0, 300) ?? "NO BODY")
    console.log("  body:", body)
  }

  check(netFails.length === 0, "no failed requests", netFails.slice(0, 4).join(" | "))
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))

  await browser.close()
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
