/**
 * Regression: the "Open Editor" link in app-nav lives in `cms/data/
 * content.json` as a plain `nav-link` block with `href:
 * "/cms-demo?editor=1"`. The EditorShell only consults the
 * `__editor` cookie — the URL param has no effect — so a plain
 * anchor never opens the editor. Clicking that link must flip the
 * cookie AND navigate, so the chrome appears on the destination
 * page.
 */

import { expect, test, request as apiRequest, waitForRscIdle } from "./fixtures.ts"

test.beforeEach(async ({ baseURL, context }) => {
  // Start from a cold editor state — the editor cookie must NOT be
  // pre-set, otherwise this spec degenerates into "editor was already
  // open."
  await context.clearCookies({ name: "__editor" })
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches")
  await ctx.dispose()
})

test("clicking the app-nav 'Open Editor' link sets the editor cookie and renders the chrome", async ({
  page,
  baseURL,
}) => {
  await page.goto("/")
  await waitForRscIdle(page)

  // Sanity: editor chrome is NOT visible yet (no cookie).
  await expect(page.getByTestId("cms-edit-tree-pane")).toHaveCount(0)

  // The nav entry is `<a>Open Editor</a>` — anchor name match.
  await page.getByRole("link", { name: "Open Editor" }).click()
  await waitForRscIdle(page)

  // Editor chrome materialises on the destination page.
  await expect(page.getByTestId("cms-edit-tree-pane")).toBeVisible()

  // Cookie was flipped client-side — assert by reading the browser
  // context so we're independent of whatever URL the click landed on.
  const cookies = await page.context().cookies(baseURL!)
  const editor = cookies.find((c) => c.name === "__editor")
  expect(editor?.value).toBe("1")
})
