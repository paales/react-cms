import { test, expect } from "./fixtures"

/**
 * Detailed tracing: watches EVERY mutation inside #root (full DOM walk),
 * dumps the structural skeleton at each mutation. Helps us see exactly
 * when React commits between the VOID unmount and the final reveal.
 */
test("trace DOM mutations during Partials refetch", async ({ page }) => {
  const consoleLines: string[] = []
  page.on("console", (msg) => {
    const t = msg.text()
    if (t.includes("[stream]") || t.includes("[trace]")) {
      consoleLines.push(t)
    }
  })

  await page.goto("/?search=url&q=a")
  await page.waitForSelector('[data-testid="stage-3-content"]', {
    timeout: 15000,
  })

  await page.evaluate(() => {
    const w = window as any
    w.__trace = { t0: 0, started: false, events: [] as string[] }

    const skeleton = () => {
      const stages: string[] = []
      for (let i = 1; i <= 3; i++) {
        const c = document.querySelector(`[data-testid="stage-${i}-content"]`)
        const f = document.querySelector(`[data-testid="stage-${i}-fallback"]`)
        stages.push(c ? `S${i}:C` : f ? `S${i}:F` : "S?:-")
      }
      const dialog = document.querySelector("dialog[open]")
      const bodyChildren = document.body.children.length
      return `[body:${bodyChildren}ch dialog:${dialog ? "Y" : "N"}] ${stages.join(" ")}`
    }

    w.__trace.skeleton = skeleton
    let lastSkel = ""
    const recorder = () => {
      if (!w.__trace.started) return
      const s = skeleton()
      if (s !== lastSkel) {
        const ms = Math.round(performance.now() - w.__trace.t0)
        w.__trace.events.push(`[+${ms}ms] ${s}`)
        lastSkel = s
      }
    }

    const obs = new MutationObserver(recorder)
    obs.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    w.__trace.obs = obs
    w.__trace.raf = () => {
      recorder()
      if (w.__trace.started) requestAnimationFrame(w.__trace.raf)
    }
    requestAnimationFrame(w.__trace.raf)
  })

  await page.evaluate(() => {
    ;(window as any).__trace.t0 = performance.now()
    ;(window as any).__trace.started = true
  })

  const input = page.locator("input[type=text]")
  await input.focus()
  await input.fill("b")

  await page.waitForTimeout(4000)

  const events = await page.evaluate(() => {
    const w = window as any
    w.__trace.started = false
    w.__trace.obs?.disconnect()
    return w.__trace.events
  })

  console.log("\n=== DOM timeline ===")
  for (const e of events) console.log(`  ${e}`)
  console.log("\n=== Stream logs ===")
  for (const l of consoleLines) console.log(`  ${l}`)

  expect(events.length).toBeGreaterThan(0)
})
