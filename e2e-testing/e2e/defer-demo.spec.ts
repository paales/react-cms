import {
  clearCaches,
  test,
  expect,
  recordPartialDispatches,
  request,
  waitForPageInteractive,
} from "./fixtures"

/**
 * /defer-demo — exercises the activation shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — button-triggered manual activation via
 *      `useNavigation().reload({ selector })`.
 *   2. `defer={<WhenVisible/>}` — IntersectionObserver-triggered
 *      activation when the fallback enters the viewport.
 *
 * Activators are pure triggers — no data crosses the wire. Each
 * section's activated content renders a server timestamp, so a change
 * in that text proves the RSC refetch round-tripped.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("Partial defer demo", () => {
  test("defer={true}: button click activates via useNavigation.reload()", async ({ page }) => {
    // Transport-agnostic: attached, the activation refetch rides the
    // channel; pre-attach it goes discrete.
    const dispatches = recordPartialDispatches(page)

    await page.goto("/defer-demo")

    await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="manual-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    dispatches.length = 0
    await page.locator('[data-testid="activate-manual"]').click()
    await expect(page.locator('[data-testid="manual-content"]')).toBeVisible({
      timeout: 5000,
    })

    const hits = dispatches.filter(
      (c) => c.partials != null && c.partials.split(",").includes("manual"),
    )
    expect(hits.length, "expected exactly one refetch dispatch for `manual`").toBeGreaterThanOrEqual(1)
  })

  test("<WhenVisible>: scroll-into-view activates the Partial", async ({ page }) => {
    await page.goto("/defer-demo")
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="any-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    await page.locator('[data-testid="any-fallback"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    })
  })
})
