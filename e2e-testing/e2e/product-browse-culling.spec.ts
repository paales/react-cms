import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

/**
 * /magento/browse — read-tracked view culling.
 *
 * Each catalog page is a parton that reads `visible()`: in view → its
 * products, out → a skeleton. The framework observes each through a
 * `<Fragment ref>` and self-refetches it as it enters or leaves view,
 * carrying the live `?visible=` set. These tests assert the behaviors that
 * matter:
 *  - scrolling NEVER jumps backward (fixed-height sections reserve space);
 *  - culling follows the viewport (products load where you look; only a
 *    viewport-sized neighborhood is ever full — not the whole catalog);
 *  - a deep-link `?page=N` lands on N with its products (the anchor seed);
 *  - the catalog is data-driven (from `total_count`) and the URL stays
 *    clean as you scroll (no `?page=` shadow, no cookie).
 */

const card = '[data-testid^="browse-card-"]'

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

// The page section whose box contains the vertical center of the viewport.
async function centeredPage(page: Page) {
  return page.evaluate(() => {
    const cy = window.innerHeight / 2
    for (const s of document.querySelectorAll("[data-page]")) {
      const r = s.getBoundingClientRect()
      if (r.top <= cy && r.bottom >= cy) return Number(s.getAttribute("data-page"))
    }
    return null
  })
}

// How many page sections currently have products (are "full" — fetched).
async function fullPageCount(page: Page) {
  return page.evaluate((cardSel) => {
    let n = 0
    for (const s of document.querySelectorAll("[data-page]")) if (s.querySelector(cardSel)) n++
    return n
  }, card)
}

async function totalPages(page: Page) {
  return Number(await page.locator('[data-testid="browse-list"]').getAttribute("data-total-pages"))
}

test("scrolling down never jumps the viewport backward", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  const ys = await wheelDown(page, 18)

  // Every sample must be >= the previous (small tolerance for sub-pixel
  // rounding). A culled page that collapsed its space would show as a large
  // negative step — the bug fixed-height reservation guards against.
  let maxBackward = 0
  for (let i = 1; i < ys.length; i++) maxBackward = Math.max(maxBackward, ys[i - 1] - ys[i])
  expect(maxBackward, `scrollY trajectory: ${ys.join(",")}`).toBeLessThan(50)
  expect(ys[ys.length - 1]).toBeGreaterThan(2000)
})

test("culling follows the viewport — products load where you scroll, far pages stay skeletons", async ({
  page,
}) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  await wheelDown(page, 18)
  const centered = await centeredPage(page)
  expect(centered, "should have scrolled several pages down").toBeGreaterThan(4)

  // The page at the viewport center has its products — culled IN.
  await expect(
    page.locator(`[data-page="${centered}"] ${card}`).first(),
    "the centered page should have product cards",
  ).toBeVisible({ timeout: 15000 })

  // Culling is real: only a viewport-sized neighborhood is full, not the
  // whole catalog.
  const full = await fullPageCount(page)
  const total = await totalPages(page)
  expect(full, `only a neighborhood is full (of ${total})`).toBeLessThan(16)
  expect(full).toBeLessThan(total)
})

test("deep-link ?page=50 lands on page 50 with its products", async ({ page }) => {
  await page.goto("/magento/browse?page=50")
  await page.waitForSelector(card, { timeout: 20000 })

  // The anchor seed renders page 50's neighborhood full on the cold paint;
  // ScrollToPage then lands the viewport there (a mount-effect scroll, so
  // poll for it rather than racing it).
  await expect(page.locator(`[data-page="50"] ${card}`).first()).toBeVisible({ timeout: 20000 })
  await expect.poll(() => centeredPage(page), { timeout: 10000 }).toBeGreaterThanOrEqual(48)
  expect(await centeredPage(page)).toBeLessThanOrEqual(52)
})

test("data-driven catalog; ?page= mirrors scroll without resetting it", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid="browse-list"]', { timeout: 20000 })

  // Data-driven count (from total_count), well over any hardcoded pool;
  // every page gets a reserved section — culling, not windowing, so the
  // document height is constant and the whole catalog is reachable.
  const total = await totalPages(page)
  expect(total).toBeGreaterThan(40)
  expect(await page.locator("[data-page]").count()).toBe(total)

  await wheelDown(page, 16)
  const yScrolled = await page.evaluate(() => Math.round(window.scrollY))
  expect(yScrolled, "actually scrolled down").toBeGreaterThan(3000)

  // The centered page is mirrored into ?page= once the scroll settles —
  // silent (no refetch), and it must NOT yank the viewport back to the top
  // (the silent-navigate scroll-reset bug).
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("page") || "0"), { timeout: 5000 })
    .toBeGreaterThan(3)
  const param = Number(new URL(page.url()).searchParams.get("page"))
  expect(Math.abs(param - ((await centeredPage(page)) ?? 0))).toBeLessThanOrEqual(2)
  const yAfter = await page.evaluate(() => Math.round(window.scrollY))
  expect(Math.abs(yAfter - yScrolled), "silent ?page= write kept the viewport put").toBeLessThan(120)
})

test("client-side nav from home swaps to browse, not a torn page", async ({ page }) => {
  // The e2e's other tests `goto` the page; the bug only shows on a CLIENT
  // nav: the cull controller, firing its refetch as browse's cold partons
  // mount mid-navigation, superseded the route swap and left the home route
  // visible on top. The controller now defers culling until the navigation
  // settles.
  await page.goto("/")
  await page.locator('a[href="/magento/browse"]').first().click()
  // The visible page heading becomes browse's, and its sections render —
  // home is swapped out (keepalive-hidden), not torn on top.
  await expect(page.locator("h1:visible").first()).toHaveText("Browse Products", { timeout: 20000 })
  await expect(page.locator('[data-page="1"]')).toBeVisible()
})
