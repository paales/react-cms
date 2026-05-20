/**
 * Regression: clicking a CONFIGURATION tab in the field panel updates
 * the URL to `?select=…&config=N` but the form on the right doesn't
 * re-render. Page refresh recovers it.
 *
 * Root cause was two-layered:
 *
 *   1. The config tab anchor was a plain `<a href>`, so clicking it
 *      ran the editor route through a full streaming render. The
 *      `cms-edit-fields` Partial reads `?config=` via `getRequest()`
 *      (deliberately, to dodge the preview frame's scope-cell leak),
 *      and `getRequest()` doesn't contribute to the structural
 *      fingerprint — so the server fp-matched the unchanged
 *      fingerprint and emitted a placeholder. The client kept the
 *      old form on screen.
 *      Fix: route the click through `nav.navigate(href, { selector:
 *      "#cms-edit-fields" })` (same pattern as `CmsEditTreeLink`)
 *      so `cms-edit-fields` lands in the explicit-id set and renders
 *      fresh regardless of fingerprint.
 *
 *   2. Even after the server returned fresh markup, the form's
 *      `<input defaultValue=…>` elements stayed at their original
 *      mount value. React reuses uncontrolled inputs across
 *      re-renders and doesn't re-apply `defaultValue` after mount.
 *      Fix: key the form by `${selected}:${effectiveIndex}` so a
 *      config switch (or selection switch) remounts every input.
 */
import { expect, test, request as apiRequest, waitForRscIdle } from "./fixtures.ts"

test.beforeEach(async ({ baseURL, context }) => {
  // Editor on/off lives in the `__editor` cookie. There's no URL
  // trigger — set the cookie before navigating so the editor chrome
  // renders on the very first response.
  await context.addCookies([{ name: "__editor", value: "1", url: baseURL! }])
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches")
  await ctx.dispose()
})

test("click greeting → click slug=alpha config tab — form reflects alpha config", async ({
  page,
}) => {
  await page.goto("/cms-demo")
  await waitForRscIdle(page)

  await page.getByTestId("cms-edit-tree-entry-cms-demo-greeting").click()
  await expect(page).toHaveURL(/select=cms-demo-greeting/)
  await expect(page.getByTestId("cms-edit-field-input-headline")).toHaveValue("Default greeting")

  const alphaTab = page.getByTestId("cms-edit-config-tab-0")
  await expect(alphaTab).toContainText("slug=alpha")
  await alphaTab.click()

  await expect(page).toHaveURL(/select=cms-demo-greeting&config=0/)
  // `toHaveValue` reads the live `.value` property — distinguishes
  // the "server returned fresh markup but uncontrolled input kept
  // its old value" case from a true full update.
  await expect(page.getByTestId("cms-edit-field-input-headline")).toHaveValue("Hello, Alpha!", {
    timeout: 3000,
  })
})

test("switching back to default config restores default fields", async ({ page }) => {
  await page.goto("/cms-demo?select=cms-demo-greeting&config=0")
  await waitForRscIdle(page)

  await expect(page.getByTestId("cms-edit-field-input-headline")).toHaveValue("Hello, Alpha!")

  // Default config is the third entry (index 2): match {} → headline
  // "Default greeting".
  await page.getByTestId("cms-edit-config-tab-2").click()
  await expect(page).toHaveURL(/config=2/)
  await expect(page.getByTestId("cms-edit-field-input-headline")).toHaveValue("Default greeting", {
    timeout: 3000,
  })
})
