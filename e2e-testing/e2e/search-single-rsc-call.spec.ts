import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Regression guard: typing a single character in the search input must
 * dispatch exactly one stages refetch. LoadMore's IntersectionObserver
 * is geometrically still "intersecting" the viewport while the search
 * <dialog> is open on top of it — dialog `inert` / occlusion doesn't
 * affect IntersectionObserver. Without the guard in load-more.tsx,
 * LoadMore races with the keystroke and produces a second dispatch for
 * page-N + load-more.
 *
 * Two transports carry a refetch: attached to the live channel, the
 * batch rides a `url` frame on a `/__parton/channel` envelope (the
 * page URL with the `?__force=` overlay); pre-attach it is a discrete
 * `_.rsc` GET with `?partials=`. The keystroke races establishment, so
 * the guard counts dispatches across BOTH and expects exactly one.
 */
test("single keystroke in search dispatches exactly one RSC call", async ({ page }) => {
  const rscCalls: Array<{
    url: string
    partials: string | null
    tags: string | null
    time: number
  }> = []
  const urlStatements: Array<{ url: string; partials: string | null; time: number }> = []
  const t0 = Date.now()
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) {
      const u = new URL(url)
      // The heartbeat's live attach POST is transport, not a dispatch.
      if (u.searchParams.get("live") === "1") return
      rscCalls.push({
        url,
        partials: u.searchParams.get("partials"),
        tags: u.searchParams.get("tags"),
        time: Date.now() - t0,
      })
      return
    }
    if (url.includes("/__parton/channel")) {
      try {
        const envelope = JSON.parse(req.postData() ?? "") as {
          frames?: Array<{ kind: string; url?: string }>
        }
        for (const frame of envelope.frames ?? []) {
          if (frame.kind !== "url" || !frame.url) continue
          const stated = new URL(frame.url, "http://localhost")
          urlStatements.push({
            url: frame.url,
            partials: stated.searchParams.get("__force"),
            time: Date.now() - t0,
          })
        }
      } catch {}
    }
  })

  // 1. Load with search open (empty query) — only stage-1 renders initially.
  //    Match the user's observed scenario: first-keystroke types 'p' before
  //    LoadMore's IntersectionObserver has finished its self-propagating
  //    firings on the underlying product list.
  await page.goto("/?search=url")
  const input = page.locator("input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Wait for the interactive marker so the input's onChange pipeline
  // is wired — a keystroke fired earlier is silently lost (text input
  // is not covered by React's discrete-event replay).
  await waitForPageInteractive(page)

  // 2. Reset the counters — observe only dispatches from the keystroke
  //    onward.
  rscCalls.length = 0
  urlStatements.length = 0

  // 3. Focus the input and type exactly one character.
  await input.focus()
  await input.press("End")
  await input.press("p")

  // 4. Wait long enough for the stages refetch (stage-3 has 2s delay) and
  //    for any spurious LoadMore firings to round-trip.
  await page.waitForTimeout(3000)

  // Report what we saw (helps diagnose failures).
  console.log(`\n=== dispatches during keystroke (rsc=${rscCalls.length}, channel=${urlStatements.length}) ===`)
  for (const c of rscCalls) {
    console.log(`  [${c.time}ms] rsc partials=${c.partials} tags=${c.tags} url=${c.url}`)
  }
  for (const s of urlStatements) {
    console.log(`  [${s.time}ms] channel partials=${s.partials} url=${s.url}`)
  }

  // The stages refetch is the ONE expected dispatch, on whichever
  // transport carried it. The server resolves `?partials=search-results`
  // against the route registry by label on both paths.
  const stageDispatches = [
    ...rscCalls.filter((c) => c.partials === "search-results"),
    ...urlStatements.filter((s) => s.partials === "search-results"),
  ]
  const otherDispatches = [
    ...rscCalls.filter((c) => c.partials !== "search-results"),
    ...urlStatements.filter((s) => s.partials !== null && s.partials !== "search-results"),
  ]

  expect(
    stageDispatches.length,
    "expected exactly one dispatch for the search stages",
  ).toBe(1)
  expect(
    otherDispatches,
    `expected no unrelated dispatches; got: ${JSON.stringify(otherDispatches)}`,
  ).toHaveLength(0)
})
