/**
 * E2E: /magento/cart line-level mutations.
 *
 * Covers the cart-line update + remove flows that the cell migration
 * introduced. Specifically guards:
 *   - Add to cart shows the new badge count
 *   - Update qty on a single line updates that line's display
 *     (and leaves other lines intact)
 *   - Remove line shrinks the cart (and other lines stay)
 */

import { test, expect } from "./fixtures"

// Cart actions share Magento's backend state across all tests in this
// file. Run serially to avoid cart cookie / cart-id contention under
// the parallel-workers default — each test creates its own cart and
// reasons about its own line-uids.
test.describe.configure({ mode: "serial" })
test.use({ actionTimeout: 30000 })

async function addOneCartLine(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/magento")
  // Wait for the badge to settle (no "?" fallback).
  await page.waitForFunction(
    () => {
      const header = document.querySelector("header")
      if (!header) return false
      return !(header.textContent ?? "").includes("?")
    },
    { timeout: 15000 },
  )
  const buttons = page.getByRole("button", { name: "Add to Cart" })
  const count = await buttons.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i)
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    await page.waitForTimeout(500)
    const card = btn.locator("..")
    const errs = await card.locator('[role="alert"]').count()
    if (errs === 0) return
  }
  throw new Error("could not add any product to cart")
}

test("badge updates immediately after Add to Cart", async ({ page, context }) => {
  await context.clearCookies()
  await addOneCartLine(page)

  // Read the badge quantity after the action commits.
  const readQty = async () => {
    return page.evaluate(() => {
      const header = document.querySelector("header")
      if (!header) return null
      for (const s of Array.from(header.querySelectorAll("span"))) {
        const t = (s.textContent ?? "").trim()
        if (/^\d+$/.test(t)) return Number(t)
      }
      return null
    })
  }

  // Allow time for the action's response render to commit. First-add
  // creates the Magento cart + adds the product, which can take a
  // while against a shared remote backend.
  await page.waitForFunction(
    () => {
      const header = document.querySelector("header")
      if (!header) return false
      for (const s of Array.from(header.querySelectorAll("span"))) {
        const t = (s.textContent ?? "").trim()
        if (/^\d+$/.test(t) && Number(t) > 0) return true
      }
      return false
    },
    { timeout: 15000 },
  )

  const qty = await readQty()
  expect(qty, "badge must show non-zero after add-to-cart").not.toBeNull()
  expect(qty as number).toBeGreaterThan(0)
})

test("update qty updates the matching cart line and leaves others alone", async ({ page, context }) => {
  await context.clearCookies()
  await addOneCartLine(page)
  // Add a second line so we can verify per-line isolation.
  await addOneCartLine(page)

  await page.goto("/magento/cart")
  await page.locator("[data-testid='cart-lines']").waitFor({ timeout: 10000 })

  const lines = page.locator("[data-testid^='cart-line-']").filter({
    has: page.locator("[data-testid^='cart-line-name-']"),
  })
  const lineCount = await lines.count()
  expect(lineCount, "expected at least one cart line on /cart").toBeGreaterThanOrEqual(1)

  // Snapshot every line's qty + name before mutation.
  const before: Array<{ uid: string; qty: string; name: string }> = []
  for (let i = 0; i < lineCount; i++) {
    const line = lines.nth(i)
    const uidAttr = (await line.getAttribute("data-testid")) ?? ""
    const uid = uidAttr.replace(/^cart-line-/, "")
    const qty = (await line.locator(`[data-testid='cart-line-qty-${uid}']`).textContent()) ?? ""
    const name = (await line.locator(`[data-testid='cart-line-name-${uid}']`).textContent()) ?? ""
    before.push({ uid, qty: qty.trim(), name: name.trim() })
  }

  // Click +1 on the first line.
  const firstUid = before[0].uid
  await page.locator(`[data-testid='cart-line-qty-up-${firstUid}']`).click()
  // Wait for the qty text to change.
  await page.waitForFunction(
    ({ uid, oldQty }) => {
      const el = document.querySelector(`[data-testid='cart-line-qty-${uid}']`)
      return el && (el.textContent ?? "").trim() !== oldQty
    },
    { uid: firstUid, oldQty: before[0].qty },
    { timeout: 10000 },
  )

  // Verify every OTHER line still has its name + qty intact.
  for (let i = 1; i < before.length; i++) {
    const { uid, name, qty } = before[i]
    const stillName = (
      (await page.locator(`[data-testid='cart-line-name-${uid}']`).textContent()) ?? ""
    ).trim()
    const stillQty = (
      (await page.locator(`[data-testid='cart-line-qty-${uid}']`).textContent()) ?? ""
    ).trim()
    expect(stillName, `line ${uid} name should survive single-line mutation`).toBe(name)
    expect(stillQty, `line ${uid} qty should survive single-line mutation`).toBe(qty)
  }
})

test("remove line removes only that line", async ({ page, context }) => {
  await context.clearCookies()
  await addOneCartLine(page)
  await addOneCartLine(page)

  await page.goto("/magento/cart")
  await page.locator("[data-testid='cart-lines']").waitFor({ timeout: 10000 })

  const lines = page.locator("[data-testid^='cart-line-']").filter({
    has: page.locator("[data-testid^='cart-line-name-']"),
  })
  const before = await lines.count()
  expect(before).toBeGreaterThanOrEqual(2)

  const firstUid = (
    (await lines.first().getAttribute("data-testid")) ?? ""
  ).replace(/^cart-line-/, "")
  await page.locator(`[data-testid='cart-line-remove-${firstUid}']`).click()

  await page.waitForFunction(
    (count) => {
      const els = document.querySelectorAll("[data-testid^='cart-line-name-']")
      return els.length === count
    },
    before - 1,
    { timeout: 10000 },
  )
})
