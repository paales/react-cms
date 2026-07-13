import { clearCaches, expect, test, waitForPageInteractive } from "./fixtures"

/**
 * /bound-cells-demo — bound cells (the inward state contract).
 *
 * The host parton resolves its own cart cell in its body and binds it
 * at the RemoteFrame call site; the e2e-magento page `/remote/cart-note`
 * declares `cells: { cart: { required: true }, locale: {} }` and
 * renders the projected VALUES.
 *
 *  (a) the embed renders the host-projected value;
 *  (b) a host-side write re-projects: the recorded `cell:host.cart`
 *      dep re-renders the host parton, the re-embed carries the fresh
 *      cart, and the embedded content updates;
 *  (c) the sibling placement with NO binding fails on the PRODUCER
 *      (required `cart` missing) and surfaces as that parton's error
 *      card — the happy section and the rest of the page keep working.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("host binds a cell; the embed renders the projected value", async ({ page }) => {
  await page.goto("/bound-cells-demo", { timeout: 30000 })

  // Host's own state…
  await expect(page.getByTestId("bound-cells-host-total")).toHaveText("40", { timeout: 15000 })
  // …projected into the cross-origin embed.
  const note = page.getByTestId("cart-note")
  await expect(note).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("cart-note-total")).toHaveText("40")
  await expect(page.getByTestId("cart-note-items")).toHaveText("2")
  // The optional `locale` binding is absent — the page branched, no
  // failure (default locale).
  await expect(note).toHaveAttribute("data-locale", "en")
})

test("a host-side cell write re-projects the embed", async ({ page }) => {
  await page.goto("/bound-cells-demo", { timeout: 30000 })
  await waitForPageInteractive(page)
  await expect(page.getByTestId("cart-note-total")).toHaveText("40", { timeout: 15000 })

  await page.locator('[data-testid="bound-cells-add"][data-hydrated]').click()

  // Host state moved…
  await expect(page.getByTestId("bound-cells-host-total")).toHaveText("50", { timeout: 15000 })
  await expect(page.getByTestId("bound-cells-host-items")).toHaveText("3")
  // …and the embed re-rendered with the freshly projected cart — the
  // dep recorded by the in-body resolve is what re-ran the placement.
  await expect(page.getByTestId("cart-note-total")).toHaveText("50", { timeout: 15000 })
  await expect(page.getByTestId("cart-note-items")).toHaveText("3")
})

test("a missing required binding fails produce-side and surfaces sanely host-side", async ({
  page,
}) => {
  await page.goto("/bound-cells-demo", { timeout: 30000 })

  // The happy placement is unaffected…
  await expect(page.getByTestId("cart-note-total")).toHaveText("40", { timeout: 15000 })

  // …while the unbound placement's produce-side failure lands as the
  // enclosing parton's error card (dev servers show the real message).
  const missing = page.getByTestId("bound-cells-missing")
  await expect(missing.locator("[data-partial-error]")).toBeVisible({ timeout: 15000 })
  await expect(missing.locator("[data-partial-error]")).toContainText("required bound cell")
  // The failure never renders the remote content.
  await expect(missing.getByTestId("cart-note")).toHaveCount(0)
})
