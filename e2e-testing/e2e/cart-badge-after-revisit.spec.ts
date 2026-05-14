import { test, expect, request } from "./fixtures"

/**
 * Regression user reported 2026-05-13:
 *   1. Home
 *   2. Magento
 *   3. Back
 *   4. Forward
 *   5. Click second Add to cart
 *   6. fetch call completes but the count doesn't update.
 *   7. hard refresh > count is updated.
 *
 * The cart-badge subtree comes from the action's `{revalidate:
 * {selector: ".cart"}}` directive triggering a partial refetch.
 * After my multi-fp + trailer changes, the refetched bytes arrive
 * but the visible count stays stale until a full reload.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

test("cart-badge updates after Add to Cart on /magento re-visit", async ({ page }) => {
  await page.goto("/")
  await page.waitForLoadState("networkidle")

  // 2. Magento (cold)
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  // 3. Back to home
  await page.getByRole("link", { name: /Pokemon$/ }).click()
  await page.waitForSelector("[data-testid=page-shell]", { timeout: 10000 })
  await page.waitForLoadState("networkidle")

  // 4. Forward back to Magento
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  // Read cart badge BEFORE action (capture by matching the
  // `min-w-[18px]` quantity span in the CartBadge component).
  const html0 = await page.content()
  const before = html0.match(/min-w-\[18px\][^>]*>(\d+)</)?.[1] ?? "(unknown)"
  console.log(`cart badge before: ${before}`)

  // 5. Click second Add to Cart (simple product; first is configurable).
  const addButton = page.getByRole("button", { name: /Add to Cart/ }).nth(1)
  await expect(addButton).toBeVisible()

  const actionResp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("_.rsc"),
    { timeout: 15000 },
  )
  await addButton.click()
  const resp = await actionResp
  expect(resp.status(), `action POST returned ${resp.status()}`).toBeLessThan(400)

  // 6. The cart-badge should UPDATE without a hard refresh.
  // Wait a bit for the refetch+reconcile to complete.
  await page.waitForLoadState("networkidle")
  await page.waitForTimeout(1000)

  const html1 = await page.content()
  const after = html1.match(/min-w-\[18px\][^>]*>(\d+)</)?.[1] ?? "(unknown)"
  console.log(`cart badge after: ${after}`)
  expect(
    after,
    `cart badge stayed at "${before}" after Add to Cart — refetch landed but didn't reconcile (#step 6 of user's repro)`,
  ).not.toBe(before)
})
