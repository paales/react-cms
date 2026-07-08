import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Degraded mode = document navigation. The channel is the whole
 * interactive transport, so a page whose transport is proven broken
 * stops intercepting: links become browser-native document loads (SSR
 * renders — a plain website). Two explicit degrade signals, each
 * pinned here:
 *
 *   1. never-acked — the connection established and deliveries
 *      committed, but the envelope carrying the FIRST ack can't reach
 *      the server (a blocked `/__parton/channel` POST path);
 *   2. establishment failure under an interaction — a navigation
 *      fired pre-establishment rides the attach it triggers, and that
 *      attach settles without ever establishing (a blocked
 *      `/__parton/live` path): the pending navigation completes as a
 *      document load carrying its target.
 *
 * The document-load signal is real, not inferred: a `window` marker
 * stamped before the click is GONE after the navigation (same-document
 * navs preserve the JS realm; only a document load resets it).
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("blocked channel POSTs degrade the page; links become document loads", async ({ page }) => {
  // The duplex breaks: envelopes never reach the server. The attach
  // (its own endpoint) still works — the connection establishes and
  // deliveries commit, but the first ack can never be said.
  await page.route("**/__parton/channel", (route) => route.abort("failed"))

  await page.goto("/selector-demo")
  await waitForPageInteractive(page)

  // The first committed delivery drives the first ack flush; its
  // envelope fails — sticky page degrade, stamped as the explicit
  // `data-parton-degraded` marker.
  await page.locator("html[data-parton-degraded]").waitFor({ state: "attached", timeout: 15000 })

  await page.evaluate(() => {
    ;(window as unknown as { __realmMarker?: number }).__realmMarker = 42
  })

  // The link is NOT intercepted — a browser-native document load
  // replaces the realm.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __realmMarker?: number }).__realmMarker),
      { timeout: 20000 },
    )
    .toBeUndefined()
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
  await expect(page.getByTestId("activate-manual")).toBeVisible({ timeout: 10000 })
})

test("an attach that never establishes under an interaction completes it as a document load", async ({
  page,
}) => {
  // The transport can never open: the attach endpoint is unreachable
  // (an ad-blocked `/__parton/*` path).
  await page.route("**/__parton/live", (route) => route.abort("failed"))

  await page.goto("/selector-demo")
  await waitForPageInteractive(page)
  await page.evaluate(() => {
    ;(window as unknown as { __realmMarker?: number }).__realmMarker = 42
  })

  // The click fires pre-establishment: the statement latches and rides
  // the attach it triggers; the attach settles without establishing —
  // the page degrades and the pending navigation completes as ONE
  // document load carrying its target.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __realmMarker?: number }).__realmMarker),
      { timeout: 20000 },
    )
    .toBeUndefined()
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
  await expect(page.getByTestId("activate-manual")).toBeVisible({ timeout: 10000 })
})
