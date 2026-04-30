import { test, expect, request } from "./fixtures"

// Cold-start every run so the `<Cache>` store doesn't short-circuit
// stage-2/3's artificial delays. Without this, a prior test's cached
// `{searchQuery: "ab"}` entry would return instantly and the fallback
// never flashes.
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("measure stage appearance timing with raw setState", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  page.on("console", (msg) => {
    const text = msg.text()
    if (msg.type() === "error" || text.includes("[stream]") || text.includes("[PartialsClient]")) {
      console.log(`  BROWSER: ${text.slice(0, 300)}`)
    }
  })

  // 1. Load page
  await page.goto("/?search=url&q=a")
  await page.waitForSelector('[data-testid="stage-3-content"]', {
    timeout: 15000,
  })
  console.log("Initial SSR loaded")

  // 2. Take snapshot of initial DOM state
  const initialSnapshot = await page.evaluate(() => {
    const result: Record<string, string> = {}
    for (let i = 1; i <= 3; i++) {
      const content = document.querySelector(`[data-testid="stage-${i}-content"]`)
      result[`stage${i}`] = content?.textContent?.slice(0, 60) ?? "ABSENT"
    }
    return result
  })

  // 3. Install micro-timing tracker with requestAnimationFrame
  await page.evaluate((initSnapshot) => {
    const w = window as any
    w.__t = {
      t0: 0,
      events: [] as string[],
      stages: {} as Record<string, number>,
      started: false,
      initSnapshot,
      lastState: "",
    }

    function snapshot() {
      const parts: string[] = []
      for (let i = 1; i <= 3; i++) {
        const content = document.querySelector(`[data-testid="stage-${i}-content"]`)
        const fallback = document.querySelector(`[data-testid="stage-${i}-fallback"]`)
        // Fallback first: on re-suspend, React keeps old content in DOM
        // (hidden) and renders the fallback alongside. Checking fallback
        // first lets the observer actually see the loading state.
        if (fallback) {
          parts.push(`S${i}:FALLBACK`)
          if (!w.__t.stages[`stage${i}_fb`]) {
            w.__t.stages[`stage${i}_fb`] = Math.round(performance.now() - w.__t.t0)
          }
        } else if (content) {
          const text = content.textContent?.slice(0, 30) ?? ""
          const isNew = text !== (w.__t.initSnapshot[`stage${i}`] ?? "").slice(0, 30)
          parts.push(`S${i}:${isNew ? "NEW" : "old"}("${text.slice(0, 15)}")`)
          if (isNew && !w.__t.stages[`stage${i}`]) {
            w.__t.stages[`stage${i}`] = Math.round(performance.now() - w.__t.t0)
          }
        } else {
          parts.push(`S${i}:GONE`)
          if (!w.__t.stages[`stage${i}_gone`]) {
            w.__t.stages[`stage${i}_gone`] = Math.round(performance.now() - w.__t.t0)
          }
        }
      }
      return parts.join(" | ")
    }

    const check = () => {
      if (!w.__t.started) return
      const state = snapshot()
      if (state !== w.__t.lastState) {
        const ms = Math.round(performance.now() - w.__t.t0)
        w.__t.events.push(`[${ms}ms] ${state}`)
        w.__t.lastState = state
      }
    }

    // Use both RAF and interval for maximum resolution
    const raf = () => {
      check()
      if (w.__t.started) requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)
    w.__t.poll = setInterval(check, 5)
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    w.__t.observer = observer
  }, initialSnapshot)

  // 4. Start timing and trigger refetch
  await page.evaluate(() => {
    ;(window as any).__t.t0 = performance.now()
    ;(window as any).__t.started = true
  })

  const input = page.locator("input[type=text]")
  await input.focus()
  await input.fill("b")

  // 5. Wait
  await page.waitForTimeout(8000)

  // 6. Collect
  const result = await page.evaluate(() => {
    const t = (window as any).__t
    t.started = false
    clearInterval(t.poll)
    t.observer?.disconnect()
    return { events: t.events, stages: t.stages }
  })

  console.log("\n=== State transitions ===")
  for (const e of result.events) console.log(`  ${e}`)

  console.log("\n=== Key timing ===")
  console.log(JSON.stringify(result.stages, null, 2))

  if (errors.length > 0) {
    console.log("\n=== Errors ===")
    for (const e of errors) console.log(`  ${e.slice(0, 300)}`)
  }

  const s1 = result.stages.stage1
  const s2 = result.stages.stage2
  const s3 = result.stages.stage3

  if (s1 != null && s2 != null && s3 != null) {
    console.log(`\nProgressive: Stage 1=${s1}ms, Stage 2=${s2}ms, Stage 3=${s3}ms`)
    console.log(`Gap 1→2: ${s2 - s1}ms, Gap 2→3: ${s3 - s2}ms`)
  }

  expect(
    s1 ?? s2 ?? s3 ?? result.stages.stage1_fb ?? result.stages.stage1_gone,
    "No state changes detected at all",
  ).toBeDefined()
})
