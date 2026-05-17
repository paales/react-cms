import { expect, request, test } from "./fixtures"

/**
 * /remote-frame-demo — `<RemoteFrame>` integration coverage.
 *
 * Covers:
 *  - Host chrome paints before any remote arrives.
 *  - Multiple remotes stream into the page in parallel (slower
 *    ones don't gate faster ones).
 *  - A `"use client"` component inside a remote spec hydrates and
 *    is interactive in the host's browser.
 *  - A remote spec with `cache: { maxAge }` returns from cache on
 *    the second fetch.
 *  - Selector-based refetch updates the affected remote's content.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches?all=1`)
  await ctx.dispose()
})

test("host chrome paints before any remote arrives", async ({ page }) => {
  await page.goto("/remote-frame-demo", { waitUntil: "commit" })

  // Header + controls + footer are in the host's first stream chunk;
  // remote bodies arrive later via SSR Suspense reveals.
  await expect(page.getByTestId("rfd-header")).toBeVisible({ timeout: 2000 })
  await expect(page.getByTestId("rfd-controls")).toBeVisible({ timeout: 2000 })
  await expect(page.getByTestId("rfd-footer")).toBeVisible({ timeout: 2000 })

  // The remote-slow card (1000ms) should arrive eventually.
  await expect(page.getByTestId("remote-slow")).toBeVisible({ timeout: 5000 })
})

test("multiple remotes stream in parallel (fastest arrives well before slowest)", async ({
  page,
}) => {
  await page.goto("/remote-frame-demo", { waitUntil: "commit" })

  const fastStart = Date.now()
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  const fastT = Date.now() - fastStart

  await page.waitForSelector('[data-testid="remote-slow"]', { timeout: 5000 })
  const slowT = Date.now() - fastStart

  // remote-fast (200ms) vs remote-slow (1000ms). If they were
  // serialized, fast would be ~200ms and slow would be ~1200ms.
  // In parallel both fire concurrently. fast arrives < slow by at
  // least ~500ms — generous slack for the SSR stream pipeline.
  expect(
    slowT - fastT,
    `parallel streaming check: fast=${fastT}ms slow=${slowT}ms`,
  ).toBeGreaterThan(400)
})

test("client component inside a remote spec hydrates and is interactive", async ({ page }) => {
  await page.goto("/remote-frame-demo")

  // Wait for the remote that contains ClickCounter.
  await page.waitForSelector('[data-testid="remote-counter-mount"]', { timeout: 5000 })

  // Scope the ClickCounter query to the remote-counter mount — the
  // cached-region demo has its own copy and we don't want to grab it.
  const counter = page
    .getByTestId("remote-counter-mount")
    .getByTestId("click-counter")

  await expect(counter).toHaveText(/clicked 0/, { timeout: 5000 })
  await counter.click()
  await expect(counter).toHaveText(/clicked 1/)
  await counter.click()
  await expect(counter).toHaveText(/clicked 2/)
})

test("cached remote spec: second direct fetch is faster than the first", async ({
  request,
}) => {
  const coldStart = Date.now()
  await request.get("/__remote/remote-cached")
  const coldMs = Date.now() - coldStart

  const warmStart = Date.now()
  await request.get("/__remote/remote-cached")
  const warmMs = Date.now() - warmStart

  // Cold pays the 500ms artificial delay; warm hits the cache and
  // returns immediately. Generous bounds for CI.
  expect(coldMs).toBeGreaterThan(400)
  expect(warmMs).toBeLessThan(coldMs / 3)
})

test("refresh button updates a remote frame's timestamp", async ({ page }) => {
  // Validates the unified-addressing loop closed by the snapshot
  // trailer (`snapshot-trailer.ts`): the remote endpoint ships
  // PartialBoundary snapshots as a trailing JSON segment after
  // its Flight bytes. The host's <RemoteFrame> parses the trailer
  // and re-registers each snapshot in the host's request registry.
  // `nav.reload({selector: "remote-fast"})` then finds the id and
  // routes through the normal cache-mode refetch path — in same-
  // origin v1 the refetch hits the host's local copy of the spec
  // (the catalog has it). v2 cross-origin will need a
  // `source: "remote:<origin>"` annotation to route refetches
  // back to the remote endpoint.
  await page.goto("/remote-frame-demo")
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })

  const card = page.getByTestId("remote-fast")
  const initialText = await card.textContent()

  await page.getByTestId("rfd-refresh-remote-fast").click()

  await expect
    .poll(async () => (await card.textContent()) !== initialText, { timeout: 5000 })
    .toBe(true)
})

test("page navigation re-fetches all remote frames with fresh content", async ({ page }) => {
  await page.goto("/remote-frame-demo")
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  const firstText = await page.getByTestId("remote-fast").textContent()

  // Full navigation re-runs the host's render which re-fetches the
  // remote (the remote spec has no cache, so each fetch is fresh).
  // Validates the end-to-end pipeline works across navigation.
  await page.goto("/remote-frame-demo?bust=" + Date.now())
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  const secondText = await page.getByTestId("remote-fast").textContent()

  expect(secondText).not.toBe(firstText)
})
