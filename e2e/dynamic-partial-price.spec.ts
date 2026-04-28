import { expect, request, test } from "./fixtures"

/**
 * Dynamic Partial discovery + refresh end-to-end.
 *
 * The /magento page renders each product's live price as a
 * `<Partial id={"price-" + sku}>` produced inside `ProductGrid.map(...)` —
 * invisible to the bootstrap JSX walk in `PartialRoot`. Each Partial
 * self-registers in the route-scoped registry on its first render,
 * so a click on one product's ↻ button refetches that single partial
 * via the Flight (`_.rsc`) endpoint.
 */

// Clear server-side caches between tests so each one starts from a
// deterministic state. Tests that preceded this one may have populated
// the `<Cache>` store (ProductGrid output) and the partial registry;
// without clearing, dynamic refetches can return cached bytes that
// don't match the current page state.
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("dynamic live-price Partial is discoverable and individually refetchable by id", async ({
  page,
}) => {
  const rscRefetches: Array<{ url: string; partials: string | null }> = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc") && url.includes("partials=")) {
      const u = new URL(url)
      rscRefetches.push({ url, partials: u.searchParams.get("partials") })
    }
  })

  await page.goto("/magento")

  // Wait for the price grid to materialize. If the Partial self-wrap
  // weren't running / registering, these wouldn't be here.
  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  await expect(firstPrice).toBeVisible({ timeout: 15000 })
  const priceCount = await page.locator('[data-testid^="live-price-"][data-price-tick]').count()
  expect(priceCount).toBeGreaterThan(1)

  const testId = await (await firstPrice.elementHandle())!.getAttribute("data-testid")
  const sku = testId!.replace(/^live-price-/, "")
  expect(sku.length).toBeGreaterThan(0)

  rscRefetches.length = 0
  await page.locator(`[data-testid="refresh-price-${sku}"]`).click()

  // The refetch should hit the RSC endpoint with EXACTLY the targeted id.
  await expect.poll(() => rscRefetches.length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(rscRefetches[0].partials).toBe(`price-${sku}`)
})

/**
 * DOM-patch assertion: clicking refresh should update the targeted
 * price's rendered `data-price-tick` in the DOM while leaving sibling
 * products untouched. This is the payoff of the dynamic-partial
 * registry — otherwise the server response arrives but the client's
 * cache/template merge doesn't swap in the fresh content.
 */
test("clicking refresh updates the targeted price's tick in the DOM", async ({ page }) => {
  await page.goto("/magento")

  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  await expect(firstPrice).toBeVisible({ timeout: 15000 })

  const testId = await (await firstPrice.elementHandle())!.getAttribute("data-testid")
  const sku = testId!.replace(/^live-price-/, "")

  const tickBefore = await firstPrice.getAttribute("data-price-tick")
  expect(tickBefore).toBeTruthy()

  // Read a sibling product's tick — should stay put across this refresh.
  const otherPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').nth(1)
  const otherTickBefore = await otherPrice.getAttribute("data-price-tick")

  await page.locator(`[data-testid="refresh-price-${sku}"]`).click()

  // The targeted price's tick should update within a few seconds.
  await expect
    .poll(() => firstPrice.getAttribute("data-price-tick"), { timeout: 5000 })
    .not.toBe(tickBefore)

  // Sibling did NOT get refreshed.
  const otherTickAfter = await otherPrice.getAttribute("data-price-tick")
  expect(otherTickAfter).toBe(otherTickBefore)
})

/**
 * Tag-based bulk refresh. Clicking "Refresh all prices" should issue
 * a single `?tags=price` refetch that resolves (through the route
 * registry — see `partial-registry.ts`) to every dynamic
 * `price-<sku>` partial currently rendered. Each one's tick should
 * advance on the client.
 */
test("clicking 'refresh all prices' updates every visible price in one request", async ({
  page,
}) => {
  const rscRefetches: Array<{
    url: string
    tags: string | null
    partials: string | null
  }> = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc") && (url.includes("tags=") || url.includes("partials="))) {
      const u = new URL(url)
      rscRefetches.push({
        url,
        tags: u.searchParams.get("tags"),
        partials: u.searchParams.get("partials"),
      })
    }
  })

  await page.goto("/magento")
  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  await expect(firstPrice).toBeVisible({ timeout: 15000 })

  // Hydration must have installed `window.__rsc_partial_refetch`
  // before the click — otherwise the handler's early-return fires
  // silently and the test sees no Flight request.
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Snapshot all visible ticks before the click.
  const before = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => ({
      testId: el.getAttribute("data-testid") ?? "",
      tick: el.getAttribute("data-price-tick") ?? "",
    })),
  )
  expect(before.length).toBeGreaterThan(2)

  rscRefetches.length = 0
  await page.locator('[data-testid="refresh-all-prices"]').click()

  // Exactly one refetch, carrying the `price` tag.
  await expect.poll(() => rscRefetches.length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(rscRefetches[0].tags).toBe("price")

  // Every price's tick should update to a new value.
  await expect
    .poll(
      async () => {
        const after = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
          els.map((el) => ({
            testId: el.getAttribute("data-testid") ?? "",
            tick: el.getAttribute("data-price-tick") ?? "",
          })),
        )
        const byId = new Map(after.map((x) => [x.testId, x.tick]))
        return before.every((b) => {
          const a = byId.get(b.testId)
          return a != null && a !== b.tick
        })
      },
      { timeout: 5000 },
    )
    .toBe(true)
})
