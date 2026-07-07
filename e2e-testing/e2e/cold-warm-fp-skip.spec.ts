import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Cold→warm fp instability fix via the fp-trailer.
 *
 * The descendant fold in a spec's fp depends on which descendants
 * have ever registered for the route. On the cold render of a route
 * (first request in a fresh scope), no descendants are registered
 * yet, so the fold is empty and the spec emits `fp_cold`. After that
 * render commits, descendants ARE registered — the very same spec
 * would compute `fp_warm` on the next request. With a single-fp
 * client pool, the client would present `fp_cold`, the server would
 * compute `fp_warm`, mismatch, fresh re-render. Keepalive then costs
 * a wasted body run on the first re-visit.
 *
 * The fp-trailer fix: at end-of-render, the server recomputes each
 * spec's fp against the now-populated registry; any drift is shipped
 * down as a trailer segment after the main Flight bytes. The client
 * stores BOTH `fp_cold` (registered from the wrapper props) and
 * `fp_warm` (from the trailer) in its fp set for the id; the manifest
 * carries both, and the server's fp-skip check (set membership)
 * matches whichever applies — fp-skip works on the very next visit,
 * no fresh re-render.
 *
 * Observable: navigate to /magento (cold, large render), navigate
 * away, navigate back. The return navigation rides the held stream
 * as a whole-tree segment, so the byte signal is CDP-level: the
 * stream bytes received between the return click and the grid
 * appearing are mostly fp-skip placeholders — a small fraction of
 * the cold render's ~250KB.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("re-visit to a route fp-skips on the very next nav after cold", async ({ page }) => {
  // CDP byte accounting for the held live stream — the return nav's
  // segment arrives on it, not as its own response.
  const client = await page.context().newCDPSession(page)
  await client.send("Network.enable")
  const liveRequests = new Set<string>()
  let liveBytes = 0
  client.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.includes("/__parton/live")) liveRequests.add(e.requestId)
  })
  client.on("Network.dataReceived", (e) => {
    if (liveRequests.has(e.requestId)) liveBytes += e.dataLength
  })

  // Visit /magento (cold). Body renders fully, snapshots register.
  await page.goto("/magento")
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })
  await waitForPageInteractive(page)

  // Client-side nav away, to remove /magento's partials from the
  // visible tree (they park under keepalive).
  await page.getByRole("link", { name: /Pokemon$/ }).click()
  // Pokedex heading appearing means the away-nav's covering segment
  // committed and its trailer applied. Generous timeout: on a cold
  // dev server the Pokemon route's first Vite dep-optimization pass
  // can push it past 10s.
  await page.getByRole("heading", { name: "Pokedex" }).waitFor({ timeout: 25000 })

  // Nav back to /magento, measuring the stream bytes the return costs.
  const beforeReturn = liveBytes
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })
  const returnBytes = liveBytes - beforeReturn

  // The return segment should be much smaller than a cold render.
  // Cold renders the full product list (~250KB); a successful fp-skip
  // pass is mostly placeholders.
  console.log(`return-to-magento stream bytes: ${returnBytes}`)
  expect(
    returnBytes,
    `return-to-magento segment (${returnBytes} bytes) is not much smaller than ` +
      `a cold render — the fp-trailer round-trip may not be wired`,
  ).toBeLessThan(80_000)
})
