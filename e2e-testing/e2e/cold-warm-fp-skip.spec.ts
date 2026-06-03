import { test, expect, request } from "./fixtures"

/**
 * Cold→warm fp instability fix via the fp-trailer.
 *
 * The descendant fold in a spec's fp depends on which descendants
 * have ever registered for the route. On the cold render of a route
 * (first request in a fresh scope), no descendants are registered
 * yet, so the fold is empty and the spec emits `fp_cold`. After that
 * render commits, descendants ARE registered — the very same spec
 * would compute `fp_warm` on the next request. With a single-fp
 * client pool, the client would send `fp_cold`, the server would
 * compute `fp_warm`, mismatch, fresh re-render. Keepalive then costs
 * a wasted body run on the first re-visit.
 *
 * The fp-trailer fix: at end-of-render, the server recomputes each
 * spec's fp against the now-populated registry; any drift is shipped
 * down as a trailer segment after the main Flight bytes. The client
 * stores BOTH `fp_cold` (registered from the wrapper props) and
 * `fp_warm` (from the trailer) in its fp set for the id. On the
 * next visit, `?cached=` carries both, and the server's fp-skip
 * check (set membership) matches whichever applies — fp-skip works
 * on the very next visit, no fresh re-render.
 *
 * Observable: navigate to /magento (cold, large response), navigate
 * away, navigate back. The second /magento response is much smaller
 * than the first — only the fp-skipped placeholders for the
 * unchanged partials come down.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("re-visit to a route fp-skips on the very next nav after cold", async ({ page }) => {
  // Track every RSC response and its size.
  const rscResponses: Array<{ url: string; size: number }> = []
  page.on("response", async (res) => {
    const ct = res.headers()["content-type"] ?? ""
    if (!ct.includes("text/x-component")) return
    try {
      const body = await res.body()
      rscResponses.push({ url: res.url(), size: body.byteLength })
    } catch {
      // ignore
    }
  })

  // Visit /magento (cold). Body renders fully, snapshots register.
  await page.goto("/magento")
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Clear the response log — we're interested in what happens AFTER
  // the cold render commits.
  rscResponses.length = 0

  // Client-side nav away, then back. The away nav is just to remove
  // /magento's partials from the visible tree (they'll be parked by
  // keepalive).
  await page.getByRole("link", { name: /Pokemon$/ }).click()
  // Wait for Pokemon-page content to render — proxy for "away-nav
  // response landed + trailer applied." `networkidle` would have
  // worked here but the framework's live-page heartbeat holds a
  // streaming connection open continuously, so the network never
  // goes idle. Pokedex heading appearing means the trailer round-
  // trip is complete.
  //
  // Generous timeout: this is a full client nav round-trip (away-nav
  // fetch + heartbeat teardown/reopen), and on a cold dev server the
  // Pokemon route's first Vite dep-optimization pass can push it past
  // 10s — all retries then land in the same cold window. Warm it is a
  // few seconds; the headroom only matters on first boot.
  await page.getByRole("heading", { name: "Pokedex" }).waitFor({ timeout: 25000 })

  // Nav back to /magento.
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  // Find the two /magento responses: the one from away→back, and
  // any subsequent ones.
  const magentoResponses = rscResponses.filter((r) => r.url.includes("/magento_.rsc"))
  expect(
    magentoResponses.length,
    `expected at least one /magento_.rsc response in ${JSON.stringify(rscResponses.map((r) => r.url))}`,
  ).toBeGreaterThan(0)

  // The return nav's response should be much smaller than a cold
  // render. Cold renders the full product list (~250KB). A
  // successful fp-skip response is mostly placeholders (~20KB or
  // smaller).
  const returnNav = magentoResponses[0]
  console.log(`return-to-magento response: ${returnNav.size} bytes`)
  expect(
    returnNav.size,
    `return-to-magento response (${returnNav.size} bytes) is not much smaller than ` +
      `a cold render — fp-trailer round-trip may not be wired`,
  ).toBeLessThan(80_000)
})
