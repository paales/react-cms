/**
 * Two related frames-demo regressions:
 *
 *   (a) Browser-back from `/frames-demo?product=X` to `/frames-demo`
 *       leaves the main-listing partial showing the product-detail
 *       view (the URL bar moves, the content does not). The list and
 *       the detail share `frames-main-list`'s id+matchKey (the parent
 *       wrapper has no named match params, so descendants inherit a
 *       constant matchKey); the second visit's fingerprint accumulates
 *       into the client's set alongside the first's. On the back nav
 *       the server fp-skips against the *stale* fp it sees, the client
 *       substitutes from its cache slot (which the alpha visit
 *       overwrote), and we get the wrong content.
 *
 *   (b) Inside the menu frame's About view, clicking the nested tab
 *       buttons (General/Advanced) cycles the tab-frame URL in the
 *       session but the rendered body never moves past whichever one
 *       loaded first. The outer `menu` partial's `vary` only sees
 *       `pathname`, so its OWN fp is stable across nested-frame moves
 *       — only the descendant `menu-tab` partial's fp should drift.
 *       The descendant fp-fold re-runs descendants' `vary` against
 *       `getRequest()` (the page request) without honoring their
 *       `framePath`, so the tab-frame's URL never reaches the
 *       descendant's pathname, and the fold contribution doesn't move.
 *       Menu fp-skips on a stale entry; tab body stays cached.
 */

import { expect, test, request as apiRequest, waitForRscIdle } from "./fixtures.ts"

test.beforeEach(async ({ baseURL }) => {
  // Clear caches so the registry starts cold each test — frame URLs
  // are session-scoped, and stale draft / session state from a prior
  // run would muddle the assertions about cross-nav fingerprint flow.
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches?all=1")
  await ctx.dispose()
})

test("browser back from a product detail returns the main list", async ({ page }) => {
  await page.goto("/frames-demo")
  await waitForRscIdle(page)
  await expect(page.getByTestId("main-list")).toBeVisible()

  await page.getByTestId("main-open-alpha").click()
  await waitForRscIdle(page)
  await expect(page.getByTestId("main-detail")).toBeVisible()
  await expect(page.getByTestId("main-detail")).toHaveAttribute("data-sku", "alpha")

  await page.goBack()
  await waitForRscIdle(page)
  expect(new URL(page.url()).search).toBe("")
  await expect(page.getByTestId("main-list")).toBeVisible()
  await expect(page.getByTestId("main-detail")).toHaveCount(0)
})

test("nested-frame tab nav inside the menu About view swaps the body", async ({ page }) => {
  await page.goto("/frames-demo")
  await waitForRscIdle(page)

  // Open the menu frame's About view — this places the nested
  // `menu.tab` frame with its `/general` initial body.
  await page.getByTestId("menu-about-btn").click()
  await expect(page.getByTestId("menu-about")).toBeVisible()
  await expect(page.getByTestId("menu-tab-general-body")).toBeVisible()

  // Move the nested frame to /advanced — body should switch.
  await page.getByTestId("menu-tab-advanced").click()
  await expect(page.getByTestId("menu-tab-advanced-body")).toBeVisible()
  await expect(page.getByTestId("menu-tab-general-body")).toHaveCount(0)

  // …and back to /general. The outer menu partial's `vary` hasn't
  // changed (pathname is still `/menu/about`); only the inner tab
  // moved. With a frame-aware descendant fp-fold the menu wrapper's
  // fp shifts when the tab does, so the wrapper re-renders.
  await page.getByTestId("menu-tab-general").click()
  await expect(page.getByTestId("menu-tab-general-body")).toBeVisible()
  await expect(page.getByTestId("menu-tab-advanced-body")).toHaveCount(0)
})
