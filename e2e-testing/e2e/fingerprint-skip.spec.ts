import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Verify: on a navigation (URL param change), the server skips
 * re-rendering partials whose fingerprint the connection's mirror
 * holds. The navigation segment rides the held stream, so the byte
 * signal is CDP-level: the stream bytes the nav costs are
 * substantially smaller than a cold render of the same URL.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("nav with warm client cache streams placeholders for unchanged partials", async ({ page }) => {
  // CDP byte accounting for the held live stream — the navigation
  // segment arrives on it, not as its own response.
  const client = await page.context().newCDPSession(page)
  await client.send("Network.enable")
  const liveRequests = new Set<string>()
  let liveBytes = 0
  client.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.includes("/__parton/live")) liveRequests.add(e.requestId)
  })
  client.on("Network.dataReceived", (e) => {
    if (liveRequests.has(e.requestId)) liveBytes += e.dataLength
  })

  // Initial page load. After this, the client's manifest has entries
  // for head, nav, header, hero, stats, species, trivia — all with
  // their current fingerprints — and the attach presented them.
  await page.goto("/pokemon/1")
  await page.waitForSelector("header", { timeout: 10000 })
  await waitForPageInteractive(page)

  // Trigger a nav that opens the search overlay. The `?search=url`
  // param makes stage-1 appear (a genuinely new mount — its bytes are
  // fresh by design), then close it again: the RETURN nav's segment
  // is the fp-skip measurement — every partial in the tree is
  // unchanged and the mirror holds all of them, so the segment is
  // placeholders.
  await page
    .getByRole("button", { name: /Search \(URL\)/ })
    .and(page.locator("[data-hydrated]"))
    .click()
  await page.waitForSelector("input[type=text][data-hydrated]", { timeout: 10000 })

  const beforeReturn = liveBytes
  await page.keyboard.press("Escape")
  await expect(page.locator("input[type=text][data-hydrated]")).toHaveCount(0, {
    timeout: 10000,
  })
  const firstReturnBytes = liveBytes - beforeReturn
  console.log(`first return-nav segment: ${firstReturnBytes} bytes`)

  // The FIRST return pays one-time effects — the stages' cold-record
  // gates and first-park variant emissions (over-fetch, never stale).
  // The steady state is the fp-skip claim: round-trip again and
  // measure the second return.
  await page
    .getByRole("button", { name: /Search \(URL\)/ })
    .and(page.locator("[data-hydrated]"))
    .click()
  await page.waitForSelector("input[type=text][data-hydrated]", { timeout: 10000 })
  const beforeReturn2 = liveBytes
  await page.keyboard.press("Escape")
  await expect(page.locator("input[type=text][data-hydrated]")).toHaveCount(0, {
    timeout: 10000,
  })
  const returnBytes = liveBytes - beforeReturn2
  console.log(`steady-state return-nav segment: ${returnBytes} bytes`)

  // Fetch a cold DOCUMENT of the page (no manifest) for scale — the
  // server renders everything fresh there.
  const coldResponse = await page.request.get(`${new URL(page.url()).origin}/pokemon/1`)
  const coldSize = (await coldResponse.body()).byteLength
  console.log(`cold document (no cache): ${coldSize} bytes`)

  // The steady-state return re-renders only what the URL change
  // touched (the header's SearchToggle) — everything else skips to a
  // placeholder. Expect a small fraction of the cold render.
  expect(
    returnBytes,
    `steady-state return segment (${returnBytes} bytes) is not much smaller than cold (${coldSize} bytes) — fingerprint skip may not be firing`,
  ).toBeLessThan(coldSize * 0.25)
})
