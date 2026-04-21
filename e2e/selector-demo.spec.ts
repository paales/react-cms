import { test, expect, request } from "@playwright/test";

/**
 * /selector-demo — verify tag-based refetch semantics.
 *
 *   {tags: ["product"]}  → one id-less Partial
 *   {tags: ["price"]}    → three ids (price-a, price-b, price-c)
 *   {tags: ["featured"]} → two ids (price-b, price-c)
 *   {ids: ["price-a"]}   → single id
 *
 * Tag → id resolution runs server-side against the route-scoped
 * partial registry (`partial.tsx:resolveTagsToIds`). Each Partial
 * renders a server timestamp. After refetch, only the targeted
 * timestamps should change; untargeted ones stay pinned.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext();
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`);
  await ctx.dispose();
});

async function readTimestamps(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const labels = ["product", "price-a", "price-b", "price-c"];
    const out: Record<string, string> = {};
    for (const l of labels) {
      const el = document.querySelector(`[data-testid="time-${l}"]`);
      out[l] = el?.textContent ?? "";
    }
    return out;
  });
}

test.describe("selector-based refetch", () => {
  test("`.product` refetches only the id-less product Partial", async ({
    page,
  }) => {
    await page.goto("/selector-demo");
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    const before = await readTimestamps(page);
    // Ensure enough time passes so a fresh render produces a different ISO string.
    await page.waitForTimeout(50);
    await page.locator('[data-testid="refresh-product"]').click();
    // Wait until the "product" timestamp text changes.
    await expect
      .poll(async () => (await readTimestamps(page))["product"])
      .not.toBe(before.product);
    const after = await readTimestamps(page);

    // product changed, price-* unchanged.
    expect(after.product).not.toBe(before.product);
    expect(after["price-a"]).toBe(before["price-a"]);
    expect(after["price-b"]).toBe(before["price-b"]);
    expect(after["price-c"]).toBe(before["price-c"]);
  });

  test("`.price` refetches all three price Partials", async ({ page }) => {
    await page.goto("/selector-demo");
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    const before = await readTimestamps(page);
    await page.waitForTimeout(50);
    await page.locator('[data-testid="refresh-price"]').click();
    await expect
      .poll(async () => (await readTimestamps(page))["price-a"])
      .not.toBe(before["price-a"]);
    const after = await readTimestamps(page);

    expect(after["price-a"]).not.toBe(before["price-a"]);
    expect(after["price-b"]).not.toBe(before["price-b"]);
    expect(after["price-c"]).not.toBe(before["price-c"]);
    // The id-less `product` Partial was NOT targeted — stays pinned.
    expect(after.product).toBe(before.product);
  });

  test("`.price.featured` refetches only the two featured ones", async ({
    page,
  }) => {
    await page.goto("/selector-demo");
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    const before = await readTimestamps(page);
    await page.waitForTimeout(50);
    await page.locator('[data-testid="refresh-price-featured"]').click();
    await expect
      .poll(async () => (await readTimestamps(page))["price-b"])
      .not.toBe(before["price-b"]);
    const after = await readTimestamps(page);

    expect(after["price-b"]).not.toBe(before["price-b"]);
    expect(after["price-c"]).not.toBe(before["price-c"]);
    // price-a lacks the `featured` tag, stays pinned.
    expect(after["price-a"]).toBe(before["price-a"]);
    expect(after.product).toBe(before.product);
  });

  test("`#price-a` refetches a single id", async ({ page }) => {
    await page.goto("/selector-demo");
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    );

    const before = await readTimestamps(page);
    await page.waitForTimeout(50);
    await page.locator('[data-testid="refresh-price-a"]').click();
    await expect
      .poll(async () => (await readTimestamps(page))["price-a"])
      .not.toBe(before["price-a"]);
    const after = await readTimestamps(page);

    expect(after["price-a"]).not.toBe(before["price-a"]);
    expect(after["price-b"]).toBe(before["price-b"]);
    expect(after["price-c"]).toBe(before["price-c"]);
    expect(after.product).toBe(before.product);
  });
});
