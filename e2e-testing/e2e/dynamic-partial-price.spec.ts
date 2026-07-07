import {
  clearCaches,
  expect,
  recordPartialDispatches,
  request,
  test,
  waitForPageInteractive,
} from "./fixtures"

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
  await clearCaches(baseURL)
})

test("dynamic live-price Partial is discoverable and individually refetchable by id", async ({
  page,
}) => {
  // Transport-agnostic dispatch log: an attached page states the
  // refetch on the channel; pre-attach it goes discrete.
  const refetches = recordPartialDispatches(page)

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

  refetches.length = 0
  await page.locator(`[data-testid="refresh-price-${sku}"][data-hydrated]`).first().click()

  // The refetch dispatches a single id (on either transport). The id
  // is the framework-derived per-instance instance id — opaque on the
  // wire but stable for self-refetch via the `@self` selector token.
  await expect.poll(() => refetches.length, { timeout: 10000 }).toBeGreaterThan(0)
  const partials = refetches[0].partials
  expect(partials).toBeTruthy()
  // The id is derived from the spec id ("price") plus a per-instance
  // hash, so it starts with the spec id and is a single token.
  expect(partials!.startsWith("price")).toBe(true)
  expect(partials!.includes(",")).toBe(false)
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

  await page.locator(`[data-testid="refresh-price-${sku}"][data-hydrated]`).first().click()

  // The targeted price's tick should update within a few seconds.
  await expect
    .poll(() => firstPrice.getAttribute("data-price-tick"), { timeout: 10000 })
    .not.toBe(tickBefore)

  // Sibling did NOT get refreshed.
  const otherTickAfter = await otherPrice.getAttribute("data-price-tick")
  expect(otherTickAfter).toBe(otherTickBefore)
})

/**
 * Class-label bulk refresh. Clicking "Refresh all prices" should
 * issue a single `?partials=price` refetch — `price` is a label
 * carried by every LivePrice instance, and the framework resolves it
 * (through `partial-registry.ts`) to every dynamic instance currently
 * rendered. Each one's tick should advance on the client.
 */
test("clicking 'refresh all prices' updates every visible price in one request", async ({
  page,
}) => {
  const refetches = recordPartialDispatches(page)

  await page.goto("/magento")
  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  await expect(firstPrice).toBeVisible({ timeout: 15000 })

  await waitForPageInteractive(page)

  // Snapshot all visible ticks before the click.
  const before = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => ({
      testId: el.getAttribute("data-testid") ?? "",
      tick: el.getAttribute("data-price-tick") ?? "",
    })),
  )
  expect(before.length).toBeGreaterThan(2)

  refetches.length = 0
  await page.locator('[data-testid="refresh-all-prices"][data-hydrated]').click()

  // Exactly one refetch, carrying the `price` label.
  await expect.poll(() => refetches.length, { timeout: 10000 }).toBeGreaterThan(0)
  expect(refetches[0].partials).toBe("price")

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
      { timeout: 10000 },
    )
    .toBe(true)
})
