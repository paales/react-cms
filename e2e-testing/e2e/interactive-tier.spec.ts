import { clearCaches, expect, test, waitForPageInteractive } from "./fixtures"

/**
 * /interactive-tier-demo — the Interactive grant
 * (`<RemoteFrame grant="interactive">`).
 *
 * One e2e-magento page embedded twice, cross-origin:
 *
 *  (a) under `grant="interactive"` the vocabulary's interactive
 *      members splice intact and the HOST-bundle bridge wires them:
 *      typing in the quantity TextField shows instantly (optimistic —
 *      the uncontrolled input IS the local value), the write POSTs to
 *      the REMOTE origin's `/__remote/cells/write`, and the server
 *      echo lands via the bridge's `@self` refresh — the embed
 *      reflects the REMOTE's canonicalised cell;
 *  (b) the bid Button invokes the REMOTE-hosted `place-bid`
 *      embedAction (a composed `update` on the remote's cell) and the
 *      embed reflects the new amount;
 *  (c) the SAME page under `grant="paint"` degrades those rows in
 *      place (DEV violation markers) — no input, no button.
 */

const REMOTE_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

test.beforeEach(async ({ baseURL, request }) => {
  await clearCaches(baseURL)
  // The interactive cells live in the REMOTE process (persisted per
  // scope) — clear its worker bucket too so qty/bid start fresh.
  await request.get(`${REMOTE_ORIGIN}/__test/clear-caches`)
})

/** Wait for the bridge's own "wired" marker — the embed's DOM streams
 *  in (and is visible) before the bridge client component hydrates,
 *  so interactions wait on the signal the wiring writes. */
async function waitForBridge(page: import("./fixtures").Page): Promise<void> {
  await page
    .locator("parton-embed-interactive[data-interactive-ready]")
    .first()
    .waitFor({ state: "attached", timeout: 15000 })
}

test("a quantity edit round-trips to the remote's cell and the embed reflects it", async ({
  page,
}) => {
  await page.goto("/interactive-tier-demo", { timeout: 30000 })
  await waitForPageInteractive(page)

  const demo = page.getByTestId("interactive-demo")
  await expect(demo.getByTestId("interactive-panel")).toBeVisible({ timeout: 15000 })
  await expect(demo.getByTestId("interactive-qty-value")).toHaveText("1")

  await waitForBridge(page)
  const input = demo.locator("parton-textfield input")
  await expect(input).toBeVisible()
  // Optimistic self-echo: the field shows the keystrokes immediately —
  // the uncontrolled input is the local value; no round trip gates it.
  await input.fill("7")
  await expect(input).toHaveValue("7")

  // The server echo: the bridge's coalesced write hit the REMOTE's
  // cell (its `write` canonicalisation runs) and the settled hop
  // refreshed the host parton — the embedded display reflects the
  // remote's stored value.
  await expect(demo.getByTestId("interactive-qty-value")).toHaveText("7", { timeout: 15000 })
})

test("the write POST is namespaced to the remote origin", async ({ page }) => {
  const writePosts: string[] = []
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/__remote/cells/write")) {
      writePosts.push(req.url())
    }
  })
  await page.goto("/interactive-tier-demo", { timeout: 30000 })
  await waitForPageInteractive(page)
  const input = page.getByTestId("interactive-demo").locator("parton-textfield input")
  await expect(input).toBeVisible({ timeout: 15000 })
  await waitForBridge(page)
  await input.fill("3")
  await expect
    .poll(() => writePosts, { timeout: 15000 })
    .toContain(`${REMOTE_ORIGIN}/__remote/cells/write`)
})

test("a bid click invokes the remote-hosted action and the embed reflects the composed result", async ({
  page,
}) => {
  await page.goto("/interactive-tier-demo", { timeout: 30000 })
  await waitForPageInteractive(page)

  const demo = page.getByTestId("interactive-demo")
  const bidValue = demo.getByTestId("interactive-bid-value")
  await expect(bidValue).toBeVisible({ timeout: 15000 })
  const before = Number((await bidValue.textContent())!.replace(/[^0-9]/g, ""))

  await waitForBridge(page)
  await demo.locator("parton-button").click()

  // The action ran REMOTE-side (`magentoBid.update(v => v + 50)`) and
  // the refreshed embed shows the composed amount.
  await expect(bidValue).toHaveText(`EUR ${before + 50}`, { timeout: 15000 })
})

test("the same page under grant=paint degrades the interactive rows in place", async ({ page }) => {
  await page.goto("/interactive-tier-demo", { timeout: 30000 })

  const paint = page.getByTestId("interactive-demo-paint")
  // Paint-safe siblings paint…
  await expect(paint.getByTestId("interactive-bid-value")).toBeVisible({ timeout: 15000 })
  // …the interactive members do not (DEV violation markers instead).
  await expect(paint.locator("parton-textfield")).toHaveCount(0)
  await expect(paint.locator("parton-button")).toHaveCount(0)
  const markers = paint.locator("parton-tier-violation")
  await expect(markers.first()).toBeVisible({ timeout: 15000 })
  const types = await markers.evaluateAll((els) => els.map((el) => el.getAttribute("data-type")))
  expect(types).toContain("parton-textfield")
  expect(types).toContain("parton-button")
})
