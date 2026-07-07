import { clearCaches, expect, recordPartialDispatches, request, test } from "./fixtures"

/**
 * /remote-frame-crossorigin-demo — true cross-origin `<RemoteFrame>`.
 *
 * The remote app (`e2e-magento`) runs alongside the host: both are
 * Playwright-managed webServers (see `playwright.config.ts`), so no
 * manual `yarn dev:magento` terminal is needed. The config exports
 * the remote's origin as `MAGENTO_REMOTE_ORIGIN` — the same env var
 * the host's generated bindings (`src/remote/magento/`) read — so a
 * port remap stays a single-constant change in the config.
 */

const REMOTE_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("host renders cross-origin magento-greeting", async ({ page }) => {
  // Longer goto timeout — the first hit to /__remote/<id> on the
  // magento dev server forces vite to compile the parton (cold
  // optimizeDeps); subsequent hits are fast.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  await expect(page.getByTestId("rfxd-header")).toBeVisible({ timeout: 10000 })

  // Both cross-origin frames arrive after their respective delays.
  await expect(page.getByTestId("magento-greeting")).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByTestId("magento-stocks")).toBeVisible({
    timeout: 15000,
  })

  // The greeting card carries text identifying its origin.
  await expect(page.getByTestId("magento-greeting")).toContainText("e2e-magento")
})

test("cross-origin remote endpoint returns Flight + snapshot trailer", async ({ request }) => {
  const response = await request.get(`${REMOTE_ORIGIN}/__remote/magento-greeting`)
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toMatch(/^text\/x-component/)
  // CORS header for browser fetches.
  expect(response.headers()["access-control-allow-origin"]).toBe("*")

  // Buffer the response and look for the snapshot trailer marker.
  // Wire shape per `fp-trailer-marker.ts`: one UTF-8-invalid lead
  // byte (`\xFF`) followed by an ASCII bracketed header
  // (`[parton:snapshots:<length>]\n`) and a length-prefixed JSON
  // body. We scan for the readable header prefix — finding it
  // confirms the remote endpoint is emitting the snapshot trailer.
  // `response.body()` resolves to a Node Buffer (a Uint8Array
  // subclass), which TextDecoder accepts directly — no need to reach
  // through `.buffer`, which types as `ArrayBufferLike` (possibly a
  // SharedArrayBuffer) and breaks the `Uint8Array` ctor overload.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(await response.body())
  expect(text, "snapshot trailer marker must be present").toMatch(/\[parton:snapshots:\d+\]/)
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

test("selector refetch routes back to the cross-origin remote", async ({ page }) => {
  // The `_.rsc?partials=` GET is retired: a selector-targeted refetch is
  // now a `url` frame with a `?__force=` overlay stating the page URL,
  // on the held channel (or the attach it triggers). Drive the page's
  // own refresh button (`nav.reload({selector})`) and prove the refetch
  // ROUTES through the channel — the dispatch's `__force` overlay names
  // the remote's addressable id — and the stock ticker stays rendered.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const stocks = page.getByTestId("magento-stocks")
  await expect(stocks).toBeVisible({ timeout: 15000 })

  const dispatches = recordPartialDispatches(page)
  await page
    .getByTestId("rfd-refresh-magento-stocks")
    .and(page.locator("[data-hydrated]"))
    .click()

  // The refetch routed as a selector-targeted dispatch on the channel
  // (the `__force` overlay names the stocks selector), not a full-page
  // nav — the wire signal that the refetch reached the host's refetch
  // machinery for the remote's namespaced id.
  await expect
    .poll(
      () => dispatches.filter((d) => d.partials?.includes("magento-stocks")).length,
      { timeout: 10000 },
    )
    .toBeGreaterThan(0)
  await expect(stocks).toBeVisible()
})

test("nested cross-origin partial is registered via the commit-defer trailer", async ({ page }) => {
  // `MagentoStockTicker` (rendered on magento) embeds an addressable
  // child `MagentoCartSummary` (`magento:cart-summary`). The child's
  // snapshot only ever reaches the host's registry through the trailer
  // that ships with its PARENT's render — the commit-defer mechanism
  // holds the RemoteFrame's commit open until every nested snapshot is
  // registered. Its presence, freshly rendered with a numeric
  // `data-tick` from the remote, proves the nested snapshot landed
  // (without commit-defer it would race and the nested id would never
  // register).
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const nested = page.getByTestId("magento-cart-summary")
  await expect(nested, "nested cart-summary must reach the host registry").toBeVisible({
    timeout: 15000,
  })
  expect(await nested.getAttribute("data-tick")).toMatch(/^\d+$/)
})

test("namespacing prevents collisions: bare selector doesn't hit remote", async ({ request }) => {
  // The remote's spec is registered locally as `magento:magento-stocks`.
  // A refetch URL that targets the bare id `magento-stocks` (without
  // the namespace prefix) must NOT route to the remote — the host's
  // registry doesn't have anything under that key, so the request
  // falls through to streaming-mode (a full Root render) rather than
  // accidentally returning the remote's bytes.
  await request.get("/remote-frame-crossorigin-demo")

  const bare = await request.get("/remote-frame-crossorigin-demo_.rsc?partials=magento-stocks")
  const body = await bare.text()
  // No cache-mode marker → fell through to streaming-mode (full
  // Root render), which is the correct behavior for an unknown
  // selector. The bare id doesn't accidentally collide with the
  // namespaced remote registration.
  expect(body, "bare id must not resolve to the namespaced remote").not.toContain('"mode":"cache"')
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
  const response = await request.get(`${REMOTE_ORIGIN}/__remote/magento-payment-summary`)
  expect(response.status()).toBe(200)
  const text = await response.text()
  expect(text).toContain("<missing>")
  expect(text).toContain("USD")
})
