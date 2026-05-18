import { test, expect, request } from "./fixtures"

/**
 * End-to-end coverage for the /streaming-demo page — three live
 * proofs of the server primitives:
 *
 *  - `markConnectionLive` + segment loop  → live tick advances on
 *    the same HTTP response without client-side polling.
 *  - `getServerNavigation().reload({selector})` → click bumps the
 *    counter and the partial re-renders.
 *  - `getServerNavigation().navigate(url)` → click pushes a new
 *    `?seq=` into the URL bar without re-fetching.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

/**
 * Wait for the page's use-client subtree to hydrate. The
 * `LiveTickAutostart` useEffect stamps `data-streaming-demo-ready`
 * on `<body>` after it runs — once present, every other use-client
 * component on this page (BumpButton, PushUrlButton) also has its
 * onClick handler attached. Without this Playwright's `.click()`
 * can fire on the SSR-rendered DOM before React 19's `hydrateRoot`
 * installs its delegated root listener, and the click is a no-op
 * (React's event-replay queue only catches clicks fired AFTER
 * `hydrateRoot` ran, not before).
 */
async function waitForStreamingDemoReady(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("body[data-streaming-demo-ready]").waitFor({ timeout: 10000 })
}

test("live tick advances over time on one rolling response", async ({ page }) => {
  await page.goto("/streaming-demo")
  // The tick partial mounts; initial render shows tick #0 (or
  // whatever the scope state was at request time).
  await expect(page.locator('[data-testid="streaming-demo-tick"]')).toBeAttached({
    timeout: 10000,
  })

  // Sample the tick text every 200ms; assert the value advances.
  const seen = new Set<string>()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && seen.size < 3) {
    const text = await page.locator('[data-testid="streaming-demo-tick"]').textContent()
    if (text) {
      const match = text.match(/Tick #(\d+)/)
      if (match) seen.add(match[1])
    }
    await page.waitForTimeout(200)
  }
  // At least 2 distinct tick values within 5s — confirms the segment
  // loop is keeping the connection open and emitting new segments
  // as the server-side ticker fires.
  expect(seen.size).toBeGreaterThanOrEqual(2)
})

test("bump button calls getServerNavigation().reload + partial re-renders", async ({
  page,
}) => {
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 0", {
    timeout: 10000,
  })
  await waitForStreamingDemoReady(page)

  await page.locator('[data-testid="streaming-demo-bump-btn"]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 1", {
    timeout: 5000,
  })

  await page.locator('[data-testid="streaming-demo-bump-btn"]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 2", {
    timeout: 5000,
  })
})

test("push-URL button advances ?seq= via server-side navigate", async ({ page }) => {
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-push-btn"]')).toBeVisible({
    timeout: 10000,
  })
  await waitForStreamingDemoReady(page)

  // Before click: no ?seq= in the URL.
  expect(new URL(page.url()).searchParams.get("seq")).toBeNull()

  // The action calls `getServerNavigation().navigate("?seq=N")`. The
  // url-trailer is applied via `history.replaceState` on the client.
  // `seq` is module-scope on the server (advances across calls) so we
  // read the value from the URL after each click rather than asserting
  // exact numbers — what matters is that the URL changes and that each
  // click advances it.
  await page.locator('[data-testid="streaming-demo-push-btn"]').click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("seq"), { timeout: 5000 })
    .not.toBeNull()
  const first = Number(new URL(page.url()).searchParams.get("seq"))
  expect(first).toBeGreaterThan(0)

  await page.locator('[data-testid="streaming-demo-push-btn"]').click()
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("seq")), { timeout: 5000 })
    .toBe(first + 1)
})
