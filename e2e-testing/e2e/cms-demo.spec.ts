import { expect, test } from "./fixtures.ts"

test.describe("CMS demo — accessor-tracked fields + cascade resolution", () => {
  test("hero renders global fields from the default config", async ({ page }) => {
    await page.goto("/cms-demo")
    await expect(page.getByTestId("cms-demo-hero-headline")).toHaveText("Welcome to the CMS demo")
  })

  test("greeting default (no slug) uses the fallback config", async ({ page }) => {
    await page.goto("/cms-demo")
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Default greeting")
    await expect(page.getByTestId("cms-demo-greeting-accent")).toHaveText("accent 1")
  })

  test("greeting on /cms-demo/alpha matches the exact-slug config", async ({ page }) => {
    await page.goto("/cms-demo/alpha")
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Hello, Alpha!")
    await expect(page.getByTestId("cms-demo-greeting-accent")).toHaveText("accent 3")
  })

  test("greeting on /cms-demo/beta matches the {in:[…]} config", async ({ page }) => {
    await page.goto("/cms-demo/beta")
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Beta/Gamma view")
  })

  test("greeting on an unmatched slug falls through to default", async ({ page }) => {
    await page.goto("/cms-demo/zulu")
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Default greeting")
  })

  test("client-side navigation between slugs re-renders the greeting", async ({ page }) => {
    await page.goto("/cms-demo/alpha")
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Hello, Alpha!")

    await page.getByRole("link", { name: /beta$/ }).click()
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Beta/Gamma view")

    await page.getByRole("link", { name: /Default \(no slug\)/ }).click()
    await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Default greeting")
  })
})
