import { test, expect, request } from "./fixtures"

/**
 * Verify: on a navigation (URL param change), the server skips
 * re-rendering partials whose fingerprint matches the client's
 * `?cached=id:fp,…` list. The response should be substantially
 * smaller than a cold-cache nav.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("nav with warm client cache streams placeholders for unchanged partials", async ({ page }) => {
  const rscResponses: Array<{ url: string; size: number }> = []
  page.on("response", async (res) => {
    const ct = res.headers()["content-type"] ?? ""
    if (!ct.includes("text/x-component")) return
    try {
      const body = await res.body()
      rscResponses.push({ url: res.url(), size: body.byteLength })
    } catch {
      // ignore
    }
  })

  // Initial page load. After this, client cache has entries for
  // head, nav, header, hero, stats, species, trivia — all with
  // their current fingerprints.
  await page.goto("/pokemon/1")
  await page.waitForSelector("header", { timeout: 10000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  rscResponses.length = 0

  // Trigger a nav that opens the search overlay. The `?search=url`
  // param makes stage-1 appear (new mount), but every other partial
  // in the tree is unchanged. Use the "Search (URL)" button so the
  // navigate event fires through the framework's normal path.
  await page.getByRole("button", { name: /Search \(URL\)/ }).click()
  await page.waitForSelector("input[type=text]", { timeout: 10000 })

  expect(rscResponses.length, "expected one RSC response for the nav").toBe(1)

  const navSize = rscResponses[0].size
  console.log(`nav payload with warm cache: ${navSize} bytes`)

  // Fetch a cold-cache version of the same URL (no `?cached=`) for
  // comparison. The server must render all partials fresh.
  const coldResponse = await page.request.get(
    `${new URL(page.url()).origin}/pokemon/1?search=url`,
    { headers: { accept: "text/x-component" } },
  )
  const coldSize = (await coldResponse.body()).byteLength
  console.log(`cold nav payload (no cache): ${coldSize} bytes`)

  // Header partial re-renders because SearchToggle's `isOpen` prop
  // changed, and stage-1 mounts fresh. Everything else should skip
  // to a 3-byte placeholder `<i>`. Expect the warm payload to be
  // meaningfully smaller than the cold.
  expect(
    navSize,
    `nav payload (${navSize} bytes) was not smaller than cold (${coldSize} bytes) — fingerprint skip may not be firing`,
  ).toBeLessThan(coldSize * 0.6)
})
