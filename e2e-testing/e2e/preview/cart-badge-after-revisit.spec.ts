import { test, expect } from "@playwright/test"
import { waitForRscIdle } from "../fixtures.ts"

/**
 * Prod-build version of the cart-badge-after-revisit regression
 * (mirrors `e2e/cart-badge-after-revisit.spec.ts`). User reported
 * 2026-05-13 that the count doesn't update after Add to Cart on
 * the re-visit, only on hard refresh.
 */

test("cart-badge updates after Add to Cart on re-visit (prod)", async ({ page }) => {
  await page.goto("/")
  await waitForRscIdle(page)

  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  await page.getByRole("link", { name: /Pokemon$/ }).click()
  await page.waitForSelector("[data-testid=page-shell]", { timeout: 10000 })
  await waitForRscIdle(page)

  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  const html0 = await page.content()
  const before = html0.match(/min-w-\[18px\][^>]*>(\d+)</)?.[1] ?? "(unknown)"
  console.log(`cart badge before: ${before}`)

  const addButton = page.getByRole("button", { name: /Add to Cart/ }).nth(1)
  await expect(addButton).toBeVisible()

  const actionResp = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("_.rsc"),
    { timeout: 15000 },
  )
  await addButton.click()
  const resp = await actionResp
  expect(resp.status(), `action POST returned ${resp.status()}`).toBeLessThan(400)

  await waitForRscIdle(page)
  await page.waitForTimeout(1000)

  const html1 = await page.content()
  const after = html1.match(/min-w-\[18px\][^>]*>(\d+)</)?.[1] ?? "(unknown)"
  console.log(`cart badge after: ${after}`)
  expect(after, `cart badge stayed at "${before}" after Add to Cart in prod build`).not.toBe(before)
})
