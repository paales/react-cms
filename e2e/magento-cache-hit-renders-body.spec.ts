import { expect, request, test } from "./fixtures"

/**
 * Regression: on the *second* GET of /magento (when the server-side
 * `<Cache>` wrapping `<ProductGrid>` is hit) the rendered body was
 * effectively empty — no `<nav>`, no `<header>`, no product cards —
 * even though the dev panel reported every partial as "fresh".
 *
 * Cache should be transparent: a cache hit still has to produce the
 * full rendered tree for the client. This test drives the dev server
 * over raw HTTP (no JS, no hydration) so we're exercising purely the
 * SSR pathway through PartialsClient + renderTemplate.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("second /magento render (Cache hit) still produces full body HTML", async ({ baseURL }) => {
  const ctx = await request.newContext()
  const base = baseURL ?? "http://localhost:5173"

  // Cold miss — populates the `<Cache>` store.
  const first = await ctx.get(`${base}/magento`)
  expect(first.ok()).toBe(true)
  const firstHtml = await first.text()

  // Warm hit.
  const second = await ctx.get(`${base}/magento`)
  expect(second.ok()).toBe(true)
  const secondHtml = await second.text()

  await ctx.dispose()

  // Structural smoke test: a real Magento render has a nav, a header,
  // a product grid, and many live-price testids. All three must be
  // present in *both* renders.
  for (const [label, html] of [
    ["cold", firstHtml],
    ["cached", secondHtml],
  ] as const) {
    expect(html, `${label} render should contain <nav>`).toContain("<nav")
    expect(html, `${label} render should contain <header>`).toContain("<header")
    expect(html, `${label} render should contain the product grid`).toContain(
      'data-testid="product-grid"',
    )
    const priceMatches = html.match(/data-testid="live-price-[^"]+"/g) ?? []
    expect(
      priceMatches.length,
      `${label} render should include many live-price testids`,
    ).toBeGreaterThan(5)
  }
})
