import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * /scale — the scroller's physics at 1,000,000 items.
 *
 * The window model's three claims, pinned:
 *  - a scrollbar jump to ANYWHERE paints local skeleton cells the
 *    same frame (client arithmetic — no server round trip) and fills
 *    with real content after ONE settled window statement;
 *  - the document's geometry is stable through the whole exchange —
 *    the viewport never moves except by the user's hand;
 *  - the DOM stays O(viewport): a placed span + two reservation
 *    shells, independent of the million.
 */

test("scrollbar jump to 50%: instant skeletons, one statement, content — geometry stable", async ({
  page,
}) => {
  await page.goto("/scale")
  await page.waitForSelector('[data-testid="scale-cell"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  const docH0 = await page.evaluate(() => document.documentElement.scrollHeight)
  // 8 cols × 40px rows × 1M items ≈ 5M px — the reservations hold the
  // whole collection's space.
  expect(docH0).toBeGreaterThan(4_000_000)

  // Jump.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5))
  const yLanded = await page.evaluate(() => Math.round(window.scrollY))

  // The local band: skeleton cells inside the reservation, painted
  // without any server involvement. Generously 500ms — the assertion
  // is "before any round trip could matter", not a frame race.
  await expect
    .poll(
      () =>
        page.evaluate(() => document.querySelectorAll(".parton-scroller-res .parton-skel").length),
      { timeout: 500 },
    )
    .toBeGreaterThan(20)

  // The settled statement moves the span; real cells reach the
  // viewport.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('[data-testid="scale-cell"]')].filter((c) => {
              const r = c.getBoundingClientRect()
              return r.bottom > 0 && r.top < window.innerHeight
            }).length,
        ),
      { timeout: 15000 },
    )
    .toBeGreaterThan(20)

  // The anchor carries the landing (≈ item 500k / leaf 64).
  const pageParam = Number(new URL(page.url()).searchParams.get("page"))
  expect(pageParam).toBeGreaterThan(7500)
  expect(pageParam).toBeLessThan(8200)

  // Geometry held: same document height, viewport where the user put
  // it.
  const docH1 = await page.evaluate(() => document.documentElement.scrollHeight)
  expect(Math.abs(docH1 - docH0)).toBeLessThan(docH0 * 0.01)
  const yAfter = await page.evaluate(() => Math.round(window.scrollY))
  expect(Math.abs(yAfter - yLanded)).toBeLessThan(50)

  // The visible numbers are the RIGHT numbers for this position.
  const first = await page.evaluate(() => {
    const inView = [...document.querySelectorAll('[data-testid="scale-cell"]')].filter((c) => {
      const r = c.getBoundingClientRect()
      return r.bottom > 0 && r.top < window.innerHeight
    })
    return Number(inView[0]?.getAttribute("data-i") ?? -1)
  })
  expect(first).toBeGreaterThan(490_000)
  expect(first).toBeLessThan(510_000)
})

test("scrolling up through unexplored territory never moves the viewport forward", async ({
  page,
}) => {
  await page.goto("/scale?page=7814")
  await page.waitForSelector('[data-testid="scale-cell"]', { timeout: 20000 })
  await waitForPageInteractive(page)

  await page.mouse.move(600, 400)
  const ys: number[] = []
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(120)
    ys.push(await page.evaluate(() => Math.round(window.scrollY)))
  }
  // Reverse scroll: strictly monotonic decrease — any forward step
  // means something above the viewport changed size (the exact bug
  // uniform rows exist to make impossible).
  let maxForward = 0
  for (let i = 1; i < ys.length; i++) maxForward = Math.max(maxForward, ys[i] - ys[i - 1])
  expect(maxForward, `trajectory: ${ys.join(",")}`).toBe(0)
})

test("the DOM is O(viewport), independent of the million", async ({ page }) => {
  await page.goto("/scale")
  await page.waitForSelector('[data-testid="scale-cell"]', { timeout: 20000 })
  await waitForPageInteractive(page)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5))
  await page.waitForTimeout(3000)

  const counts = await page.evaluate(() => ({
    nodes: document.querySelectorAll("*").length,
    reservations: document.querySelectorAll(".parton-scroller-res").length,
  }))
  expect(counts.nodes, "total DOM nodes").toBeLessThan(4000)
  expect(counts.reservations).toBeLessThanOrEqual(2)
})

test("span moves while scrolling up never teleport the viewport", async ({ page }) => {
  // The regression this pins: a span move swaps reservation-space
  // for leaves at identical height, but native scroll anchoring saw
  // its anchor node destroyed and "compensated" — a spontaneous
  // teleport by exactly the swapped height. The collection opts out
  // of anchoring (`overflow-anchor: none`); geometry is exact by
  // construction.
  await page.addInitScript(() => {
    ;(window as unknown as { __spont: number[] }).__spont = []
    let lastY = 0
    window.addEventListener(
      "scroll",
      () => {
        const d = window.scrollY - lastY
        // Wheel steps below are exactly -700; anything else large is
        // a spontaneous move.
        if (Math.abs(d) > 900) {
          ;(window as unknown as { __spont: number[] }).__spont.push(Math.round(d))
        }
        lastY = window.scrollY
      },
      { passive: true, capture: true },
    )
  })
  await page.goto("/scale?page=7814")
  await page.waitForSelector('[data-testid="scale-cell"]', { timeout: 20000 })
  await waitForPageInteractive(page)
  // Ignore the deep-link landing itself.
  await page.evaluate(() => {
    ;(window as unknown as { __spont: number[] }).__spont.length = 0
  })

  await page.mouse.move(600, 400)
  // Stepped up-scroll with settle pauses — each pause lets the
  // reservation state a landing and the span move underneath us.
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(900)
  }
  const spont = await page.evaluate(() => (window as unknown as { __spont: number[] }).__spont)
  expect(spont, `spontaneous scroll moves: ${spont.join(",")}`).toEqual([])
})
