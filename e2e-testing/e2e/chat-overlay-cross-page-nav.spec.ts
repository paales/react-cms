import { test, expect, waitForRscIdle } from "./fixtures"

// Skipped: requires the `/chat-notes` route + the `defaultOpen`
// plumbing on `<ChatOverlay/>`, neither of which is wired in
// `root.tsx`. Reactivate when both land.

/**
 * Cross-page navigation must preserve the already-streamed chat
 * overlay. The `<ChatOverlay>` `<Partial frame="chat-overlay">`
 * computes the same fingerprint on `/` (Pokemon) and `/magento`
 * even though `/` has a sibling `<Partial frame="search">`: a
 * `<Partial>` that opens its own frame doesn't fold ambient sibling
 * frames into its fp. The server emits a fingerprint-skip
 * placeholder on the second route, and the cached overlay survives
 * the cross-page nav untouched.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/__test/clear-caches")
})

test.skip("opened chat overlay survives navigation from / to /magento", async ({ page }) => {
  await page.goto("/")
  // The overlay pill sits in the page — wait until it's interactive
  // before clicking. Without this, a click can fire pre-hydration and
  // follow the plain `<a href="?chat=open">` fallback, which lands on
  // the window URL (not the frame URL) and leaves the session empty.
  await waitForRscIdle(page)

  // Open the overlay.
  await page.locator('[data-testid="chat-open-pill"]').click()
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({
    timeout: 10000,
  })

  // Wait for the default AA_CHAT_STREAMING message to start streaming
  // and accumulate some chunks.
  const chunks = page.locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]')
  await expect(chunks.first()).toBeAttached({ timeout: 10000 })
  await expect.poll(() => chunks.count(), { timeout: 10000 }).toBeGreaterThanOrEqual(3)
  const chunksBefore = await chunks.count()

  // Navigate to /magento via the top nav link (same intercept path the
  // user's repro uses — not a direct `page.goto`).
  await page.locator('a[href="/magento"]').first().click()
  await expect(page).toHaveURL(/\/magento/)

  // The overlay must still be open (not collapsed back to the pill).
  // Magento's initial render fetches from the GraphCommerce API, which
  // can be slow under parallel load — give this a generous timeout so
  // we're really asserting "the overlay survived the nav," not
  // "Magento's API responded in 5s."
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator('[data-testid="chat-msg-AA_CHAT_STREAMING"]')).toBeAttached()

  // Chunk count must not regress. Whether we observe N or N+k chunks,
  // it must be ≥ what we saw pre-nav — a remount would drop to 0
  // before restreaming.
  const chunksAfter = await page
    .locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]')
    .count()
  expect(chunksAfter).toBeGreaterThanOrEqual(chunksBefore)
})
