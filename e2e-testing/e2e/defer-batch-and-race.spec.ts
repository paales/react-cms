import { test, expect, request } from "./fixtures"

/**
 * /defer-demo § 4-5 — dispatch behavior under concurrent activations.
 *
 *   § 4 Batched activation: two <WhenStored> Partials with pre-set
 *       keys activate in the same commit pass. The microtask-batched
 *       dispatch should coalesce them into ONE RSC request listing
 *       both ids in ?partials=.
 *
 *   § 5 Streaming + defer race: a slow async Partial suspends on
 *       initial render; a neighboring deferred Partial activates
 *       immediately on mount. The defer refetch must land (and its
 *       content render) before the slow Partial resolves.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test.describe("defer batching + race", () => {
  test("two <WhenStored> pre-set keys coalesce into one RSC request", async ({ page }) => {
    // Pre-set both keys BEFORE navigation so each activator's useEffect
    // calls `fire()` synchronously in the same commit pass.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("batch-a-key", "hello-a")
        localStorage.setItem("batch-b-key", "hello-b")
      } catch {
        /* ignore */
      }
    })

    const rscCalls: Array<{ partials: string | null; url: string }> = []
    page.on("request", (req) => {
      const url = req.url()
      if (url.includes("_.rsc")) {
        const u = new URL(url)
        rscCalls.push({ partials: u.searchParams.get("partials"), url })
      }
    })

    await page.goto("/defer-demo")
    // Wait for both partials to render their activated content — that
    // proves both refetches landed.
    await expect(page.locator('[data-testid="batch-a-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })
    await expect(page.locator('[data-testid="batch-b-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })

    // One RSC call should list BOTH `batch-a` and `batch-b` in its
    // ?partials= param. Separate calls (one per partial) would be the
    // batching bug.
    const matches = rscCalls.filter((c) => {
      if (!c.partials) return false
      const ids = c.partials.split(",")
      return ids.includes("batch-a") && ids.includes("batch-b")
    })
    expect(
      matches.length,
      `expected one RSC call covering both batch-a + batch-b, got: ${JSON.stringify(
        rscCalls.map((c) => c.partials),
      )}`,
    ).toBeGreaterThanOrEqual(1)

    // And no one-off calls for either partial alone — those would
    // indicate un-batched dispatches.
    const soloA = rscCalls.filter((c) => c.partials === "batch-a")
    const soloB = rscCalls.filter((c) => c.partials === "batch-b")
    expect(soloA.length, "batch-a should not be refetched alone").toBe(0)
    expect(soloB.length, "batch-b should not be refetched alone").toBe(0)
  })

  test("deferred activation doesn't wait for a slow suspending sibling", async ({ page }) => {
    // `waitUntil: "commit"` lets us observe the streaming fallback
    // before the 1.5s slow partial resolves. Default `load` waits for
    // stream close, which hides the interleaving this test is about.
    const start = Date.now()
    await page.goto("/defer-demo", { waitUntil: "commit" })

    // The slow partial streams its Suspense fallback first. race-defer
    // activates on mount and completes its refetch in parallel with
    // the slow stream.
    await page.waitForSelector('[data-testid="slow-fallback"]', {
      timeout: 5000,
    })
    const fallbackMs = Date.now() - start

    // race-defer's refetch should resolve before the 1.5s slow delay
    // — it's a cold refetch of trivial content, typical ~200-400ms.
    await page.waitForSelector('[data-testid="race-defer-content"]', {
      timeout: 5000,
    })
    const raceMs = Date.now() - start

    // Finally the slow partial resolves.
    await page.waitForSelector('[data-testid="slow-content"]', {
      timeout: 5000,
    })
    const slowMs = Date.now() - start

    console.log(`fallback=${fallbackMs}ms race-defer=${raceMs}ms slow-content=${slowMs}ms`)

    // race-defer must land meaningfully earlier than the slow stream.
    // If they serialized (race waited on slow, or vice versa), both
    // would arrive together near the 1.5s mark.
    expect(
      slowMs - raceMs,
      `expected race-defer to land well before slow-content; race=${raceMs}ms slow=${slowMs}ms`,
    ).toBeGreaterThan(400)
  })
})
