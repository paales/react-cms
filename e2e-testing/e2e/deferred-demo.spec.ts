import { test, expect, request } from "./fixtures"

/**
 * /deferred-demo — a `deferred` cell write propagates ONLY over the
 * open streaming connection, never on the action POST.
 *
 *  - heartbeat ON:  Ping → the value lands via a heartbeat segment.
 *  - heartbeat OFF: Ping → the write round-trips (`sent:` advances) but
 *    nothing commits (`Pings:` is frozen) — the POST carried a null
 *    root, so there was nothing to commit.
 *
 * Together they show the value rides the stream, not the POST — the
 * whole point of `deferred`.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5379"}/__test/clear-caches`)
  await ctx.dispose()
})

// Wait for the page's use-client subtree to hydrate — `DeferredDemoReady`
// stamps `data-deferred-demo-ready` on `<body>` from a post-commit
// effect, by which point the Ping button's onClick is attached. Without
// it a fast Playwright click can land on the SSR DOM before
// `hydrateRoot` installs its delegated listener and no-op.
async function waitForReady(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("body[data-deferred-demo-ready]").waitFor({ timeout: 10000 })
}

test("deferred write propagates over the open heartbeat stream", async ({ page }) => {
  await page.goto("/deferred-demo")
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 0", {
    timeout: 10000,
  })
  await waitForReady(page)

  await page.locator('[data-testid="deferred-ping-btn"]').click()
  // The action POST returns no root; the new value arrives on the next
  // heartbeat segment. Generous timeout — the heartbeat may need to
  // (re)open its streaming connection before the bump lands.
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 1", {
    timeout: 15000,
  })

  await page.locator('[data-testid="deferred-ping-btn"]').click()
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 2", {
    timeout: 15000,
  })
})

test("with the heartbeat off, the write completes but nothing commits on the POST", async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled = true
  })
  await page.goto("/deferred-demo")
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 0", {
    timeout: 10000,
  })
  await waitForReady(page)

  await page.locator('[data-testid="deferred-ping-btn"]').click()
  // The write round-trips: `sent:` advances once `pings.set(...)` resolves.
  await expect(page.locator('[data-testid="deferred-ping-sent"]')).toContainText("sent: 1", {
    timeout: 10000,
  })
  // …but with no open stream, the deferred value never commits — the
  // action POST carried a null root, so `Pings:` is unchanged.
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 0")
  // And stays put — no delayed commit arrives.
  await page.waitForTimeout(500)
  await expect(page.locator('[data-testid="deferred-pings"]')).toContainText("Pings: 0")
})
