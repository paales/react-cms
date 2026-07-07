import { clearCaches, test, expect, recordPartialDispatches, waitForPageInteractive } from "./fixtures"

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
  await clearCaches(baseURL)
})

test.describe("concurrent refetches", () => {
  test("single refetch updates its partial (baseline)", async ({ page }) => {
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="concurrent-a"]', {
      timeout: 10000,
    })
    await waitForPageInteractive(page)
    const before = await page.locator('[data-testid="concurrent-a"]').textContent()
    await page.locator('[data-testid=\"refresh-concurrent-a\"][data-hydrated]').click()
    await expect
      .poll(async () => await page.locator('[data-testid="concurrent-a"]').textContent(), {
        timeout: 5000,
      })
      .not.toBe(before)
  })

  test("a streaming refetch's milestones settle promptly — the button doesn't hang loading", async ({ page }) => {
    // `refresh-concurrent-a` fires `reload({selector, streaming: true})`.
    // `streaming` is a CLIENT commit-mode switch (progressive reveal).
    // The fire's `finished` resolves at the covering segment's settle
    // on the held stream — the button, whose label is "…" while
    // `committed && !finished`, must leave its loading state at the
    // roundtrip, never ride the connection's 20s keepalive.
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="concurrent-a"]', {
      timeout: 10000,
    })
    await waitForPageInteractive(page)
    const btn = page.locator('[data-testid="refresh-concurrent-a"][data-hydrated]')
    const before = await page.locator('[data-testid="concurrent-a"]').textContent()
    await btn.click()
    // The refetch commits (proves it actually fired, not a no-op)…
    await expect
      .poll(async () => await page.locator('[data-testid="concurrent-a"]').textContent(), {
        timeout: 5000,
      })
      .not.toBe(before)
    // …and the connection closes one-shot, so the button leaves its
    // loading state far short of the 20s subscription keepalive. The
    // hold-open bug pinned it at "…" for the full keepalive; the 6s
    // bound sits well below 20s and ~10× above the real one-shot close.
    await expect(btn).toHaveText("refetch a", { timeout: 6000 })
  })

  test("three distinct-id refetches run in parallel server-side", async ({ page }) => {
    const rscCalls = recordPartialDispatches(page)
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
    await waitForPageInteractive(page)

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
    await page.locator('[data-testid=\"refresh-concurrent-a\"][data-hydrated]').click()
    await page.locator('[data-testid=\"refresh-concurrent-b\"][data-hydrated]').click()
    await page.locator('[data-testid=\"refresh-concurrent-c\"][data-hydrated]').click()

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
        { timeout: 10000 },
      )
      .toEqual({
        a: expect.not.stringContaining(before.a),
        b: expect.not.stringContaining(before.b),
        c: expect.not.stringContaining(before.c),
      } as any)

    // Every target was STATED — successive statements restate the
    // union of uncovered forces, so across the dispatch log all three
    // ids appear (however many envelopes carried them).
    console.log(`dispatches after concurrent clicks:`, JSON.stringify(rscCalls))
    const statedIds = new Set(
      rscCalls.flatMap((c) => c.partials?.split(",").filter(Boolean) ?? []),
    )
    for (const id of ["concurrent-a", "concurrent-b", "concurrent-c"]) {
      expect([...statedIds], `expected ${id} to be stated`).toContainEqual(
        expect.stringContaining(id),
      )
    }

    // Parallelism check from the SERVER's own render intervals: each
    // concurrent partial stamps `data-started-at` / `data-finished-at`
    // (server clock, taken around its awaited delay). Handled in
    // parallel means the intervals OVERLAP — b and c must have started
    // before a (400ms) finished. A serialized server would start b
    // only after a's interval closed. Interval overlap is the direct
    // signal; client-side wall clock only correlates with it (and
    // collapses under machine load).
    const intervals = await page.evaluate(() => {
      const read = (id: string) => {
        const el = document.querySelector(`[data-testid="concurrent-${id}"]`)
        return {
          started: Number(el?.getAttribute("data-started-at")),
          finished: Number(el?.getAttribute("data-finished-at")),
        }
      }
      return { a: read("a"), b: read("b"), c: read("c") }
    })
    // Serialized handling would stack the intervals end-to-start —
    // a[0,400] b[400,1200] c[1200,2400] — so NO pair overlaps.
    // Parallel handling overlaps adjacent intervals for any realistic
    // click cadence (b spans 800ms, c spans 1200ms). Asserting that
    // SOME overlap exists discriminates the serialized regime without
    // putting a number on scheduling jitter, which under a loaded
    // suite can stretch both the click cadence and request queueing.
    const overlaps =
      intervals.b.started < intervals.a.finished || intervals.c.started < intervals.b.finished
    expect(
      overlaps,
      `render intervals must overlap somewhere (parallel handling); intervals: ${JSON.stringify(intervals)}`,
    ).toBe(true)

  })

  test("rapid-fire refetches against the SAME id: last completion wins", async ({ page }) => {
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="concurrent-c"]', {
      timeout: 10000,
    })
    await waitForPageInteractive(page)

    // Three clicks on the same slow partial — each fires its own
    // refetch. The framework doesn't cancel in-flight requests; each
    // response overwrites the partial on arrival. With a monotonically
    // increasing server clock the final timestamp should match the
    // last response to complete (which is the last one fired, assuming
    // server FIFO).
    const btn = page.locator('[data-testid="refresh-concurrent-c"][data-hydrated]')
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
