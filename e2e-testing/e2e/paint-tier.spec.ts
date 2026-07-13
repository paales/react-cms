import { expect, test, type Page } from "./fixtures"

/**
 * /paint-tier-demo — the Paint tier (`<RemoteFrame grant="paint">`).
 *
 * Two e2e-magento pages embed cross-origin under a Paint grant:
 *  (a) the vocabulary-only page splices and paints;
 *  (b) a page carrying a raw `<div>` and a client component gets
 *      those rows degraded (dropped; DEV renders the visible
 *      `parton-tier-violation` marker — the dev servers this suite
 *      runs against are DEV builds) while its vocabulary siblings
 *      still paint;
 *  (c) zero script/module (or any non-image) browser traffic to the
 *      remote origin — below the Client tier no remote module loads;
 *      the only remote-attributable request is the vocabulary
 *      `Image`'s `src`;
 *  (d) host CSS custom properties (`--parton-text-color`) reach the
 *      embedded vocabulary through the containment boundary.
 */

const REMOTE_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

/** Collect every browser request aimed at the remote origin. */
function recordRemoteRequests(page: Page): { url: string; type: string }[] {
  const out: { url: string; type: string }[] = []
  page.on("request", (req) => {
    if (req.url().startsWith(REMOTE_ORIGIN)) {
      out.push({ url: req.url(), type: req.resourceType() })
    }
  })
  return out
}

test("a vocabulary-only page splices and paints under a Paint grant", async ({ page }) => {
  await page.goto("/paint-tier-demo", { timeout: 30000 })

  const summary = page.getByTestId("paint-summary")
  await expect(summary).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("paint-summary-total")).toContainText("EUR 127.45")

  // The content arrived as vocabulary tags, host-styled: the stack
  // lays out via the host's stylesheet (display:flex proves the
  // vocabulary CSS resolved from the HOST bundle).
  const themed = page.getByTestId("paint-demo-themed")
  const stackDisplay = await themed
    .locator("parton-stack")
    .first()
    .evaluate((el) => getComputedStyle(el).display)
  expect(stackDisplay).toBe("flex")

  // The pure page carries no violation markers.
  await expect(themed.locator("parton-tier-violation")).toHaveCount(0)

  // The granted embed sits in the host-defined box with containment.
  const contain = await themed
    .locator("parton-embed-box")
    .evaluate((el) => getComputedStyle(el).contain)
  // Browsers serialize either the shorthand or the longhand set.
  expect(contain === "strict" || (contain.includes("size") && contain.includes("paint"))).toBe(true)
})

test("non-vocabulary rows degrade in place while the rest of the page paints", async ({ page }) => {
  await page.goto("/paint-tier-demo", { timeout: 30000 })

  const mixed = page.getByTestId("paint-demo-mixed")
  await expect(mixed.getByTestId("paint-mixed-before")).toBeVisible({ timeout: 15000 })

  // Both violating rows resolved to nothing…
  await expect(mixed.getByTestId("paint-mixed-raw")).toHaveCount(0)
  await expect(page.getByText("raw div leak")).toHaveCount(0)
  await expect(mixed.getByTestId("paint-leak-widget")).toHaveCount(0)

  // …replaced by the DEV markers (dev servers → dev splice), naming
  // the offenses…
  const markers = mixed.locator("parton-tier-violation")
  await expect(markers).toHaveCount(2)
  await expect(markers.first()).toHaveAttribute("data-offense", "element")
  await expect(markers.first()).toHaveAttribute("data-type", "div")
  await expect(markers.nth(1)).toHaveAttribute("data-offense", "module")

  // …while the vocabulary siblings around them still painted.
  await expect(mixed.getByTestId("paint-mixed-after")).toBeVisible()
})

test("no remote module loads under Paint — only the image src touches the remote origin", async ({
  page,
}) => {
  const remoteRequests = recordRemoteRequests(page)
  await page.goto("/paint-tier-demo", { timeout: 30000 })
  await expect(page.getByTestId("paint-summary")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("paint-mixed-after")).toBeVisible({ timeout: 15000 })

  // Give any late module fetch a beat to fire, then assert: every
  // remote-origin request the browser made is the vocabulary Image's
  // src — no script, no dynamic import, no fetch/XHR, nothing else.
  await expect
    .poll(() => remoteRequests.filter((r) => r.type === "image").map((r) => r.url))
    .toContain(`${REMOTE_ORIGIN}/paint-logo.svg`)
  const nonImage = remoteRequests.filter((r) => r.type !== "image")
  expect(nonImage).toEqual([])
})

test("host CSS custom properties reach the embedded vocabulary", async ({ page }) => {
  await page.goto("/paint-tier-demo", { timeout: 30000 })
  const themed = page.getByTestId("paint-demo-themed")
  await expect(themed.getByTestId("paint-summary-total")).toBeVisible({ timeout: 15000 })

  // `--parton-text-color` set on the HOST wrapper computes on the
  // EMBEDDED parton-text (default tone) — custom properties inherit
  // through the `contain: strict` boundary.
  const color = await themed
    .getByTestId("paint-summary-subtotal")
    .evaluate((el) => getComputedStyle(el).color)
  expect(color).toBe("rgb(190, 24, 93)")

  // And the gap variable resizes the stack's layout.
  const gap = await themed
    .locator("parton-stack")
    .first()
    .evaluate((el) => getComputedStyle(el).gap)
  expect(gap).toBe("14px")
})
