/**
 * DEV-HMR LIVE-EDIT gate — proves a server-code edit reaches the
 * browser WITHOUT a manual reload, across every transport phase of a
 * dev session. Manual (not wired into CI): it boots its own `vite dev`
 * on a scratch port and edits source files on disk, which is too
 * environment-sensitive for the suite. Run from the repo root:
 *
 *   node e2e-testing/validate-hmr.mjs
 *
 * What it drives (all against /hmr-probe, whose plain + byte-cached
 * partons render a MARKER constant this script rewrites on disk):
 *
 *   1. FETCH-ERA edit — an edit ~1s after load, while the live channel
 *      is still fetch-based (the ws auto-upgrade races it).
 *   2. CONSECUTIVE edit — a second edit immediately after the first
 *      commits (exercises the mid-reattach born-stale session gate).
 *   3. POST-UPGRADE edits — two more after the ws upgrade settles
 *      (exercises the held-socket detach + immediate reattach).
 *   4. FRAMEWORK edit — a comment appended to a framework source file
 *      (the whole rsc graph re-evaluates; globalThis-backed state must
 *      carry the code version across).
 *   5. RELOAD — a plain reload still shows the newest marker.
 *
 * Every step asserts BOTH markers (plain parton + `cache:` parton), so
 * the fp-keyed byte cache is covered. The mechanism under test is
 * documented in docs/internals/render-pipeline.md § Dev HMR.
 */

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROBE = path.join(ROOT, "e2e-testing/src/app/pages/hmr-probe.tsx")
const FRAMEWORK_FILE = path.join(ROOT, "framework/src/lib/code-version.ts")
const PORT = Number(process.env.HMR_GATE_PORT ?? 5327)
const URL = `http://localhost:${PORT}/hmr-probe`

const require = createRequire(path.join(ROOT, "e2e-testing/package.json"))
const { chromium } = require("playwright")

const originalProbe = readFileSync(PROBE, "utf8")
const originalFw = readFileSync(FRAMEWORK_FILE, "utf8")
if (!originalProbe.includes('const MARKER = "HMR_MARKER_A"')) {
  console.error("hmr-probe.tsx is not in its committed state — restore it first")
  process.exit(1)
}
const setMarker = (m) =>
  writeFileSync(
    PROBE,
    originalProbe.replace('const MARKER = "HMR_MARKER_A"', `const MARKER = "${m}"`),
  )

const server = spawn(
  "yarn",
  ["workspace", "@parton/e2e-testing", "dev", "--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
)
let serverLog = ""
server.stdout.on("data", (d) => (serverLog += d))
server.stderr.on("data", (d) => (serverLog += d))

let browser = null
const cleanup = () => {
  writeFileSync(PROBE, originalProbe)
  writeFileSync(FRAMEWORK_FILE, originalFw)
  try {
    process.kill(-server.pid, "SIGKILL")
  } catch {}
  try {
    server.kill("SIGKILL")
  } catch {}
}
process.on("exit", cleanup)
process.on("SIGINT", () => process.exit(130))

for (let i = 0; ; i++) {
  try {
    const res = await fetch(URL)
    if (res.ok) break
  } catch {}
  if (i > 240) {
    console.error("dev server never came up on :" + PORT + "\n" + serverLog.slice(-4000))
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 500))
}

browser = await chromium.launch()
const page = await browser.newPage()
// Vite's OWN HMR socket must finish its handshake before we edit a
// source file: an `rsc:update` Vite emits before the client socket is
// connected is dropped (Vite does not replay backlog on connect), and
// the browser stays on the old bytes. This is independent of the
// framework's live channel — it's the dev server's HMR transport. Fast
// hydration (a lean initial chunk) can reach "interactive" before that
// handshake lands, so gate the first edit on the connection, not on
// paint. `[vite] connected` is the client runtime's own ready log.
let viteHmrConnected = false
page.on("console", (m) => {
  if (m.text().includes("[vite] connected")) viteHmrConnected = true
})
await page.goto(URL)

let failures = 0
const expectBoth = async (value, label, timeout = 10_000) => {
  try {
    await page.waitForFunction(
      (v) =>
        document.querySelector('[data-testid="hmr-marker"]')?.textContent === v &&
        document.querySelector('[data-testid="hmr-marker-cached"]')?.textContent === v,
      value,
      { timeout },
    )
    console.log(`PASS ${label}: both markers -> ${value}`)
  } catch {
    failures++
    const plain = await page
      .locator('[data-testid="hmr-marker"]')
      .textContent()
      .catch(() => "?")
    const cached = await page
      .locator('[data-testid="hmr-marker-cached"]')
      .textContent()
      .catch(() => "?")
    console.log(`FAIL ${label}: plain=${plain} cached=${cached} (wanted ${value})`)
  }
}

await expectBoth("HMR_MARKER_A", "initial load")

// Gate the first edit on Vite's HMR socket handshake (see above). Bounded
// wait — a `[vite] connected` that never lands falls through after 5s and
// the phase fails honestly rather than hanging.
for (let i = 0; i < 100 && !viteHmrConnected; i++) {
  await new Promise((r) => setTimeout(r, 50))
}

// 1. Fetch-era edit (~1s after load, upgrade in flight).
setMarker("HMR_MARKER_B")
await expectBoth("HMR_MARKER_B", "fetch-era edit, live")

// 2. Immediate consecutive edit.
setMarker("HMR_MARKER_C")
await expectBoth("HMR_MARKER_C", "consecutive edit, live")

// 3. Post-upgrade edits (ws established).
await new Promise((r) => setTimeout(r, 6000))
setMarker("HMR_MARKER_D")
await expectBoth("HMR_MARKER_D", "post-upgrade edit, live")
setMarker("HMR_MARKER_E")
await expectBoth("HMR_MARKER_E", "post-upgrade consecutive edit, live")

// 4. Framework-file edit (whole rsc graph re-evaluates), then an app edit.
writeFileSync(FRAMEWORK_FILE, originalFw + "\n// hmr-gate touch\n")
await new Promise((r) => setTimeout(r, 2500))
await expectBoth("HMR_MARKER_E", "framework edit did not regress content")
setMarker("HMR_MARKER_F")
await expectBoth("HMR_MARKER_F", "edit after framework edit, live")

// 5. Plain reload shows the newest marker.
await page.reload()
await expectBoth("HMR_MARKER_F", "after reload")

await browser.close()
console.log(failures === 0 ? "\nHMR GATE: ALL PASS" : `\nHMR GATE: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
