import type { Page } from "@playwright/test"
import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * /magento/browse — the catalog as a `scroller()` collection.
 *
 * The interval tree windows the catalog: leaf partons resolve their
 * slice only in view, culled regions collapse to shells, `?page=` is
 * the anchor (cold seed + silent mirror). These tests assert the
 * behaviors that matter:
 *  - scrolling NEVER jumps backward (shells reserve estimated space);
 *  - culling follows the viewport (products load where you look; only
 *    a viewport-sized neighborhood is ever full);
 *  - the tree WINDOWS the catalog (far regions are collapsed shells,
 *    not one DOM section per page);
 *  - a deep-link `?page=N` lands on N with its products (anchor seed);
 *  - scroll silently mirrors into `?page=` without moving the viewport.
 *
 * Position is read from the tree's interval markers:
 * `[data-s="browse-grid"]` with `data-so` (offset) / `data-sn` (count).
 */

const card = '[data-testid^="browse-card-"]'
const marker = '[data-s="browse-grid"]'
const PAGE_SIZE = 12

// Drive the page down via the wheel, sampling scrollY after each notch.
async function wheelDown(page: Page, notches: number, dy = 400) {
  await page.mouse.move(550, 400)
  const ys: number[] = []
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, dy)
    await page.waitForTimeout(180)
    ys.push(await page.evaluate(() => Math.round(window.scrollY)))
  }
  return ys
}

// The anchor page derived from the deepest interval marker crossing
// the viewport's vertical center — the same rule the anchor-sync
// mirror uses.
async function centeredPage(page: Page) {
  return page.evaluate(
    ({ sel, ps }) => {
      const cy = window.innerHeight / 2
      let best: HTMLElement | null = null
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const r = el.getBoundingClientRect()
        if (!(r.top <= cy && r.bottom >= cy)) continue
        if (best === null || Number(el.dataset.sn) < Number(best.dataset.sn)) best = el
      }
      if (!best) return null
      const o = Number(best.dataset.so)
      const n = Number(best.dataset.sn)
      const r = best.getBoundingClientRect()
      const frac = r.height > 0 ? Math.min(1, Math.max(0, (cy - r.top) / r.height)) : 0
      return Math.floor((o + frac * n) / ps) + 1
    },
    { sel: marker, ps: PAGE_SIZE },
  )
}

// How many LEAF intervals currently SHOW products (are "full"). Culled
// leaves park their product DOM under a hidden Activity (cull-to-park),
// so presence alone doesn't mean full — a card counts only when it's
// actually rendered (display:none ancestors give offsetParent === null).
async function fullLeafCount(page: Page) {
  return page.evaluate(
    ({ sel, cardSel, ps }) => {
      let n = 0
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (Number(el.dataset.sn) > ps) continue
        for (const c of el.querySelectorAll<HTMLElement>(cardSel)) {
          if (c.offsetParent !== null) {
            n++
            break
          }
        }
      }
      return n
    },
    { sel: marker, cardSel: card, ps: PAGE_SIZE },
  )
}

// Catalog size in items, read off the root interval marker (the one
// spanning the whole collection).
async function totalItems(page: Page) {
  return page.evaluate((sel) => {
    let max = 0
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      max = Math.max(max, Number(el.dataset.sn))
    }
    return max
  }, marker)
}

test("scrolling down never jumps the viewport backward", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  // The culling machinery (Fragment-ref observers + refetch dispatch)
  // only runs on the hydrated page — scroll after the marker.
  await waitForPageInteractive(page)

  const ys = await wheelDown(page, 18)

  // Every sample must be >= the previous (small tolerance for sub-pixel
  // rounding). A culled region that collapsed its reservation would show
  // as a large negative step.
  let maxBackward = 0
  for (let i = 1; i < ys.length; i++) maxBackward = Math.max(maxBackward, ys[i - 1] - ys[i])
  expect(maxBackward, `scrollY trajectory: ${ys.join(",")}`).toBeLessThan(50)
  expect(ys[ys.length - 1]).toBeGreaterThan(2000)
})

test("culling follows the viewport — products load where you scroll, far regions stay shells", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await waitForPageInteractive(page)

  await wheelDown(page, 18)
  const centered = await centeredPage(page)
  expect(centered, "should have scrolled several pages down").toBeGreaterThan(4)

  // The viewport neighborhood fills — culled IN where you look. The
  // tree materializes level by level (each flip-in is a lane), so
  // poll for convergence rather than racing the cascade.
  await expect.poll(() => fullLeafCount(page), { timeout: 15000 }).toBeGreaterThan(0)
  const full = await fullLeafCount(page)

  // Culling is real: only a viewport-sized neighborhood is full, not
  // the whole catalog.
  const total = await totalItems(page)
  expect(full).toBeLessThan(16)
  expect(full * PAGE_SIZE).toBeLessThan(total)
})

test("the tree windows the catalog — far regions are collapsed shells, not per-page DOM", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  // Data-driven size (from total_count), well over any hardcoded pool.
  const total = await totalItems(page)
  expect(total).toBeGreaterThan(40 * PAGE_SIZE)

  // WINDOWING: the number of interval markers in the DOM is a tree
  // spine — O(viewport + log catalog) — below one section per page
  // (the shape this replaced).
  const markers = await page.locator(marker).count()
  expect(markers, `markers=${markers} for total=${total}`).toBeLessThan(
    Math.ceil(total / PAGE_SIZE),
  )

  // The whole catalog is still reachable: the document reserves
  // estimated space for every item.
  const docH = await page.evaluate(() => document.documentElement.scrollHeight)
  expect(docH).toBeGreaterThan((total / PAGE_SIZE) * 400)
})

test("deep-link ?page=50 lands on page 50 with its products", async ({ page }) => {
  await page.goto("/magento/browse?page=50")
  await page.waitForSelector(card, { timeout: 30000 })
  await waitForPageInteractive(page, { timeout: 30000 })

  // The anchor seed renders page 50's neighborhood full on the cold
  // paint; the pre-hydration script lands the viewport there (poll —
  // don't race it).
  await expect.poll(() => centeredPage(page), { timeout: 10000 }).toBeGreaterThanOrEqual(48)
  expect(await centeredPage(page)).toBeLessThanOrEqual(52)
  // The anchored leaf's products are rendered.
  const anchoredVisible = await page.evaluate(
    ({ sel, cardSel, t, ps }) => {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const o = Number(el.dataset.so)
        const n = Number(el.dataset.sn)
        if (!(t >= o && t < o + n) || n > ps) continue
        for (const c of el.querySelectorAll<HTMLElement>(cardSel)) {
          if (c.offsetParent !== null) return true
        }
      }
      return false
    },
    { sel: marker, cardSel: card, t: 49 * PAGE_SIZE, ps: PAGE_SIZE },
  )
  expect(anchoredVisible, "page 50's leaf shows products").toBe(true)
})

test("?page= mirrors scroll without resetting it", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  await wheelDown(page, 16)
  const yScrolled = await page.evaluate(() => Math.round(window.scrollY))
  expect(yScrolled, "actually scrolled down").toBeGreaterThan(3000)

  // The centered page is mirrored into ?page= once the scroll settles —
  // silent (no refetch), and it must NOT yank the viewport back to the
  // top (the silent-navigate scroll-reset bug).
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("page") || "0"), {
      timeout: 5000,
    })
    .toBeGreaterThan(3)
  const param = Number(new URL(page.url()).searchParams.get("page"))
  expect(Math.abs(param - ((await centeredPage(page)) ?? 0))).toBeLessThanOrEqual(2)
  const yAfter = await page.evaluate(() => Math.round(window.scrollY))
  expect(Math.abs(yAfter - yScrolled), "silent ?page= write kept the viewport put").toBeLessThan(
    120,
  )
})

test("client-side nav from home swaps to browse, not a torn page", async ({ page }) => {
  // The e2e's other tests `goto` the page; the bug only shows on a CLIENT
  // nav: the cull controller, firing its refetch as browse's cold partons
  // mount mid-navigation, superseded the route swap and left the home route
  // visible on top. The controller now defers culling until the navigation
  // settles.
  await page.goto("/")
  await waitForPageInteractive(page)
  await page.locator('a[href="/magento/browse"][data-hydrated]').first().click()
  // The visible page heading becomes browse's, and its first leaf
  // renders — home is swapped out (keepalive-hidden), not torn on top.
  await expect(page.locator("h1:visible").first()).toHaveText("Browse Products", { timeout: 20000 })
  await expect(page.locator(card).first()).toBeVisible({ timeout: 20000 })
})
