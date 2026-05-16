import { test, expect } from "./fixtures"

/**
 * Regression guard: typing a single character in the search input must
 * fire exactly one RSC call (the stage dispatch). LoadMore's
 * IntersectionObserver is geometrically still "intersecting" the viewport
 * while the search <dialog> is open on top of it — dialog `inert` /
 * occlusion doesn't affect IntersectionObserver. Without the guard in
 * load-more.tsx, LoadMore races with the keystroke and produces a second
 * RSC call for page-N + load-more.
 */
test("single keystroke in search dispatches exactly one RSC call", async ({ page }) => {
  const rscCalls: Array<{
    url: string
    partials: string | null
    tags: string | null
    time: number
  }> = []
  const t0 = Date.now()
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) {
      const u = new URL(url)
      rscCalls.push({
        url,
        partials: u.searchParams.get("partials"),
        tags: u.searchParams.get("tags"),
        time: Date.now() - t0,
      })
    }
  })

  // 1. Load with search open (empty query) — only stage-1 renders initially.
  //    Match the user's observed scenario: first-keystroke types 'p' before
  //    LoadMore's IntersectionObserver has finished its self-propagating
  //    firings on the underlying product list.
  await page.goto("/?search=url")
  const input = page.locator("input[type=text]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Give hydration a beat so React event handlers are wired.
  await page.waitForTimeout(300)

  // 2. Reset the counter — observe only calls from the keystroke onward.
  rscCalls.length = 0

  // 3. Focus the input and type exactly one character.
  await input.focus()
  await input.press("End")
  await input.press("p")

  // 4. Wait long enough for the stages refetch (stage-3 has 2s delay) and
  //    for any spurious LoadMore firings to round-trip.
  await page.waitForTimeout(3000)

  // Report what we saw (helps diagnose failures).
  console.log(`\n=== RSC calls during keystroke (${rscCalls.length}) ===`)
  for (const c of rscCalls) {
    console.log(`  [${c.time}ms] partials=${c.partials} tags=${c.tags} url=${c.url}`)
  }

  // Stages-only refetch is the ONE expected call. Server receives
  // `?partials=search-results`; the ids resolve server-side against
  // the route registry by label.
  const stageCalls = rscCalls.filter((c) => c.partials === "search-results")
  const otherCalls = rscCalls.filter((c) => c.partials !== "search-results")

  expect(stageCalls.length, "expected exactly one RSC call dispatching the search stages").toBe(1)
  expect(
    otherCalls,
    `expected no unrelated RSC calls; got: ${JSON.stringify(otherCalls)}`,
  ).toHaveLength(0)
})
