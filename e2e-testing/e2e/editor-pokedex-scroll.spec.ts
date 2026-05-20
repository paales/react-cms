import { expect, test, request as apiRequest, waitForRscIdle } from "./fixtures.ts"

/**
 * Scrolling the Pokedex while the editor is open must keep the
 * preview pane populated. The editor renders previewed content
 * inline (no `frame: "preview"` wrapper), so LoadMore's
 * scroll-driven refetch is a window-scoped targeted refetch
 * (`partials=page-N,load-more`) and existing pages stay rendered.
 */

test.beforeEach(async ({ baseURL, context }) => {
  // Editor on/off lives in the `__editor` cookie. There's no URL
  // trigger — set the cookie before navigating so the editor chrome
  // renders on the very first response.
  await context.addCookies([{ name: "__editor", value: "1", url: baseURL! }])
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches")
  await ctx.dispose()
})

test("editor preview keeps Pokedex grid visible after a LoadMore scroll", async ({ page }) => {
  await page.goto("/")

  const preview = page.getByTestId("page-shell")
  await expect(preview).toBeVisible()
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeVisible()

  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, 800)
      await sleep(120)
    }
  })

  await waitForRscIdle(page)

  // Page-2's first card (#25 pikachu) loaded into the same preview.
  await expect(preview.getByRole("link", { name: /#25\s+pikachu/i })).toBeVisible({
    timeout: 10000,
  })
  // Page-1 cards must not vanish when later pages land.
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeAttached()
})
