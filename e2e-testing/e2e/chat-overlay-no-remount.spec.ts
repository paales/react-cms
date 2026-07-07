import { test, expect, type Page } from "@playwright/test"
import { waitForLiveConnection, waitForPageInteractive } from "./fixtures"

/**
 * Regression: opening the chat overlay on a page made the WHOLE page
 * flicker while notes streamed in (reported 2026-06-02 on /inspect).
 *
 * Mechanism: the chat overlay opens via a frame nav whose `<ChunkSlot>`
 * calls `markConnectionLive()`, so that refetch becomes a long-poll that
 * streams chunks and commits in CACHE mode. Meanwhile the page heartbeat
 * holds its own `?streaming=1` connection that ALSO renders the now-open
 * chat and commits in STREAMING mode. With both live, their segments land
 * on the same React root as alternating payloads. Two inconsistencies
 * made React remount the entire page on every segment seam:
 *   1. the streaming payload was wrapped in `<PageUrlProvider>` but the
 *      cache payload was a bare `<PartialsClient>` — different root types
 *      tore down the whole subtree (`page-shell` and everything under it);
 *   2. the streaming-mode "pending Flight chunk" path returned raw
 *      children instead of the template, so partials inside the page
 *      (the nav) remounted even once the root matched.
 *
 * This spec opens the overlay, lets the heartbeat's streaming connection
 * overlap the frame long-poll, and asserts the page's stable structure
 * (page-shell, the nav, a grid card) keeps its exact DOM nodes the whole
 * time. A remount discards a marked node for a fresh one.
 *
 * Runs against the DEFAULT scope (no `x-test-scope`) on purpose: only the
 * default scope streams in real time (100ms/chunk), and that long pending
 * window is what lets the heartbeat's stream overlap the frame long-poll.
 * A per-worker test scope streams in ~5ms/chunk and finishes before the
 * heartbeat can reopen chat-aware, so the two connections never overlap.
 */

const KEEPALIVE_CLOSE_TIMEOUT = 30_000

/** Tag stable DOM nodes with a JS marker so a remount (which builds fresh
 *  nodes) is detectable — the marker only survives if the node does. */
async function markStableNodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __marks: Record<string, "alive" | "missing">
    }
    w.__marks = {}
    const mark = (sel: string, name: string) => {
      const el = document.querySelector(sel) as (Element & { __mark?: string }) | null
      if (el) {
        el.__mark = name
        w.__marks[name] = "alive"
      } else {
        w.__marks[name] = "missing"
      }
    }
    mark('[data-testid="page-shell"]', "page-shell")
    mark('[data-testid="page-shell"] nav, [data-testid="page-shell"] > *', "nav")
    mark("main .grid > *", "grid-card")
    // A MutationObserver flips a mark to "missing" the moment its node is
    // detached — catches a remount even if a fresh node takes its place.
    const observed = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) {
          const m = (n as Element & { __mark?: string }).__mark
          if (m) w.__marks[m] = "missing"
        }
      }
    })
    observed.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  })
}

async function marks(page: Page): Promise<Record<string, string>> {
  const result = await page.evaluate(
    () => (window as unknown as { __marks?: Record<string, string> }).__marks,
  )
  if (!result) {
    throw new Error(
      "marks were lost — the page reloaded during the run (cold Vite dep-optimization?). " +
        "Re-run; the warm-up phase should prevent this.",
    )
  }
  return result
}

test("opening the chat overlay does not remount the page while notes stream", async ({
  browser,
}) => {
  // The heartbeat's chat-closed connection must idle out (20s keepalive)
  // before it reopens chat-aware and overlaps the frame long-poll.
  test.setTimeout(75_000)
  // Default-scope context (no per-worker header) → real-time streaming.
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    // Warm-up: load the page and open the chat once so Vite optimizes
    // every module these routes pull in. A cold dep-optimization round
    // triggers a full-page reload mid-test, which would wipe the marks and
    // read as a (spurious) remount. After this, the measured run is
    // reload-free.
    await page.goto("/inspect")
    await waitForPageInteractive(page)
    // Settle the live stream's first segment: its initial-load
    // re-commit (cold→warm fp drift) may replace nodes, which is not
    // the overlay-open remount this spec guards against.
    await waitForLiveConnection(page)
    await page.locator('[data-testid=\"chat-open-pill\"][data-hydrated]').click()
    await page.locator('[data-testid="chat-box"]').waitFor({ state: "visible", timeout: 10_000 })
    await page.waitForTimeout(500)

    // Fresh producer: clear-caches now also wipes the chat logs, so the
    // AA_CHAT_STREAMING stream starts cold and actually streams.
    await page.goto("/__test/clear-caches")

    // The heartbeat opens a chat-closed live connection on load (the
    // `/__parton/live` attach — a held stream). Track when it closes (idle
    // keepalive): the attach POST FINISHES when the connection ends, so a
    // `requestfinished` for it is the close signal — only after it reopens
    // does the heartbeat render the now-open chat and overlap the frame
    // long-poll.
    let streamingClosed = false
    const onLiveEnd = (req: { url(): string }) => {
      if (req.url().includes("/__parton/live")) streamingClosed = true
    }
    page.on("requestfinished", onLiveEnd)
    page.on("requestfailed", onLiveEnd)

    await page.goto("/inspect")
    await waitForPageInteractive(page)
    // Settle the live stream's first segment: its initial-load
    // re-commit (cold→warm fp drift) may replace nodes, which is not
    // the overlay-open remount this spec guards against.
    await waitForLiveConnection(page)

    await markStableNodes(page)

    // Wait for the chat-closed heartbeat connection to idle out, so its
    // reopen (chat-aware) overlaps the frame long-poll we start next.
    await expect.poll(() => streamingClosed, { timeout: KEEPALIVE_CLOSE_TIMEOUT }).toBe(true)

    // Open the chat via the client frame-nav path (markConnectionLive
    // long-poll). The producer starts streaming; within ~5s the heartbeat
    // reopens chat-aware and the two connections run concurrently.
    await page.locator('[data-testid=\"chat-open-pill\"][data-hydrated]').click()
    await expect(page.locator('[data-testid="chat-box"]')).toBeVisible({
      timeout: 10_000,
    })

    // Let the overlap run and notes accumulate.
    const chunks = page.locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]')
    await expect.poll(() => chunks.count(), { timeout: 15_000 }).toBeGreaterThan(8)

    // The stable page structure must have kept its exact DOM nodes through
    // the whole streaming overlap — no remount, no flicker.
    const result = await marks(page)
    expect(result["page-shell"], "page-shell remounted (whole-page flicker)").toBe("alive")
    expect(result["nav"], "the nav remounted").toBe("alive")
    expect(result["grid-card"], "a page grid card remounted").toBe("alive")
  } finally {
    await context.close()
  }
})
