/**
 * Stress tests for the client-side `_cache` / `_fingerprints` prune
 * logic in `<PartialsClient>` during streaming-mode navigation.
 *
 * The prune set expands transitively through cached wrappers: for
 * every id seen on the new tree (fresh wrapper OR placeholder),
 * harvest the nested partial ids from its cache entry, and keep
 * harvesting until no new ids appear. Without that, a server fp-skip
 * of an OUTER partial would leave the prune set seeing only top-
 * level ids, and every NESTED partial's cache entry would be deleted
 * out from under the next render's `substituteNested` walk —
 * surfacing as vanished test blocks on multi-step navigation
 * ("alpha → beta → gamma blanks the slug nav", "/cms-edit frame nav
 * loses the field form"). These tests pin the expansion behaviour so
 * any regression that breaks it shows up here first.
 */
import { expect, test, request as apiRequest, waitForRscIdle } from "./fixtures.ts"

// All blocks that should be visible on /cms-demo and /cms-demo/:slug.
// If a partial cache entry gets pruned mid-nav, one of these blanks
// out. Each entry is a UNIQUE testid (no duplicates) so a missing
// one is unambiguous.
const ALL_BLOCK_TESTIDS = [
  "cms-demo-slug-nav-block",
  "cms-demo-hero",
  "cms-demo-hero-headline",
  "cms-demo-greeting",
  "cms-demo-greeting-headline",
  "cms-demo-greeting-body",
  "cms-demo-composed-section",
  "cms-demo-multi-slot-section",
  "cms-demo-multi-slot-body",
  "cms-demo-multi-slot-sidebar",
  "group-block",
]

async function expectAllBlocks(page: import("./fixtures.ts").Page): Promise<void> {
  for (const tid of ALL_BLOCK_TESTIDS) {
    await expect(
      page.getByTestId(tid),
      `expected ${tid} to be visible after navigation`,
    ).toBeVisible()
  }
  // 3 product cards in the group.
  await expect(page.getByTestId("product-card")).toHaveCount(3)
}

test.beforeEach(async ({ baseURL }) => {
  // Each worker gets a clean partial registry / cache snapshot so
  // residue from earlier specs in the same worker can't influence
  // assertions about the prune.
  const ctx = await apiRequest.newContext({ baseURL })
  await ctx.get("/__test/clear-caches")
  await ctx.dispose()
})

async function clickSlug(
  page: import("./fixtures.ts").Page,
  slug: "alpha" | "beta" | "gamma" | "zulu" | "Default (no slug)",
): Promise<void> {
  // Slug-nav anchors don't all use the bare slug name — the
  // unmatched-fallback link reads "zulu (unmatched)" and the default
  // reads "Default (no slug)". Map each slug to its visible label.
  const labelRe: Record<typeof slug, RegExp> = {
    alpha: /^alpha$/,
    beta: /^beta$/,
    gamma: /^gamma$/,
    zulu: /^zulu \(unmatched\)$/,
    "Default (no slug)": /^Default \(no slug\)$/,
  } as const
  await page.getByRole("link", { name: labelRe[slug] }).click()
}

test("alpha → beta → gamma keeps every block (fp-skipped outer regression)", async ({ page }) => {
  await page.goto("/cms-demo")
  await waitForRscIdle(page)
  await expectAllBlocks(page)

  await clickSlug(page, "alpha")
  await expect(page).toHaveURL(/\/cms-demo\/alpha/)
  await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Hello, Alpha!")
  await expectAllBlocks(page)

  // beta and gamma both match {in: ["beta","gamma"]} → identical
  // greeting fields → identical cms-demo-root recursive contribution
  // → server fp-skips the OUTER partial. This is the path that broke
  // when the prune walked only top-level placeholders.
  await clickSlug(page, "beta")
  await expect(page).toHaveURL(/\/cms-demo\/beta/)
  await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Beta/Gamma view")
  await expectAllBlocks(page)

  await clickSlug(page, "gamma")
  await expect(page).toHaveURL(/\/cms-demo\/gamma/)
  await expect(page.getByTestId("cms-demo-greeting-headline")).toHaveText("Beta/Gamma view")
  await expectAllBlocks(page)
})

test("long sequential nav cycle keeps every block at every step", async ({ page }) => {
  await page.goto("/cms-demo")
  await waitForRscIdle(page)
  await expectAllBlocks(page)

  const sequence = [
    "alpha",
    "beta",
    "gamma",
    "zulu",
    "Default (no slug)",
    "alpha",
    "Default (no slug)",
    "gamma",
    "beta",
    "alpha",
  ] as const

  for (const slug of sequence) {
    await clickSlug(page, slug)
    // Don't wait for networkidle — the bug surfaces between
    // network arrival and the next render. Auto-retrying
    // expectAllBlocks handles transient invisibility while React
    // settles.
    await expectAllBlocks(page)
  }
})

test("browser back/forward through history keeps every block", async ({ page }) => {
  await page.goto("/cms-demo")
  await waitForRscIdle(page)
  await clickSlug(page, "alpha")
  await clickSlug(page, "beta")
  await clickSlug(page, "gamma")
  await expectAllBlocks(page)

  await page.goBack()
  await expect(page).toHaveURL(/\/cms-demo\/beta/)
  await expectAllBlocks(page)

  await page.goBack()
  await expect(page).toHaveURL(/\/cms-demo\/alpha/)
  await expectAllBlocks(page)

  await page.goBack()
  await expect(page).toHaveURL(/\/cms-demo$/)
  await expectAllBlocks(page)

  await page.goForward()
  await expect(page).toHaveURL(/\/cms-demo\/alpha/)
  await expectAllBlocks(page)

  await page.goForward()
  await expect(page).toHaveURL(/\/cms-demo\/beta/)
  await expectAllBlocks(page)

  await page.goForward()
  await expect(page).toHaveURL(/\/cms-demo\/gamma/)
  await expectAllBlocks(page)
})

test("mixing app-level cross-page nav with cms-demo nav keeps cms-demo intact", async ({
  page,
}) => {
  // Visit other pages first to populate stale partials in `_cache`,
  // then come to cms-demo. The prune step should drop the stale
  // ids; nothing on cms-demo should be missing because of leftover
  // entries from prior routes.
  await page.goto("/cache-demo")
  await waitForRscIdle(page)
  await page.getByRole("link", { name: /CMS Demo/ }).click()
  await expect(page).toHaveURL(/\/cms-demo$/)
  await expectAllBlocks(page)

  await clickSlug(page, "alpha")
  await expectAllBlocks(page)

  // Navigate AWAY then back — `_cache` should re-warm.
  await page.getByRole("link", { name: /Cache Demo/ }).click()
  await expect(page).toHaveURL(/\/cache-demo/)

  await page.getByRole("link", { name: /CMS Demo/ }).click()
  await expect(page).toHaveURL(/\/cms-demo$/)
  await expectAllBlocks(page)
})

test("rapid multi-click survives — last URL wins, blocks all present", async ({ page }) => {
  await page.goto("/cms-demo")
  await waitForRscIdle(page)

  // Fire alpha + beta + gamma clicks back-to-back without awaiting.
  // The Navigation API will commit them in order; we assert the
  // last commits cleanly and every block is present.
  await Promise.all([page.getByRole("link", { name: /^alpha$/ }).click()])
  await Promise.all([page.getByRole("link", { name: /^beta$/ }).click()])
  await Promise.all([page.getByRole("link", { name: /^gamma$/ }).click()])

  await expect(page).toHaveURL(/\/cms-demo\/gamma/)
  await expectAllBlocks(page)
})

test("editor preview nav preserves tree + field-form across slug switches", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "__editor", value: "1", url: baseURL! }])
  await page.goto("/cms-demo")
  await waitForRscIdle(page)

  // Select a node — sidebar URL becomes ?select=... and the field
  // form for cms-demo-greeting renders on the right.
  await page.getByTestId("cms-edit-tree-entry-cms-demo-greeting").click()
  await expect(page).toHaveURL(/select=cms-demo-greeting/)
  await expect(page.getByTestId("cms-edit-field-input-headline")).toBeVisible()

  // Cross-slug nav through alpha → beta → gamma. The tree + field
  // panel must stay visible at every step — prune expansion keeps
  // their cache entries alive when an outer partial fp-skips, so the
  // right pane stays painted and tree clicks keep working. URL nav
  // preserves `?select=…`, so selection is still greeting at every
  // step. There's no editor address-bar input; we drive the same
  // nav-preserves-state surface with `page.goto`.
  for (const path of ["/cms-demo/alpha", "/cms-demo/beta", "/cms-demo/gamma"]) {
    await page.goto(`${path}?select=cms-demo-greeting`)
    await expect(page.getByTestId("cms-edit-field-input-headline")).toBeVisible()
    await expect(page.getByTestId("cms-edit-selected-id")).toContainText(/greeting/i)
    // Tree entries still clickable after every nav.
    const heroEntry = page.getByTestId("cms-edit-tree-entry-cms-demo-hero")
    await expect(heroEntry).toBeVisible()
  }

  // Selection still on greeting AFTER all preview navs.
  await expect(page.getByTestId("cms-edit-tree-entry-cms-demo-greeting")).toHaveAttribute(
    "data-selected",
    "true",
  )

  // Switch selection — clicks still fire selector-targeted refetches.
  await page.getByTestId("cms-edit-tree-entry-cms-demo-hero").click()
  await expect(page).toHaveURL(/select=cms-demo-hero/)
  await expect(page.getByTestId("cms-edit-selected-id")).toContainText(/hero/i)
})
