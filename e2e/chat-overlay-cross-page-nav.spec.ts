import { test, expect } from "./fixtures";

/**
 * Cross-page navigation must preserve the already-streamed chat
 * overlay — the bug this spec guards against:
 *
 * Before the `ambientFrameKey` fix, the `<ChatOverlay>` `<Partial
 * frame="chat-overlay">` rendered on `/` (Pokemon) and `/magento`
 * computed different fingerprints, because `/` has a sibling
 * `<Partial frame="search">` that mutated the per-request frame-scope
 * cell before ChatOverlay ran, while `/magento` had no sibling
 * frame. The client-cached overlay fp (from `/`) didn't match the
 * server's fresh fp on `/magento`, so the server re-rendered the
 * overlay instead of emitting a fingerprint-skip placeholder —
 * visible to the user as the streamed chat content disappearing or
 * re-streaming from scratch.
 *
 * With the fix, a `<Partial>` that opens its own frame no longer
 * folds the ambient sibling frame into its fp. The overlay's fp is
 * identical on both routes, the server skips, and the cached
 * overlay survives the cross-page nav untouched.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/__test/clear-caches");
});

test("opened chat overlay survives navigation from / to /magento", async ({
  page,
}) => {
  await page.goto("/");
  // The overlay pill sits in the page — wait until it's interactive
  // before clicking. Without this, a click can fire pre-hydration and
  // follow the plain `<a href="?chat=open">` fallback, which lands on
  // the window URL (not the frame URL) and leaves the session empty.
  await page.waitForLoadState("networkidle");

  // Open the overlay.
  await page.locator('[data-testid="chat-open-pill"]').click();
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({
    timeout: 10000,
  });

  // Wait for the default AA_CHAT_STREAMING message to start streaming
  // and accumulate some chunks.
  const chunks = page.locator(
    '[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]',
  );
  await expect(chunks.first()).toBeAttached({ timeout: 10000 });
  await expect
    .poll(() => chunks.count(), { timeout: 10000 })
    .toBeGreaterThanOrEqual(3);
  const chunksBefore = await chunks.count();

  // Navigate to /magento via the top nav link (same intercept path the
  // user's repro uses — not a direct `page.goto`).
  await page.locator('a[href="/magento"]').first().click();
  await expect(page).toHaveURL(/\/magento/);

  // The overlay must still be open (not collapsed back to the pill).
  // Magento's initial render fetches from the GraphCommerce API, which
  // can be slow under parallel load — give this a generous timeout so
  // we're really asserting "the overlay survived the nav," not
  // "Magento's API responded in 5s."
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator('[data-testid="chat-msg-AA_CHAT_STREAMING"]'),
  ).toBeAttached();

  // Chunk count must not regress. Whether we observe N or N+k chunks,
  // it must be ≥ what we saw pre-nav — a remount would drop to 0
  // before restreaming.
  const chunksAfter = await page
    .locator(
      '[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]',
    )
    .count();
  expect(chunksAfter).toBeGreaterThanOrEqual(chunksBefore);
});
