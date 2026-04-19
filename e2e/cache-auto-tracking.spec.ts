import { expect, request, test } from "@playwright/test";

/**
 * End-to-end verification of auto-tracked cache keys.
 *
 * The cache-demo `SlowContent` calls `getSearchParam("flavor")`. That
 * accessor participates in the `<Partial cache>`'s access manifest,
 * so different flavor values should produce different cache entries
 * without the Partial declaring a `vary` object. Same flavor twice ⇒
 * cache hit (renderCount unchanged); different flavor ⇒ miss (render
 * count increments).
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext();
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`);
  await ctx.dispose();
});

async function readRenderCount(page: import("@playwright/test").Page): Promise<number> {
  // Read the count baked INTO the cached SlowContent, not the outer
  // `server-render-count` span (which sits outside the cache and
  // reflects the live module-level counter on every request).
  const attr = await page
    .locator('[data-testid="slow-content"]')
    .getAttribute("data-render-count");
  return Number(attr);
}

test("different flavor URL params produce different cache entries (auto-tracked)", async ({
  page,
}) => {
  // First render for flavor=one → cache miss, body runs. The counter
  // value baked into the cached bytes is this render's.
  await page.goto("/cache-demo?flavor=one");
  await page.waitForSelector('[data-testid="slow-content"]');
  const cachedForOne = await readRenderCount(page);

  // flavor=two → different manifest values → cache miss → body runs
  // again, counter increments.
  await page.goto("/cache-demo?flavor=two");
  await page.waitForSelector('[data-testid="slow-content"]');
  const cachedForTwo = await readRenderCount(page);
  expect(cachedForTwo).toBe(cachedForOne + 1);

  // Back to flavor=one → cache HIT serving the original bytes. The
  // data-render-count is FROZEN at whatever was rendered first time
  // — not the live value.
  await page.goto("/cache-demo?flavor=one");
  await page.waitForSelector('[data-testid="slow-content"]');
  const afterOneAgain = await readRenderCount(page);
  expect(afterOneAgain).toBe(cachedForOne);
});

test("same flavor twice is a cache hit (render count does not increment)", async ({
  page,
}) => {
  // Warm the cache for this flavor first so the assertion isn't
  // watching the cold-miss → warm-hit transition (which would still
  // run the body once).
  await page.goto("/cache-demo?flavor=strawberry");
  await page.waitForSelector('[data-testid="slow-content"]');
  const first = await readRenderCount(page);

  await page.goto("/cache-demo?flavor=strawberry");
  await page.waitForSelector('[data-testid="slow-content"]');
  const second = await readRenderCount(page);

  expect(second).toBe(first);
});

test("cache entry carries the flavor read through the accessor", async ({ page }) => {
  await page.goto("/cache-demo?flavor=mint");
  const body = await page.textContent("body");
  expect(body).toContain("flavor: mint");
});
