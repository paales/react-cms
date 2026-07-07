import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

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
 * THE INVARIANT this file guards: RESULT ORDERING — the committed
 * stages must reflect the LATEST query, never a superseded one. On
 * the channel the covering render is server-serialized (stream order
 * + the as-of guard), so the remaining client-side hazard is the
 * fp/slot lockstep below.
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

// ─── Result ordering ────────────────────────────────────────────────
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
// Reproduces via raw timing (rapid keystrokes overlap the 1-2s stage
// delays); the covering render for the final query is what must land.
// The deterministic slot-lockstep reproduction lives in
// `framework/src/lib/__tests__/partial-client-fp-desync.test.tsx`.

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
