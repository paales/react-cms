import { expect, test, request as apiRequest } from "./fixtures.ts"

/**
 * Regression: scrolling the Pokedex while the editor is open used to
 * blank the preview pane. The editor previously wrapped the previewed
 * page in a `frame: "preview"` spec; LoadMore (a client component)
 * resolved its ambient frame from React context and routed its
 * `?pages=` bump through the FRAME handle, which refetched the
 * wrapper alone and rendered `<>{children}</>` empty in cache mode.
 *
 * Fix: the wrapper is gone; the previewed content renders inline. The
 * scroll-driven refetch is now a window-scoped targeted refetch
 * (`partials=page-N,load-more`) and the existing pages stay rendered.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches")
  await ctx.dispose()
})

test("editor preview keeps Pokedex grid visible after a LoadMore scroll", async ({ page }) => {
  await page.goto("/?editor=1")

  const preview = page.getByTestId("cms-edit-preview-pane")
  await expect(preview).toBeVisible()
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeVisible()

  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, 800)
      await sleep(120)
    }
  })

  await page.waitForLoadState("networkidle")

  // Page-2's first card (#25 pikachu) loaded into the same preview.
  await expect(preview.getByRole("link", { name: /#25\s+pikachu/i })).toBeVisible({
    timeout: 10000,
  })
  // Page-1 cards must not vanish when later pages land.
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeAttached()
})
