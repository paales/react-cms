import { expect, test } from "@playwright/test"

/**
 * Cold→warm fp-trailer round-trip under `yarn build && yarn preview`.
 *
 * Mirrors `e2e/cold-warm-fp-skip.spec.ts` (dev tier) — verifies the
 * fp-trailer infrastructure works against the production bundle too.
 *
 * The user reported on 2026-05-14 that production preview still
 * showed a ~25 KB response on the FIRST re-visit to /magento (i.e.
 * fp-skip not yet active), even though dev passes. This spec pins
 * that the prod build's trailer is emitted, parsed, and applied
 * before the next nav.
 *
 * The trailer rides two channels:
 *   - SSR HTML responses: `<!--fp-trailer:JSON-->` comment after `</html>`.
 *   - RSC GET responses: length-prefixed binary segment after the
 *     Flight bytes (see `splitAtFpTrailer` for the client splitter).
 *   - RSC action POSTs: no trailer — Flight stops reading once the
 *     action result resolves, and a splitter waiting past that point
 *     can stall under backpressure.
 *
 * Note: the preview server is long-lived per Playwright worker, so
 * the cold-render moment is the very first nav to /magento. Routes
 * the worker already touched in prior tests would be warm; this
 * test must therefore be one of the early ones to hit /magento.
 * (`yarn test:e2e:preview` runs the preview directory in isolation,
 * so ordering against other suites isn't a concern.)
 */

test("re-visit to /magento fp-skips on the second visit (prod build)", async ({ page }) => {
  const rscResponses: Array<{ url: string; size: number }> = []
  page.on("response", async (res) => {
    const ct = res.headers()["content-type"] ?? ""
    if (!ct.includes("text/x-component")) return
    try {
      const body = await res.body()
      rscResponses.push({ url: res.url(), size: body.byteLength })
    } catch {}
  })

  // Visit / first to load the app shell.
  await page.goto("/")
  await page.waitForSelector("a[href='/magento']", { timeout: 10000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  rscResponses.length = 0

  // Click into Magento (first visit — cold via RSC nav).
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  // Click back to home.
  await page.getByRole("link", { name: /Pokemon$/ }).click()
  await page.waitForSelector("[data-testid=page-shell]", { timeout: 10000 })
  await page.waitForLoadState("networkidle")

  // Click forward to Magento (second visit — should fp-skip via the
  // binary fp-trailer the cold RSC response just shipped).
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  const magentoResponses = rscResponses.filter((r) => r.url.includes("/magento_.rsc"))
  expect(magentoResponses.length, "expected at least 2 /magento_.rsc responses").toBeGreaterThanOrEqual(2)

  const coldNav = magentoResponses[0]
  const returnNav = magentoResponses[1]
  console.log(`cold-magento: ${coldNav.size} bytes; return-magento: ${returnNav.size} bytes`)

  // Return nav should be much smaller than cold — fp-skip activated
  // via the trailer that shipped on the cold render.
  expect(
    returnNav.size,
    `return-to-magento (${returnNav.size} bytes) was not much smaller than ` +
      `cold (${coldNav.size} bytes) — fp-trailer round-trip may not be wired in prod`,
  ).toBeLessThan(coldNav.size * 0.6)
})
