import { test, expect, request } from "./fixtures"

/**
 * `useNavigation().preload(target)` — hover-eager warm of a
 * destination's partials, the forward-looking counterpart to keepalive.
 * The nav links (`NavLinkActive`) fire `nav.preload(href)` on
 * pointer-enter: a read-only RSC GET whose response is walked into the
 * client cache WITHOUT committing — no navigation, no visible change,
 * nothing mounts. The actual click stays an ordinary nav that
 * revalidates against the server; it just starts warm, so the
 * destination's partials fp-skip and substitute from cache.
 *
 * This asserts the observable wire behaviour:
 *   1. hovering a link issues a preload GET to the destination, carrying
 *      `?cached=` and NOT `streaming=1` / `partials=` (so it's the
 *      warm-only path, not a heartbeat or a targeted refetch);
 *   2. the current page does NOT navigate while it warms;
 *   3. the subsequent click still navigates normally (no regression).
 *
 * The cache-population contract (warming advertises the id for fp-skip)
 * is unit-tested in `framework/src/lib/__tests__/preload-warm-cache.test.tsx`.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("hovering a nav link preloads its destination without navigating", async ({ page }) => {
  // Quiet the heartbeat so the only destination-bound RSC traffic is the
  // preload we trigger. (The heartbeat only ever polls the CURRENT url,
  // so it can't forge a /defer-demo hit — but this keeps the trace clean
  // and the "did not navigate" timing deterministic.)
  await page.addInitScript(() => {
    ;(window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled = true
  })

  const rscRequests: string[] = []
  page.on("request", (req) => {
    const u = req.url()
    if (u.includes("_.rsc")) rscRequests.push(u)
  })

  await page.goto("/cache-demo")
  await expect(page.getByTestId("click-counter")).toBeVisible({ timeout: 15000 })
  await page.waitForFunction(
    () => typeof (window as unknown as { __rsc_partial_preload?: unknown }).__rsc_partial_preload === "function",
    null,
    { timeout: 10000 },
  )

  // Only care about traffic triggered from here on.
  rscRequests.length = 0

  // Hover the Defer Demo link — pointer-enter fires `nav.preload(href)`.
  await page.getByRole("link", { name: /Defer Demo/ }).hover()

  // A warm-only preload GET to /defer-demo lands: it carries `?cached=`
  // (so the warm render fp-skips shared chrome) and is neither a
  // streaming heartbeat (`streaming=1`) nor a targeted refetch
  // (`partials=`).
  await expect
    .poll(
      () =>
        rscRequests.some((u) => {
          if (!u.includes("/defer-demo_.rsc")) return false
          const q = new URL(u).searchParams
          return q.has("cached") && !q.has("streaming") && !q.has("partials")
        }),
      { timeout: 10000 },
    )
    .toBe(true)

  // Warm-only: the preload must NOT navigate. Still on /cache-demo, with
  // its client state (the counter) untouched and the URL unchanged.
  await expect(page.getByTestId("click-counter")).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/cache-demo")

  // No regression: the click still navigates normally (now warm).
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.getByTestId("activate-manual")).toBeVisible({ timeout: 10000 })
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
})

test("clicking immediately after the hover-preload still navigates (no race)", async ({
  page,
}) => {
  // The race guard: a single `.click()` fires pointer-enter (→ preload)
  // then the click (→ nav) back-to-back, so the warm fetch is still in
  // flight when the navigation commits. The warm walk is per-partial
  // atomic, so the nav reading the cache concurrently never sees a torn
  // entry — the destination must paint normally, not stick on the prior
  // page. Regression guard for preload-in-flight-during-nav.
  await page.goto("/cache-demo")
  await expect(page.getByTestId("click-counter")).toBeVisible({ timeout: 15000 })
  await page.waitForFunction(
    () => typeof (window as unknown as { __rsc_partial_preload?: unknown }).__rsc_partial_preload === "function",
    null,
    { timeout: 10000 },
  )

  // No prior hover / poll — the preload has no head start, so it's
  // genuinely mid-flight at nav time.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.getByTestId("activate-manual")).toBeVisible({ timeout: 10000 })
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
})
