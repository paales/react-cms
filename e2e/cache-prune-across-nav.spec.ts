import { test, expect, request } from "@playwright/test";

/**
 * Verify: after navigating between routes, the client `_cache` drops
 * entries whose ids aren't on the new page. Observable via the
 * `?cached=` param on a subsequent refetch — it should only report
 * ids present on the CURRENT page, not stale ones carried over from
 * the prior route.
 *
 * Without pruning, a long session hopping between routes accumulates
 * every id it's ever seen; the `?cached=` query string grows
 * unbounded and starts announcing fingerprints for partials that no
 * longer render.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext();
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`);
  await ctx.dispose();
});

test("client-side nav from /pokemon/1 to /defer-demo prunes stale ids from ?cached=", async ({
  page,
}) => {
  // Warm the cache on /pokemon/1 — partial ids include hero, stats,
  // species, trivia, plus search stages and dynamic price-XXX.
  await page.goto("/pokemon/1");
  await page.waitForSelector("header", { timeout: 10000 });
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  );

  // Client-side nav via the app-nav link. A hard `page.goto` would
  // drop the browser process entirely and clear module state (making
  // the prune moot); a same-document intercepted click preserves the
  // `_cache` / `_fingerprints` Maps, which is where stale entries
  // actually leak.
  await page.getByRole("link", { name: /Defer Demo/ }).click();
  await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible();
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  );

  // Capture the RSC refetch URL when we activate the "manual" partial.
  const rscRequest = page.waitForRequest((req) => req.url().includes("_.rsc"));
  await page.locator('[data-testid="activate-manual"]').click();
  const req = await rscRequest;

  const url = new URL(req.url());
  const cachedParam = url.searchParams.get("cached") ?? "";
  const cachedIds = cachedParam
    .split(",")
    .map((t) => t.split(":")[0])
    .filter(Boolean);

  // Stale ids from /pokemon/1 must NOT appear.
  for (const id of ["hero", "stats", "species", "trivia"]) {
    expect(
      cachedIds,
      `expected pruned id "${id}" to be absent from ?cached=`,
    ).not.toContain(id);
  }

  // Current-page ids SHOULD be present. `head` is on both pages but
  // the fingerprint differs; `stored` and `any` are unique to
  // /defer-demo. `manual` is the refetch target and is excluded from
  // ?cached= by design.
  expect(cachedIds).toContain("head");
  expect(cachedIds).toContain("stored");
  expect(cachedIds).toContain("any");
  expect(cachedIds).not.toContain("manual");
});
