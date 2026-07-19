import { test, expect } from "@playwright/test"

/**
 * Prod-build pin for the scroller's page-transition blink (user
 * report 2026-07-19: "when it switches from page 2 to page 3 there is
 * a brief layout shift"). Two mechanisms produced it, both
 * prod-timing-dependent (dev streams too fast to catch):
 *
 *  - the visibility observer stored a stale not-intersecting entry
 *    (computed while a lane commit had the node detached/hidden) and
 *    parked a leaf the user was looking at — fixed by treating
 *    zero-rect entries and non-laid-out nodes as unmeasurable
 *    (`visibility.tsx`);
 *  - the in-place window statement committed its whole-tree segment
 *    progressively (`setPayloadRaw`), re-suspending/replacing mounted
 *    content — fixed by branding in-place navs as atomic-swap
 *    commits, with the commit-mode wish surviving the record's
 *    supersede abort (`live-boot.tsx` + `channel-client.ts`).
 *
 * The spec drives the exact reproducing cadence (wheel bursts with
 * settle pauses across several page transitions) and asserts the two
 * user-visible invariants: a visible card never vanishes or hides
 * mid-viewport, and no visible card's document position ever jumps.
 */

test("browse scroll across page transitions: no card blinks, no layout shifts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __blinks: string[]; __shifts: string[] }
    w.__blinks = []
    w.__shifts = []
    document.addEventListener("DOMContentLoaded", () => {
      const seen = new Map<string, { lastFrame: number; doc: number; flagged: boolean }>()
      let frame = 0
      const loop = () => {
        frame++
        for (const [key, rec] of seen) {
          if (rec.lastFrame !== frame - 1 || rec.flagged) continue
          const el = document.querySelector<HTMLElement>(`[data-testid="${key}"]`)
          // Visible one frame ago, now hidden or gone — the blink.
          if (!el || el.offsetParent === null) {
            rec.flagged = true
            w.__blinks.push(key)
          }
        }
        for (const c of document.querySelectorAll<HTMLElement>('[data-testid^="browse-card-"]')) {
          if (c.offsetParent === null) continue
          const r = c.getBoundingClientRect()
          if (r.bottom < 0 || r.top > innerHeight) continue
          const key = c.getAttribute("data-testid")!
          const doc = Math.round(r.top + scrollY)
          const rec = seen.get(key)
          if (rec && rec.lastFrame === frame - 1 && Math.abs(rec.doc - doc) > 100) {
            w.__shifts.push(`${key}:${rec.doc}->${doc}`)
          }
          seen.set(key, { lastFrame: frame, doc, flagged: false })
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
  })
  await page.goto("/magento/browse")
  await page.waitForSelector('[data-testid^="browse-card-"]', { timeout: 30000 })
  await page.locator("html[data-parton-interactive]").waitFor({ state: "attached", timeout: 15000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => {
    const w = window as unknown as { __blinks: string[]; __shifts: string[] }
    w.__blinks.length = 0
    w.__shifts.length = 0
  })

  // The reproducing cadence: short wheel bursts with settle pauses,
  // crossing several page transitions.
  await page.mouse.move(640, 400)
  for (let step = 0; step < 8; step++) {
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 180)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(800)
  }
  await page.waitForTimeout(1500)

  const { blinks, shifts } = await page.evaluate(() => {
    const w = window as unknown as { __blinks: string[]; __shifts: string[] }
    return { blinks: w.__blinks, shifts: w.__shifts }
  })
  expect(blinks, `cards that blinked: ${blinks.join(",")}`).toEqual([])
  expect(shifts, `cards that shifted: ${shifts.join(",")}`).toEqual([])
})
