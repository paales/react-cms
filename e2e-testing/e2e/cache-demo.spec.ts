import { test, expect } from "./fixtures"

/**
 * /cache-demo — server-side Flight-buffer caching.
 *
 * Validates that a <Cache dep> wrapper stores and serves a subtree's
 * rendered output across requests. The key assertion: the slow
 * component's render counter (embedded in the rendered DOM as
 * data-render-count) stays stable across cache hits, and bumps only
 * on cache misses (different dep).
 *
 * We also check that <Cache> composes with a normal <Partial>: the
 * enclosing Partial is still refetchable, and on a refetch targeting
 * it the cached content is served — server work skipped entirely.
 */

// Match the render-count value in either HTML attribute form
// (`data-render-count="N"`) or RSC Flight JSON form
// (`"data-render-count":N`) — depending on streaming order React may
// emit the resolved Suspense content as either a `<template>` chunk
// or only via the Flight payload, and both are valid representations
// of the same render output.
function extractRenderCount(body: string): string | undefined {
  return (
    body.match(/data-render-count="(\d+)"/)?.[1] ?? body.match(/"data-render-count":(\d+)/)?.[1]
  )
}

test("cache hit serves stored subtree without re-running the server component", async ({
  page,
  request,
}) => {
  // Use raw requests rather than browser navigation for precise control.
  // First request establishes the cache.
  const first = await request.get("/cache-demo?flavor=vanilla-a")
  const firstCount = extractRenderCount(await first.text())
  expect(firstCount, "initial render must include a count").toBeDefined()

  // Second request for the same dep should NOT bump the render count.
  const second = await request.get("/cache-demo?flavor=vanilla-a")
  const secondCount = extractRenderCount(await second.text())
  expect(secondCount).toBe(firstCount)

  // A different dep should MISS, bumping the count.
  const third = await request.get("/cache-demo?flavor=vanilla-b")
  const thirdCount = extractRenderCount(await third.text())
  expect(thirdCount).toBeDefined()
  expect(Number(thirdCount)).toBeGreaterThan(Number(firstCount))

  // Revisiting the original dep still hits and serves the original body.
  const fourth = await request.get("/cache-demo?flavor=vanilla-a")
  const fourthCount = extractRenderCount(await fourth.text())
  expect(fourthCount).toBe(firstCount)
})

test("partial refetch targeting a cached partial skips server work", async ({ request }) => {
  // Seed the cache.
  const seed = await request.get("/cache-demo?flavor=vanilla-c")
  const beforeCount = extractRenderCount(await seed.text())

  // Refetch only the slow partial. A flight response comes back; count
  // in the response should still match the seed.
  const refetch = await request.get("/cache-demo_.rsc?flavor=vanilla-c&partials=slow")
  const refetchCount = extractRenderCount(await refetch.text())
  expect(refetchCount).toBeDefined()
  expect(refetchCount).toBe(beforeCount)

  // Full page load again — still the same count.
  const revisit = await request.get("/cache-demo?flavor=vanilla-c")
  const revisitCount = extractRenderCount(await revisit.text())
  expect(revisitCount).toBe(beforeCount)
})

test("clock partial stays fresh on every request regardless of cache state", async ({
  request,
}) => {
  // React 19 SSR inserts a `<!-- -->` marker between adjacent text and
  // expression children for hydration. Match the ISO after it so we
  // capture the rendered timestamp, not the Flight-serialized source.
  const clockTime = /Server time:[^<]*<!-- -->([^<]+)</
  const first = (await (await request.get("/cache-demo?flavor=clock-a")).text()).match(
    clockTime,
  )?.[1]
  // Clock is not cached — a new request should produce a new time.
  await new Promise((r) => setTimeout(r, 15))
  const second = (await (await request.get("/cache-demo?flavor=clock-a")).text()).match(
    clockTime,
  )?.[1]
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  expect(first).not.toBe(second)
})

test("cache hit is significantly faster than cold miss", async ({ request }) => {
  const uniqueFlavor = `perf-${Date.now()}`
  const coldStart = Date.now()
  await request.get(`/cache-demo?flavor=${uniqueFlavor}`)
  const coldMs = Date.now() - coldStart

  const warmStart = Date.now()
  await request.get(`/cache-demo?flavor=${uniqueFlavor}`)
  const warmMs = Date.now() - warmStart

  // Cold has ~500ms of awaited work. Warm skips it via cache.
  // Generous bounds to tolerate CI jitter.
  expect(coldMs).toBeGreaterThan(400)
  expect(warmMs).toBeLessThan(coldMs / 3)
})

test("client component inside cached subtree hydrates and retains state", async ({ page }) => {
  await page.goto(`/cache-demo?flavor=hydrate-${Date.now()}`)
  const button = page.locator('[data-testid="click-counter"]')
  await expect(button).toHaveText(/clicked 0/)
  await button.click()
  await expect(button).toHaveText(/clicked 1/)
  await button.click()
  await expect(button).toHaveText(/clicked 2/)
})

test("ClickCounter state survives refetch of its cached Partial", async ({ page, request }) => {
  await request.get("/__test/clear-caches")
  await page.goto(`/cache-demo?flavor=retain-${Date.now()}`)
  const button = page.locator('[data-testid="click-counter"]')
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="click-counter"]')
    return el != null && Object.keys(el).some((k) => k.startsWith("__reactFiber"))
  })

  await button.click()
  await button.click()
  await expect(button).toHaveText(/clicked 2/)

  // Stamp the DOM node — survives reconciliation only if React keeps
  // the same fiber instance.
  await button.evaluate((el) => {
    ;(el as HTMLElement & { __stamp?: number }).__stamp = 42
  })

  const refetchResponse = page.waitForResponse(
    (r) => r.url().includes("_.rsc") && r.url().includes("partials=slow"),
  )
  await page.getByTestId("refetch-slow").click()
  await refetchResponse

  const stamped = await page
    .locator('[data-testid="click-counter"]')
    .evaluate((el) => (el as HTMLElement & { __stamp?: number }).__stamp)
  expect(stamped, "button DOM node was remounted (client state lost)").toBe(42)
  await expect(button).toHaveText(/clicked 2/)
})

test("client component inside cached subtree remains clickable after cache hit", async ({
  page,
  request,
}) => {
  // Prime the cache with a fresh request first.
  const flavor = `hydrate-cached-${Date.now()}`
  await request.get(`/cache-demo?flavor=${flavor}`)
  // Now navigate in the browser — this hit serves from cache.
  await page.goto(`/cache-demo?flavor=${flavor}`)
  const button = page.locator('[data-testid="click-counter"]')
  await expect(button).toHaveText(/clicked 0/)
  // Wait for hydration — otherwise the click races the event handler attach.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="click-counter"]')
    // Rough hydration check: if the element has a React event key,
    // hydration has happened for this subtree.
    return el != null && Object.keys(el).some((k) => k.startsWith("__reactFiber"))
  })
  await button.click()
  await expect(button).toHaveText(/clicked 1/)
})

test("Toggle flavor: cached spec re-renders with new flavor on URL change", async ({ page }) => {
  // Cached specs read their deps via `vary` rather than parent-passed
  // JSX props. The `Toggle flavor` button calls
  // `nav.navigate(url, { selector: "#slow" })` — a partial-refetch
  // for `#slow` against the new URL. Slow's vary derives `flavor`
  // from the URL search param, so the cache key shifts and the new
  // body lands in the DOM.
  const flavor = `toggle-${Date.now()}`
  await page.goto(`/cache-demo?flavor=${flavor}`)
  await expect(page.locator('[data-testid="slow-content"]')).toContainText(`flavor: ${flavor}`)

  await page.locator('[data-testid="toggle-flavor"]').click()
  // Toggle goes vanilla → chocolate when the current flavor isn't
  // exactly "vanilla", the demo flips to "vanilla". Either way, the
  // URL search param changes, the slow body should reflect it.
  const newFlavor = "vanilla"
  await expect(page.locator('[data-testid="slow-content"]')).toContainText(
    `flavor: ${newFlavor}`,
    { timeout: 10000 },
  )
  expect(new URL(page.url()).searchParams.get("flavor")).toBe(newFlavor)
})
