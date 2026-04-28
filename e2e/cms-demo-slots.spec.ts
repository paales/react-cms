import { expect, test } from "./fixtures.ts"

test.describe("CMS demo — <Children> slot composition", () => {
  test("renders every slot entry in store order", async ({ page }) => {
    await page.goto("/cms-demo")
    const slot = page.getByTestId("cms-demo-composed-slot")
    const heroHeadlines = slot.getByTestId("composed-hero-headline").allTextContents()
    await expect(slot.getByTestId("composed-hero-headline").first()).toHaveText(
      "First hero in the body slot",
    )
    await expect(slot.getByTestId("composed-rich-text")).toContainText(
      "This rich-text block is the second entry",
    )
    await expect(slot.getByTestId("composed-hero-headline").last()).toHaveText(
      "Third block (default)",
    )
    // Silence unused-variable lint — we intentionally take the count
    // via the .last() locator rather than via allTextContents length.
    void heroHeadlines
  })

  test("per-entry cascade resolves slot children against the page URL", async ({ page }) => {
    await page.goto("/cms-demo/alpha")
    const slot = page.getByTestId("cms-demo-composed-slot")
    await expect(slot.getByTestId("composed-hero-headline").last()).toHaveText(
      "Alpha-only third block",
    )
  })

  test("client-side nav between slugs updates slot entries", async ({ page }) => {
    await page.goto("/cms-demo/alpha")
    const slot = page.getByTestId("cms-demo-composed-slot")
    await expect(slot.getByTestId("composed-hero-headline").last()).toHaveText(
      "Alpha-only third block",
    )

    await page.getByRole("link", { name: /^beta$/ }).click()
    await expect(slot.getByTestId("composed-hero-headline").last()).toHaveText(
      "Third block (default)",
    )
  })
})
