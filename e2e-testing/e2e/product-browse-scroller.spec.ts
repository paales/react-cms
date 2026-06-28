import { test, expect } from "./fixtures"

/**
 * /magento/browse — the view-culled bidirectional scroller.
 *
 * The new model (vs the old `/bare` grow-only `?end=`):
 *  - The visible set drives the render; it rides the FRAME url, so it
 *    never appears on the sharable page url.
 *  - `?page=` on the page url is a sharable *effect* — the anchor the
 *    scroller writes via replaceState as you move.
 *  - Pages cull BOTH ways: scroll down and the top pages leave the DOM,
 *    not just grow without bound.
 *  - A deep-link `?page=N` cold-starts centered on N.
 */

const card = '[data-testid^="browse-card-"]'

// Drive the window down a few notches, settling after each so the
// scroller's refetch lands and the ring advances.
async function scrollDown(page: import("@playwright/test").Page, steps: number) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000))
    await page.waitForTimeout(500)
  }
}

test("cold load renders the first pages and culls the far ones", async ({ page }) => {
  await page.goto("/magento/browse")

  await page.waitForSelector(card, { timeout: 20000 })
  expect(await page.locator(`[data-testid="browse-page-1"] ${card}`).count()).toBeGreaterThan(0)

  // A far page is not in the DOM at all (absent, not just off-screen).
  expect(await page.locator('[data-testid="browse-page-12"]').count()).toBe(0)

  // `visible` is frame-scoped — it must NOT leak onto the page url.
  expect(new URL(page.url()).searchParams.has("visible")).toBe(false)
})

test("scrolling down advances the ring and writes the ?page= anchor", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })

  await scrollDown(page, 6)

  // A later page (≥ 5) has materialized with products — the ring moved.
  await expect(page.locator('[data-testid="browse-page-5"]')).toBeAttached({ timeout: 20000 })
  expect(await page.locator(`[data-testid="browse-page-5"] ${card}`).count()).toBeGreaterThan(0)

  // The anchor followed the camera onto the page url.
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("page") || "1"), { timeout: 5000 })
    .toBeGreaterThan(2)
})

test("scrolling far down culls the top pages out of the DOM (bidirectional)", async ({ page }) => {
  await page.goto("/magento/browse")
  await page.waitForSelector(card, { timeout: 20000 })
  await expect(page.locator('[data-testid="browse-page-1"]')).toBeAttached()

  await scrollDown(page, 8)

  // Page 1 is now well beyond the reserve band → out of the live tree.
  await expect(page.locator('[data-testid="browse-page-1"]')).toHaveCount(0, { timeout: 20000 })
})

test("deep-link ?page=5 cold-starts centered on page 5", async ({ page }) => {
  await page.goto("/magento/browse?page=5")
  await page.waitForSelector(card, { timeout: 20000 })

  // Page 5 is in the ring with products; page 1 is outside the band.
  await expect(page.locator('[data-testid="browse-page-5"][data-zone="ring"]')).toBeVisible({
    timeout: 20000,
  })
  await expect(page.locator('[data-testid="browse-page-1"]')).toHaveCount(0, { timeout: 10000 })
})
