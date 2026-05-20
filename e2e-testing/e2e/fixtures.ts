import {
  request as pwRequest,
  test as base,
  type APIRequestNewContextOptions,
  type Page,
  type Request as PwRequest,
} from "@playwright/test"

/**
 * Playwright fixtures layer. Every e2e spec imports `test` / `expect`
 * from here instead of `@playwright/test` directly, so we can attach
 * per-worker setup without touching each file.
 *
 * What we do: stamp every page with an `x-test-scope: worker-<N>`
 * header. The dev server reads it in `framework/context.ts`
 * (`deriveScope`) and routes the request into a per-worker bucket
 * of the process-wide state maps (`<Cache>` store, partial
 * registry, session store, GraphQL cache). That's what lets
 * Playwright run `workers > 1` without concurrent tests corrupting
 * each other's cached bytes or registry entries.
 *
 * The scope is stable per worker (same `workerIndex` reused across
 * sequential tests within that worker), so warm-cache assertions
 * that live across `beforeEach` still behave. To start from cold
 * within a worker, spec files call `/__test/clear-caches` — which
 * now forwards the request's scope and clears just that bucket.
 */

type WorkerFixtures = {
  testScope: string
}

export const test = base.extend<object, WorkerFixtures>({
  testScope: [
    async ({}, use, workerInfo) => {
      await use(`worker-${workerInfo.workerIndex}`)
    },
    { scope: "worker" },
  ],

  // Override the built-in `page` fixture so every HTTP request the
  // browser fires carries the worker's scope header.
  page: async ({ page, testScope }, use) => {
    await page.context().setExtraHTTPHeaders({
      "x-test-scope": testScope,
    })
    await use(page)
  },

  // Override the built-in `request` fixture (Playwright's standalone
  // APIRequestContext that tests use as `{ request }`). Without this
  // override, `await request.get(...)` skips the page fixture and
  // goes out without the scope header — reads fall into the
  // "default" bucket and collide with other workers.
  request: async ({ testScope }, use) => {
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: { "x-test-scope": testScope },
    })
    await use(ctx)
    await ctx.dispose()
  },
})

export { expect } from "@playwright/test"
export type { Page, APIRequestContext, Locator } from "@playwright/test"

/**
 * Drop-in replacement for `request` from `@playwright/test`. Any
 * `APIRequestContext` created through it automatically carries the
 * current worker's `x-test-scope` header, so manual HTTP calls (what
 * several specs do in `beforeEach` to hit `/__test/clear-caches`)
 * route into the right scope bucket instead of trampling the default
 * one. Plain `page.request.*` calls already inherit the header from
 * our page fixture; this covers the bypass path.
 */
export const request = {
  newContext: (options: APIRequestNewContextOptions = {}) => {
    const info = base.info()
    return pwRequest.newContext({
      ...options,
      extraHTTPHeaders: {
        ...options.extraHTTPHeaders,
        "x-test-scope": `worker-${info.workerIndex}`,
      },
    })
  },
}

/**
 * Replacement for `page.waitForLoadState("networkidle")` that
 * ignores the framework's live-update heartbeat connection.
 *
 * Why we can't use `networkidle`: `startLivePageHeartbeat()`
 * (mounted in the browser entry) keeps one `?streaming=1` RSC
 * long-poll connection open against the current URL for the
 * lifetime of the page. The network is never idle by design —
 * it's the channel for server-pushed updates.
 *
 * What this waits for: every non-streaming RSC request (the
 * normal page-load / nav / partial-refetch / action flow)
 * finishes AND no new ones land for `quietMs`. Streaming
 * requests (`?streaming=1`) are excluded from the tracked set.
 *
 * Use this any place a test previously used
 * `page.waitForLoadState("networkidle")` to sync on "the
 * server-side response from my last action has applied."
 */
export async function waitForRscIdle(
  page: Page,
  opts: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const quietMs = opts.quietMs ?? 300
  const timeout = opts.timeout ?? 10_000

  const isTracked = (url: string): boolean => {
    // RSC endpoints have a `_.rsc` suffix on the path. Filter out
    // the heartbeat's streaming connection — it's intentionally
    // long-lived and would prevent the idle window from ever
    // settling.
    if (!url.includes("_.rsc")) return false
    try {
      const u = new URL(url)
      return u.searchParams.get("streaming") !== "1"
    } catch {
      return false
    }
  }

  const inFlight = new Set<string>()
  let lastActivity = Date.now()

  const onRequest = (req: PwRequest) => {
    if (isTracked(req.url())) {
      inFlight.add(req.url())
      lastActivity = Date.now()
    }
  }
  const onSettled = (req: PwRequest) => {
    if (inFlight.delete(req.url())) {
      lastActivity = Date.now()
    }
  }

  page.on("request", onRequest)
  page.on("requestfinished", onSettled)
  page.on("requestfailed", onSettled)

  try {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (inFlight.size === 0 && Date.now() - lastActivity >= quietMs) {
        return
      }
      // 50ms poll — small enough to feel snappy, large enough to
      // not pin a CPU under the event-listener firehose.
      await page.waitForTimeout(50)
    }
    throw new Error(
      `waitForRscIdle: timeout after ${timeout}ms; in-flight: ${[...inFlight].join(", ") || "(none, but lastActivity < quietMs)"}`,
    )
  } finally {
    page.off("request", onRequest)
    page.off("requestfinished", onSettled)
    page.off("requestfailed", onSettled)
  }
}
