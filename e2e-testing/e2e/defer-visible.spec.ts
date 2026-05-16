import { test, expect } from "./fixtures"

/**
 * <Partial defer> + <VisibleTrigger> — the trivia card on
 * /pokemon/:id is placed below an 80vh spacer and should stay at
 * its fallback until the user scrolls it into view. The trigger
 * (an app-level component) is rendered inside the fallback and
 * calls `useNavigation().reload({ids: ["trivia"]})` on intersection.
 *
 * Assertions:
 *  1. On initial load the fallback is visible and the real content
 *     is NOT in the DOM.
 *  2. Scrolling the trivia partial into view triggers exactly ONE
 *     RSC refetch, and the real content appears.
 */
test("defer + VisibleTrigger activates the block when it enters the viewport", async ({ page }) => {
  const rscCalls: Array<{ url: string; partials: string | null }> = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) {
      const u = new URL(url)
      rscCalls.push({ url, partials: u.searchParams.get("partials") })
    }
  })

  await page.goto("/pokemon/1")

  // Hero/stats/species render immediately.
  await page.waitForSelector('[data-testid="lazy-spacer"]', { timeout: 15000 })

  // Before scroll: fallback is in the DOM, real content is not.
  await expect(page.locator('[data-testid="trivia-fallback"]')).toBeVisible()
  expect(await page.locator('[data-testid="trivia-content"]').count()).toBe(0)

  // Reset the RSC counter before the scroll.
  rscCalls.length = 0

  // Scroll the trivia partial into view.
  await page.locator('[data-testid="trivia-fallback"]').scrollIntoViewIfNeeded()

  // Real content appears after the refetch round-trip.
  await page.waitForSelector('[data-testid="trivia-content"]', {
    timeout: 15000,
  })

  // Tiny settling window to catch any extra calls.
  await page.waitForTimeout(500)

  // The trivia spec's effective id is auto-derived from its catalog
  // id ("trivia") plus a hash of its JSX call-site props — looks like
  // "trivia:abcdef0123". Any partials token whose first colon-segment
  // is "trivia" is the trivia partial.
  const isTrivia = (token: string): boolean => token.split(":")[0] === "trivia"
  const triviaCalls = rscCalls.filter(
    (c) => c.partials != null && c.partials.split(",").some(isTrivia),
  )
  const otherCalls = rscCalls.filter(
    (c) => c.partials == null || !c.partials.split(",").some(isTrivia),
  )

  console.log(`\n=== RSC calls after scroll (${rscCalls.length}) ===`)
  for (const c of rscCalls) console.log(`  partials=${c.partials}`)

  expect(triviaCalls.length, "expected exactly one RSC refetch for the trivia partial").toBe(1)
  expect(
    otherCalls,
    `expected no unrelated RSC calls; got: ${JSON.stringify(otherCalls)}`,
  ).toHaveLength(0)
})
