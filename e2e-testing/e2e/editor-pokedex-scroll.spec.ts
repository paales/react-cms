import { clearCaches, expect, test, waitForPageInteractive, waitForRscIdle } from "./fixtures.ts"

/**
 * Scrolling the Pokedex while the editor is open must keep the
 * preview pane populated. The editor renders previewed content
 * inline (no `frame: "preview"` wrapper), so the scroller's culling
 * rides window-scoped visibility statements and already-rendered
 * leaves stay rendered (parked at worst) as later ones land.
 */

test.beforeEach(async ({ baseURL, context }) => {
  // Editor on/off lives in the `__editor` cookie. There's no URL
  // trigger — set the cookie before navigating so the editor chrome
  // renders on the very first response.
  await context.addCookies([{ name: "__editor", value: "1", url: baseURL! }])
  await clearCaches(baseURL)
})

test("editor preview keeps Pokedex grid visible after a deep scroll", async ({ page }) => {
  await page.goto("/")
  await waitForPageInteractive(page)

  const preview = page.getByTestId("page-shell")
  await expect(preview).toBeVisible()
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeVisible()

  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    // Scroll into the second leaf's neighborhood (#25 pikachu). The
    // catalog now reserves the FULL pokedex, so a deep scroll would
    // overshoot into culled regions — the point here is that later
    // content lands while earlier content survives.
    for (let i = 0; i < 2; i++) {
      window.scrollBy(0, 800)
      await sleep(120)
    }
  })

  await waitForRscIdle(page)

  // The next leaf's first card (#25 pikachu) loaded into the same preview.
  await expect(preview.getByRole("link", { name: /#25\s+pikachu/i })).toBeVisible({
    timeout: 10000,
  })
  // Earlier cards must not vanish when later leaves land.
  await expect(preview.getByRole("link", { name: /#1\s+bulbasaur/i })).toBeAttached()
})
