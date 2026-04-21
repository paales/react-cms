import { test, expect } from "@playwright/test";

/**
 * "Search (Frame)" — frame-scoped version of the pokemon search demo.
 *
 * Proves that the search flow can be driven purely by a frame's own
 * URL (`/` closed vs `/?search=1&q=…` open) without any mutation of
 * the page URL. The page renders `<SearchArea/>` twice — once at
 * page scope and once inside `<Partial frame="search">` — and the
 * same component drives both. The ambient `useNavigation()` binds to
 * the enclosing scope.
 */

test.beforeEach(async ({ request }) => {
  await request.get("/__test/clear-caches");
});

async function awaitHydrated(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="search-frame-open"]');
    if (!el) return false;
    return Object.keys(el).some((k) => k.startsWith("__reactFiber"));
  });
}

test("opens the search frame without touching the page URL", async ({
  page,
}) => {
  await page.goto("/");
  await awaitHydrated(page);
  const beforeUrl = page.url();

  await page.getByTestId("search-frame-open").click();

  // The dialog renders from the frame Partial.
  await expect(page.locator("dialog")).toBeVisible();
  await expect(page.locator("dialog input[type=text]")).toBeVisible();

  // Page URL is untouched — no ?search=, no ?q=.
  expect(page.url()).toBe(beforeUrl);
});

test("typing in the frame search navigates the frame, not the page", async ({
  page,
}) => {
  await page.goto("/");
  await awaitHydrated(page);
  const beforeUrl = page.url();

  await page.getByTestId("search-frame-open").click();
  await expect(page.locator("dialog")).toBeVisible();

  const input = page.locator("dialog input[type=text]");
  await input.focus();
  await input.fill("pika");

  // Stages stream in for a non-empty query.
  await expect(page.getByTestId("stage-1-content")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("stage-2-content")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("stage-3-content")).toBeVisible({ timeout: 8000 });

  // Page URL STILL untouched — `?q=` lives only on the frame URL.
  expect(page.url()).toBe(beforeUrl);
});

test("closing the dialog (Escape) navigates the frame back to /", async ({
  page,
}) => {
  await page.goto("/");
  await awaitHydrated(page);
  await page.getByTestId("search-frame-open").click();
  await expect(page.locator("dialog")).toBeVisible();

  // The modal <dialog> intercepts pointer events on the header button,
  // so use Escape — which fires the <dialog>'s onClose handler, which
  // navigates the frame back to "/" (no ?search=).
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).not.toBeVisible();

  // Open button is back in the header.
  await expect(page.getByTestId("search-frame-open")).toBeVisible();
});

test("search input keeps focus across live refetches", async ({ page }) => {
  await page.goto("/");
  await awaitHydrated(page);
  await page.getByTestId("search-frame-open").click();
  await expect(page.locator("dialog")).toBeVisible();

  const input = page.locator("dialog input[type=text]");
  await input.focus();

  // Stamp the DOM node and watch for remount.
  await input.evaluate((el) => {
    (el as HTMLInputElement & { __stamp?: number }).__stamp = 42;
  });

  await input.pressSequentially("pika", { delay: 200 });
  // Wait for at least one refetch round-trip to finish.
  await expect(page.getByTestId("stage-3-content")).toBeVisible({
    timeout: 8000,
  });

  const stillStamped = await page
    .locator("dialog input[type=text]")
    .evaluate(
      (el) => (el as HTMLInputElement & { __stamp?: number }).__stamp === 42,
    );
  expect(stillStamped, "input DOM node was remounted by reconciliation").toBe(
    true,
  );

  const isFocused = await page
    .locator("dialog input[type=text]")
    .evaluate((el) => el === document.activeElement);
  expect(isFocused).toBe(true);
  await expect(page.locator("dialog input[type=text]")).toHaveValue("pika");
});

test("frame search refetch uses ?__frame=search, not ?q= on the page", async ({
  page,
}) => {
  const refetches: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("_.rsc")) refetches.push(url);
  });

  await page.goto("/");
  await awaitHydrated(page);
  await page.getByTestId("search-frame-open").click();
  await expect(page.locator("dialog")).toBeVisible();

  refetches.length = 0;

  const input = page.locator("dialog input[type=text]");
  await input.focus();
  await input.fill("a");

  // Wait for stages to land.
  await expect(page.getByTestId("stage-3-content")).toBeVisible({ timeout: 8000 });

  // At least one refetch used the `__frame` param for the search frame.
  const frameRefetch = refetches.find((u) => {
    const p = new URL(u).searchParams;
    const frameUrl = p.get("__frameUrl");
    return p.get("__frame") === "search" && frameUrl?.includes("q=a");
  });
  expect(
    frameRefetch,
    `no frame refetch seen; got ${JSON.stringify(refetches)}`,
  ).toBeTruthy();

  // None of the refetches should carry ?q= as a page-URL param.
  for (const u of refetches) {
    const p = new URL(u).searchParams;
    expect(p.get("q"), `unexpected page-URL ?q= on ${u}`).toBeNull();
  }
});
