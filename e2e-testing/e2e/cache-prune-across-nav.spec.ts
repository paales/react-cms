import { test, expect, request } from "./fixtures"

/**
 * With `keepalive: true` (the default on every spec), partials that
 * leave the current route are NOT pruned from `_currentPagePartials` —
 * they're parked under `<Activity mode="hidden">` and continue to
 * appear in the `?cached=` query string on subsequent refetches. The
 * server emits an `<Activity mode="hidden">{placeholder}</Activity>`
 * shell for any parked id whose fingerprint the client reports as
 * cached, and the client substitutes its cached subtree at the
 * placeholder position — so the React fiber tree stays shape-stable
 * across the route change and `useState` / `useRef` survive.
 *
 * This test pins that invariant by checking that ids rendered on a
 * prior route still show up in `?cached=` after a client-side nav,
 * which is the server's signal to keep emitting the parked shell.
 * Without keepalive (the previous behavior) those ids would be
 * pruned and the round-trip would lose state.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("client-side nav from /pokemon/1 to /defer-demo keeps parked ids in ?cached=", async ({
  page,
}) => {
  // Warm the cache on /pokemon/1 — partial ids include hero, stats,
  // species, trivia, plus search stages and dynamic price-XXX.
  await page.goto("/pokemon/1")
  await page.waitForSelector("header", { timeout: 10000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Client-side nav via the app-nav link. A hard `page.goto` would
  // drop the browser process entirely and clear module state (making
  // the keepalive pool moot); a same-document intercepted click
  // preserves the `_currentPagePartials` / `_currentPageFingerprints`
  // Maps, which is what we want to assert against.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Capture the RSC refetch URL when we activate the "manual" partial.
  // Match specifically on `partials=manual` — activators like WhenVisible
  // / WhenStored on other defer-demo sections can race into `_.rsc` on
  // slow parallel runs, and a generic `_.rsc` match would grab theirs.
  const rscRequest = page.waitForRequest(
    (req) =>
      req.url().includes("_.rsc") && new URL(req.url()).searchParams.get("partials") === "manual",
  )
  await page.locator('[data-testid="activate-manual"]').click()
  const req = await rscRequest

  const url = new URL(req.url())
  const cachedParam = url.searchParams.get("cached") ?? ""
  const cachedIds = cachedParam
    .split(",")
    .map((t) => t.split(":")[0])
    .filter(Boolean)

  // Parked ids from /pokemon/1 SHOULD still appear — keepalive defaults
  // to true, so the client keeps reporting them and the server can
  // fp-skip them when the user navigates back.
  for (const id of ["hero", "stats", "species", "trivia"]) {
    expect(cachedIds, `expected keepalive id "${id}" to be parked in ?cached=`).toContain(id)
  }

  // Current-page ids SHOULD be present too. `stored` and `any` are
  // unique to /defer-demo, and both sit inside `<body>` where they
  // register quickly. (`head` is intentionally NOT asserted here — it
  // lives directly under `<html>` and its `<PartialErrorBoundary>`
  // commits on a separate reconciliation tick from the body subtree;
  // the activate-manual click routinely wins that race, so the
  // assertion would be flaky.) `manual` is the refetch target and is
  // excluded from `?cached=` by design.
  expect(cachedIds).toContain("stored")
  expect(cachedIds).toContain("any")
  expect(cachedIds).not.toContain("manual")
})
