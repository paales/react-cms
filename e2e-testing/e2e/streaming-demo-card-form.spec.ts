import {
  clearCaches,
  test,
  expect,
  waitForLiveConnection,
  waitForPageInteractive,
  type Page,
  scopedContext,
} from "./fixtures"

/**
 * /streaming-demo card-form (card 4) — exercises:
 *
 *  - Three cells (`cardName` / `cardNumber` / `cardCvc`) read via
 *    `schema`, written atomically by `commitCardForm` inside one
 *    `runInvalidationTransaction`.
 *  - Single-inflight + replace-coalesce on the client → strict
 *    send-order writes despite per-action 0–1500 ms random delay.
 *  - Local-transform toggle: when off, the input adopts the
 *    server-formatted value once the action queue drains
 *    (`inflight === null && pending === null`).
 *  - Multi-tab broadcast: `vary: () => ({})` makes the cells global,
 *    so a second page sees the typing-page's commits via its own
 *    open heartbeat stream.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

/**
 * These tests TYPE into cell-bound inputs, and text input is not
 * covered by React's discrete-event replay — a keystroke landing
 * before the input's boundary hydrates is silently lost. Wait for
 * the page-interactive marker AND the inputs' own `data-hydrated`
 * (stamped by the framework's `useCell().input()` callback ref at
 * the commit that wires their onChange pipeline).
 */
async function waitForCardFormReady(page: Page): Promise<void> {
  await waitForPageInteractive(page)
  // Settle the heartbeat's first live fire: a cold→warm re-commit
  // landing mid-typing adopts the PRE-typing server value into the
  // input and swallows the first keystroke. Its own marker says when
  // it's done.
  await waitForLiveConnection(page)
  await page.locator('[data-testid="card-name-input"][data-hydrated]').waitFor({ timeout: 10000 })
  await page.locator('[data-testid="card-number-input"][data-hydrated]').waitFor({ timeout: 10000 })
}

test("local-transform ON: name typed verbatim ends up on the server, CVC fires", async ({
  page,
}) => {
  await page.goto("/streaming-demo")
  await waitForCardFormReady(page)

  const nameInput = page.locator('[data-testid="card-name-input"]')
  await nameInput.fill("JOHN DOE")

  // Server panel adopts the typed value once the queue drains. Max
  // server delay per action is 1500 ms; fill issues one keystroke per
  // char so the queue can grow up to N+1 actions. Generous timeout.
  await expect(page.locator('[data-testid="card-server-name"]')).toContainText("JOHN DOE", {
    timeout: 15000,
  })
  // CVC populated atomically by the same action body.
  await expect(page.locator('[data-testid="card-server-cvc"]')).not.toContainText("cvc: —", {
    timeout: 5000,
  })
})

test("local-transform OFF: input adopts server-formatted value after the queue drains", async ({
  page,
}) => {
  await page.goto("/streaming-demo")
  await waitForCardFormReady(page)

  // Turn off local transform so the input shows raw typing until the
  // server's authoritative value lands.
  await page.locator('[data-testid="card-local-transform"]').uncheck()

  // Type lowercase + special chars; server will uppercase + strip.
  await page.locator('[data-testid="card-name-input"]').fill("john!#@doe")

  // Server-authoritative panel shows the cleaned form (no specials,
  // uppercase).
  await expect(page.locator('[data-testid="card-server-name"]')).toContainText("JOHNDOE", {
    timeout: 15000,
  })

  // Once the framework's auto-batched queue drains, the input itself
  // adopts the server value — the visible "reconcile moment."
  await expect(page.locator('[data-testid="card-name-input"]')).toHaveValue("JOHNDOE", {
    timeout: 10000,
  })
})

test("server inserts spaces in the card number; CVC reflects (name, number)", async ({ page }) => {
  await page.goto("/streaming-demo")
  await waitForCardFormReady(page)

  // Type 8 digits into the number field. Server formats to "1234 5678".
  await page.locator('[data-testid="card-number-input"]').fill("12345678")

  await expect(page.locator('[data-testid="card-server-number"]')).toContainText("1234 5678", {
    timeout: 15000,
  })

  // CVC is derived deterministically from (cleanName, digits). Empty
  // name + "12345678" produces a specific 3-digit code that the
  // computeCvc helper will land on. We don't assert the exact value
  // (would couple the spec to the hash impl) — just that it's the
  // expected 3-char width and stable across re-typing.
  // The CVC write is coin-flipped between the same batch and a 50 ms
  // stagger (see the demo's comment) — poll for the derived value
  // rather than sampling once while the staggered batch is in flight.
  await expect(page.locator('[data-testid="card-server-cvc"]')).toHaveText(/cvc: \d{3}$/)
})

test("rapid typing — every character ends up on the server in send-order", async ({ page }) => {
  await page.goto("/streaming-demo")
  await waitForCardFormReady(page)

  // pressSequentially fires one keystroke per char with no built-in
  // delay; the framework's auto-batched coalescer is single-inflight
  // so it commits the FINAL snapshot in strict send-order regardless
  // of how the per-batch latency simulator shakes out.
  const target = "THEQUICKBROWNFOX"
  await page.locator('[data-testid="card-name-input"]').pressSequentially(target, {
    delay: 30,
  })

  // Worst case: every keystroke fires + the per-batch latency tops out
  // at ~500 ms. With single-inflight the drain takes at most a couple
  // of seconds after the last keystroke. The server-authoritative
  // panel reflects the entire typed string once the queue drains.
  await expect(page.locator('[data-testid="card-server-name"]')).toContainText(target, {
    timeout: 20000,
  })
})

test("auto-batch: per-keystroke writes coalesce into a small number of POSTs", async ({ page }) => {
  await page.goto("/streaming-demo")
  await waitForCardFormReady(page)

  const postUrls: string[] = []
  page.on("request", (req) => {
    if (req.method() !== "POST") return
    const url = req.url()
    if (!url.includes("_.rsc")) return
    postUrls.push(url)
  })

  // 8 keystrokes. Per keystroke the client fires setName + setNumber
  // (always synchronous) + setCvc (50/50 same-batch vs +50 ms). With
  // the framework's single-inflight + microtask-coalesced batcher,
  // each keystroke produces AT MOST 2 batches (one for name/number,
  // optionally one for CVC); and consecutive keystrokes during an
  // in-flight batch accumulate into the next batch instead of firing
  // their own POSTs. So 8 keystrokes never produce 24 (3×8) POSTs —
  // typically far fewer.
  await page.locator('[data-testid="card-name-input"]').pressSequentially("ABCDEFGH", {
    delay: 50,
  })
  await page.waitForTimeout(2500)

  // The exact count is timing-sensitive (depends on how many batches
  // coalesce). The hard upper bound is 16 (2 per keystroke if every
  // keystroke is in its own tick AND the CVC always staggers); the
  // hard lower bound is 1 (everything coalesces into one super-batch).
  // Assert we never see the un-batched 24 — if we do, the coalescer is
  // broken.
  expect(
    postUrls.length,
    `expected < 24 POSTs (would mean no coalescing); saw ${postUrls.length}`,
  ).toBeLessThan(24)
  // And at least one — sanity check.
  expect(postUrls.length).toBeGreaterThanOrEqual(1)
})

test("multi-page broadcast: a second tab sees the typing tab's commits via its heartbeat", async ({
  browser,
  testScope,
  baseURL,
}) => {
  // Two independent page contexts sharing the same x-test-scope so
  // they look at the same per-worker cell store. Each page mounts its
  // own LivePageHeartbeat, holds its own streaming connection; cell
  // writes from page A wake page B's segment driver via the shared
  // invalidation registry. `scopedContext` carries the scope as header
  // AND cookie — the auto-upgraded WebSocket handshake only sees the
  // cookie, and a socket without it lands in the default scope, deaf
  // to this worker's writes.
  const ctxA = await scopedContext(browser, testScope, baseURL!)
  const ctxB = await scopedContext(browser, testScope, baseURL!)
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await Promise.all([pageA.goto("/streaming-demo"), pageB.goto("/streaming-demo")])
    await Promise.all([waitForCardFormReady(pageA), waitForCardFormReady(pageB)])

    await pageA.locator('[data-testid="card-name-input"]').fill("HELLO B")

    // Page B never touched its input — yet its server-authoritative
    // panel updates because the heartbeat stream landed a segment
    // with the new cell value.
    await expect(pageB.locator('[data-testid="card-server-name"]')).toContainText("HELLO B", {
      timeout: 15000,
    })
    // Page B's input ALSO adopts (no inflight/pending on B; the
    // safe-moment rule applies).
    await expect(pageB.locator('[data-testid="card-name-input"]')).toHaveValue("HELLO B", {
      timeout: 5000,
    })
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
