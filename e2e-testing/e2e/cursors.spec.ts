import { test, expect, request, type Page } from "./fixtures"

/**
 * /cursors — multiplayer presence over the `deferred` cell primitive.
 *
 * Two tabs share one browser context, so they share the worker's
 * `x-test-scope` (the fixture stamps it on the context) and therefore
 * the same process-global `cursorsCell`. Moving the pointer in one tab
 * writes a `deferred` cell (no commit on its POST); the other tab picks
 * the new cursor up over its open heartbeat stream. We assert each tab
 * sees exactly the OTHER tab's cursor (its own is filtered out).
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5379"}/__test/clear-caches`)
  await ctx.dispose()
})

async function ready(page: Page): Promise<void> {
  await page.locator("body[data-cursors-ready]").waitFor({ timeout: 10000 })
}

/** Move the pointer to a point inside the cursor area, firing
 *  pointermove events the layer listens on. Multiple steps guarantee at
 *  least one event lands inside the box. */
async function moveInArea(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('[data-testid="cursor-area"]').boundingBox()
  if (!box) throw new Error("cursor-area has no bounding box")
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 8 })
}

test("each viewer sees the other viewer's cursor, not its own", async ({ page }) => {
  await page.goto("/cursors")
  await ready(page)

  // Second tab in the SAME context → same scope → shared cursor cell.
  const page2 = await page.context().newPage()
  await page2.goto("/cursors")
  await ready(page2)

  // Tab 1 moves. Its own dot is filtered out (0 remote on tab 1); tab 2
  // receives tab 1's cursor over its heartbeat stream (1 remote).
  await moveInArea(page, 0.25, 0.3)
  await expect(page2.locator('[data-testid="remote-cursor"]')).toHaveCount(1, { timeout: 15000 })
  await expect(page.locator('[data-testid="remote-cursor"]')).toHaveCount(0)

  // Tab 2 moves. Now tab 1 sees tab 2's cursor; both tabs show exactly
  // one remote cursor (each other's).
  await moveInArea(page2, 0.7, 0.6)
  await expect(page.locator('[data-testid="remote-cursor"]')).toHaveCount(1, { timeout: 15000 })
  await expect(page2.locator('[data-testid="remote-cursor"]')).toHaveCount(1)

  await page2.close()
})
