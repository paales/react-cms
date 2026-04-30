import { test, expect } from "./fixtures"

/**
 * E2E test: do search stages stream progressively on AJAX refetch?
 *
 * Three search stage partials have server-side delays of 0ms, 1000ms, 2000ms.
 * If streaming works, stage 1 appears ~1s before stage 2, and stage 2 ~1s
 * before stage 3. If broken, all three appear together after ~2s.
 */

test("search stages stream progressively on AJAX refetch", async ({ page }) => {
  const errors: string[] = []
  const consoleLines: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  page.on("console", (msg) => {
    const t = msg.text()
    if (t.includes("[stream]") || t.includes("[partial]")) consoleLines.push(t)
  })

  // 1. Load page with search open. Use a broad query so all 3 stages have data.
  //    "a" matches ~700 pokemon, so all 3 slices will have content.
  //    Use /pokemon/1 so the page has hero/stats/species partials but NOT the
  //    LoadMore sentinel — LoadMore's IntersectionObserver would otherwise fire
  //    a competing navigation while the search refetch is in flight.
  await page.goto("/pokemon/1?search=url&q=a")
  await page.waitForSelector('[data-testid="stage-1-content"]', {
    timeout: 15000,
  })
  await page.waitForSelector('[data-testid="stage-3-content"]', {
    timeout: 15000,
  })
  console.log("Initial SSR: all 3 stages loaded")

  // Opt into streaming commit mode. Default is startTransition
  // (preserve UI, no fallback, no per-chunk streaming), which this
  // test is not about.
  await page.locator('[data-testid="disable-transition-toggle"] input').check()

  // 2. Inject timing tracker before typing
  await page.evaluate(() => {
    const w = window as any
    w.__streamTest = {
      started: false,
      t0: 0,
      stages: {} as Record<string, number>,
      log: [] as string[],
      lastState: "",
    }

    function snapshot() {
      const parts: string[] = []
      for (let i = 1; i <= 3; i++) {
        const content = document.querySelector(`[data-testid="stage-${i}-content"]`)
        const fallback = document.querySelector(`[data-testid="stage-${i}-fallback"]`)
        // Fallback first: when a Suspense boundary re-suspends on
        // update, React keeps the old content element in the DOM
        // (hidden) and renders the fallback alongside it. A
        // content-first check would report "content" throughout and
        // miss the fallback flash entirely.
        if (fallback) parts.push(`S${i}:fallback`)
        else if (content) parts.push(`S${i}:content`)
        else parts.push(`S${i}:absent`)
      }
      return parts.join("|")
    }

    const check = () => {
      const st = w.__streamTest
      if (!st.started) return
      const state = snapshot()

      if (state !== st.lastState) {
        st.log.push(`[${Math.round(performance.now() - st.t0)}ms] ${state}`)
        st.lastState = state

        // Track: first fallback time, and first content time SEEN AFTER fallback
        for (let i = 1; i <= 3; i++) {
          const fbKey = `stage${i}_fallback`
          const resolvedKey = `stage${i}_resolved`
          if (!st.stages[fbKey] && state.includes(`S${i}:fallback`)) {
            st.stages[fbKey] = Math.round(performance.now() - st.t0)
          }
          // Content time only counts if fallback was already seen for this stage
          if (
            st.stages[fbKey] != null &&
            !st.stages[resolvedKey] &&
            state.includes(`S${i}:content`)
          ) {
            st.stages[resolvedKey] = Math.round(performance.now() - st.t0)
          }
        }
      }
    }

    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    })
    w.__streamPoll = setInterval(check, 2)
    w.__streamObserver = observer
    const raf = () => {
      check()
      if (w.__streamTest.started) requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)
  })

  // 3. Type a character that keeps results broad.
  //    Move cursor to end first, then type. Start the clock explicitly,
  //    just before typing — stage-1 has 0ms delay so there's no
  //    fallback-flash to detect; we need to anchor t0 manually.
  const input = page.locator("input[type=text]")
  await input.focus()
  await input.press("End")
  await page.evaluate(() => {
    const w = window as any
    w.__streamTest.t0 = performance.now()
    w.__streamTest.started = true
  })
  await input.press("b")

  // 4. Wait for the VOID flush (stage-3 goes absent/fallback), then for its
  //    content to reappear. Otherwise waitForSelector would match the stale
  //    stage-3-content from the initial SSR render.
  try {
    await page.waitForSelector('[data-testid="stage-3-fallback"]', {
      timeout: 5000,
    })
  } catch {}
  try {
    await page.waitForSelector('[data-testid="stage-3-content"]', {
      timeout: 15000,
    })
  } catch {
    // Even if it doesn't appear, we'll report what happened
  }
  await page.waitForTimeout(500)

  // 5. Collect results
  const result = await page.evaluate(() => {
    const w = window as any
    clearInterval(w.__streamPoll)
    w.__streamObserver?.disconnect()
    return w.__streamTest
  })

  console.log("\n=== Stream event log ===")
  for (const entry of result.log) {
    console.log(`  ${entry}`)
  }
  console.log("\n=== Stage appearance times ===")
  console.log(JSON.stringify(result.stages))

  if (errors.length > 0) {
    console.log("\n=== Errors ===")
    for (const e of errors) console.log(`  ${e.slice(0, 200)}`)
  }

  console.log("\n=== Browser console [stream]/[partial] logs ===")
  for (const l of consoleLines) console.log(`  ${l}`)

  // 6. Assert progressive streaming. Stale content remains visible until
  //    the new Suspense boundary mounts and swaps to fallback. Measure
  //    both fallback appearance and the resolved-content time AFTER fallback.
  const s2fb = result.stages.stage2_fallback
  const s2r = result.stages.stage2_resolved
  const s3fb = result.stages.stage3_fallback
  const s3r = result.stages.stage3_resolved

  console.log(`\nStage 2 fallback: ${s2fb}ms → resolved: ${s2r}ms`)
  console.log(`Stage 3 fallback: ${s3fb}ms → resolved: ${s3r}ms`)

  expect(
    s2fb,
    "Stage 2 fallback never appeared — Suspense boundary did not remount on refetch",
  ).toBeDefined()
  expect(
    s3fb,
    "Stage 3 fallback never appeared — Suspense boundary did not remount on refetch",
  ).toBeDefined()
  expect(s2r, "Stage 2 never resolved to content after fallback").toBeDefined()
  expect(s3r, "Stage 3 never resolved to content after fallback").toBeDefined()

  if (s2r != null && s3r != null) {
    const gap23 = s3r - s2r
    console.log(`Gap stage2-resolved → stage3-resolved: ${gap23}ms`)
    expect(
      gap23,
      `Stage 2→3 resolved gap was ${gap23}ms — not streaming progressively`,
    ).toBeGreaterThan(500)
  }
})
