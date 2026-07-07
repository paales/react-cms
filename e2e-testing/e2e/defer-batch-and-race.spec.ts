import { clearCaches, test, expect, recordPartialDispatches } from "./fixtures"

/**
 * /defer-demo § 2,5 — dispatch behavior under concurrent activations.
 *
 *   § 2 Batched activation: two <WhenMounted> Partials activate in the
 *       same commit pass. The microtask-batched dispatch should
 *       coalesce them into ONE RSC request listing both ids in
 *       ?partials=.
 *
 *   § 5 Streaming + defer race: a slow async Partial suspends on
 *       initial render; a neighboring deferred Partial activates
 *       immediately on mount. The defer refetch must land (and its
 *       content render) before the slow Partial resolves.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("defer batching + race", () => {
  test("two <WhenMounted> partials coalesce into one dispatch", async ({ page }) => {
    // Both batch partials activate on mount, so each activator's
    // useEffect calls `fire()` in the same commit pass.
    const rscCalls = recordPartialDispatches(page)

    await page.goto("/defer-demo")
    // Wait for both partials to render their activated content — that
    // proves both refetches landed.
    await expect(page.locator('[data-testid="batch-a-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })
    await expect(page.locator('[data-testid="batch-b-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })

    // One dispatch should list BOTH `batch-a` and `batch-b` in its
    // stated targets. Separate dispatches (one per partial) would be
    // the batching bug.
    const matches = rscCalls.filter((c) => {
      if (!c.partials) return false
      const ids = c.partials.split(",")
      return ids.includes("batch-a") && ids.includes("batch-b")
    })
    expect(
      matches.length,
      `expected one dispatch covering both batch-a + batch-b, got: ${JSON.stringify(
        rscCalls.map((c) => c.partials),
      )}`,
    ).toBeGreaterThanOrEqual(1)

    // And no one-off dispatches for either partial alone — those would
    // indicate un-batched fires.
    const soloA = rscCalls.filter((c) => c.partials === "batch-a")
    const soloB = rscCalls.filter((c) => c.partials === "batch-b")
    expect(soloA.length, "batch-a should not be refetched alone").toBe(0)
    expect(soloB.length, "batch-b should not be refetched alone").toBe(0)
  })

  test("deferred activation doesn't wait for a slow suspending sibling", async ({ page }) => {
    // `waitUntil: "commit"` lets us observe the streaming fallback
    // before the 1.5s slow partial resolves. Default `load` waits for
    // stream close, which hides the interleaving this test is about.
    await page.goto("/defer-demo", { waitUntil: "commit" })

    // The slow partial streams its Suspense fallback first. race-defer
    // activates on mount and completes its refetch in parallel with
    // the slow stream.
    await page.waitForSelector('[data-testid="slow-fallback"]', {
      timeout: 10000,
    })

    await page.waitForSelector('[data-testid="race-defer-content"]', {
      timeout: 10000,
    })
    await page.waitForSelector('[data-testid="slow-content"]', {
      timeout: 10000,
    })

    // The non-waiting claim, from the SERVER's own render stamps:
    // race-defer's activation render STARTED before the slow stream
    // FINISHED its 1.5s of work — the two ran concurrently. A
    // pipeline that serialized the activation behind the slow stream
    // could never produce that interval overlap. Server-clock stamps
    // are immune to client-side scheduling jitter, unlike a
    // wall-clock arrival gap.
    const raceStarted = Number(
      await page.locator('[data-testid="race-defer-content"]').getAttribute("data-started-at"),
    )
    const slowFinished = Number(
      await page.locator('[data-testid="slow-content"]').getAttribute("data-finished-at"),
    )
    expect(
      raceStarted,
      `race-defer must start before the slow stream finishes (parallel); race.started=${raceStarted} slow.finished=${slowFinished}`,
    ).toBeLessThan(slowFinished)
  })
})
