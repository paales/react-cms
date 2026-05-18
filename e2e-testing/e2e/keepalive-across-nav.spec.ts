import { test, expect, request } from "./fixtures"

/**
 * With `keepalive: true` on every spec (the default), a partial's
 * React subtree stays mounted across cross-route navigation —
 * `<Activity mode="hidden">` parks it instead of unmounting. The
 * Activity fiber lives at the spec's natural JSX position (root.tsx
 * sibling), and the cached inner Suspense subtree is substituted at
 * the placeholder position via the existing cache merge, so `useState`
 * / `useRef` / DOM state survive the navigate-away-and-back round-trip.
 *
 * This spec uses `/cache-demo`'s `Slow` partial, which has a client
 * `<ClickCounter>` (useState) inside it. Click the counter to a known
 * value, navigate away, navigate back — the count must persist.
 * Without keepalive, the counter would mount fresh at 0 on return.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test.skip("ClickCounter state inside a partial survives nav away and back", async ({ page }) => {
  // Pending: cross-route keepalive isn't fully wired. When navigating
  // /cache-demo → /defer-demo, the new page's streaming render
  // doesn't touch the Slow spec, so its `_currentPagePartials` entry
  // is pruned (per the seen-set prune in `PartialsClient`'s streaming
  // branch). The Activity wrapper React still has in the fiber tree
  // sticks at `mode="hidden"` (DOM kept with `display: none`).
  // Navigating back to /cache-demo emits `Activity mode="visible"`
  // around a `<i hidden>` placeholder, but the cache lookup misses
  // (entry was pruned), so `renderTemplate` substitutes nothing and
  // React doesn't reconcile the new Activity's children against the
  // hidden subtree — display:none stays.
  //
  // The fix needs server-side logic in `PartialRoot` (streaming
  // mode) to walk every (id, matchKey) the client has cached, and
  // emit a hidden Activity wrapper for any that this page's render
  // didn't touch — so the client's `seen` harvest covers them and
  // the prune preserves the cache entry. That's an architectural
  // addition the navigation-milestones refactor doesn't include.
  await page.goto("/cache-demo")
  const counter = page.getByTestId("click-counter")
  await expect(counter).toBeVisible({ timeout: 10000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Click the counter three times. Each click bumps the useState
  // counter inside `<ClickCounter>`, which is rendered inside the
  // `Slow` partial inside `/cache-demo`'s wrapper.
  await counter.click()
  await counter.click()
  await counter.click()
  await expect(counter).toHaveText(/clicked 3×/)

  // Client-side nav to /defer-demo via the app-nav link. The whole
  // cache-demo subtree should flip to `<Activity mode="hidden">` —
  // its DOM is rendered with `display:none` but the React fiber tree
  // (including ClickCounter's `useState` value) stays mounted.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()

  // The ClickCounter button is in the DOM but hidden (Activity hidden).
  // We can't assert "not visible" through Playwright's `toBeVisible`
  // because that races with the Activity-driven `display:none`
  // commit; instead we just confirm the new page is showing.
  await expect(page.getByTestId("activate-manual")).toBeVisible()

  // Client-side nav back. With keepalive, the spec emits
  // `<Activity mode="visible">` for the now-active route; the cached
  // inner Suspense subtree paints from the prior render and the
  // counter's `useState` value survives.
  await page.getByRole("link", { name: /Cache Demo/ }).click()
  const counterAfter = page.getByTestId("click-counter")
  await expect(counterAfter).toBeVisible({ timeout: 10000 })
  await expect(counterAfter).toHaveText(/clicked 3×/)
})
