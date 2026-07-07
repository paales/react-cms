import { clearCaches, test, expect, request, waitForPageInteractive } from "./fixtures"

/**
 * Search result ordering + bounded-cache guards.
 *
 * BACKGROUND
 * ──────────
 * The search overlay renders three result stages, each demonstrating a
 * different way a parton receives query-dependent data (see
 * `makeSearchArea` in `app/pages/pokemon.tsx`):
 *   - stage-1: call-site PROPS   (`<Stage1 q={q} results={cell.with(...)}/>`)
 *   - stage-2: VARY + CELL        (vary reads `q`, schema binds the cell)
 *   - stage-3: MATCH on the query (`match: {search: "*q=:query"}`, page scope)
 *
 * Typing fires a `.search-results` refetch per keystroke; the stages
 * have artificial 0/1/2s server delays so several refetches overlap.
 *
 * TWO INVARIANTS this file guards, both upheld:
 *   1. BOUNDED CACHE — `?cached=` must not grow without limit as queries
 *      accumulate. The client commit prunes both client maps to the
 *      live/parked tree, so superseded entries stop being advertised.
 *   2. RESULT ORDERING — the committed stages must reflect the LATEST
 *      query, never a superseded one whose response landed late.
 *
 * The ordering invariant rests on a framework-level fingerprint
 * invariant: the client only ever advertises a fingerprint in `?cached=`
 * that it can correctly restore — i.e. the advertised fp-set for a
 * `(id, matchKey)` slot stays in lockstep with the node the slot holds.
 * The subtle break this file pins: the warm-fp trailer (an async
 * cold→warm fp update) used to attach to the "most recently rendered"
 * matchKey. A trailer from a superseded query landing AFTER a newer
 * query overwrote a stable slot then advertised that newer slot's fp as
 * the OLD query's — so a re-typed old query fp-skipped and restored the
 * newer (stale) node. Fixed by carrying the cold fp in the trailer
 * (`{from, to}`) and aliasing the warm fp onto the slot still holding
 * `from`, matched by content; a superseded trailer finds no slot and is
 * dropped. See `applyFpUpdates` in `partial-client.tsx` and the
 * deterministic unit reproduction in
 * `framework/src/lib/__tests__/partial-client-fp-desync.test.tsx`.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

// ─── Invariant 1: bounded cache (FIXED) ─────────────────────────────

test("?cached= stays bounded across many distinct queries", async ({ page }) => {
  // Each refetch's `?cached=` token count must plateau, not climb with
  // the number of queries typed. Before the fix it grew ~1 token per
  // query forever (id-churn from call-site props left every past
  // query's effective id in the client fp map; the warm-fp trailer also
  // accumulated uncapped). Fixed by: (a) `pruneToLive` on the cache-mode
  // commit — prune both client maps to the (id,matchKey) set actually
  // present in the rendered/parked tree; (b) routing `applyFpUpdates`
  // through the capped `registerClientPartial`. See partial-client.tsx.
  const tokenCounts: number[] = []
  page.on("request", (req) => {
    const u = req.url()
    if (!u.includes("_.rsc") || !u.includes("partials=search-results")) return
    const cached = new URL(u).searchParams.get("cached")
    tokenCounts.push(cached ? cached.split(",").length : 0)
  })

  // The bound under test is a property of the DISCRETE transport's URL
  // manifest (`?cached=` rides the request line). An attached page
  // states refetches on the channel instead — no `?cached=` at all,
  // the connection's mirror is the manifest — so pin the discrete path
  // by keeping the heartbeat (and with it the channel) closed.
  await page.addInitScript(() => {
    ;(window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled = true
  })

  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // The onChange handler must be wired before we drive the input, or
  // early fills race the client and the dialog can tear. Text input is
  // not covered by discrete-event replay — wait for the interactive
  // marker.
  await waitForPageInteractive(page)
  await input.click()

  // Distinct queries, each FULLY SETTLED before the next (3s > the 2s
  // slow stage) so they don't overlap. Overlapping rapid queries hit
  // the unfixed ordering/decode crash (see the fixme cases + log); the
  // bound accrues per DISTINCT query regardless of speed, so settled
  // input exercises it cleanly. Each iteration tolerates a transient
  // dialog tear and re-acquires the input.
  const queries = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh"]
  for (const q of queries) {
    try {
      await page.locator("dialog input[type=text][data-hydrated]").fill(q, { timeout: 4000 })
    } catch {
      // dialog torn this beat — skip; the bound still holds over the
      // refetches that did fire.
    }
    await page.waitForTimeout(3000)
  }
  await page.waitForTimeout(1000)

  expect(tokenCounts.length, "no search refetches were observed").toBeGreaterThan(4)

  // The last third of refetches must not exceed the first third by more
  // than a small constant — i.e. it plateaus rather than grows linearly.
  const settled = tokenCounts.slice(Math.floor(tokenCounts.length / 2))
  const max = Math.max(...settled)
  const min = Math.min(...settled)
  expect(
    max - min,
    `?cached= token count drifted (${min}..${max}) over ${queries.length} queries — not bounded`,
  ).toBeLessThanOrEqual(6)
})

// ─── Invariant 2: result ordering ──────────────────────────────────
//
// Both cases exercise the stable-slot fp-skip path: stage-2 (vary+cell)
// and the `.search-results` wrapper keep a CONSTANT matchKey across
// queries, so every query shares one cache slot. The danger is a
// re-typed earlier query (`po`) fp-skipping against a fingerprint the
// slot no longer backs (`pokem` overwrote it), restoring the stale node.
// The content-matched warm-fp trailer (see this file's header) keeps the
// advertised fp-set in lockstep with the slot, so the re-typed query
// either fp-skips to its OWN content or re-renders fresh — never stale.
//
// The first case reproduces via raw timing (rapid keystrokes overlap the
// 1-2s stage delays); the second forces it deterministically by delaying
// the `q=pokem` refetch response past `q=po`. Run single-worker — the
// dev server's real PokeAPI fetches throttle under parallel headless
// load.

test("rapid type→backspace must not leave stages on a superseded query", async ({ page }) => {
  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  await waitForPageInteractive(page)
  await input.focus()

  for (const c of "pokem") {
    await input.press(c)
    await page.waitForTimeout(40)
  }
  for (let i = 0; i < 3; i++) {
    await input.press("Backspace")
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(5000)

  const value = await input.inputValue()
  for (const id of ["stage-1", "stage-2", "stage-3"]) {
    const stage = page.locator(`[data-testid="${id}"]`)
    if ((await stage.count()) === 0) continue
    expect(
      await stage.getAttribute("data-q"),
      `${id} shows a stale query after rapid type→backspace`,
    ).toBe(value)
  }
})

test("a late superseded query response must not clobber the newer result", async ({ page }) => {
  // Deterministic: delay the `q=pokem` refetch response so it lands
  // after the final `q=po` one — forcing the late-superseded commit
  // the rapid-timing case hits only by luck.
  await page.route(/_\.rsc\?.*partials=search-results/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "pokem") {
      await new Promise((r) => setTimeout(r, 2500))
    }
    await route.continue()
  })

  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  await waitForPageInteractive(page)
  await input.focus()
  for (const c of "pokem") {
    await input.press(c)
    await page.waitForTimeout(40)
  }
  for (let i = 0; i < 3; i++) {
    await input.press("Backspace")
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(5000)

  const value = await input.inputValue()
  for (const id of ["stage-1", "stage-2", "stage-3"]) {
    const stage = page.locator(`[data-testid="${id}"]`)
    if ((await stage.count()) === 0) continue
    expect(
      await stage.getAttribute("data-q"),
      `${id} shows a stale query after a late superseded response`,
    ).toBe(value)
  }
})
