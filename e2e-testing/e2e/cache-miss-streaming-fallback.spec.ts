import { expect, request, test } from "./fixtures"

/**
 * Cold-cache regression: on the first load (no cached entry), the
 * Suspense fallback inside the cached subtree (`LivePriceFallback`)
 * MUST appear before the real `LivePrice` content resolves.
 *
 * The bug: `<Cache>` on miss buffered the entire inner Flight stream
 * via `readAll`, which waits for every inner Suspense chunk to
 * complete. By the time Cache returned, its subtree was fully resolved —
 * the outer render never saw a pending Suspense to fall back on, so
 * the whole page stalled for ~1s until LivePrice's artificial delay
 * elapsed, then committed content with no fallback flash.
 *
 * Warm-cache path already worked: decode-on-hit produces a tree whose
 * inner Partials are live (`reinjectDynamic`) and whose LivePrice body
 * is still async — so outer Suspense fallbacks naturally fire.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("cold cache: LivePrice Suspense fallback appears before content", async ({ page }) => {
  const start = Date.now()
  await page.goto("/magento", { waitUntil: "commit" })

  // LivePrice awaits 1000ms. In streaming mode the outer shell +
  // per-card fallbacks should be visible well before that resolves.
  await page.waitForSelector('[data-testid^="live-price-fallback-"]', {
    timeout: 5000,
  })
  const fallbackTime = Date.now() - start

  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  const contentTime = Date.now() - start

  // LivePrice has a 1000ms artificial delay. Streaming path: fallback
  // paints at ~500–700ms (GraphQL only), content at ~1500–1700ms.
  // Buffered path: both appear at once, once everything resolved.
  // A 400ms gap is a clear streaming signal and well above jitter.
  expect(
    contentTime - fallbackTime,
    `expected fallback to paint well before content. fallback=${fallbackTime}ms content=${contentTime}ms`,
  ).toBeGreaterThan(400)
})

test("warm cache: LivePrice Suspense fallback still appears before content", async ({ page }) => {
  // Populate cache.
  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })

  // Warm reload — cache hit serves bytes immediately; inner Partials
  // are re-injected as live holes so LivePrice still suspends.
  const start = Date.now()
  await page.goto("/magento", { waitUntil: "commit" })

  await page.waitForSelector('[data-testid^="live-price-fallback-"]', {
    timeout: 5000,
  })
  const fallbackTime = Date.now() - start

  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  const contentTime = Date.now() - start

  expect(
    contentTime - fallbackTime,
    `warm cache: expected fallback to paint well before content. fallback=${fallbackTime}ms content=${contentTime}ms`,
  ).toBeGreaterThan(400)
})
