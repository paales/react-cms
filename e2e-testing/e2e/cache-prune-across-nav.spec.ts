import { clearCaches, test, expect, recordPartialDispatches, waitForPageInteractive } from "./fixtures"

/**
 * With `keepalive: true` (the default on every spec), partials that
 * leave the current route are NOT pruned from `_currentPagePartials` —
 * they're parked under `<Activity mode="hidden">` and keep their
 * fibers, and the client's manifest (the attach statement's `cached`,
 * maintained by the connection's mirror) keeps advertising them so
 * the server emits the parked shell on every covering render. This
 * test pins the client half of that invariant: after a same-document
 * nav, the prior route's addressable partons are still mounted
 * (hidden) in the DOM — the round-trip that would lose `useState` /
 * `useRef` never happens — and a defer activation on the new route
 * dispatches cleanly against the parked world.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("client-side nav from /pokemon/1 to /defer-demo keeps prior-route partons parked", async ({
  page,
}) => {
  const dispatches = recordPartialDispatches(page)
  // Warm the client on /pokemon/1 — partial ids include hero, stats,
  // species, trivia, plus search stages and dynamic price-XXX.
  await page.goto("/pokemon/1")
  await page.waitForSelector("header", { timeout: 10000 })
  await waitForPageInteractive(page)

  // Client-side nav via the app-nav link. A hard `page.goto` would
  // drop the browser process entirely and clear module state (making
  // the keepalive pool moot); a same-document intercepted click
  // preserves the parked fibers, which is what we assert against.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
  await waitForPageInteractive(page)

  // The prior route's addressable partons are PARKED, not pruned:
  // their subtrees are still in the DOM under hidden Activity slots
  // (the detail page's hero heading — its match missed, so its
  // variant parked).
  const parkedHero = page.locator("h1.capitalize", { hasText: /bulbasaur/i })
  await expect(
    parkedHero,
    "expected the prior route's hero to stay parked in the DOM",
  ).toBeAttached()
  await expect(parkedHero).toBeHidden()

  // A defer activation on the new route dispatches for exactly its
  // own target (on whichever carrier is up), against the parked world.
  await page.locator('[data-testid="activate-manual"]').click()
  await expect(page.locator('[data-testid="manual-fallback"]')).toHaveCount(0)
  const manualDispatches = dispatches.filter(
    (d) => d.partials != null && d.partials.split(",").includes("manual"),
  )
  expect(manualDispatches.length).toBeGreaterThanOrEqual(1)
})
