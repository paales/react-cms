import {
  clearCaches,
  test,
  expect,
  recordPartialDispatches,
  request,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * /defer-demo — exercises the activation shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — button-triggered manual activation via
 *      `useNavigation().reload({ selector })`.
 *   2. `defer={<WhenVisible/>}` — IntersectionObserver-triggered
 *      activation when the fallback enters the viewport.
 *
 * Activators are pure triggers — no data crosses the wire. Each
 * section's activated content renders a server timestamp, so a change
 * in that text proves the RSC refetch round-tripped.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("Partial defer demo", () => {
  test("defer={true}: button click activates via useNavigation.reload()", async ({ page }) => {
    // Transport-agnostic: attached, the activation refetch rides the
    // channel; pre-attach it goes discrete.
    const dispatches = recordPartialDispatches(page)

    await page.goto("/defer-demo")

    await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="manual-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    dispatches.length = 0
    await page.locator('[data-testid="activate-manual"]').click()
    await expect(page.locator('[data-testid="manual-content"]')).toBeVisible({
      timeout: 5000,
    })

    const hits = dispatches.filter(
      (c) => c.partials != null && c.partials.split(",").includes("manual"),
    )
    expect(
      hits.length,
      "expected exactly one refetch dispatch for `manual`",
    ).toBeGreaterThanOrEqual(1)
  })

  test("client nav STREAMS: shell reveals, then async content arrives (no tear)", async ({
    page,
  }) => {
    // A full window navigation over the channel commits root-ready — the
    // destination's newly-introduced Suspense boundaries flash their
    // fallbacks, then their content streams in as the nav segment's
    // Flight continuation resolves. Regression guard for two failures a
    // streaming nav could hit:
    //   - the async continuation never lands (the segment closes early),
    //     so `slow-content` never appears; and
    //   - a same-URL on-mount activation refetch (the `<WhenMounted>`
    //     defers on this page) supersedes the in-flight streaming nav and
    //     tears its committed shell — the torn Suspense refs reject with
    //     "Connection closed.", surfacing a per-partial "failed to render"
    //     card instead of the content.
    const consoleErrors: string[] = []
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    // Land on a page with NO async boundaries, so the channel is fully
    // established before we do the client-side navigation under test.
    await page.goto("/")
    await waitForLiveConnection(page)

    await page.evaluate(() => {
      // The Navigation API — the only client URL path (never History).
      window.navigation.navigate("/defer-demo")
    })

    // The streaming shell: the slow parton's Suspense fallback shows
    // while its 1.5s body streams. It commits root-ready, so this is
    // quick — but the assertion that matters is that it appears at all
    // AND is later replaced by content, not stranded.
    await expect(page.locator('[data-testid="slow-fallback"]')).toBeVisible({
      timeout: 2000,
    })

    // The Flight continuation drains into the committed tree: the async
    // parton's content lands after its ~1.5s server await. Before the
    // fix this never arrived on this page (the defer activation refetch
    // tore the nav segment).
    await expect(page.locator('[data-testid="slow-content"]')).toBeVisible({
      timeout: 4000,
    })

    // The on-mount defer partons still activate — their forced refetch
    // applies once the streaming nav drains, not by superseding it.
    await expect(page.locator('[data-testid="batch-a-content"]')).toBeVisible({
      timeout: 4000,
    })

    // The streaming commit mode must survive REPEATED full navigations —
    // the second and third away-and-back behave like the first, never
    // reverting to a withholding transition and never tearing. On a settled
    // return the mirror restores the unchanged-fp slow parton, so its
    // content lands; the invariant under test is that the navigation always
    // delivers and never surfaces an error card.
    for (const round of [2, 3]) {
      await page.evaluate(() => {
        window.navigation.navigate("/")
      })
      await page.waitForFunction(() => location.pathname === "/")
      await page.evaluate(() => {
        window.navigation.navigate("/defer-demo")
      })
      await expect(page.locator('[data-testid="slow-content"]')).toBeVisible({
        timeout: 4000,
      })
      expect(
        await page.getByText("failed to render").count(),
        `away-and-back nav ${round} must not tear`,
      ).toBe(0)
    }

    // No partial was torn into its error card across ANY of the
    // navigations, and no "Connection closed." reached the console.
    expect(await page.getByText("failed to render").count()).toBe(0)
    expect(
      consoleErrors.filter((e) => e.includes("Connection closed")),
      "a superseded streaming nav must not tear its committed shell",
    ).toEqual([])
  })

  test("rapid nav: an interrupted stream's leftover force never stops the return re-streaming", async ({
    page,
  }) => {
    // NAV 1's on-mount `defer` fires a same-URL `?__force=` refetch — a
    // `streaming: false` statement. If a rapid away-nav interrupts the
    // stream BEFORE that force's segment runs (it is deferred behind the
    // streaming render's drain), its record lingers unsettled. The next
    // window navigation must still commit PROGRESSIVELY: the commit-mode
    // read consults the NEWEST pending navigation, so the leftover atomic
    // force can no longer drag it into a withholding transition. The parked
    // shell is still on its fallback (the stream never finished), so the
    // return RE-STREAMS — fallback fast, then fresh content — never stranded.
    const consoleErrors: string[] = []
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    await page.goto("/")
    await waitForLiveConnection(page)

    // Interrupt the very first streaming nav mid-flight (before the ~1.5s
    // body resolves), so its on-mount force is left unsettled.
    await page.evaluate(() => {
      window.navigation.navigate("/defer-demo")
    })
    await expect(page.locator('[data-testid="slow-fallback"]')).toBeVisible({
      timeout: 2000,
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      window.navigation.navigate("/")
    })
    await page.waitForFunction(() => location.pathname === "/")

    // The return: it must still stream — fallback then fresh content.
    await page.evaluate(() => {
      window.navigation.navigate("/defer-demo")
    })
    await expect(page.locator('[data-testid="slow-fallback"]')).toBeVisible({
      timeout: 2000,
    })
    await expect(page.locator('[data-testid="slow-content"]')).toBeVisible({
      timeout: 4000,
    })

    expect(await page.getByText("failed to render").count()).toBe(0)
    expect(
      consoleErrors.filter((e) => e.includes("Connection closed")),
      "the interrupted nav's leftover force must not tear the return",
    ).toEqual([])
  })

  test("<WhenVisible>: scroll-into-view activates the Partial", async ({ page }) => {
    await page.goto("/defer-demo")
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="any-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    await page.locator('[data-testid="any-fallback"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    })
  })
})
