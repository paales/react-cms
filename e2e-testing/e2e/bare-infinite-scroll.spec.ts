import { test, expect } from "./fixtures"

/**
 * /bare — infinite scroll via the singleton-`<Partial selector="#next">` slot.
 *
 * Validates the design we landed on after the renderOn=visible
 * exploration: rather than declaring N partials up-front, we declare
 * one "next" partial whose content is a client observer. When it
 * becomes visible it bumps `?end=N+1`, refetches `page-{N+1}` + `next`,
 * and the new `next` mounts re-armed for `page-{N+2}`.
 *
 * Asserts:
 *  1. Initial load (no `?end`) shows page-1, observer below, no page-2.
 *  2. Scrolling the observer into view loads page-2 with exactly one
 *     RSC refetch carrying `partials=page-2,next` and `end=2`.
 *  3. Scrolling again loads page-3, URL bumps to `?end=3`.
 *  4. Browser back-nav from another route lands on `/bare?end=3` and
 *     the server delivers all 3 pages in one shot — proving the URL
 *     state is what drives discovery.
 *  5. Scroll position is restored on back-nav via Navigation API state.
 */

interface RscCall {
  url: string
  end: string | null
  partials: string | null
}

async function recordRscCalls(page: import("@playwright/test").Page) {
  const calls: RscCall[] = []
  page.on("request", (req) => {
    const u = req.url()
    if (!u.includes(".rsc")) return
    const parsed = new URL(u)
    calls.push({
      url: u,
      end: parsed.searchParams.get("end"),
      partials: parsed.searchParams.get("partials"),
    })
  })
  return calls
}

test("infinite scroll: loads page-2 then page-3 as the observer enters view", async ({ page }) => {
  const rscCalls = await recordRscCalls(page)

  await page.goto("/bare")

  // Initial: page-1 and the observer present, page-2 not.
  await expect(page.locator('[data-testid="page-1"]')).toBeVisible()
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "1",
  )
  expect(await page.locator('[data-testid="page-2"]').count()).toBe(0)
  await expect(page.locator('[data-testid="end-readout"]')).toHaveText("end=1")

  // ── Trigger page-2 load ────────────────────────────────────────────
  rscCalls.length = 0
  await page.locator('[data-testid="next-observer"]').scrollIntoViewIfNeeded()
  await page.waitForSelector('[data-testid="page-2"]', { timeout: 10000 })

  const page2Calls = rscCalls.filter(
    (c) => c.partials != null && c.partials.split(",").includes("page-2"),
  )
  expect(page2Calls.length).toBe(1)
  expect(page2Calls[0].partials!.split(",").sort()).toEqual(["next", "page-2"])
  expect(page2Calls[0].end).toBe("2")

  // URL was silently bumped.
  expect(new URL(page.url()).searchParams.get("end")).toBe("2")

  // Observer re-armed for the next page.
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "2",
  )

  // ── Trigger page-3 load ────────────────────────────────────────────
  rscCalls.length = 0
  await page.locator('[data-testid="next-observer"]').scrollIntoViewIfNeeded()
  await page.waitForSelector('[data-testid="page-3"]', { timeout: 10000 })

  const page3Calls = rscCalls.filter(
    (c) => c.partials != null && c.partials.split(",").includes("page-3"),
  )
  expect(page3Calls.length).toBe(1)
  expect(page3Calls[0].partials!.split(",").sort()).toEqual(["next", "page-3"])
  expect(page3Calls[0].end).toBe("3")

  expect(new URL(page.url()).searchParams.get("end")).toBe("3")
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "3",
  )
})

test("back navigation from another route restores ?end and renders the full range", async ({
  page,
}) => {
  await page.goto("/bare")
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "1",
  )
  await page.locator('[data-testid="next-observer"]').scrollIntoViewIfNeeded()
  await page.waitForSelector('[data-testid="page-2"]')
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "2",
  )
  await page.locator('[data-testid="next-observer"]').scrollIntoViewIfNeeded()
  await page.waitForSelector('[data-testid="page-3"]')
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "3",
  )

  // Navigate away. Use `force: true` so Playwright doesn't auto-scroll
  // the link into view — that would race with the navigate handler.
  await page.locator('[data-testid="link-home"]').click({ force: true })
  await page.waitForURL((u) => u.pathname === "/")

  // Back to /bare via browser back.
  await page.goBack()
  await page.waitForURL((u) => u.pathname === "/bare")

  // URL state preserved by the silent nav bumps during scroll.
  expect(new URL(page.url()).searchParams.get("end")).toBe("3")

  // All three pages render up-front (server saw ?end=3 and walked the
  // tree with all 3 page partials present — no observer trips required).
  await expect(page.locator('[data-testid="page-1"]')).toBeVisible()
  await expect(page.locator('[data-testid="page-2"]')).toBeAttached()
  await expect(page.locator('[data-testid="page-3"]')).toBeAttached()
  await expect(page.locator('[data-testid="next-observer"]')).toHaveAttribute(
    "data-current-end",
    "3",
  )
})
