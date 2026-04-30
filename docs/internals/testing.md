# Testing

Three Vitest projects:

| Project | Where | Runs |
|---|---|---|
| `node` | `framework/src/lib/__tests__/*.test.ts(x)` (jsdom-safe), `cms/src/editor/__tests__/*` | Plain TS / DOM-safe units. |
| `rsc` | `framework/src/lib/__tests__/*.rsc.test.tsx`, `framework/src/runtime/__tests__/*` | In-process Flight render via `framework/src/test/rsc-server.ts`. |
| `browser` | `framework/src/lib/__tests__/*.browser.test.ts(x)` | Real Chromium via Vitest browser mode. |

Plus Playwright:

| Suite | Where |
|---|---|
| e2e | `e2e/*.spec.ts` |

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
import { ReactCms, ROOT } from "../../lib"

const TestPartial = ReactCms.partial(
  ({ value }) => <span>{value}</span>,
  { selector: "#test", vary: ({ request }) => ({ value: new URL(request.url).searchParams.get("v") ?? "" }) }
)

const { rendered } = await renderRsc(<TestPartial parent={ROOT} />, { url: "/?v=hello" })
expect(rendered).toContain("hello")
```

The `<Partial>` JSX wrapper, tracked accessors (`getCookie`,
`getSearchParam`, …), `runWithCacheManifest`, and
`HoistingViolationError` are all gone — see `archive/` for the
historical surface and `notes/partial-define-step-api.md` for the
design rationale behind the constructor.
