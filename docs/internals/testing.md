# Testing

Four Vitest projects:

| Project | Where | Runs |
|---|---|---|
| `node` | `framework/src/lib/__tests__/*.test.ts(x)` (jsdom-safe), `cms/src/editor/__tests__/*` | Plain TS / DOM-safe units. |
| `rsc` | `framework/src/lib/__tests__/*.rsc.test.tsx`, `framework/src/runtime/__tests__/*` | In-process Flight render via `framework/src/test/rsc-server.ts` — the **dev** Flight build. |
| `rsc-prod` | `framework/src/lib/__tests__/*.rsc-prod.test.tsx` | The same harness against the **production** Flight build. `yarn test:rsc:prod` sets `NODE_ENV=production`, which the vendored `server.edge` entry uses to require the prod build. The dev and prod builds schedule tasks differently, so prod-only regressions (e.g. the server-context carrier) need their own tier — every other tier runs the dev build. Tests `skipIf(NODE_ENV !== "production")`, so a plain all-projects run skips them. |
| `browser` | `framework/src/lib/__tests__/*.browser.test.ts(x)` | Real Chromium via Vitest browser mode. |

Plus Playwright:

| Suite | Where |
|---|---|
| e2e | `e2e/*.spec.ts` |

## Playwright — deterministic by construction

`yarn test:e2e` runs with **`retries: 0`**: a test that fails, fails.
Flakes are treated as bugs — in the spec (waiting on timing instead of
a signal), in the app (a missing signal), or in the infra (cold-server
races) — and fixed at the root, per the repo's no-heuristics rule.
Three mechanisms make that hold:

### Managed servers

`playwright.config.ts` declares BOTH dev servers as `webServer`
entries: the e2e-testing app (port 5179) and the e2e-magento
companion (port 5181, the cross-origin `<RemoteFrame>` remote). No
manual `yarn dev:magento` terminal — the cross-origin specs always
run. The magento readiness URL is a real remote endpoint
(`/__remote/magento-greeting`), so the first parton compile happens
during boot, not inside a spec's timeout. The two ports live in
single constants at the top of the config; the config exports
`MAGENTO_REMOTE_ORIGIN` to the host server (the generated bindings in
`src/remote/magento/` read it) and to the spec workers, so a worktree
port remap is a two-constant change.

### Warmup project

The `warmup` Playwright project (`e2e/warmup.setup.ts`) is a
dependency of the main `chromium` project: it visits every route
once, serially, before any spec runs. A fresh dev server compiles
each page's module graph lazily and discovers optimizer deps as the
browser requests them (which can trigger a full-page reload when it
re-bundles); the warmup absorbs those costs up front instead of
letting the parallel spec storm race them mid-assertion.

### Third-party backends: record/replay

The example app reads live public APIs (PokeAPI, GraphCommerce), and
public APIs rate-limit by IP — under repeated full-suite runs PokeAPI
answers 429, which mid-spec is indistinguishable from an app bug. The
Playwright config exports `GQL_DISK_CACHE=1` to the dev servers it
spawns; under that flag `e2e-testing/src/app/gql-disk-cache.ts` wraps
the clients whose backends serve immutable reference data (PokeAPI;
GraphCommerce's catalog) and records every successful QUERY response
to `.gql-cache/` (gitignored), replaying it from then on. Whether a
document is a query is read from the document's own grammar — the
AST's `OperationDefinition.operation` — never guessed. Stateful
traffic stays live: mutations always pass through, and the cart
client is simply not wrapped (replaying a cart query recorded before
a mutation would mask the mutation). Cold-cache misses retry on 429
per the response's own semantics (`Retry-After`, bounded backoff). A
plain `yarn dev` never sets the flag and stays fully live; delete
`.gql-cache/` to re-record.

### Real readiness signals, not timing

Specs never guess readiness from `waitForTimeout`, `__reactFiber`
key-sniffing, or `window.__rsc_partial_refetch` presence (which is
set before `hydrateRoot` even runs). The app publishes explicit
markers; `e2e/fixtures.ts` wraps them:

| Signal | Producer | Fixture helper | Wait on it before… |
|---|---|---|---|
| `<html data-parton-interactive>` | Browser entry, from the effect that follows the first hydration commit and attaches the navigate listener (`framework/lib/page-interactive.ts`) | `waitForPageInteractive(page)` | interacting with SHELL-level UI. Pre-marker clicks land on inert SSR DOM; pre-marker link clicks fall through to full document navs. |
| `<html data-parton-live>` | `LivePageHeartbeat`, set when the live stream's first segment commits, removed when the connection settles | `waitForLiveConnection(page)` | asserting on server-PUSHED updates (live ticks, deferred cell writes), or interacting with an island the heartbeat's first fire may re-commit (a fp-drift re-commit remounts it mid-interaction). |
| `data-hydrated` on the target element | the element's own callback ref — `useCell().input()` bindings get it from the framework; interactive demo/editor components attach it themselves; server-rendered regions embed the cms `HydrationBeacon` client component | interact through a `[data-hydrated]`-qualified locator | ANY element inside a streamed / cached / substituted Suspense boundary. Those hydrate after the root commit, and events fired earlier are silently lost — text input has no replay, and clicks aren't replayed when the island's client module hasn't loaded yet. |

The root marker alone is NOT sufficient for controls inside
late-hydrating boundaries — interaction targets carry their own
element-level marker and specs click/type through the qualified
locator.

Two more fixture rules. `clearCaches(baseURL)` wraps the
`/__test/clear-caches` endpoint — scoped to the calling worker, one
retry on a dropped connection (the endpoint is harness plumbing, not
the system under test). And specs never clear with `?all=1`: a
wholesale clear nukes every OTHER worker's state mid-test. The scoped
clear covers remote-frame state too, because `RemoteFrame` forwards
the host request's `x-test-scope` header on its internal fetch —
remote renders land in the host request's bucket.

Assertions about performance-shaped claims (cache hits, parallel
rendering, non-blocking activation) read the server's own stamps
instead of the client's wall clock: cache tests assert the stored
render's `computed at` timestamp is replayed byte-identically;
concurrency tests assert `data-started-at` / `data-finished-at`
intervals OVERLAP (`started(b) < finished(a)`), which no amount of
machine load can fake or break.

One transient to know about: while a Suspense re-commit is in flight,
React keeps the prior children hidden in the DOM alongside the
incoming copy, so a testid can momentarily match twice. Specs that
read attributes off such elements use `.first()` (both copies carry
the same committed bytes) instead of a strict single-match locator.

## RSC harness

`framework/src/test/rsc-server.ts` wraps the same Flight encode → decode
round-trip the production renderer uses, but inside a single Node
process. Use it to assert against the exact tree the client would
render:

```ts
const { rendered } = await renderRsc(<Root />, { url: "/cache-demo" })
expect(rendered).toContain("Cache size:")
```

## Per-test scope

Every RSC + Vitest test gets a per-test scope token via
`x-test-scope`. Parallel tests don't contend on the per-scope
state buckets (`<Cache>` store, registry, sessions, GraphQL cache).

## Spec test shape

The basic shape of a partial-system test:

```ts
import { parton } from "../partial.tsx"
import { searchParam } from "../server-hooks.ts"

const TestPartial = parton(
  ({ value }) => <span>{value}</span>,
  { selector: "#test", schema: () => ({ value: searchParam("v", "") }) }
)

const { rendered } = await renderRsc(<TestPartial />, { url: "/?v=hello" })
expect(rendered).toContain("hello")
```
