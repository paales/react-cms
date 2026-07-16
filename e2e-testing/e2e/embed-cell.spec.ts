import { clearCaches, expect, test, waitForPageInteractive } from "./fixtures"

/**
 * A resolved cell spliced through an ungoverned `<RemoteFrame>` embed
 * (`/embed-cell-demo` embeds `/embed-cell-target`).
 *
 *  - The host page renders — the embedded counter appears. Before the
 *    fix, passing a `ResolvedCell` (with its bound `set` server ref) to
 *    a client component inside the embed stalled the host render
 *    (~40 s): a decoded bound server reference cannot be re-encoded
 *    into the host's document stream. The cell's `set` now crosses as a
 *    client reference, so the splice closes.
 *  - The embedded write still works: clicking the counter's button
 *    calls `.set` directly across the boundary; the write commits and
 *    the focused re-embed lands the fresh value.
 *  - The standalone page keeps working — the embeddable page is an
 *    ordinary interactive page by itself.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("the host page renders the embedded counter (the splice does not stall)", async ({ page }) => {
  await page.goto("/embed-cell-demo", { waitUntil: "commit" })

  await expect(page.getByTestId("embed-cell-header")).toBeVisible({ timeout: 5000 })
  // The embedded target's content splices in — proof the host stream
  // closed. A stalled splice would leave the fallback forever.
  await expect(page.getByTestId("embed-cell-frame").getByTestId("embed-cell-value")).toHaveText(
    "0",
    { timeout: 15000 },
  )
})

test("the embedded write commits across the boundary", async ({ page }) => {
  await page.goto("/embed-cell-demo", { waitUntil: "commit" })
  await waitForPageInteractive(page)

  const value = page.getByTestId("embed-cell-frame").getByTestId("embed-cell-value")
  await expect(value).toHaveText("0", { timeout: 15000 })

  const button = page.getByTestId("embed-cell-frame").getByTestId("embed-cell-inc")
  await button.locator("xpath=self::*[@data-hydrated]").waitFor({ timeout: 15000 })
  await button.click()

  // The direct `.set` across the embed committed to the shared store —
  // read it back on the standalone page (same cell, same scope). (A
  // pre-fix `.set` here could not even reach the server: passing the
  // resolved cell into the embed stalled the host render.)
  await page.goto("/embed-cell-target", { waitUntil: "commit" })
  await expect(page.getByTestId("embed-cell-target").getByTestId("embed-cell-value")).toHaveText(
    "1",
    { timeout: 15000 },
  )
})

test("the embeddable page still works standalone", async ({ page }) => {
  await page.goto("/embed-cell-target", { waitUntil: "commit" })
  await waitForPageInteractive(page)

  const value = page.getByTestId("embed-cell-target").getByTestId("embed-cell-value")
  await expect(value).toHaveText("0", { timeout: 15000 })

  const button = page.getByTestId("embed-cell-target").getByTestId("embed-cell-inc")
  await button.locator("xpath=self::*[@data-hydrated]").waitFor({ timeout: 15000 })
  await button.click()
  await expect(value).toHaveText("1", { timeout: 15000 })
})
