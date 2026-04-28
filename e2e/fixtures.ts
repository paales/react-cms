import {
  request as pwRequest,
  test as base,
  type APIRequestNewContextOptions,
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
