import { expect, test } from "@playwright/test"

/**
 * Regression: schema-using partons sometimes render as bare
 * `<i hidden data-partial-id="...">` placeholders on initial production
 * preview load, blanking the partial's content.
 *
 * Reproduced 2026-05-20 on `/streaming-demo` against `yarn preview`.
 * Affects ANY parton whose `schema: () => ({...cells})` resolves cells
 * (so both `bump-counter` and `card-form`). The `streaming-demo-tick`
 * parton (vary-only, no schema) is unaffected.
 *
 * Root cause is in `framework/src/lib/partial-client.tsx`:
 *   - `unwrapLazy()` returns `null` for pending Flight lazies.
 *   - `cacheFromStreamingChildren` + `deriveTemplate` walk past those
 *     lazies, silently dropping the partial wrapper inside.
 *   - `renderTemplate` produces a placeholder with no cache entry to
 *     substitute from → the bare `<i hidden>` lands in the DOM.
 *
 * The SSR-side render bypasses the cache machinery for exactly this
 * reason (the code comment in `PartialsClient` documents the trade-
 * off), but the browser-side first render has the same problem when
 * a Flight chunk is still streaming when PartialsClient first commits.
 *
 * This spec drives 10 fresh page loads. With the bug present, at least
 * one schema-using partial typically blanks. The test must be green
 * for every load.
 */

const ITERATIONS = 10

test("every load renders every parton — no schema-using parton blanks", async ({ browser }) => {
  const failures: Array<{ iter: number; blanked: string[] }> = []
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await page.goto("/streaming-demo", { waitUntil: "load" })
      // Give the hydration commit + warm-fp trailer time to settle but
      // don't wait for the heartbeat to fire — the bug is purely in the
      // initial render path, before any heartbeat response could land.
      await page.waitForTimeout(1500)
      // Read the live DOM (post-hydration) and exclude the inline
      // `<script id="_R_">` Flight payload from the check so we count
      // ACTUAL rendered elements, not Flight references.
      const html = await page.content()
      const flightIdx = html.indexOf("__FLIGHT_DATA")
      const dom = flightIdx > 0 ? html.slice(0, flightIdx) : html
      const has = (testid: string) => dom.includes(`data-testid="${testid}"`)
      const blanked: string[] = []
      // streaming-demo-tick: vary-only parton, sanity check that
      // hydration ran at all.
      if (!has("streaming-demo-tick")) blanked.push("streaming-demo-tick")
      // bump-counter: parton with `schema: () => ({ bumps })`
      if (!has("streaming-demo-bumps")) blanked.push("bump-counter")
      // card-form: parton with 3-cell schema
      if (!has("card-form")) blanked.push("card-form")
      if (blanked.length > 0) failures.push({ iter, blanked })
    } finally {
      await ctx.close()
    }
  }
  expect(
    failures,
    `${failures.length}/${ITERATIONS} loads had blanked partons:\n${failures
      .map((f) => `  iter ${f.iter}: ${f.blanked.join(", ")}`)
      .join("\n")}`,
  ).toEqual([])
})
