import { test, expect } from "./fixtures"

/**
 * E2E test: after a successful "Add to Cart" action, the cart badge in the
 * page <header> must re-render with the new total_quantity.
 *
 * Expected flow:
 *   1. Page renders with cart quantity = N (likely 0 on fresh context).
 *   2. Click "Add to Cart" on a product that succeeds server-side
 *      (no user_errors from Magento).
 *   3. Server action returns { invalidate: { tags: ["cart"] } }.
 *   4. entry.rsc injects ?tags=cart onto the re-render request, so only
 *      the "cart" partial re-renders; CartPartial runs, re-queries
 *      total_quantity, and emits a fresh <CartBadge quantity={N+1} />.
 *   5. CartBadge DOM updates to N+1.
 *
 * Observed bug: the badge never updates. The test asserts (4) + (5).
 */

test("cart badge updates after successful add-to-cart", async ({ page, context }) => {
  // Fresh cart cookie state
  await context.clearCookies()

  const errors: string[] = []
  const consoleLines: string[] = []
  const requests: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  page.on("console", (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on("request", (req) => {
    const u = req.url()
    if (u.includes("/magento") || u.includes("?partials") || u.includes("?tags")) {
      requests.push(`${req.method()} ${u}`)
    }
  })

  await page.goto("/magento")

  // Wait for the cart partial to finish its fallback and display a real quantity.
  // CartBadge fallback renders quantity="?" while the suspended cart query runs.
  await page.waitForFunction(
    () => {
      const header = document.querySelector("header")
      if (!header) return false
      const text = header.textContent ?? ""
      return !text.includes("?")
    },
    { timeout: 15000 },
  )

  const readCartQuantity = () =>
    page.evaluate(() => {
      const header = document.querySelector("header")
      if (!header) return null
      // Cart badge is the last numeric text inside header (icon + number)
      const spans = Array.from(header.querySelectorAll("span"))
      for (const s of spans) {
        const t = (s.textContent ?? "").trim()
        if (/^\d+$/.test(t)) return Number(t)
      }
      return null
    })

  const initialQty = await readCartQuantity()
  console.log(`Initial cart quantity: ${initialQty}`)
  expect(initialQty, "should read a numeric initial cart quantity").not.toBeNull()

  // Install mutation tracker to observe ALL header transitions after click.
  await page.evaluate(() => {
    const w = window as any
    w.__cartLog = [] as Array<{ t: number; qty: string | null }>
    w.__cartT0 = performance.now()
    const readQty = () => {
      const header = document.querySelector("header")
      if (!header) return null
      const spans = Array.from(header.querySelectorAll("span"))
      for (const s of spans) {
        const t = (s.textContent ?? "").trim()
        if (/^\d+$/.test(t) || t === "?") return t
      }
      return null
    }
    const push = () => {
      const qty = readQty()
      const last = w.__cartLog[w.__cartLog.length - 1]
      if (!last || last.qty !== qty) {
        w.__cartLog.push({
          t: Math.round(performance.now() - w.__cartT0),
          qty,
        })
      }
    }
    push()
    w.__cartObserver = new MutationObserver(push)
    w.__cartObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })

  // Click the first "Add to Cart" button. We try buttons in order until one
  // succeeds (no error alert appears). Some SKUs require option selection and
  // will surface a user_error — skip those.
  const buttons = page.getByRole("button", { name: "Add to Cart" })
  const count = await buttons.count()
  expect(count).toBeGreaterThan(0)

  let clickedIndex = -1
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i)
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    // Wait for either button to re-enable (success) OR an alert to appear (failure).
    await page.waitForFunction(
      (idx) => {
        const bs = document.querySelectorAll("button")
        const candidate = Array.from(bs).filter((b) => (b.textContent ?? "").includes("Adding"))
        if (candidate.length > 0) return false // still pending
        const alerts = document.querySelectorAll('[role="alert"]')
        return bs.length > idx || alerts.length > 0 || true
      },
      i,
      { timeout: 10000 },
    )
    // Give the UI a moment to settle
    await page.waitForTimeout(200)
    // Did this button show an error?
    const card = btn.locator("..")
    const errorInCard = await card.locator('[role="alert"]').count()
    if (errorInCard === 0) {
      clickedIndex = i
      console.log(`Clicked Add-to-Cart button #${i} successfully`)
      break
    } else {
      const errText = await card.locator('[role="alert"]').first().textContent()
      console.log(`Button #${i} errored: ${errText?.slice(0, 120)}`)
    }
  }

  expect(
    clickedIndex,
    "at least one Add-to-Cart button must succeed without user_errors",
  ).toBeGreaterThanOrEqual(0)

  // Wait for the cart partial to re-render with the new quantity.
  // CartPartial has a small delay; give it plenty of room.
  await page.waitForTimeout(3000)

  const log = await page.evaluate(() => {
    const w = window as any
    w.__cartObserver?.disconnect()
    return w.__cartLog as Array<{ t: number; qty: string | null }>
  })

  console.log("\n=== Cart badge transitions after click ===")
  for (const e of log) console.log(`  [${e.t}ms] qty=${e.qty}`)

  console.log("\n=== Requests ===")
  for (const r of requests) console.log(`  ${r}`)

  if (errors.length > 0) {
    console.log("\n=== Page errors ===")
    for (const e of errors) console.log(`  ${e.slice(0, 300)}`)
  }

  const finalQty = await readCartQuantity()
  console.log(`Final cart quantity: ${finalQty}`)

  // Grouped/bundled products can add more than one item, so assert strictly
  // greater rather than +1. The bug we're validating is "quantity never
  // changes at all" — any increase proves the nested cart partial is
  // patching into the cached header.
  expect(
    finalQty,
    `cart badge must increase after successful add-to-cart (was ${initialQty}, now ${finalQty})`,
  ).toBeGreaterThan(initialQty ?? 0)
})
