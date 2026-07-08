import { expect, test } from "@playwright/test"

/**
 * Sync-content guard for `yarn build && yarn preview`.
 *
 * The framework's CMS read surface (`cms.text()`, `cms.enum()`, …) is
 * synchronous and `entry.rsc.tsx` awaits `warmCmsCache()` before any
 * spec renders, so every CMS-driven block should land in the SSR HTML
 * fully resolved — no Suspense fallback, no streaming hole, no
 * "content arrives only via the FLIGHT_DATA inline script".
 *
 * Empirically that's NOT what `yarn build && yarn preview` does today.
 * On a freshly-booted preview server the first GET to `/cms-demo`
 * returns ~74 KB of HTML with the hero, greeting, composed slots, and
 * product grid all inlined. EVERY subsequent GET — same URL, different
 * URL under the same registered pattern, even cross-route navigations —
 * comes back at ~60 KB with the layout shell + nav only; the entire
 * CMS-driven body is absent from the HTML and lives only inside the
 * `(self.__FLIGHT_DATA||=[]).push(...)` script. The browser fills in
 * the gap on hydration, but that's exactly the "content became async"
 * regression we want to catch.
 *
 * Root cause sketch (for whoever picks this up): `PartialsClient` in
 * `framework/src/lib/partial-client.tsx` keeps `_template`,
 * `_currentPagePartials`, `_currentPageFingerprints` as MODULE-level
 * state. That's intentional for the browser session, but the same
 * module is loaded once per server process and re-evaluated during
 * SSR for every request. Request 1 populates `_template`; request 2
 * sees the cached template, runs `renderTemplate(_template, cache)`
 * against children that no longer carry the inlined wrappers, and
 * the SSR HTML loses the rendered subtree. In dev the
 * `x-test-scope` header threads each Playwright worker into its own
 * registry/cache bucket (see `deriveScope` in
 * `framework/src/runtime/context.ts`); that branch is gated on
 * `import.meta.env.DEV` so preview gets one shared bucket.
 *
 * This test is intentionally STRICT: it asserts on the rendered
 * `<h1>` element by data-testid attribute, not on the substring
 * "Welcome to the CMS demo" — that substring also appears inside the
 * FLIGHT_DATA payload as `\"children\":\"Welcome to the CMS demo\"`,
 * so a `body.toContain(...)` check would pass on a broken response
 * and silently mask the regression. Likewise the test runs serially
 * (`workers: 1`) and against a single URL — racing parallel workers
 * for a "first hit" wins is exactly the flake we don't want.
 */

test.describe.configure({ mode: "serial" })

test("hero text rendered in SSR HTML on /cms-demo (sync)", async ({ request }) => {
  const response = await request.get("/cms-demo")
  expect(response.status()).toBe(200)
  const body = await response.text()

  // The CMS-resolved hero comes through `<PageHeroBlock>` in
  // `e2e-testing/src/app/blocks/page-hero.tsx`. The headline lives
  // on `<h1 data-testid="cms-demo-hero-headline">` and the subhead
  // on the next `<p>`. Both must appear as inline SSR HTML, not as
  // FLIGHT_DATA-only content. The `[^<]*` clamp prevents the regex
  // from straddling other tags.
  expect(body, "hero <h1> missing from SSR HTML — content shipped only via FLIGHT_DATA").toMatch(
    /data-testid="cms-demo-hero-headline"[^>]*>[^<]*Welcome to the CMS demo</,
  )

  expect(body, "hero subhead missing from SSR HTML").toMatch(
    /<p[^>]*>Every field on this page is read through accessor-tracked calls\./,
  )

  // Nav links are also CMS-driven (`<NavLinkBlock>` reads
  // `cms.text("label")`). They render fine on the first hit AND on
  // subsequent hits in current behavior — the regression doesn't
  // affect partials defined directly under `<Root>`'s body. Asserting
  // on at least one nav label here keeps the test honest about which
  // surface area is sync (layout) vs which has gone async (the
  // CMS-demo body).
  expect(body, "Pokemon nav label missing from SSR HTML").toContain(">Pokemon</a>")

  // No suspended boundaries. React's SSR streamer would emit
  // `<!--$?-->` for an unresolved Suspense boundary or
  // `<template id="B:...">` rows for late chunks; either presence
  // means content was deferred.
  expect(body, "unexpected suspense fallback marker").not.toContain("<!--$?-->")
  expect(body, "unexpected suspense template chunk").not.toContain('<template id="B:')
})
