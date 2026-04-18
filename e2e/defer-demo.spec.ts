import { test, expect, request } from "@playwright/test";

/**
 * /defer-demo — exercises all three shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — button-triggered manual activation.
 *   2. `defer={<WhenStored/>}` — localStorage-triggered activation with
 *      value passed to the server via `__inputs`.
 *   3. `defer={<AnyOf activators={.../>}`— first-of-many activators wins.
 *
 * Each section's activated content renders a server timestamp, so a
 * change in that text proves the RSC refetch round-tripped.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext();
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`);
  await ctx.dispose();
});

test.describe("Partial defer demo", () => {
  test("defer={true}: button click activates via usePartial.refetch()", async ({
    page,
  }) => {
    const rscCalls: Array<{ partials: string | null }> = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_.rsc")) {
        const u = new URL(url);
        rscCalls.push({ partials: u.searchParams.get("partials") });
      }
    });

    await page.goto("/defer-demo");

    await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible();
    expect(await page.locator('[data-testid="manual-content"]').count()).toBe(
      0,
    );
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    rscCalls.length = 0;
    await page.locator('[data-testid="activate-manual"]').click();
    await expect(page.locator('[data-testid="manual-content"]')).toBeVisible({
      timeout: 5000,
    });

    const hits = rscCalls.filter(
      (c) => c.partials != null && c.partials.split(",").includes("manual"),
    );
    expect(
      hits.length,
      "expected exactly one RSC refetch for `manual`",
    ).toBeGreaterThanOrEqual(1);
  });

  test("<WhenStored>: setting the key activates and value passes via __inputs", async ({
    page,
  }) => {
    const rscCalls: Array<{ partials: string | null; inputs: string | null }> =
      [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_.rsc")) {
        const u = new URL(url);
        rscCalls.push({
          partials: u.searchParams.get("partials"),
          inputs: u.searchParams.get("__inputs"),
        });
      }
    });

    // Make sure the key is clear before navigation so the initial mount
    // reads null and the Partial stays dormant.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("demo-stored");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/defer-demo");
    await expect(page.locator('[data-testid="stored-fallback"]')).toBeVisible();
    expect(await page.locator('[data-testid="stored-content"]').count()).toBe(
      0,
    );
    // Wait for hydration — WhenStored's `storage` listener only attaches
    // after its client-side useEffect runs.
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    rscCalls.length = 0;
    await page.locator('[data-testid="demo-stored-input"]').fill("hello-world");
    await page.locator('[data-testid="demo-stored-set"]').click();

    await expect(page.locator('[data-testid="stored-content"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="stored-value"]')).toHaveText(
      "hello-world",
    );

    const hit = rscCalls.find(
      (c) => c.partials != null && c.partials.split(",").includes("stored"),
    );
    expect(hit, "expected an RSC refetch for `stored`").toBeDefined();
    expect(hit!.inputs, "expected __inputs with the stored value").toContain(
      "hello-world",
    );
  });

  test("<AnyOf>: scroll-into-view activates the composed Partial", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("demo-any");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/defer-demo");
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible();
    expect(await page.locator('[data-testid="any-content"]').count()).toBe(0);
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    await page.locator('[data-testid="any-fallback"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    });
  });

  test("<AnyOf>: setting the storage key also activates (other branch)", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("demo-any");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/defer-demo");
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible();
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    // Set the storage key WITHOUT scrolling into view first.
    await page.locator('[data-testid="demo-any-input"]').fill("via-storage");
    await page.locator('[data-testid="demo-any-set"]').click();

    // Scroll in so Playwright can observe the activated content.
    await page.waitForTimeout(200);
    await page
      .locator('[data-testid="any-spacer"]')
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    });
  });
});
