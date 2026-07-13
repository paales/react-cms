import { clearCaches, expect, test, waitForLiveConnection } from "./fixtures"

/**
 * /remote-cell-demo — remoteCell (the outward state contract), two
 * REAL processes: e2e-testing (host) reads `magento.bid`, a cell the
 * e2e-magento process owns and publishes.
 *
 * The loop under test: a write committed in the REMOTE process →
 * committed-bump batch on the host's held server-to-server attach →
 * host drops its cached value + re-emits through
 * `deliverInvalidationBumps` → the host parton that read the
 * remoteCell re-renders (fresh value re-read over the value
 * endpoint) → the update lands on the browser's held live connection.
 * No reload, no polling — the DOM moves because the remote's store
 * did.
 */

const REMOTE_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

test.beforeEach(async ({ baseURL, request }) => {
  await clearCaches(baseURL)
  await request.get(`${REMOTE_ORIGIN}/__test/clear-caches`)
})

test("a remote-side cell write re-renders the host parton live", async ({ page, request }) => {
  await page.goto("/remote-cell-demo", { timeout: 30000 })
  const bid = page.getByTestId("remote-cell-bid")
  await expect(bid).toBeVisible({ timeout: 15000 })
  // Server-pushed updates need the held connection.
  await waitForLiveConnection(page)

  const before = Number((await bid.textContent())!.replace(/[^0-9]/g, ""))
  const next = before + 173

  // Commit the write IN THE REMOTE PROCESS (its open write endpoint —
  // the same pipeline an interactive embed's field rides).
  const res = await request.post(`${REMOTE_ORIGIN}/__remote/cells/write`, {
    data: { cell: "magento.bid", value: next },
  })
  expect(res.status()).toBe(204)

  // Doorbell → drop → re-read → host parton lane on the held stream.
  await expect(bid).toHaveText(`EUR ${next}`, { timeout: 15000 })
})

test("the remote's manifest advertises the published cell", async ({ request }) => {
  const res = await request.get(`${REMOTE_ORIGIN}/__remote/manifest.json`)
  expect(res.status()).toBe(200)
  const manifest = (await res.json()) as {
    publishes: string[]
    specs: { selector: string; cells: unknown }[]
  }
  expect(manifest.publishes).toContain("magento.bid")
  // And the bound-cells page's requirements ride the same inventory.
  const cartNote = manifest.specs.find((s) => s.selector === "cart-note")
  expect(cartNote?.cells).toEqual({ cart: { required: true }, locale: { required: false } })
})

test("an unpublished cell refuses the attach (403)", async ({ request }) => {
  const res = await request.post(`${REMOTE_ORIGIN}/__remote/cells/attach`, {
    data: { cells: ["magento.qty"] },
  })
  expect(res.status()).toBe(403)
})
