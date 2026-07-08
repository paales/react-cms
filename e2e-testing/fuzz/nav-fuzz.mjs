/**
 * Navigation fuzzer — Phase 0.
 *
 * Drives the app through random navigation sequences and asserts the
 * two invariants that encode the "navigation blows up the app / only a
 * refresh fixes it" symptom class:
 *
 *   - CONTAINMENT: after every action the app shell is still mounted and
 *     the global "Something went wrong" page is NOT showing. A parton may
 *     fail (a contained error card is fine) — the chrome must survive.
 *   - RECOVERY: when an action does trip a global failure, a browser
 *     Back should restore a working shell without a hard refresh. We
 *     probe it and record the result (this is the open fix-#2 question).
 *
 * Every run is driven by a seeded PRNG, so `--seed=N` replays the exact
 * action sequence. On a violation the full trace + a screenshot + the
 * page HTML + the console buffer are dumped so the failure is
 * reproducible and diagnosable. Races are manufactured by sometimes
 * firing the next action WITHOUT waiting for the prior one to settle
 * (`--overlap`), which is what surfaces stale-commit / cache-prune /
 * template-stickiness ordering bugs that manual clicking can't.
 *
 * Usage (against the prod preview — `yarn build:all && yarn preview:all`):
 *   node e2e-testing/fuzz/nav-fuzz.mjs                 # one random seed
 *   node e2e-testing/fuzz/nav-fuzz.mjs --runs=20       # 20 random seeds
 *   node e2e-testing/fuzz/nav-fuzz.mjs --seed=12345    # replay one seed
 *   node e2e-testing/fuzz/nav-fuzz.mjs --url=http://localhost:5179
 *   node e2e-testing/fuzz/nav-fuzz.mjs --steps=200 --overlap=0.5 --headed
 *
 * Phase 1 (not yet): per-frame / search-keystroke actions, dev-mode
 * runtime invariant hooks, and ddmin shrinking → auto-emitted .spec.ts.
 */

import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACT_DIR = path.join(HERE, "..", ".tmp", "fuzz-artifacts")

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] ?? true
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const BASE = (args.url ?? "http://localhost:5173").replace(/\/$/, "")
const STEPS = Number(args.steps ?? 120)
const RUNS = Number(args.runs ?? 1)
const OVERLAP = Number(args.overlap ?? 0.35) // P(fire next action before settling)
const HEADED = Boolean(args.headed)
// Substrings to skip in link hrefs — e.g. routes that depend on an
// external backend or a companion server, so a campaign can isolate the
// core navigation surface from environmental (network) noise.
const EXCLUDE = typeof args.exclude === "string" ? args.exclude.split(",").filter(Boolean) : []

// ── seeded PRNG (mulberry32) — the whole run derives from one int ────
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]

// ── oracle: patterns that are NORMAL, not failures ──────────────────
// Aborts/torn streams are expected on nav cancel (the runtime models
// these — see entry.browser.tsx `silenceTornStream`).
const BENIGN = [
  /AbortError/i,
  /could not finish this Suspense boundary/i,
  /BodyStreamBuffer was aborted/i,
]
// Environmental noise in this sandbox (external API outage / a known
// CMS list-key warning) — logged but never a hard failure.
const ENV_NOISE = [/fetch failed/i, /unique "key" prop/i, /\[cell\] persistent cell/i]
const matchAny = (res, s) => res.some((r) => r.test(s))

// ── lightweight RSC-idle (the heartbeat keeps a ?streaming=1 conn open
//    forever, so plain networkidle never fires) ──────────────────────
function trackRsc(page) {
  const inflight = new Set()
  let lastChange = Date.now()
  const isRsc = (u) => u.includes("_.rsc") && !u.includes("streaming=1")
  page.on("request", (r) => {
    if (isRsc(r.url())) {
      inflight.add(r)
      lastChange = Date.now()
    }
  })
  const done = (r) => {
    if (inflight.delete(r)) lastChange = Date.now()
  }
  page.on("requestfinished", done)
  page.on("requestfailed", done)
  return {
    async settle(quietMs = 250, timeout = 8000) {
      const start = Date.now()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (inflight.size === 0 && Date.now() - lastChange >= quietMs) return
        if (Date.now() - start > timeout) return // best-effort
        await new Promise((r) => setTimeout(r, 40))
      }
    },
  }
}

// ── invariants checked after every action ───────────────────────────
async function checkInvariants(page) {
  // Only assert on app pages — a traversal that left the origin
  // (e.g. back to about:blank) is the fuzzer's concern, not a bug.
  if (!page.url().startsWith(BASE)) return null
  const [shell, globalErr] = await Promise.all([
    page.locator("[data-testid=page-shell]").count(),
    page.getByText("Something went wrong").count(),
  ])
  if (globalErr > 0) return { type: "global-error-page" }
  if (shell === 0) return { type: "page-shell-missing" }
  return null
}

// Base invariants + (right after a keystroke) the search overlay must
// survive being typed into — typing must never drop the dialog. `action`
// supplies that context; the check is a no-op for non-search actions.
async function checkAll(page, action) {
  const base = await checkInvariants(page)
  if (base) return base
  if (action?.typedIntoSearch) {
    // A drop only counts as a bug if URL search is STILL meant to be open
    // (`?search` present). A `back`/link that popped `?search` closes the
    // dialog legitimately — typing a beat later then "loses" it, but
    // that's the navigation, not a torn stream.
    let searchMeantOpen = false
    try {
      searchMeantOpen = new URL(page.url()).searchParams.has("search")
    } catch {
      /* ignore */
    }
    if (searchMeantOpen) {
      const stillOpen = await page
        .locator("dialog input[type=text]")
        .count()
        .catch(() => 1)
      if (stillOpen === 0) return { type: "search-dialog-dropped" }
    }
  }
  return null
}

// ── action model: same-origin link clicks + history traversal ───────
async function sameOriginLinks(page) {
  return page.$$eval(
    "a[href]",
    (els, exclude) =>
      els
        .filter((a) => {
          const href = a.getAttribute("href") || ""
          if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("//"))
            return false
          if (exclude.some((e) => href.includes(e))) return false
          const r = a.getBoundingClientRect()
          return r.width > 0 && r.height > 0 // visible
        })
        .map((a) => a.getAttribute("href")),
    EXCLUDE,
  )
}

async function doAction(page, rng, hist) {
  const links = await sameOriginLinks(page)
  // Search surface: type into an open overlay (each keystroke is a
  // same-page `?q` nav — the case that tore the page via the heartbeat),
  // or open one when the page offers it.
  const searchOpen = (await page.locator("dialog input[type=text]").count()) > 0
  // URL-mode search: each keystroke is a window `?q` nav — the surface
  // the heartbeat tear dropped. (Frame-mode search navigates the frame,
  // which doesn't fire a window `navigate`, so it never hit the bug.)
  const urlSearchBtn = page.getByRole("button", { name: /Search \(URL\)/ })
  const canOpenSearch = !searchOpen && (await urlSearchBtn.count()) > 0
  // History-depth gating keeps traversal INSIDE the app: never `back`
  // past the entry page (which would land on about:blank), and only
  // `forward` when we've actually backed up.
  const kinds = []
  if (links.length) kinds.push("link", "link") // weight navigation higher
  if (hist.pos > 0) kinds.push("back")
  if (hist.pos < hist.max) kinds.push("forward")
  if (searchOpen) kinds.push("searchKey", "searchKey", "searchKey") // hammer when open
  if (canOpenSearch) kinds.push("searchOpen")
  if (!kinds.length) kinds.push("link")
  const kind = pick(rng, kinds)

  if (kind === "searchKey") {
    const key = rng() < 0.75 ? "abcdefghijklmnopqrstuvwxyz"[Math.floor(rng() * 26)] : "Backspace"
    await page
      .locator("dialog input[type=text]")
      .first()
      .press(key, { timeout: 2000 })
      .catch(() => {})
    return { kind, key, typedIntoSearch: true }
  }
  if (kind === "searchOpen") {
    await urlSearchBtn
      .first()
      .click({ timeout: 2000 })
      .catch(() => {})
    return { kind }
  }
  if (kind === "link" && links.length) {
    const href = pick(rng, links)
    await page
      .locator(`a[href="${href}"]`)
      .first()
      .click({ timeout: 3000 })
      .catch(() => {})
    hist.pos++ // assume a push (occasional over-count is harmless)
    hist.max = hist.pos
    return { kind, href }
  }
  if (kind === "back") {
    await page.goBack({ timeout: 3000 }).catch(() => {})
    hist.pos = Math.max(0, hist.pos - 1)
    return { kind }
  }
  await page.goForward({ timeout: 3000 }).catch(() => {})
  hist.pos = Math.min(hist.max, hist.pos + 1)
  return { kind }
}

// ── one seeded run ───────────────────────────────────────────────────
async function runSeed(seed, browser) {
  const rng = mulberry32(seed)
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-test-scope": `fuzz-${seed}` }, // per-seed state bucket
  })
  const page = await ctx.newPage()
  const rsc = trackRsc(page)
  const trace = []
  const consoleErrors = []
  let pageError = null

  page.on("pageerror", (e) => {
    if (!matchAny(BENIGN, e.message)) pageError ??= { msg: e.message, at: trace.length }
  })
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (matchAny(BENIGN, t) || matchAny(ENV_NOISE, t)) return
    consoleErrors.push({ at: trace.length, msg: t.slice(0, 300) })
  })

  await page.goto(BASE + "/", { waitUntil: "load" }).catch(() => {})
  await rsc.settle()

  const hist = { pos: 0, max: 0 } // in-app history position
  let violation = null
  for (let i = 0; i < STEPS && !violation && !pageError; i++) {
    const action = await doAction(page, rng, hist)
    trace.push(action)
    // Overlap knob: sometimes DON'T settle — fire into an in-flight nav.
    if (rng() > OVERLAP) await rsc.settle().catch(() => {})
    else await page.waitForTimeout(Math.floor(rng() * 60))
    let v = await checkAll(page, action).catch(() => null)
    if (v) {
      // Distinguish a STUCK failure (the "only a refresh fixes it"
      // symptom) from a one-frame recovery blank: re-check after a beat.
      // A failure that self-heals within ~half a second is not the bug.
      await page.waitForTimeout(450)
      v = await checkAll(page, action).catch(() => null)
      if (v) violation = { ...v, at: i, action }
    }
  }
  if (!violation && pageError) violation = { type: "pageerror", ...pageError }

  // Recovery probe — does Back restore a working shell w/o a refresh?
  let recovery = null
  if (violation) {
    await page.goBack({ timeout: 3000 }).catch(() => {})
    await rsc.settle().catch(() => {})
    const after = await checkInvariants(page).catch(() => ({ type: "unknown" }))
    recovery = after ? "back-did-not-recover" : "back-recovered"
  }

  const result = { seed, steps: trace.length, violation, recovery, consoleErrors, trace }
  if (violation) await dumpArtifacts(page, result)
  await ctx.close()
  return result
}

async function dumpArtifacts(page, result) {
  const dir = path.join(ARTIFACT_DIR, String(result.seed))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(result, null, 2))
  await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true }).catch(() => {})
  await fs.promises
    .writeFile(path.join(dir, "page.html"), await page.content().catch(() => ""))
    .catch(() => {})
  console.log(`   ↳ artifacts: ${path.relative(process.cwd(), dir)}`)
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  const seeds = args.seed
    ? [Number(args.seed)]
    : Array.from({ length: RUNS }, () => Math.floor(Math.random() * 2 ** 31))

  console.log(
    `nav-fuzz · base=${BASE} · seeds=${seeds.length} · steps=${STEPS} · overlap=${OVERLAP}`,
  )
  const browser = await chromium.launch({ headless: !HEADED })
  let failures = 0
  for (const seed of seeds) {
    const r = await runSeed(seed, browser)
    if (r.violation) {
      failures++
      const a = r.violation.action ? ` after ${r.violation.action.kind}` : ""
      console.log(
        `✘ seed ${seed}: ${r.violation.type}${a} @ step ${r.violation.at ?? "?"} · recovery: ${r.recovery}`,
      )
    } else {
      const warn = r.consoleErrors.length ? ` (${r.consoleErrors.length} console errors)` : ""
      console.log(`✓ seed ${seed}: ${r.steps} steps clean${warn}`)
    }
  }
  await browser.close()
  console.log(`\n${seeds.length - failures}/${seeds.length} seeds clean`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
