/**
 * Embassy district gate — the paint-only exhibit of the federation
 * arc's demo thread (`docs/notes/remote-frame-arc.md`), against a
 * PROD build by default.
 * Run: `yarn build:website && node website/validate-embassy.mjs`
 * (starts its own preview server on PORT below; `--dev` runs the dev
 * server instead).
 *
 * What it proves:
 *   1. the thesis — /embassy/bulletin is an ORDINARY page: browsable
 *      standalone (no world around it), contraband raw HTML and all;
 *   2. the splice — the world's embassy building paints the bulletin
 *      INSIDE `<parton-embed-box data-grant="paint">` with the
 *      framework-stamped `contain: strict` containment;
 *   3. the handshake — host `--parton-*` custom properties cross the
 *      containment boundary: the spliced heading computes the
 *      district's violet, which the STANDALONE page does not carry;
 *   4. the border — the contraband rows do NOT paint inside the box:
 *      neither the raw <div> nor the raw <a> (a link that crossed
 *      would natively navigate the WHOLE host page — links are
 *      deliberately not vocabulary). Prod degrades silently (no
 *      marker either); dev leaves the visible
 *      `parton-tier-violation` marker. Both modes assert the
 *      structured `[parton] tier-violation` line in the host log —
 *      degrade + loud — including the seized link's own line
 *      (`"type":"a"`);
 *   5. navigation containment — real clicks inside the embed box
 *      never move the host document. Real signals, not timing: a
 *      realm token stamped on `window` survives (a top-level
 *      navigation mints a fresh JS realm) and the page URL is
 *      byte-identical;
 *   6. the district — chunks under the building carry the embassy
 *      tint, and the world around it stays healthy (origin content,
 *      no error cards, no page errors, no failed requests).
 */
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PORT = process.env.PORT ?? 5287
const BASE = `http://localhost:${PORT}`
const MODE = process.argv.includes("--dev") ? "dev" : "preview"

// The district's violet (--parton-heading-color in styles.css).
const EMBASSY_VIOLET = "rgb(199, 146, 234)"

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

  // ── 1. Standalone: an embeddable page is an ordinary page ──
  await page.goto(`${BASE}/embassy/bulletin`)
  await page.waitForSelector('[data-testid="embassy-bulletin-title"]', { timeout: 15000 })
  check(true, "standalone /embassy/bulletin renders the bulletin")
  check(
    (await page.$('[data-testid="world-scroller"]')) === null,
    "the world's match carves out /embassy — no scroller on the standalone page",
  )
  const standaloneContraband = await page.$eval(
    '[data-testid="embassy-contraband"]',
    (el) => el.textContent,
  )
  check(
    standaloneContraband.includes("GLORIOUS FIREWORKS"),
    "contraband raw HTML renders on the ORDINARY page",
  )
  const standaloneLink = await page.$eval('[data-testid="embassy-defection-link"]', (el) => ({
    tag: el.tagName,
    href: el.getAttribute("href"),
  }))
  check(
    standaloneLink.tag === "A" && standaloneLink.href === "https://ministry.example/defect",
    "contraband raw <a> renders on the ORDINARY page, href intact",
    standaloneLink.href,
  )
  const standaloneHeading = await page.$eval(
    '[data-testid="embassy-bulletin-title"]',
    (el) => getComputedStyle(el).color,
  )
  check(
    standaloneHeading !== EMBASSY_VIOLET,
    "standalone heading does NOT wear the district violet (the theme is the host's)",
    standaloneHeading,
  )

  // ── 2. The world: the splice, the box, the handshake, the border ──
  await page.goto(`${BASE}/`)
  await until(
    async () => (await page.$('[data-testid="chunk-0,0"][data-loaded]')) !== null,
    15000,
    "origin content",
  )
  // The embassy content rides the page parton (never culled), so it's
  // in the DOM before any scroll; scroll west so the tint chunks load
  // and the assertions run on a painted region.
  await page.$eval('[data-testid="world-scroller"]', (el) => el.scrollBy(-1100, 0))
  const box = '[data-testid="embassy-building"] parton-embed-box'
  await until(
    async () =>
      (await page
        .$eval(box, (el) => el.querySelector("parton-heading") !== null)
        .catch(() => false)) === true,
    15000,
    "bulletin spliced into the embed box",
  )
  check(true, "bulletin content painted inside <parton-embed-box>")
  const boxFacts = await page.$eval(box, (el) => ({
    grant: el.getAttribute("data-grant"),
    contain: getComputedStyle(el).contain,
    height: el.getBoundingClientRect().height,
  }))
  check(boxFacts.grant === "paint", "embed box carries data-grant=paint", boxFacts.grant)
  check(
    boxFacts.contain === "strict" || boxFacts.contain === "size layout paint",
    "containment is framework-stamped (contain: strict)",
    boxFacts.contain,
  )
  check(boxFacts.height > 0, "host CSS sizes the box (size containment)", `${boxFacts.height}px`)

  const splicedHeading = await page.$eval(
    `${box} parton-heading`,
    (el) => getComputedStyle(el).color,
  )
  check(
    splicedHeading === EMBASSY_VIOLET,
    "host --parton-* custom properties theme the spliced vocabulary",
    splicedHeading,
  )

  // The border: contraband never paints under the paint grant. Prod
  // drops the row silently; dev replaces it with the visible marker —
  // don't fake one in the other mode.
  const contrabandInBox = await page.$(`${box} [data-testid="embassy-contraband"]`)
  check(contrabandInBox === null, "contraband raw <div> did NOT cross the paint splice")
  const anchorsInBox = await page.$$eval(`${box} a`, (els) => els.length)
  check(
    anchorsInBox === 0,
    "no anchor crossed the paint splice — zero <a> inside the embed box",
    `${anchorsInBox} anchors`,
  )
  const markers = await page.$$eval("parton-tier-violation", (els) => els.length)
  if (MODE === "preview") {
    check(markers === 0, "prod degrades silently — no violation marker", `${markers} markers`)
  } else {
    check(markers >= 1, "dev shows the violation marker in place", `${markers} markers`)
  }
  const violationLines = serverLog
    .join("")
    .split("\n")
    .filter((l) => l.includes("[parton] tier-violation"))
  check(
    violationLines.length >= 1 && violationLines.some((l) => l.includes('"offense":"element"')),
    "structured tier-violation line lands in the host log (degrade + LOUD)",
    violationLines[0]?.slice(0, 140),
  )
  check(
    violationLines.some((l) => l.includes('"offense":"element"') && l.includes('"type":"a"')),
    "the seized link logs its own structured line (element offense, type a)",
  )

  // ── The escalation probe: clicks inside the box never move the host ──
  // A leaked anchor (or any activation behavior smuggled past the
  // border) would navigate the HOST document — the embed is spliced
  // into the host DOM, so a native activation is a TOP-LEVEL move.
  // Real signals, not timing: a realm token stamped on `window`
  // survives (a top-level navigation mints a fresh JS realm where the
  // token is gone), and the page URL stays byte-identical (no soft
  // navigation either — the world syncs nothing into its URL).
  const realmToken = `embassy-realm-${Date.now()}`
  await page.evaluate((t) => {
    window.__partonEmbassyRealm = t
  }, realmToken)
  const urlBefore = page.url()
  const clickTargets = [
    ...(await page.$$(`${box} parton-heading`)),
    ...(await page.$$(`${box} parton-text`)),
    // Dev leaves violation markers standing exactly where the seized
    // contraband (div + link) would have been — click those spots too.
    ...(await page.$$(`${box} parton-tier-violation`)),
  ]
  for (const target of clickTargets) await target.click({ force: true })
  const realmAfter = await page.evaluate(() => window.__partonEmbassyRealm ?? null)
  check(
    clickTargets.length >= 2 && realmAfter === realmToken,
    "clicks inside the embed box never replaced the document (realm token survives)",
    `${clickTargets.length} targets clicked`,
  )
  check(
    page.url() === urlBefore,
    "clicks inside the embed box never navigated the host",
    page.url(),
  )

  // ── 3. The district tint under the building ──
  await until(
    async () => (await page.$('[data-testid="chunk--3,0"][data-loaded]')) !== null,
    15000,
    "district chunk content",
  )
  const tinted = await page.$eval('[data-testid="chunk--3,0"]', (el) =>
    el.className.includes("chunk--embassy"),
  )
  check(tinted, "district chunks carry the embassy tint")

  // ── 4. Hygiene ──
  const errCards = await page
    .$$eval("[data-partial-error], .partial-error", (els) => els.length)
    .catch(() => 0)
  check(errCards === 0, "no error cards", `${errCards} cards`)
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "))
  check(netFails.length === 0, "no failed requests", netFails.slice(0, 4).join(" | "))

  await browser.close()
} catch (e) {
  failures++
  console.error(`✗ ${e.message}`)
  console.error(serverLog.slice(-20).join(""))
} finally {
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {
    server.kill("SIGTERM")
  }
}

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
