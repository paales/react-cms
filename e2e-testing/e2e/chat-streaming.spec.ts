import { test, expect, request, type Page } from "./fixtures"

/**
 * End-to-end coverage for the segment-loop chat. The chat overlay
 * renders on every page via `root.tsx`; opening it (`?chat=open`)
 * mounts `<ChatOverlayPartial>` which threads through to
 * `<ChatMessage>`.
 *
 * Each `<ChatMessage>` reads `readLogState(fileId)` synchronously
 * and ends with one `<Suspense>` whose child `<ChunkSlot>` calls
 * `markConnectionLive()` and awaits `waitForNextChunk`. The log
 * producer's `appendChunk` fires `refreshSelector` on the message
 * label; the server's segment driver wakes, re-renders with the
 * fresh chunk now in `<ChunkList>`, and emits another segment on
 * the same connection. Loop until the log signals done — then the
 * render takes the `snapshot.done` branch, skips the Suspense, no
 * `markConnectionLive`, driver closes.
 *
 * What this spec pins:
 *   - Opening the overlay (open-pill click) triggers an RSC GET that
 *     runs the segment loop.
 *   - Chunks accumulate progressively in the DOM as segments arrive
 *     (NOT all in one paint, which would mean the segment loop
 *     collapsed into a single render).
 *   - Chunk count never regresses — each segment renders the full
 *     prefix from the log, no drop on segment seams.
 *   - The "stream complete" tail eventually appears (driver
 *     terminates cleanly when the producer drains the log).
 *   - No `<ResumeTail>` / `<Piece>` / `<FlatPrefix>` artefacts —
 *     the new architecture has no client-side compaction sentinel.
 */

async function countChunks(page: Page, fileId: string): Promise<number> {
  return page.locator(`[data-testid="chat-body-${fileId}"] [data-chunk]`).count()
}

test.beforeEach(async ({ page }) => {
  // Logs + registry are process-wide per scope. Start each test cold
  // so chunk-count assertions begin at zero.
  await page.goto("/__test/clear-caches")
})

test.afterAll(async ({ baseURL }) => {
  // Wipe sessions / logs / registry so downstream specs inherit a
  // clean server even if the last test left a producer running mid-
  // budget.
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

test("clicking the open pill streams chunks progressively into the chat", async ({ page }) => {
  // Start on a stable, fast-rendering route. The chat overlay is
  // mounted by `root.tsx` so it's available wherever we navigate.
  await page.goto("/pokemon/1")

  // Open pill is a client component; wait until hydration is ready.
  await page.waitForLoadState("networkidle")

  // Click the open pill — this fires `navigate("?chat=open",
  // {selector: "#chat-overlay"})`, which becomes an RSC GET against
  // the segment-loop driver because the chat partial now signals
  // `markConnectionLive()`.
  await page.locator('[data-testid="chat-open-pill"]').click()
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({ timeout: 10000 })

  // Message frame mounts.
  await expect(page.locator('[data-testid="chat-msg-AA_CHAT_STREAMING"]')).toBeAttached({
    timeout: 10000,
  })

  // First chunk lands within the test-mode chunk delay budget (~5ms
  // per chunk + Flight roundtrip). Generous timeout for CI.
  await expect(
    page.locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]').first(),
  ).toBeAttached({ timeout: 5000 })

  // Sample chunk count over time. Each segment carries the full
  // prefix from the log (`readLogState` snapshots all chunks), so
  // count must grow monotonically and end well above 1. Sampling
  // every ~50ms gives the segment driver multiple ticks; we cap at
  // 8s so a stuck loop surfaces fast.
  const samples: number[] = []
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const n = await countChunks(page, "AA_CHAT_STREAMING")
    samples.push(n)
    if (
      n > 5 &&
      (await page.locator('[data-testid="chat-done-AA_CHAT_STREAMING"]').count()) > 0
    ) {
      break
    }
    await page.waitForTimeout(50)
  }
  const nonzero = samples.filter((c) => c > 0)
  expect(nonzero.length, "no chunks ever appeared").toBeGreaterThan(0)
  // Progressively grew (or at least crossed a few thresholds — this
  // is the actual segment-loop signal). If the segment loop
  // collapsed into a single render the count would jump from 0 to
  // final in one sample with no intermediate values.
  const distinctCounts = new Set(nonzero).size
  expect(distinctCounts, "chunk count never advanced past a single value").toBeGreaterThan(1)
  // Monotonic — segment N+1's render sees a longer log than segment
  // N, so chunk count can only grow.
  for (let i = 1; i < nonzero.length; i++) {
    expect(nonzero[i]).toBeGreaterThanOrEqual(nonzero[i - 1])
  }
  // Producer drains the log under the test-mode budget (3s for
  // ~2.4KB at 25 char/chunk = ~95 chunks at 5ms each ≈ 475ms).
  await expect(page.locator('[data-testid="chat-done-AA_CHAT_STREAMING"]')).toBeVisible({
    timeout: 10000,
  })
  // Final chunk count matches the "✓ stream complete (N chunks)"
  // counter rendered by the done-branch.
  const finalCount = await countChunks(page, "AA_CHAT_STREAMING")
  const doneText = await page
    .locator('[data-testid="chat-done-AA_CHAT_STREAMING"]')
    .textContent()
  expect(doneText).toMatch(new RegExp(`${finalCount} chunks`))
})

test("no client-side compaction sentinel — old Piece/ResumeTail pattern is gone", async ({
  page,
}) => {
  // Sanity check that the legacy data-testids don't show up. If they
  // do, the chat code regressed to the old recursive shape.
  await page.goto("/pokemon/1?chat=open")
  await expect(page.locator('[data-testid="chat-msg-AA_CHAT_STREAMING"]')).toBeAttached({
    timeout: 10000,
  })
  // Give the stream a moment to actually run.
  await page.waitForTimeout(1000)
  expect(await page.locator('[data-testid^="resume-tail-"]').count()).toBe(0)
})

test("closing the chat collapses the overlay back to the open pill mid-stream", async ({
  page,
}) => {
  // Open via the pill (RSC GET → segment loop). The connection
  // stays live as long as `<ChunkSlot>` is suspended on the next
  // log entry. Closing the overlay fires a new navigation; the
  // Navigation API's `event.signal` aborts the prior in-flight
  // fetch, the segment loop tears down, and the close-click
  // payload commits cleanly.
  await page.goto("/pokemon/1")
  await page.waitForLoadState("networkidle")
  await page.locator('[data-testid="chat-open-pill"]').click()
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({ timeout: 10000 })

  // Wait for at least one chunk so we know the segment loop is
  // actively streaming when we click close.
  await expect(
    page.locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]').first(),
  ).toBeAttached({ timeout: 5000 })

  await page.locator('[data-testid="chat-close-pill"]').click()
  // After close, the overlay collapses and the open-pill returns.
  await expect(page.locator('[data-testid="chat-open-pill"]')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="chat-box"]')).toHaveCount(0)
})
