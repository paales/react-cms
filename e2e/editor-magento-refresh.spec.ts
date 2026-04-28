import { test, expect } from "@playwright/test"

test("editor mode + magento + refresh prices does not throw HoistingViolation", async ({
  page,
  context,
}) => {
  // Prime the partial registry with a non-editor /magento render so
  // the editor visit's `clearRoute` moves those snapshots into the
  // previous-route map. This is the state that exposes the cell-drift
  // attribution bug: nav-link-open-editor's previous-render manifest
  // is empty, and the editor visit's `getSearchParam("q")` read at
  // the top of `MagentoPage` leaks into that nav-link's manifest
  // scope post-await — tripping `HoistingViolationError`.
  await page.goto("/magento")
  await page.waitForLoadState("networkidle")

  await context.addCookies([{ name: "__editor", value: "1", url: "http://localhost:5179" }])

  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(`PAGE: ${err.message}`))
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text()}`)
  })
  const responses: Array<{ status: number; url: string }> = []
  page.on("response", (r) => {
    if (r.url().includes("__frame=preview") || r.url().includes("partials=")) {
      responses.push({ status: r.status(), url: r.url() })
    }
  })

  await page.goto("/magento")
  await page.waitForLoadState("networkidle")

  await page.locator('[data-testid="refresh-all-prices"]').click()
  await page.waitForTimeout(1500)

  // The hoisting violation surfaces as a server render error inside
  // the preview Partial, which the client boundary renders as the
  // built-in error card. `PartialErrorBoundary` shows
  // `Partial "<id>" failed to render` on a thrown render; a clean run
  // never shows it.
  const errorCardVisible = await page.locator("text=/failed to render/i").count()
  expect(errorCardVisible, "no PartialErrorBoundary card should be visible").toBe(0)

  const violations = errors.filter(
    (e) => e.includes("HoistingViolation") || e.includes("manifest captured"),
  )
  expect(violations, violations.join("\n")).toEqual([])

  const failedFetches = responses.filter((r) => r.status >= 500)
  expect(failedFetches, JSON.stringify(failedFetches)).toEqual([])
})
