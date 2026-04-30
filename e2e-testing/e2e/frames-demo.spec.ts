import { test, expect } from "./fixtures"

/**
 * /frames-demo — acceptance test for the Frame primitive + the
 * per-frame / window-scoped Navigation API surface.
 */

test.beforeEach(async ({ request }) => {
  await request.get("/__test/clear-caches")
})

async function awaitHydrated(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="partial-debug-cart-hash-cart"]')
    if (!el) return false
    return Object.keys(el).some((k) => k.startsWith("__reactFiber"))
  })
  // Debug toolbar starts collapsed by default; expand so the per-Partial
  // rows the assertions below depend on are visible.
  const toggle = page.getByTestId("partials-debug-toggle")
  if ((await toggle.textContent())?.trim().startsWith("▸")) {
    await toggle.click()
  }
}

test("cart and menu frames expose their own debug strips", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await expect(page.getByTestId("partial-debug-cart")).toBeVisible()
  await expect(page.getByTestId("partial-debug-menu")).toBeVisible()

  await expect(page.getByTestId("main-list")).toBeVisible()
  await expect(page.getByTestId("cart-closed")).toBeVisible()
  await expect(page.getByTestId("menu-closed")).toBeVisible()
})

test("main listing updates the window URL (useNavigation falls through to window)", async ({
  page,
}) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await expect(page.getByTestId("main-list")).toBeVisible()
  const beforeUrl = page.url()

  await page.getByTestId("main-open-alpha").click()
  await expect(page.getByTestId("main-detail")).toBeVisible()
  await expect(page.getByTestId("main-detail")).toHaveAttribute("data-sku", "alpha")
  // Window URL updated (product in the query string).
  expect(page.url()).not.toBe(beforeUrl)
  expect(page.url()).toContain("product=alpha")

  // Cart/menu untouched.
  await expect(page.getByTestId("cart-closed")).toBeVisible()
  await expect(page.getByTestId("menu-closed")).toBeVisible()
})

test("browser back on a main-listing navigation returns to the list", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("main-open-beta").click()
  await expect(page.getByTestId("main-detail")).toBeVisible()

  await page.goBack()
  await expect(page.getByTestId("main-list")).toBeVisible()
})

test("cart frame navigates through its own states (drawer)", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()

  await page.getByTestId("cart-checkout-btn").click()
  await expect(page.getByTestId("cart-checkout")).toBeVisible()

  await page.getByTestId("cart-back-to-open").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()

  await page.getByTestId("cart-close-btn").click()
  await expect(page.getByTestId("cart-closed")).toBeVisible()
})

test("debug URL strip reflects the frame's current URL", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await expect(page.getByTestId("partial-debug-cart-url")).toHaveText("/cart/closed")
  await expect(page.getByTestId("partial-debug-menu-url")).toHaveText("/menu/closed")

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("partial-debug-cart-url")).toHaveText("/cart/open")
  await expect(page.getByTestId("partial-debug-menu-url")).toHaveText("/menu/closed")
})

test("frame back navigation restores the initial state", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await expect(page.getByTestId("partial-debug-cart-back")).toBeDisabled()

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()
  await expect(page.getByTestId("partial-debug-cart-back")).toBeEnabled()

  await page.getByTestId("partial-debug-cart-back").click()
  await expect(page.getByTestId("cart-closed")).toBeVisible()
  await expect(page.getByTestId("partial-debug-cart-url")).toHaveText("/cart/closed")
})

test("frame forward re-navigates after back", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()

  await page.getByTestId("partial-debug-cart-back").click()
  await expect(page.getByTestId("cart-closed")).toBeVisible()

  await expect(page.getByTestId("partial-debug-cart-forward")).toBeEnabled()
  await page.getByTestId("partial-debug-cart-forward").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()
})

test("reload re-renders the frame without changing its URL", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()

  await page.waitForTimeout(50)
  await page.getByTestId("partial-debug-cart-hash-cart").click()
  await expect(page.getByTestId("cart-open")).toBeVisible()
  await expect(page.getByTestId("partial-debug-cart-url")).toHaveText("/cart/open")
})

test("updateCurrentEntry writes per-frame state visible in debug strip", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("partial-debug-cart-state")).toHaveText("{}")

  await page.getByTestId("cart-mark-ready").click()
  await expect(page.getByTestId("partial-debug-cart-state")).toContainText('"itemsReady":true')
  // Menu state isn't polluted.
  await expect(page.getByTestId("partial-debug-menu-state")).toHaveText("{}")
})

test("streaming inside a frame: fallback paints first, content streams in", async ({ page }) => {
  // `FrameWrapper` just mutates the React.cache-backed scope cell
  // and returns children directly — no Flight round-trip — so the
  // outer Flight stream progressively emits the frame's subtree,
  // with Suspense fallbacks flashing while slow content resolves.
  //
  // We bypass the default `startTransition` wrapper on commit via
  // `disableTransition` so React shows the fallback (transitions
  // hold the OLD tree visible until the new one is fully ready —
  // that's the atomic-swap mode; orthogonal to whether the server
  // is streaming).
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.evaluate(async () => {
    // @ts-expect-error __rsc_partial_refetch is attached on window.
    const handler = window.__rsc_partial_refetch as (u: string) => Promise<void>
    const u = new URL(window.location.href)
    u.searchParams.set("__frame", "menu")
    u.searchParams.set("__frameUrl", "/menu/slow")
    u.searchParams.set("partials", "menu")
    u.searchParams.set("disableTransition", "1")
    await handler(u.toString())
  })

  // Fallback appears FIRST — streaming works.
  await expect(page.getByTestId("menu-slow-fallback")).toBeVisible({
    timeout: 1000,
  })
  // Then the slow content resolves.
  await expect(page.getByTestId("menu-slow-content")).toBeVisible({
    timeout: 3000,
  })
})

test("session persists across refresh", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await page.getByTestId("menu-about-btn").click()

  await page.reload()
  await expect(page.getByTestId("cart-open")).toBeVisible()
  await expect(page.getByTestId("menu-about")).toBeVisible()
})
