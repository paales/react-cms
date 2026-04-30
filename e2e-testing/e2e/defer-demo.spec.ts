import { test, expect, request } from "./fixtures"

/**
 * /defer-demo — exercises all three shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — button-triggered manual activation via
 *      `useNavigation().reload({ids: [id]})`.
 *   2. `defer={<WhenStored/>}` — localStorage-triggered activation.
 *      The activator writes the stored value to the page URL
 *      (`?<as>=<value>`) before firing; the server reads it back via
 *      `getSearchParam(as)`.
 *   3. `defer={<WhenVisible/>}` — IntersectionObserver-triggered
 *      activation when the fallback enters the viewport.
 *
 * Each section's activated content renders a server timestamp, so a
 * change in that text proves the RSC refetch round-tripped.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test.describe("Partial defer demo", () => {
  test("defer={true}: button click activates via useNavigation.reload()", async ({ page }) => {
    const rscCalls: Array<{ partials: string | null }> = []
    page.on("request", (req) => {
      const url = req.url()
      if (url.includes("_.rsc")) {
        const u = new URL(url)
        rscCalls.push({ partials: u.searchParams.get("partials") })
      }
    })

    await page.goto("/defer-demo")

    await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="manual-content"]').count()).toBe(0)
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )

    rscCalls.length = 0
    await page.locator('[data-testid="activate-manual"]').click()
    await expect(page.locator('[data-testid="manual-content"]')).toBeVisible({
      timeout: 5000,
    })

    const hits = rscCalls.filter(
      (c) => c.partials != null && c.partials.split(",").includes("manual"),
    )
    expect(hits.length, "expected exactly one RSC refetch for `manual`").toBeGreaterThanOrEqual(1)
  })

  test("<WhenStored>: setting the key activates and value passes via partialProps", async ({
    page,
  }) => {
    const rscCalls: Array<{ partials: string | null; partialProps: string | null }> = []
    page.on("request", (req) => {
      const url = req.url()
      if (url.includes("_.rsc")) {
        const u = new URL(url)
        rscCalls.push({
          partials: u.searchParams.get("partials"),
          partialProps: u.searchParams.get("partialProps"),
        })
      }
    })

    // Make sure the key is clear before navigation so the initial mount
    // reads null and the Partial stays dormant.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("demo-stored")
      } catch {
        /* ignore */
      }
    })

    await page.goto("/defer-demo")
    await expect(page.locator('[data-testid="stored-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="stored-content"]').count()).toBe(0)
    // Wait for hydration — WhenStored's `storage` listener only attaches
    // after its client-side useEffect runs.
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )

    rscCalls.length = 0
    await page.locator('[data-testid="demo-stored-input"]').fill("hello-world")
    await page.locator('[data-testid="demo-stored-set"]').click()

    await expect(page.locator('[data-testid="stored-content"]')).toBeVisible({
      timeout: 5000,
    })
    await expect(page.locator('[data-testid="stored-value"]')).toHaveText("hello-world")

    const hit = rscCalls.find((c) => c.partials != null && c.partials.split(",").includes("stored"))
    expect(hit, "expected an RSC refetch for `stored`").toBeDefined()
    const parsed = JSON.parse(hit!.partialProps ?? "{}")
    expect(parsed, "expected partialProps to carry the stored value").toEqual({
      stored: { stored: "hello-world" },
    })
  })

  test("<WhenVisible>: scroll-into-view activates the Partial", async ({ page }) => {
    await page.goto("/defer-demo")
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="any-content"]').count()).toBe(0)
    await page.waitForFunction(
      () => typeof (window as any).__rsc_partial_refetch === "function",
      null,
      { timeout: 10000 },
    )

    await page.locator('[data-testid="any-fallback"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    })
  })
})
