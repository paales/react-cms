import { expect, test } from "@playwright/test"
import { counterValue, pin, ready, restartBackends, spyOnBus, updateOn, valueOn } from "./helpers"

/**
 * Bus scenario (the prototype's G, over the landed seam): two
 * processes over ONE SQLite store; a cell write in process A reaches a
 * live viewer attached to process B — bridge doorbell → registry
 * commit (fresh local ts) → wake index → lane. And the wire between
 * the processes carries selectors ONLY: the broker spy proves zero
 * values crossed.
 */

test.beforeAll(async ({ request }) => {
  await restartBackends(request, [0, 1], { resetStore: true })
})

test("a write on backend 0 reaches a live viewer on backend 1; zero values on the wire", async ({
  browser,
  request,
}) => {
  const spy = await spyOnBus()

  const viewerCtx = await browser.newContext()
  await pin(viewerCtx, 1)
  const viewer = await viewerCtx.newPage()
  await viewer.goto("/")
  await ready(viewer)
  const v0 = await counterValue(viewer)

  // The write lands on backend 0 directly (bypassing the proxy) — the
  // viewer's process never executes it.
  const { value: committed } = await updateOn(request, 0)
  expect(committed).toBe(v0 + 1)

  // The viewer's parked connection on backend 1 wakes on the forwarded
  // doorbell, re-reads the shared store, and the lane ships the new
  // count — no reload, no refetch from the test.
  await expect(viewer.getByTestId("counter")).toHaveText(`Count: ${v0 + 1}`, { timeout: 10_000 })

  // Both processes read the same committed row through their own
  // handles (the store is the truth).
  expect(await valueOn(request, 0)).toBe(v0 + 1)
  expect(await valueOn(request, 1)).toBe(v0 + 1)

  // The doorbell wire: every relayed line is exactly {origin,
  // selectors} with the counter's selector — no value field, no
  // payload of any shape.
  const lines = spy.lines()
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) {
    const batch = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(batch).sort()).toEqual(["origin", "selectors"])
    expect(typeof batch.origin).toBe("string")
    expect(batch.selectors).toEqual(["cell:mp.counter"])
  }
  console.log(`[bus] ${lines.length} doorbell line(s) relayed; each exactly {origin, selectors}`)

  spy.close()
  await viewerCtx.close()
})

test("doorbells fan out in BOTH directions — a backend-1 write wakes a backend-0 viewer", async ({
  browser,
  request,
}) => {
  const viewerCtx = await browser.newContext()
  await pin(viewerCtx, 0)
  const viewer = await viewerCtx.newPage()
  await viewer.goto("/")
  await ready(viewer)
  const v0 = await counterValue(viewer)

  const { value: committed } = await updateOn(request, 1)
  expect(committed).toBe(v0 + 1)
  await expect(viewer.getByTestId("counter")).toHaveText(`Count: ${v0 + 1}`, { timeout: 10_000 })

  await viewerCtx.close()
})
