/**
 * User-reported bug: navigating from /cms-demo to /remote-frame-crossorigin-demo
 * makes the AppNav disappear.
 */

import { test, expect } from "./fixtures"

test("nav from /cms-demo to /remote-frame-crossorigin-demo keeps app nav visible", async ({ page }) => {
  await page.goto("/cms-demo")
  // App nav has a known link
  await expect(page.getByRole("link", { name: "Magento Store" })).toBeVisible({ timeout: 10000 })

  // Click the "Remote (Cross-Origin)" link.
  await page.getByRole("link", { name: "Remote (Cross-Origin)" }).click()

  // Wait for URL to settle.
  await page.waitForURL(/remote-frame-crossorigin-demo/, { timeout: 10000 })

  // App nav should still be visible.
  await expect(page.getByRole("link", { name: "Magento Store" })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole("link", { name: "Cart" })).toBeVisible()
})
