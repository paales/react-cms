import { test, expect, recordPartialDispatches, waitForPageInteractive } from "./fixtures"

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
 *  2. Scrolling the trivia partial into view dispatches exactly ONE
 *     trivia refetch (on whichever carrier is up), and the real
 *     content appears.
 */
test("defer + VisibleTrigger activates the block when it enters the viewport", async ({ page }) => {
  const dispatches = recordPartialDispatches(page)

  await page.goto("/pokemon/1")

  // Hero/stats/species render immediately.
  await page.waitForSelector('[data-testid="lazy-spacer"]', { timeout: 15000 })
  await waitForPageInteractive(page)

  // Before scroll: fallback is in the DOM, real content is not.
  await expect(page.locator('[data-testid="trivia-fallback"]')).toBeVisible()
  expect(await page.locator('[data-testid="trivia-content"]').count()).toBe(0)

  // Reset the dispatch log before the scroll.
  dispatches.length = 0

  // Scroll the trivia partial into view.
  await page.locator('[data-testid="trivia-fallback"]').scrollIntoViewIfNeeded()

  // Real content appears after the refetch round-trip.
  await page.waitForSelector('[data-testid="trivia-content"]', {
    timeout: 15000,
  })

  // Tiny settling window to catch any extra dispatches.
  await page.waitForTimeout(500)

  // The trivia spec's effective id is auto-derived from its catalog
  // id ("trivia") plus a hash of its JSX call-site props — looks like
  // "trivia:abcdef0123". Any stated token whose first colon-segment
  // is "trivia" is the trivia partial.
  const isTrivia = (token: string): boolean => token.split(":")[0] === "trivia"
  const triviaCalls = dispatches.filter(
    (c) => c.partials != null && c.partials.split(",").some(isTrivia),
  )
  const otherTargets = dispatches.filter(
    (c) => c.partials != null && !c.partials.split(",").some(isTrivia),
  )

  console.log(`\n=== dispatches after scroll (${dispatches.length}) ===`)
  for (const c of dispatches) console.log(`  [${c.transport}] partials=${c.partials}`)

  expect(triviaCalls.length, "expected exactly one trivia dispatch").toBe(1)
  expect(
    otherTargets,
    `expected no unrelated targeted dispatches; got: ${JSON.stringify(otherTargets)}`,
  ).toHaveLength(0)
})
