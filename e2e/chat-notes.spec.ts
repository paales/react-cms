import { test, expect, request, type Page } from "./fixtures"

// Skipped: the `/chat-notes` route + the `defaultOpen` / `frameUrl`
// plumbing on `<ChatOverlay/>` were removed from `root.tsx`. These
// specs exercise that surface and will pass again once the route is
// reintroduced.

/**
 * /chat-notes — bounded-recursion streaming with server-side compaction.
 *
 *   The source stream is `notes/*.md` paragraph-by-paragraph (see
 *   `src/app/chat/log.ts`). Each paragraph is a chunk. The message
 *   partial renders a recursive `<Piece>` server component that awaits
 *   the next chunk and recurses inside a `<Suspense>` — so every chunk
 *   arrives as its own Flight reveal.
 *
 *   Recursion is capped at MAX_DEPTH (currently 12). At the bound the
 *   chain ends in a client-side `<ResumeTail>` that calls
 *   `nav.navigate({ selector: "#chat-msg-${fileId}" })` with a bumped
 *   `?cursor-${fileId}=` in the URL. The server re-renders the message
 *   as a synchronous `<FlatPrefix>` (all chunks up to cursor, from the
 *   log) plus a fresh depth-0 Piece chain for the tail.
 *
 *   These tests pin the important invariants:
 *     - Initial render stops at MAX_DEPTH with a ResumeTail.
 *     - After compaction, the cursor in the URL and on the message's
 *       `data-cursor` attribute advances in MAX_DEPTH strides.
 *     - Chunk count never regresses across compaction boundaries
 *       (the flat prefix has to re-emit everything the old chain had).
 *     - Terminal state reaches `chat-done` for files whose log drains.
 */

const MAX_DEPTH = 12

async function countChunks(page: Page, fileId: string): Promise<number> {
  return page.locator(`[data-testid="chat-body-${fileId}"] [data-chunk]`).count()
}

async function readCursor(page: Page, fileId: string): Promise<number> {
  const attr = await page.locator(`[data-testid="chat-msg-${fileId}"]`).getAttribute("data-cursor")
  return Number(attr ?? "0")
}

test.beforeEach(async ({ page }) => {
  // Stream state (logs, registry, caches) is process-wide. Flush so
  // each test starts from a cold server and can assert initial
  // cursor=0 reliably.
  await page.goto("/__test/clear-caches")
})

test.afterAll(async ({ baseURL }) => {
  // After the whole spec finishes, kill any producer that the final
  // test left running (the 10-second budget may not have elapsed) and
  // wipe sessions / logs so downstream specs inherit a clean server.
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test.skip("empty state renders when ?msgs= is explicitly empty", async ({ page }) => {
  // No ?msgs= defaults to streaming AA_CHAT_STREAMING; pass an empty
  // value to force the empty state.
  await page.goto("/chat-notes?msgs=")
  await expect(page.locator('[data-testid="chat-box"]')).toBeVisible()
  await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible()
  expect(await page.locator("[data-chunk]").count()).toBe(0)
})

test.skip("initial render bounds Piece recursion at MAX_DEPTH with a ResumeTail", async ({
  page,
}) => {
  // IDEAS.md has ~79 paragraphs — guaranteed to exceed MAX_DEPTH so the
  // initial render hits the bound.
  await page.goto("/chat-notes?msgs=IDEAS")

  // Wait for the first chunk to show (log producer + Flight stream).
  await expect(page.locator('[data-testid="chat-body-IDEAS"] [data-chunk]').first()).toBeAttached({
    timeout: 5000,
  })

  // The ResumeTail is client-only so it mounts after hydration. Give
  // it a beat to appear before we check.
  await page.waitForSelector('[data-testid="resume-tail-IDEAS"]', {
    state: "attached",
    timeout: 5000,
  })

  // The tail carries a positive multiple of MAX_DEPTH — once the client
  // hydrates, compactions fire fast on a hot log so we can't pin the
  // exact multiple, but the structural invariant (cursor = k·MAX_DEPTH)
  // holds across every render.
  const cursorAttr = await page
    .locator('[data-testid="resume-tail-IDEAS"]')
    .first()
    .getAttribute("data-cursor")
  const tailCursor = Number(cursorAttr)
  expect(tailCursor).toBeGreaterThan(0)
  expect(tailCursor % MAX_DEPTH).toBe(0)
})

test.skip("chat list auto-scrolls to bottom as chunks stream in", async ({ page }) => {
  await page.goto("/chat-notes?msgs=IDEAS")

  // Wait until there's enough content for the list to actually overflow.
  await expect
    .poll(
      async () => {
        const list = page.locator('[data-testid="chat-list"]')
        return (
          (await list.evaluate((el) => el.scrollHeight)) -
          (await list.evaluate((el) => el.clientHeight))
        )
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(100)

  // Auto-scroll pins the bottom — scrollTop should be within a small
  // epsilon of `scrollHeight - clientHeight`.
  const { scrollTop, scrollHeight, clientHeight } = await page
    .locator('[data-testid="chat-list"]')
    .evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
  expect(scrollHeight - scrollTop - clientHeight).toBeLessThan(80)
})

test.skip("compaction: cursor advances and chunk count grows monotonically", async ({ page }) => {
  await page.goto("/chat-notes?msgs=IDEAS")

  // The message mounts with cursor=0.
  await expect(page.locator('[data-testid="chat-msg-IDEAS"]')).toHaveAttribute("data-cursor", "0", {
    timeout: 5000,
  })

  // After MAX_DEPTH chunks stream, ResumeTail fires and the partial
  // re-renders with cursor=MAX_DEPTH. Poll for the cursor advance.
  await expect
    .poll(() => readCursor(page, "IDEAS"), { timeout: 10000, intervals: [100] })
    .toBeGreaterThanOrEqual(MAX_DEPTH)

  // Second compaction — cursor bumps another MAX_DEPTH. Proves the
  // ResumeTail re-arms cleanly after unmount/remount across the seam.
  await expect
    .poll(() => readCursor(page, "IDEAS"), { timeout: 10000, intervals: [100] })
    .toBeGreaterThanOrEqual(MAX_DEPTH * 2)

  // The cursor is also reflected on the message element's data-cursor —
  // the overlay frame's URL carries ?cursor-IDEAS, but the frame URL
  // isn't projected onto the window URL, so reading the window URL
  // would always show 0. The data-cursor attribute is the canonical
  // source.
  expect(await readCursor(page, "IDEAS")).toBeGreaterThanOrEqual(MAX_DEPTH * 2)
})

test.skip("compaction preserves rendered chunks — never regresses across the seam", async ({
  page,
}) => {
  await page.goto("/chat-notes?msgs=IDEAS")

  // Sample the rendered chunk count every ~100ms. Each sample must be
  // >= the previous one — compaction cannot drop chunks, since the
  // flat prefix has to re-emit everything the prior Piece chain had.
  // Stop early once we've crossed MAX_DEPTH AND collected enough
  // nonzero samples (a dip would have already surfaced by then);
  // otherwise cap at a 6s fail-safe.
  const samples: number[] = []
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    samples.push(await countChunks(page, "IDEAS"))
    const nonzero = samples.filter((n) => n > 0)
    if (nonzero.length > 5 && nonzero[nonzero.length - 1] > MAX_DEPTH) {
      break
    }
    await page.waitForTimeout(100)
  }
  const nonzero = samples.filter((n) => n > 0)
  expect(nonzero.length).toBeGreaterThan(5)
  for (let i = 1; i < nonzero.length; i++) {
    expect(nonzero[i]).toBeGreaterThanOrEqual(nonzero[i - 1])
  }
  expect(nonzero[nonzero.length - 1]).toBeGreaterThan(MAX_DEPTH)
})

test.skip("stream reaches the done marker after all compactions finish", async ({ page }) => {
  // README.md is ~7000 chars → ~70 chunks at 100 chars/chunk → several
  // compactions → `chat-done-README` when the producer drains the log.
  await page.goto("/chat-notes?msgs=README")
  await expect(page.locator('[data-testid="chat-done-README"]')).toBeVisible({
    timeout: 10000,
  })
  // No ResumeTail should be present at terminal state — the final
  // render emits a `done` span and no further compaction.
  expect(await page.locator('[data-testid="resume-tail-README"]').count()).toBe(0)
})

test.skip("new message link appends a fileId to ?msgs= and a second stream starts", async ({
  page,
}) => {
  await page.goto("/chat-notes?msgs=README")
  // Wait for README to finish so test state is steady before the click.
  await expect(page.locator('[data-testid="chat-done-README"]')).toBeVisible({
    timeout: 10000,
  })

  // Link is an <a href> so it works pre-hydration — server-computed
  // `nextHref` walks the available-files pool and picks the first one
  // that isn't already in `?msgs=`. `AA_CHAT_STREAMING` is first in the
  // pool. `chat=open` is preserved so the overlay stays expanded across
  // the navigation on non-chat-notes host pages.
  await expect(page.locator('[data-testid="new-message-btn"]')).toHaveAttribute(
    "href",
    "?msgs=README%2CAA_CHAT_STREAMING&chat=open",
  )
  await page.locator('[data-testid="new-message-btn"]').click()

  // The click updates the overlay frame's URL, not the window URL —
  // the frame keeps its state out of the window URL by design. The
  // fact that AA_CHAT_STREAMING's message element appears (and its
  // body starts emitting chunks) is the observable proof that the
  // frame URL took effect.
  await expect(page.locator('[data-testid="chat-msg-AA_CHAT_STREAMING"]')).toBeAttached({
    timeout: 5000,
  })
  await expect(
    page.locator('[data-testid="chat-body-AA_CHAT_STREAMING"] [data-chunk]').first(),
  ).toBeAttached({ timeout: 5000 })
})
