import { clearCaches, test, expect, request, waitForPageInteractive } from "./fixtures"

/**
 * Regression guards for pressing Escape (close) while a search refetch
 * is in flight. Two DISTINCT, separately-reproduced bugs:
 *
 *  1. Broken toggle — the stale in-flight `.search-results` fetch was
 *     built while `?search` was on the URL, so its whole-root payload
 *     renders the header in the OPEN state (`<SearchToggle urlOpen>` →
 *     "Close"). When that stale payload commits AFTER the close
 *     navigation, the header shows "Close" with no overlay — a stuck
 *     state that only a refresh clears. Made deterministic here by
 *     holding the search fetch open at the network layer, committing
 *     the close, then releasing the stale fetch.
 *
 *  2. `BodyStreamBuffer was aborted` — the live-update heartbeat holds
 *     a `?streaming=1` connection open and aborts it on every
 *     navigation (`live-page-heartbeat.tsx`). When Escape navigates
 *     while that stream is mid-read, the abort tears the partially-
 *     committed tree and a Suspense boundary throws into the error
 *     boundary ("failed to render"). Heartbeat-gated and timing-
 *     sensitive; forced here by driving repeated escape-during-fetch
 *     with the heartbeat live.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("a held stale search fetch must not re-open the header toggle after close", async ({
  page,
}) => {
  // Pin the DISCRETE transport: this guard is the pageUrlKey
  // stale-commit twin on the GET path, and the network-layer hold
  // below can only park a discrete request. An attached page would
  // state the refetch on the channel — where the equivalent
  // protection is the as-of drop, covered by the framework's channel
  // suites — and the route handler would never engage.
  await page.addInitScript(() => {
    ;(window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled = true
  })
  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Text input is not covered by discrete-event replay — wait for the
  // interactive marker so the input's onChange pipeline is live.
  await waitForPageInteractive(page)

  // Hold the `q=pika` search-results refetch open at the network layer.
  let releaseStale!: () => void
  const released = new Promise<void>((r) => (releaseStale = r))
  let held = false
  let onHeld!: () => void
  const heldP = new Promise<void>((r) => (onHeld = r))
  await page.route(/_\.rsc\?.*partials=search-results/, async (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get("q") === "pika" && !held) {
      held = true
      onHeld()
      await released
    }
    await route.continue()
  })

  await input.focus()
  await input.fill("pika") // fires the (held) q=pika refetch
  await heldP // refetch is parked in the route handler

  // Close while the stale refetch is held.
  await page.keyboard.press("Escape")
  await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 5000 })

  // Release the stale response — its whole-root commit lands AFTER close.
  releaseStale()
  await page.waitForTimeout(2500)

  // The header must reflect the CLOSED url. The bug: the stale
  // whole-root commit (built while `?search` was present) re-renders
  // the header in the open state, leaving the "Close" button with no
  // overlay — the stuck state that only a refresh clears. Assert the
  // header toggle FIRST (bounded timeout so the red is fast, not a 30s
  // default-timeout hang) — its absence is the headline symptom.
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
  // Heartbeat live (default). Type to start a search refetch, then
  // Escape while it (and the heartbeat's `?streaming=1` stream) is
  // mid-flight. The close navigation must not abort a stream mid-read
  // and tear the partially-committed tree — the splitter aborts only at
  // a segment boundary, so nothing throws into the error boundary.
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
