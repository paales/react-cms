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
 * One targeted refetch / navigation dispatch, on whichever carrier the
 * channel routed it: `"channel"` — a `url` frame on a
 * `/__parton/channel` envelope (an attached page states the refetch as
 * its page URL with the `?__force=` overlay — the whole-tree segment's
 * forced targets — and the response rides the held stream);
 * `"attach"` — the statement folded into a `POST /__parton/live` body
 * (a pre-establishment fire riding the attach it triggered).
 */
export interface PartialDispatch {
  transport: "channel" | "attach"
  /** The dispatch's target selector — the statement URL's `?__force=`
   *  overlay (`null`: a full-page nav). */
  partials: string | null
  url: string
}

/**
 * Record every partial dispatch from `page`, across BOTH carriers.
 * Specs that assert dispatch counts/shapes use this instead of
 * counting raw requests — whether a given fire rides an envelope or
 * the attach it triggered depends on whether the live connection was
 * established by then, so the assertion must be carrier-agnostic. A
 * bare attach (no `__force`, no pending statement) is transport, not
 * a dispatch, and records nothing.
 */
export function recordPartialDispatches(page: Page): PartialDispatch[] {
  const dispatches: PartialDispatch[] = []
  const recordStated = (transport: PartialDispatch["transport"], url: string) => {
    try {
      const stated = new URL(url, "http://localhost")
      if (!stated.searchParams.has("__force")) return
      dispatches.push({
        transport,
        partials: stated.searchParams.get("__force"),
        url,
      })
    } catch {}
  }
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("/__parton/channel")) {
      try {
        const envelope = JSON.parse(req.postData() ?? "") as {
          frames?: Array<{ kind: string; url?: string; frame?: string[] }>
        }
        for (const frame of envelope.frames ?? []) {
          if (frame.kind !== "url" || !frame.url || frame.frame) continue
          recordStated("channel", frame.url)
        }
      } catch {}
      return
    }
    if (url.includes("/__parton/live")) {
      try {
        const statement = JSON.parse(req.postData() ?? "") as { url?: string }
        if (statement.url) recordStated("attach", statement.url)
      } catch {}
    }
  })
  return dispatches
}

/**
 * One FRAME navigation dispatch, on whichever carrier the channel
 * routed it: `"channel"` — a frame-scoped `url` frame on a
 * `/__parton/channel` envelope (the endpoint writes the session frame
 * URL and the response lanes on the held stream); `"attach"` — a
 * statement riding a `POST /__parton/live` body's `frames` intent (a
 * pre-establishment fire).
 */
export interface FrameDispatch {
  transport: "channel" | "attach"
  /** Dotted frame key (`"search"`, `"chat-overlay"`). */
  frame: string
  /** The stated frame URL. */
  frameUrl: string
}

/**
 * Record every frame-navigation dispatch from `page`, across BOTH
 * carriers — the frame twin of `recordPartialDispatches`: whether a
 * given frame nav rides an envelope or the attach it triggered depends
 * on whether the live connection was established by then, so specs
 * assert carrier-agnostically.
 */
export function recordFrameDispatches(page: Page): FrameDispatch[] {
  const dispatches: FrameDispatch[] = []
  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("/__parton/channel")) {
      try {
        const envelope = JSON.parse(req.postData() ?? "") as {
          frames?: Array<{ kind: string; url?: string; frame?: string[] }>
        }
        for (const frame of envelope.frames ?? []) {
          if (frame.kind !== "url" || !frame.url || !frame.frame) continue
          dispatches.push({
            transport: "channel",
            frame: frame.frame.join("."),
            frameUrl: frame.url,
          })
        }
      } catch {}
      return
    }
    if (url.includes("/__parton/live")) {
      try {
        const statement = JSON.parse(req.postData() ?? "") as {
          frames?: Array<{ kind: string; url?: string; frame?: string[] }>
        }
        for (const frame of statement.frames ?? []) {
          if (frame.kind !== "url" || !frame.url || !frame.frame) continue
          dispatches.push({
            transport: "attach",
            frame: frame.frame.join("."),
            frameUrl: frame.url,
          })
        }
      } catch {}
    }
  })
  return dispatches
}

/**
 * Replacement for `page.waitForLoadState("networkidle")` that
 * ignores the framework's held live connection.
 *
 * Why we can't use `networkidle`: the heartbeat's attach
 * (`POST /__parton/live`) keeps one held stream open for the lifetime
 * of the page. The network is never idle by design — it's the channel
 * for server-pushed updates.
 *
 * What this waits for: every action POST (`_.rsc` — the one discrete
 * request kind) finishes AND no new ones land for `quietMs`.
 * Refetches and navigations ride the held stream and produce no
 * trackable request — sync on DOM state for those.
 */
export async function waitForRscIdle(
  page: Page,
  opts: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const quietMs = opts.quietMs ?? 300
  const timeout = opts.timeout ?? 10_000

  // Action POSTs carry the `_.rsc` path suffix; the held live stream
  // is `/__parton/live` and intentionally long-lived, so it never
  // enters the tracked set.
  const isTracked = (url: string): boolean => url.includes("_.rsc")

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
