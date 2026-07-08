import {
  clearCaches,
  test,
  expect,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * `useNavigation().preload(target)` — hover-eager warm of a
 * destination, the forward-looking counterpart to keepalive. The nav
 * links (`NavLinkActive`) fire `nav.preload(href)` on pointer-enter:
 * a WARM statement (a lossy `warm` frame on the channel) naming the
 * destination. The server's park point runs one byte-silent
 * whole-tree render of the target into its caches — nothing reaches
 * the client, nothing navigates. The actual click stays an ordinary
 * navigation statement; it just lands on warm server caches.
 *
 * This asserts the observable wire behaviour:
 *   1. hovering a link ships exactly one `warm` frame stating the
 *      destination;
 *   2. the current page does NOT navigate while it warms;
 *   3. the subsequent click still navigates normally (no regression).
 *
 * The server half (the park-point render of the stated target) is
 * pinned in `framework/src/lib/__tests__/attach-intent.rsc.test.tsx`.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("hovering a nav link states a warm intent without navigating", async ({ page }) => {
  const warmTargets: string[] = []
  page.on("request", (req) => {
    if (!req.url().includes("/__parton/channel")) return
    try {
      const envelope = JSON.parse(req.postData() ?? "") as {
        frames?: Array<{ kind: string; url?: string }>
      }
      for (const frame of envelope.frames ?? []) {
        if (frame.kind === "warm" && frame.url) warmTargets.push(frame.url)
      }
    } catch {}
  })

  await page.goto("/cache-demo")
  await expect(page.getByTestId("click-counter")).toBeVisible({
    timeout: 15000,
  })
  await waitForPageInteractive(page)
  // A warm intent is advisory — it only ships on an established
  // connection.
  await waitForLiveConnection(page)

  // Hover the Defer Demo link — pointer-enter fires `nav.preload(href)`.
  await page.getByRole("link", { name: /Defer Demo/ }).hover()

  await expect
    .poll(() => warmTargets.some((u) => u.startsWith("/defer-demo")), {
      timeout: 10000,
    })
    .toBe(true)

  // Warm-only: the preload must NOT navigate. Still on /cache-demo,
  // with its client state (the counter) untouched and the URL
  // unchanged.
  await expect(page.getByTestId("click-counter")).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/cache-demo")

  // No regression: the click still navigates normally (now warm).
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.getByTestId("activate-manual")).toBeVisible({
    timeout: 10000,
  })
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
})

test("clicking immediately after the hover-preload still navigates (no race)", async ({ page }) => {
  // The race guard: a single `.click()` fires pointer-enter (→ the
  // warm statement) then the click (→ the navigation statement)
  // back-to-back, so the warm render is still pending server-side when
  // the navigation consumes. Real statements outrank speculation — the
  // destination must paint normally, not stick on the prior page.
  await page.goto("/cache-demo")
  await expect(page.getByTestId("click-counter")).toBeVisible({
    timeout: 15000,
  })
  await waitForPageInteractive(page)

  // No prior hover / poll — the warm has no head start, so it's
  // genuinely pending at nav time.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.getByTestId("activate-manual")).toBeVisible({
    timeout: 10000,
  })
  expect(new URL(page.url()).pathname).toBe("/defer-demo")
})
