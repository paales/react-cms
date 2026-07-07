import {
  request as pwRequest,
  test as base,
  type Page,
  type Request as PwRequest,
} from "@playwright/test"

// `APIRequestNewContextOptions` is no longer a named export of
// `@playwright/test`. Derive the options shape from the public
// `request.newContext` signature instead — `NonNullable` because the
// parameter is optional.
type APIRequestNewContextOptions = NonNullable<Parameters<typeof pwRequest.newContext>[0]>

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
 * Clear the calling worker's scope bucket on the dev server (see
 * `/__test/clear-caches` in `entry.rsc.tsx`). The context created
 * here carries the worker's `x-test-scope` header, so only this
 * worker's state is wiped. One retry on a dropped connection: the
 * endpoint is a test utility, and a keep-alive/backlog reset on a
 * busy dev server says nothing about the system under test.
 */
export async function clearCaches(
  baseURL: string | undefined,
  opts: { cms?: boolean } = {},
): Promise<void> {
  const url = `${baseURL ?? ""}/__test/clear-caches${opts.cms ? "?cms=1" : ""}`
  const ctx = await request.newContext()
  try {
    try {
      await ctx.get(url)
    } catch {
      await ctx.get(url)
    }
  } finally {
    await ctx.dispose()
  }
}

/**
 * Wait for the page's "safe to interact" signal: the browser entry
 * stamps `<html data-parton-interactive>` from the effect that both
 * follows React's first hydration commit AND attaches the Navigation
 * API intercept listener (see `framework/lib/page-interactive.ts`).
 * Until it's present, a click or keystroke can land on SSR DOM with
 * no handlers attached (a silent no-op) and a link click falls
 * through to a full document navigation instead of the framework's
 * intercepted client-side nav.
 *
 * Call it after `page.goto(...)` in any spec that interacts with the
 * page (click / type / scroll-driven behavior). Specs that only
 * assert on streamed/SSR output don't need it.
 */
export async function waitForPageInteractive(
  page: Page,
  opts: { timeout?: number } = {},
): Promise<void> {
  await page
    .locator("html[data-parton-interactive]")
    .waitFor({ state: "attached", timeout: opts.timeout ?? 15_000 })
}

/**
 * Wait for the framework's live-update subscription to be open:
 * `<html data-parton-live>` is set by the channel transport when the
 * live stream's server-minted `conn` handshake arrives (the session
 * is provably open server-side), and removed when the connection
 * settles (keepalive elapsed, abort). Specs that assert on
 * server-PUSHED updates (live ticks, deferred cell writes) wait on
 * this before acting — a push can only arrive once the subscription
 * is actually established.
 */
export async function waitForLiveConnection(
  page: Page,
  opts: { timeout?: number } = {},
): Promise<void> {
  await page
    .locator("html[data-parton-live]")
    .waitFor({ state: "attached", timeout: opts.timeout ?? 15_000 })
}

/**
 * One targeted refetch / navigation dispatch, on whichever transport
 * carried it: `"rsc"` — a discrete `_.rsc` request with `?partials=`;
 * `"channel"` — a `url` frame on a `/__parton/channel` envelope (an
 * attached page states the refetch as its page URL with the
 * `?__force=` overlay — the whole-tree segment's forced targets — and
 * the response rides the held stream).
 */
export interface PartialDispatch {
  transport: "rsc" | "channel"
  /** The dispatch's target selector — `?partials=` on the discrete
   *  form, `?__force=` on the channel statement (`null`: a full-page
   *  nav). */
  partials: string | null
  url: string
}

/**
 * Record every partial dispatch from `page`, across BOTH transports.
 * Specs that assert dispatch counts/shapes use this instead of
 * counting raw `_.rsc` requests — whether a given fire rides the
 * channel depends on whether the live connection was established by
 * then (an interaction racing the attach goes discrete), so the
 * assertion must be transport-agnostic. The heartbeat's own live
 * attach (`?live=1`) is transport, not a dispatch, and is excluded.
 */
export function recordPartialDispatches(page: Page): PartialDispatch[] {
  const dispatches: PartialDispatch[] = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) {
      try {
        const u = new URL(url)
        if (u.searchParams.get("live") === "1") return
        if (!u.searchParams.has("partials")) return
        dispatches.push({
          transport: "rsc",
          partials: u.searchParams.get("partials"),
          url,
        })
      } catch {}
      return
    }
    if (url.includes("/__parton/channel")) {
      try {
        const envelope = JSON.parse(req.postData() ?? "") as {
          frames?: Array<{ kind: string; url?: string }>
        }
        for (const frame of envelope.frames ?? []) {
          if (frame.kind !== "url" || !frame.url) continue
          const stated = new URL(frame.url, "http://localhost")
          if (!stated.searchParams.has("__force")) continue
          dispatches.push({
            transport: "channel",
            partials: stated.searchParams.get("__force"),
            url: frame.url,
          })
        }
      } catch {}
    }
  })
  return dispatches
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
