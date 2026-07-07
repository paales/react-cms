# Testing

Four Vitest projects (root `vitest.config.ts` + the project configs
in `framework/`). The tier is chosen by filename suffix, matched
across every workspace (`{framework,cms,copies,e2e-testing,e2e-magento}/**`):

| Project | Suffix | Runs |
|---|---|---|
| `node` | `*.test.ts(x)` (anything not claimed by a suffix below) | jsdom units — hooks, client merge walks, pure TS. Setup file `framework/vitest.setup.ts` installs the Navigation API shim. |
| `rsc` | `*.rsc.test.ts(x)` | In-process Flight render via `framework/src/test/rsc-server.ts` — the **dev** Flight build, under the `react-server` condition (`framework/vitest.rsc.config.ts`). |
| `rsc-prod` | `*.rsc-prod.test.ts(x)` | The same harness against the **production** Flight build. `yarn test:rsc:prod` sets `NODE_ENV=production`, which the vendored `server.edge` entry uses to require the prod build. The dev and prod builds schedule tasks differently, so prod-only regressions (the server-context carrier, duplicate model rows, task settle, the cache write key) need their own tier — every other tier runs the dev build. Tests guard with `describe.skipIf(process.env.NODE_ENV !== "production")`, so a plain all-projects run skips them instead of asserting against the wrong build. |
| `browser` | `*.browser.test.ts(x)` | Real Chromium via Vitest browser mode (`framework/vitest.browser.config.ts`). |

`yarn test` = typecheck + `node` + `rsc` + `rsc-prod`. The browser
tier is opt-in (`yarn test:browser`) to skip the browser-boot cost
on every run.

Plus Playwright:

| Suite | Where |
|---|---|
| e2e | `e2e-testing/e2e/*.spec.ts` |

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
single constants at the top of the config; the config sets
`process.env.MAGENTO_REMOTE_ORIGIN` for the spawned dev servers (the
generated bindings in `src/remote/magento/` read it) and the spec
workers, so a worktree port remap is a two-constant change.

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
key-sniffing, or `window.__rsc_live_attach` presence (which is
set before `hydrateRoot` even runs). The app publishes explicit
markers; `e2e/fixtures.ts` wraps them:

| Signal | Producer | Fixture helper | Wait on it before… |
|---|---|---|---|
| `<html data-parton-interactive>` | Browser entry, from the effect that follows the first hydration commit and attaches the navigate listener (`framework/lib/page-interactive.ts`) | `waitForPageInteractive(page)` | interacting with SHELL-level UI. Pre-marker clicks land on inert SSR DOM; pre-marker link clicks fall through to full document navs. |
| `<html data-parton-live>` | The channel transport (`channel-client.ts`), set when the live stream's server-minted `conn` handshake arrives (the connection is provably established), removed when the connection settles | `waitForLiveConnection(page)` | asserting on server-PUSHED updates (live ticks, deferred cell writes), or interacting with an island the heartbeat's first fire may re-commit (a fp-drift re-commit remounts it mid-interaction). |
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

`framework/src/test/rsc-server.ts` drives the same vendored Flight
encode → decode round-trip the production renderer uses, inside the
Vitest worker itself — no dev server, no subprocess. Client / server
references resolve through permissive Proxy manifests, so tests can
inspect the Flight payload or the element tree without shipping real
chunks. The surface:

- `renderWithRequest(url, node, {headers?, visible?, signal?, onError?})` —
  render inside a real request context (`runWithRequestAsync` opens
  the ALS store so tracked hooks and `<PartialRoot>` resolve).
  `visible` presents a MEASURED visible set to the render — the
  harness stamps a connection-session handle on the request store,
  the same slot the segment driver stamps for a held connection;
  omitted is the unmeasured state (cull gates resolve their seeds).
  Returns `{stream, cookies}`. It tees and drains the stream before
  returning so every `<PartialBoundary>` has registered by the time
  the request context's auto-commit fires — the caller's side is a
  frozen recording.
- `withLiveDrive(url, page, scope, run, init?)`
  (`framework/src/test/live-drive.tsx`) — runs
  `driveSegmentedResponse` against an ATTACH through the real
  production pieces (statement bind, fp-trailer wrap, segment
  splitter, lane demux) with an in-process reader on the other end.
  Every held drive binds an attach statement through the same
  `bindAttachStatement` seam the entry uses — `bareAttach()` (empty
  manifest, no anchor, unmeasured viewport) by default, the `url`
  half defaulting to the drive URL — so the driver's statement reads
  see production state.
- `renderServerToFlight(node)` / `flightToString(stream)` /
  `consumePayload(stream)` / `renderAndInspect(node)` — raw Flight
  render, string-level assertions, decoded payload, or both.

## State isolation

The framework's server state is module-global, bucketed by scope
(see [`server-isolation.md`](./server-isolation.md)). Two isolation
regimes:

- **Playwright** stamps every request with a per-worker
  `x-test-scope: worker-<N>` header (`e2e/fixtures.ts`), so parallel
  workers land in disjoint buckets of the `<Cache>` store, registry,
  sessions, and cell storage.
- **Vitest** tests share the worker's default scope and reset
  explicitly instead: `beforeEach` calls the clear helpers
  (`clearRegistry("all")`, `_clearCache()`,
  `_clearInvalidationRegistry()`, …) as needed.

## Spec test shape

The basic shape of a partial-system test:

```ts
import { parton, PartialRoot } from "../partial.tsx"
import { searchParam } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

const TestPartial = parton(
  () => <span>{searchParam("v", "")}</span>,
  { selector: "#test" },
)

const { stream } = await renderWithRequest(
  "http://localhost/?v=hello",
  <PartialRoot><TestPartial /></PartialRoot>,
)
expect(await new Response(stream).text()).toContain("hello")
```
