import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Regression guards for pressing Escape (close) while a search refetch
 * is in flight. Two DISTINCT stale-commit hazards:
 *
 *  1. Broken toggle — an in-flight `.search-results` statement's
 *     covering render was built while `?search` was on the URL, so its
 *     whole-tree segment renders the header in the OPEN state
 *     (`<SearchToggle urlOpen>` → "Close"). If it committed AFTER the
 *     close navigation, the header would show "Close" with no overlay
 *     — a stuck state only a refresh clears. The as-of guard is the
 *     protection: the close's navigation point makes the older
 *     segment's delivery droppable, and the covering segment is the
 *     closed URL's render.
 *
 *  2. Torn streams — the held connection is aborted/superseded around
 *     navigations. A close mid-stream must never tear the partially-
 *     committed tree ("BodyStreamBuffer was aborted" / a Suspense
 *     boundary throwing into the error boundary).
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("a stale in-flight search statement must not re-open the header toggle after close", async ({
  page,
}) => {
  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Text input is not covered by discrete-event replay — wait for the
  // interactive marker so the input's onChange pipeline is live.
  await waitForPageInteractive(page)

  // Fire the q=pika statement, then close IMMEDIATELY — the close's
  // navigation point makes the in-flight statement's render (built
  // while `?search` was present) droppable by as-of.
  await input.focus()
  await input.fill("pika")
  await page.keyboard.press("Escape")
  await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 5000 })

  // Let the superseded render's delivery (if any) drain and the
  // covering close segment settle.
  await page.waitForTimeout(2500)

  // The header must reflect the CLOSED url. The bug shape: a stale
  // whole-tree commit re-renders the header in the open state, leaving
  // the "Close" button with no overlay — the stuck state that only a
  // refresh clears. Assert the header toggle FIRST (bounded timeout so
  // the red is fast) — its absence is the headline symptom.
  await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0, {
    timeout: 5000,
  })
  await expect(page.getByRole("button", { name: "Search (URL)" })).toBeVisible({
    timeout: 5000,
  })
  await expect(page.locator("dialog[open]")).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has("search")).toBe(false)
})

test("escape during fetch never tears the page into an error boundary", async ({ page }) => {
  // Type to start a search refetch, then Escape while its covering
  // render is mid-flight on the held stream. The close must not tear
  // the partially-committed tree — the splitter aborts only at a
  // segment boundary and superseded renders close without committing
  // — so nothing throws into the error boundary.
  const cardErrors: string[] = []
  const consoleAborts: string[] = []
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (t.includes("BodyStreamBuffer") || t.includes("AbortError"))
      consoleAborts.push(t.slice(0, 120))
  })

  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Text input is not covered by discrete-event replay — wait for the
  // interactive marker so the input's onChange pipeline is live.
  await waitForPageInteractive(page)

  await input.focus()
  await input.pressSequentially("pika", { delay: 25 })
  await page.waitForTimeout(400) // stage-2/3 (1s/2s) still pending in flight
  await page.keyboard.press("Escape")
  await page.waitForTimeout(2500) // let the (un-torn) stream drain + settle

  const cardCount = await page.locator("text=/failed to render/").count()
  if (cardCount > 0) {
    const pre = (
      await page
        .locator("pre")
        .allInnerTexts()
        .catch(() => [])
    ).join(" | ")
    cardErrors.push(pre.slice(0, 160))
  }

  expect(
    cardErrors,
    `escape-during-fetch tore a partial into the error boundary: ${JSON.stringify(cardErrors)}`,
  ).toHaveLength(0)
  expect(
    consoleAborts,
    `escape-during-fetch surfaced an AbortError to the console: ${JSON.stringify(consoleAborts)}`,
  ).toHaveLength(0)
})
