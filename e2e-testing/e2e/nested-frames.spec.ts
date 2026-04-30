import { test, expect } from "./fixtures"

/**
 * `/frames-demo` nested-frame showcase — pins the payoff of
 * `PartialCtx.frameChain`: two frames with the same local name
 * (`tab`) under different parent frames coexist without collision.
 * Session + navigation state + `?__frame=` all key off the full
 * dotted path (`cart.tab` vs `menu.tab`).
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

test("both nested tab frames render with the same local name but distinct identities", async ({
  page,
}) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  // Open cart — nested `cart.tab` mounts.
  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("partial-debug-cart-tab")).toBeVisible()
  // Open menu — nested `menu.tab` mounts alongside.
  await page.getByTestId("menu-about-btn").click()
  await expect(page.getByTestId("partial-debug-menu-tab")).toBeVisible()

  // Each starts at its author-provided initial URL — independent,
  // not a shared `tab` default.
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/items")
  await expect(page.getByTestId("partial-debug-menu-tab-url")).toHaveText("/general")
})

test("nested tab nav updates only its own URL — siblings untouched", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()
  await expect(page.getByTestId("partial-debug-cart-tab")).toBeVisible()
  await page.getByTestId("menu-about-btn").click()
  await expect(page.getByTestId("partial-debug-menu-tab")).toBeVisible()

  // Cart-tab → coupons. Menu-tab stays on general.
  await page.getByTestId("cart-tab-coupons").click()
  await expect(page.getByTestId("cart-tab-coupons-body")).toBeVisible()
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/coupons")
  await expect(page.getByTestId("partial-debug-menu-tab-url")).toHaveText("/general")

  // Menu-tab → advanced. Cart-tab stays on coupons.
  await page.getByTestId("menu-tab-advanced").click()
  await expect(page.getByTestId("menu-tab-advanced-body")).toBeVisible()
  await expect(page.getByTestId("partial-debug-menu-tab-url")).toHaveText("/advanced")
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/coupons")
})

test("nested frame's back stack is independent of its parent's", async ({ page }) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  await page.getByTestId("cart-open-btn").click()

  // Nested cart.tab history builds up from navigation inside the tab.
  await page.getByTestId("cart-tab-coupons").click()
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/coupons")
  await page.getByTestId("cart-tab-summary").click()
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/summary")

  // Walking cart.tab back does NOT change the parent cart frame
  // (which is still at /cart/open). Only the nested URL rewinds.
  await expect(page.getByTestId("partial-debug-cart-tab-back")).toBeEnabled()
  await page.getByTestId("partial-debug-cart-tab-back").click()
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/coupons")
  await expect(page.getByTestId("partial-debug-cart-url")).toHaveText("/cart/open")

  // One more back gets us to the initial `/items` — nested back stack
  // is empty. The PARENT cart frame's back stack is independent:
  // opening cart (/cart/closed → /cart/open) pushed onto its own past.
  await page.getByTestId("partial-debug-cart-tab-back").click()
  await expect(page.getByTestId("partial-debug-cart-tab-url")).toHaveText("/items")
  await expect(page.getByTestId("partial-debug-cart-tab-back")).toBeDisabled()
  await expect(page.getByTestId("partial-debug-cart-back")).toBeEnabled()
})

test("?__frame= wire format carries the full dotted path", async ({ page }) => {
  const refetches: string[] = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) refetches.push(url)
  })

  await page.goto("/frames-demo")
  await awaitHydrated(page)
  await page.getByTestId("cart-open-btn").click()

  refetches.length = 0
  await page.getByTestId("cart-tab-coupons").click()
  await expect(page.getByTestId("cart-tab-coupons-body")).toBeVisible()

  const frameRefetch = refetches.find((u) => {
    const p = new URL(u).searchParams
    return p.get("__frame") === "cart.tab"
  })
  expect(
    frameRefetch,
    `expected a refetch with __frame=cart.tab; saw ${JSON.stringify(refetches)}`,
  ).toBeTruthy()
})

test("browser back stays attached to real page navigations — nested tab navs don't pollute", async ({
  page,
}) => {
  await page.goto("/frames-demo")
  await awaitHydrated(page)

  // Real page nav — creates a browser entry.
  await page.getByTestId("main-open-beta").click()
  await expect(page.getByTestId("main-detail")).toBeVisible()

  // Open cart, navigate the nested tab a few times.
  await page.getByTestId("cart-open-btn").click()
  await page.getByTestId("cart-tab-coupons").click()
  await page.getByTestId("cart-tab-summary").click()

  // Browser back goes to the previous page, NOT through any of the
  // tab navigations (which all used `history: "auto"` =
  // updateCurrentEntry, no new browser entries).
  await page.goBack()
  await expect(page.getByTestId("main-list")).toBeVisible()
})
