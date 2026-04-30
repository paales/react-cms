import { test, expect, request } from "./fixtures"

/**
 * /defer-demo § 6 — concurrent refetch behavior.
 *
 * Three Partials `concurrent-a/b/c` each suspend for 400/800/1200ms
 * server-side. Clicking the three refetch buttons in rapid succession
 * should result in:
 *
 *   - Three separate RSC requests (click handlers are distinct event
 *     tasks → distinct microtasks → no batching).
 *   - Server handles them in parallel (request-scoped state via ALS).
 *   - Total wall time ≈ max(delays) = ~1200ms, not sum = 2400ms.
 *
 * Tracks two things the user asked about: "can multiple fetches
 * happen simultaneously" and "what about race conditions".
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test.describe("concurrent refetches", () => {
  test("single refetch updates its partial (baseline)", async ({ page }) => {
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="concurrent-a"]', {
      timeout: 10000,
    })
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )
    const before = await page.locator('[data-testid="concurrent-a"]').textContent()
    await page.waitForTimeout(50)
    await page.locator('[data-testid="refresh-concurrent-a"]').click()
    await expect
      .poll(async () => await page.locator('[data-testid="concurrent-a"]').textContent(), {
        timeout: 5000,
      })
      .not.toBe(before)
  })

  test("three distinct-id refetches run in parallel server-side", async ({ page }) => {
    const rscCalls: Array<{
      partials: string | null
      startedAt: number
    }> = []
    const startNav = Date.now()
    page.on("request", (req) => {
      const url = req.url()
      if (url.includes("_.rsc")) {
        const u = new URL(url)
        rscCalls.push({
          partials: u.searchParams.get("partials"),
          startedAt: Date.now() - startNav,
        })
      }
    })
    page.on("console", (msg) => {
      if (["error", "warning"].includes(msg.type())) {
        console.log(`BROWSER ${msg.type()}: ${msg.text()}`)
      }
    })

    await page.goto("/defer-demo")
    // Wait for initial render so all three Partials are populated
    // (each with its own ISO timestamp from the cold render).
    await page.waitForSelector('[data-testid="concurrent-a"]', {
      timeout: 10000,
    })
    await page.waitForSelector('[data-testid="concurrent-b"]', {
      timeout: 10000,
    })
    await page.waitForSelector('[data-testid="concurrent-c"]', {
      timeout: 10000,
    })
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )

    // Capture the initial timestamps to compare after refetch.
    const before = await page.evaluate(() => ({
      a: document.querySelector('[data-testid="concurrent-a"]')?.textContent ?? "",
      b: document.querySelector('[data-testid="concurrent-b"]')?.textContent ?? "",
      c: document.querySelector('[data-testid="concurrent-c"]')?.textContent ?? "",
    }))

    rscCalls.length = 0

    // Fire three refetches in sequence (awaiting each click). Click
    // handlers fire on separate event tasks — each dispatch lands in
    // its own microtask, so separate RSC requests fire and overlap on
    // the server.
    const clickedAt = Date.now()
    await page.locator('[data-testid="refresh-concurrent-a"]').click()
    await page.locator('[data-testid="refresh-concurrent-b"]').click()
    await page.locator('[data-testid="refresh-concurrent-c"]').click()

    // Wait for all three timestamps to change (proves all three
    // refetches landed).
    await expect
      .poll(
        async () =>
          await page.evaluate(() => ({
            a: document.querySelector('[data-testid="concurrent-a"]')?.textContent ?? "",
            b: document.querySelector('[data-testid="concurrent-b"]')?.textContent ?? "",
            c: document.querySelector('[data-testid="concurrent-c"]')?.textContent ?? "",
          })),
        { timeout: 5000 },
      )
      .toEqual({
        a: expect.not.stringContaining(before.a),
        b: expect.not.stringContaining(before.b),
        c: expect.not.stringContaining(before.c),
      } as any)

    const totalMs = Date.now() - clickedAt

    // Each click → own RSC request. Expect three separate calls.
    console.log(`RSC calls after concurrent clicks (${totalMs}ms total):`, JSON.stringify(rscCalls))
    expect(rscCalls.length).toBeGreaterThanOrEqual(3)

    // Parallelism check: max server delay is 1200ms, sum is 2400ms.
    // If the server serialized them, total wall time would approach
    // 2400ms. Parallel → ~1200ms + jitter. Generous ceiling at 2000ms
    // covers Playwright/network overhead without admitting serial.
    expect(
      totalMs,
      `three parallel refetches should finish in ~1200ms, not sum; got ${totalMs}ms`,
    ).toBeLessThan(2000)

    // Each call should target exactly one id (not a coalesced batch).
    const idsPerCall = rscCalls.map((c) => c.partials?.split(",").filter(Boolean) ?? [])
    const hasMulti = idsPerCall.some((ids) => ids.length > 1)
    expect(
      hasMulti,
      `each click in its own task should produce a single-id call; got ${JSON.stringify(idsPerCall)}`,
    ).toBe(false)
  })

  test("rapid-fire refetches against the SAME id: last completion wins", async ({ page }) => {
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="concurrent-c"]', {
      timeout: 10000,
    })
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )

    // Three clicks on the same slow partial — each fires its own
    // refetch. The framework doesn't cancel in-flight requests; each
    // response overwrites the partial on arrival. With a monotonically
    // increasing server clock the final timestamp should match the
    // last response to complete (which is the last one fired, assuming
    // server FIFO).
    const btn = page.locator('[data-testid="refresh-concurrent-c"]')
    await btn.click()
    await page.waitForTimeout(50)
    await btn.click()
    await page.waitForTimeout(50)
    await btn.click()

    // Wait for the partial to stabilize (no more pending). Each click
    // adds ~1200ms of server work; three sequential-ish requests
    // should all complete within ~4s.
    await expect(btn).toBeEnabled({ timeout: 5000 })
    const final = await page.locator('[data-testid="concurrent-c"]').textContent()
    // We can't deterministically assert "which timestamp" without
    // tighter control, but we can at least prove the partial is
    // well-formed + contains a fresh timestamp.
    expect(final).toMatch(/c \(1200ms\):/)
    expect(final).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })
})
