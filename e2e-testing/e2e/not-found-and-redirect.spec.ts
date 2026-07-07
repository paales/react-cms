import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * /not-found-demo throws `notFound()` → HTTP 404 + <NotFoundPage/>.
 * /redirect-demo throws `redirect("/cache-demo")` → HTTP 302 for HTML,
 * or a payload marker for RSC fetches that the client acts on.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("notFound + redirect", () => {
  test("notFound() synchronously: HTML returns 404 + NotFoundPage body", async ({ page }) => {
    const response = await page.goto("/not-found-demo")
    expect(response?.status()).toBe(404)
    await expect(page.locator('[data-testid="not-found"]')).toBeVisible()
  })

  test("URL with no registered spec match: NotFoundFallback fires 404", async ({ page }) => {
    // /this/path/does/not/exist isn't covered by any spec's `match`.
    // The framework's NotFoundFallback iterates the registered match
    // set, finds nothing, and calls notFound() from its render —
    // surfacing as HTTP 404 with the default NotFoundPage body.
    const response = await page.goto("/this/path/does/not/exist")
    expect(response?.status()).toBe(404)
    await expect(page.locator('[data-testid="not-found"]')).toBeVisible()
  })

  test("notFound() from deep async server component: HTML still returns 404", async ({ page }) => {
    // /pokemon/9999999 — PokeAPI returns no pokemon for that id;
    // HeroPartial awaits the query, sees an empty result, and calls
    // notFound(). The throw happens during async rendering, not in
    // Root's sync path. The framework control channel is flagged
    // eagerly inside notFound() so the RSC entry can still set
    // status 404 after renderHTML awaits the full tree.
    const response = await page.goto("/pokemon/9999999")
    expect(response?.status(), "async notFound should surface as HTTP 404").toBe(404)
    await expect(page.locator('[data-testid="not-found"]')).toBeVisible({
      timeout: 10000,
    })
  })

  test("redirect(): HTML request follows 302 to destination", async ({ page }) => {
    await page.goto("/redirect-demo")
    // After the 302 is followed by the browser, we should land at
    // /cache-demo.
    await page.waitForURL("**/cache-demo")
    expect(new URL(page.url()).pathname).toBe("/cache-demo")
  })

  test("redirect(): a channel navigation lands at the destination same-document", async ({
    page,
  }) => {
    // The navigation segment for a redirecting route carries the
    // <Redirect url=…> client component (never a native 302 — there
    // is no discrete response to 302 on a held stream); the client
    // applies it as a navigation. The realm marker proves the whole
    // journey stayed same-document.
    await page.goto("/cache-demo")
    await waitForPageInteractive(page)
    await page.evaluate(() => {
      ;(window as unknown as { __realmMarker?: number }).__realmMarker = 42
    })
    await page.evaluate(() => {
      ;(
        window as unknown as { navigation: { navigate: (u: string) => void } }
      ).navigation.navigate("/redirect-demo")
    })
    await page.waitForURL("**/cache-demo", { timeout: 15000 })
    expect(new URL(page.url()).pathname).toBe("/cache-demo")
    expect(
      await page.evaluate(
        () => (window as unknown as { __realmMarker?: number }).__realmMarker,
      ),
    ).toBe(42)
  })
})
