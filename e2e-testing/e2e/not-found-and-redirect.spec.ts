import { test, expect, request } from "./fixtures"

/**
 * /not-found-demo throws `notFound()` → HTTP 404 + <NotFoundPage/>.
 * /redirect-demo throws `redirect("/cache-demo")` → HTTP 302 for HTML,
 * or a payload marker for RSC fetches that the client acts on.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
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
    // Root's sync path — prior to this mechanism the response would
    // have been 200 with a broken page. The framework control channel
    // is flagged eagerly inside notFound() so the RSC entry can still
    // set status 404 after renderHTML awaits the full tree.
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

  test("redirect(): RSC response carries the <Redirect> client component, not a native 302", async ({
    request,
    baseURL,
  }) => {
    const url = `${baseURL ?? "http://localhost:5173"}/redirect-demo_.rsc`
    const res = await request.fetch(url, {
      headers: { accept: "text/x-component" },
      maxRedirects: 0,
    })
    // Server must NOT emit a 302 on the RSC path — fetch() would
    // transparently follow and decode the destination's payload,
    // committing it to the wrong route. Instead: 200 with the
    // <Redirect url=…> client reference inline.
    expect(res.status()).toBe(200)
    const body = await res.text()
    // The serialized Flight stream references the Redirect client
    // component by its module path + carries the destination URL as a
    // prop. Both strings survive serialization intact.
    expect(body).toContain("redirect-client")
    expect(body).toContain("/cache-demo")
  })
})
