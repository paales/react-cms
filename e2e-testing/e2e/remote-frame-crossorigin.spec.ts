import { expect, request, test } from "./fixtures"

/**
 * /remote-frame-crossorigin-demo — true cross-origin `<RemoteFrame>`.
 *
 * The remote app (`e2e-magento`) must be running on port 5181 in
 * parallel with the host (`e2e-testing` on 5173). The Playwright
 * web-server config starts the host but not the remote — if the
 * remote isn't up, these tests skip cleanly with a clear error.
 */

const REMOTE_ORIGIN = "http://localhost:5181"

test.beforeAll(async () => {
  // Skip the suite if e2e-magento isn't running. The user can
  // start it with `yarn dev:magento` in a separate terminal.
  // 15s timeout — vite's first hit on `/__remote/<id>` forces a
  // cold compile of the parton module, which on a clean dep cache
  // can take several seconds.
  const ctx = await request.newContext()
  try {
    const probe = await ctx.get(`${REMOTE_ORIGIN}/__remote/magento-greeting`, {
      timeout: 15000,
    })
    if (!probe.ok()) test.skip(true, "e2e-magento returned non-2xx")
  } catch {
    test.skip(true, `e2e-magento not running at ${REMOTE_ORIGIN}; run yarn dev:magento`)
  } finally {
    await ctx.dispose()
  }
})

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches?all=1`)
  await ctx.dispose()
})

test("host renders cross-origin magento-greeting", async ({ page }) => {
  // Longer goto timeout — the first hit to /__remote/<id> on the
  // magento dev server forces vite to compile the parton (cold
  // optimizeDeps); subsequent hits are fast.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  await expect(page.getByTestId("rfxd-header")).toBeVisible({ timeout: 10000 })

  // Both cross-origin frames arrive after their respective delays.
  await expect(page.getByTestId("magento-greeting")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("magento-stocks")).toBeVisible({ timeout: 15000 })

  // The greeting card carries text identifying its origin.
  await expect(page.getByTestId("magento-greeting")).toContainText("e2e-magento")
})

test("cross-origin remote endpoint returns Flight + snapshot trailer", async ({
  request,
}) => {
  const response = await request.get(`${REMOTE_ORIGIN}/__remote/magento-greeting`)
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toMatch(/^text\/x-component/)
  // CORS header for browser fetches.
  expect(response.headers()["access-control-allow-origin"]).toBe("*")

  // Buffer the response and look for the snapshot trailer marker.
  const bytes = new Uint8Array(await response.body().then((b) => b.buffer))
  const marker = new Uint8Array([
    0xff, 0xfe,
    ...new TextEncoder().encode("snapshot"),
    0xfd, 0xfc,
  ])
  let foundAt = -1
  for (let i = 0; i <= bytes.length - marker.length; i++) {
    let match = true
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) {
        match = false
        break
      }
    }
    if (match) {
      foundAt = i
      break
    }
  }
  expect(foundAt, "snapshot trailer marker must be present").toBeGreaterThanOrEqual(0)
})

test("capability-scoped remote reads host-declared values", async ({ page }) => {
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })

  // The host passes { cart_id, currency, total } via the
  // `capability` prop on RemoteFrame. The remote spec reads them
  // via `getCapability()` and renders them into its body.
  const summary = page.getByTestId("magento-payment-summary")
  await expect(summary).toBeVisible({ timeout: 15000 })
  await expect(summary).toContainText("demo-cart-7f3a9")
  await expect(summary).toContainText("EUR")
  await expect(page.getByTestId("magento-payment-total")).toContainText("127.45")
})

test("selector refetch routes back to the cross-origin remote (server wire)", async ({
  request,
}) => {
  // Wire-level validation that doesn't depend on the host page
  // rendering successfully (cross-origin dev rendering depends on
  // vite-rsc module IDs happening to be `/@fs/` paths, which
  // varies session-to-session). We:
  //  1. Hit `/remote-frame-crossorigin-demo` once to register
  //     magento-stocks in the host's registry with source stamped.
  //  2. Issue the cache-mode refetch URL.
  //  3. Assert the response is cache-mode (not streaming-mode
  //     fallback) and carries a fresh data-tick (proving the
  //     remote was re-fetched and re-rendered).
  await request.get("/remote-frame-crossorigin-demo")
  // Capture the initial tick.
  const initial = await request.get(
    "/remote-frame-crossorigin-demo_.rsc?partials=magento-stocks",
  )
  const initialBody = await initial.text()
  const initialTickMatch = initialBody.match(/"data-tick":"(\d+)"/)
  expect(initialTickMatch).not.toBeNull()
  const initialTick = initialTickMatch?.[1] ?? ""

  // Wait long enough that Date.now() differs.
  await new Promise((r) => setTimeout(r, 30))

  // Second refetch — fresh remote render → fresh tick.
  const refetch = await request.get(
    "/remote-frame-crossorigin-demo_.rsc?partials=magento-stocks",
  )
  expect(refetch.status()).toBe(200)
  const body = await refetch.text()

  // The response must be cache-mode (not the streaming-mode
  // fallback / full Root render).
  expect(body, "expected cache-mode response (PartialsClient mode=cache)").toContain(
    '"mode":"cache"',
  )
  // The data-tick must have advanced — proves the remote was
  // re-fetched and the spec's `vary: () => ({ tick: Date.now() })`
  // produced a new value.
  const tickMatch = body.match(/"data-tick":"(\d+)"/)
  expect(tickMatch, "response must contain data-tick from a fresh remote render").not.toBeNull()
  const refetchTick = tickMatch?.[1] ?? ""
  expect(Number(refetchTick)).toBeGreaterThan(Number(initialTick))
})

test("frame navigation within a cross-origin RemoteFrame", async ({ page }) => {
  // Wraps a cross-origin RemoteFrame in a `<Frame name="checkout">`.
  // Buttons inside call `useNavigation("checkout").navigate(?step=…)`
  // which updates the frame URL. A wrapper parton reads the frame
  // URL's `?step=` via `vary` and threads it into the RemoteFrame's
  // src, causing a re-fetch with new content.
  //
  // What this proves: the existing <Frame> + parton + RemoteFrame
  // primitives COMPOSE to give per-RemoteFrame navigation without
  // any new framework code. Other frames on the page are unaffected;
  // the page URL doesn't change.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const card = page.getByTestId("magento-checkout-step")
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(card).toHaveAttribute("data-step", "shipping")

  await page.getByTestId("checkout-step-payment").click()
  await expect(card).toHaveAttribute("data-step", "payment", { timeout: 5000 })

  await page.getByTestId("checkout-step-review").click()
  await expect(card).toHaveAttribute("data-step", "review", { timeout: 5000 })

  // Browser URL didn't change — the frame has its own URL space.
  expect(new URL(page.url()).pathname).toBe("/remote-frame-crossorigin-demo")
})

test("remote without capability sees no host values", async ({ request }) => {
  // Direct fetch with no x-parton-capability header — getCapability
  // returns {} on the remote side, so the body falls back to defaults
  // (cart_id=<missing>, USD, 0). Response is Flight bytes (JSON-ish),
  // not HTML — angle brackets are raw, not entity-escaped.
  const response = await request.get(
    `${REMOTE_ORIGIN}/__remote/magento-payment-summary`,
  )
  expect(response.status()).toBe(200)
  const text = await response.text()
  expect(text).toContain("<missing>")
  expect(text).toContain("USD")
})
