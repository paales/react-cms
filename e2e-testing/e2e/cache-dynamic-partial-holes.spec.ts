import { expect, request, test } from "./fixtures"

/**
 * Dynamic Partials inside a `<Partial cache>` must remain holes —
 * independent of the surrounding cached bytes, live per request, and
 * still resolvable by tag-based refetches even when their producer
 * (e.g. `ProductGrid`) didn't run this request because the cache hit
 * short-circuited it.
 *
 * Regression coverage for the bug set (2026-04-19):
 *   1. Refresh All Prices silently no-ops after /magento is warm,
 *      because dynamic price-* ids aren't in the registry after a
 *      cache hit skips `ProductGrid`.
 *   2. LivePrice renders are frozen across requests when the
 *      surrounding Cache hit serves baked-in bytes instead of
 *      re-running the holes.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("refresh-all-prices updates ticks after /magento cache is warm", async ({ page }) => {
  // First load — cold cache, ProductGrid runs, price-* partials
  // register, Cache stores the stripped hole-only bytes + dynamic
  // snapshots.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })

  // Second load — cache HIT. ProductGrid doesn't re-run. Without
  // the dynamic-snapshots sidecar, price-* ids wouldn't be in the
  // registry, and `?tags=price` would resolve to zero ids.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  await page.waitForFunction(
    () =>
      typeof (
        window as Window & {
          __rsc_partial_refetch?: (url: string) => Promise<void>
        }
      ).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  const before = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => ({
      id: el.getAttribute("data-testid") ?? "",
      tick: el.getAttribute("data-price-tick") ?? "",
    })),
  )
  expect(before.length).toBeGreaterThan(2)

  await page.locator('[data-testid="refresh-all-prices"]').click()

  await expect
    .poll(
      async () => {
        const after = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
          els.map((el) => ({
            id: el.getAttribute("data-testid") ?? "",
            tick: el.getAttribute("data-price-tick") ?? "",
          })),
        )
        const byId = new Map(after.map((x) => [x.id, x.tick]))
        const changed = before.filter((b) => {
          const a = byId.get(b.id)
          return a != null && a !== b.tick
        })
        return changed.length
      },
      { timeout: 8000 },
    )
    .toBe(before.length)
})

test("dynamic Partials inside a cached region render fresh across full loads", async ({ page }) => {
  // First load. Cold cache → ProductGrid runs → bytes stored.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })

  const first = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => ({
      id: el.getAttribute("data-testid") ?? "",
      tick: el.getAttribute("data-price-tick") ?? "",
    })),
  )

  // Second load — Cache HIT on the products Partial. LivePrice
  // should still have rendered fresh for this request (it's a hole),
  // so `data-price-tick` differs from the first load for at least
  // most prices.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })

  const second = await page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => ({
      id: el.getAttribute("data-testid") ?? "",
      tick: el.getAttribute("data-price-tick") ?? "",
    })),
  )

  const firstById = new Map(first.map((x) => [x.id, x.tick]))
  const changed = second.filter((s) => {
    const prev = firstById.get(s.id)
    return prev != null && prev !== s.tick
  })
  // At least half the prices should have a different tick — `Date.now()`
  // and Math.random inside LivePrice guarantee fresh values when it
  // actually re-runs. Some collisions are tolerable (ms granularity),
  // but if the holes were frozen we'd see zero changes.
  expect(changed.length).toBeGreaterThan(first.length / 2)
})

test("individual price refetch works after a Cache hit", async ({ page }) => {
  // Cold then warm.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  await page.waitForFunction(
    () =>
      typeof (
        window as Window & {
          __rsc_partial_refetch?: (url: string) => Promise<void>
        }
      ).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  const testId = (await firstPrice.getAttribute("data-testid"))!
  const sku = testId.replace(/^live-price-/, "")
  const before = await firstPrice.getAttribute("data-price-tick")

  await page.locator(`[data-testid="refresh-price-${sku}"]`).click()

  await expect
    .poll(() => firstPrice.getAttribute("data-price-tick"), { timeout: 5000 })
    .not.toBe(before)
})
