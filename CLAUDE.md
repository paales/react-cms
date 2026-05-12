# React CMS — project instructions

A research project: a React CMS data layer for pages composed of
independently re-renderable, addressable, cacheable subtrees built
on RSC. The primitive is `ReactCms.partial(Render, options)` — a
define-step constructor that returns a placeable React component;
the contract and full surface live in [`docs/reference/`](./docs/reference/).

This file is for working in this repo — structure, tooling,
workflow. For framework architecture and APIs, read the docs.

## Where to read what

| Folder | For |
|---|---|
| [`docs/reference/`](./docs/reference/) | Framework reference. `intro` · `partial` · `frames-navigation` · `cache` · `cms` · `prior-art`. Read these to use the framework. |
| [`docs/internals/`](./docs/internals/) | Framework internals. `testing` · `render-pipeline` · `cache-internals` · `registry-internals` · `frame-scope` · `server-isolation` · `flight-gotchas`. Read these to modify the framework. |
| [`docs/notes/`](./docs/notes/) | Active research. Forward-looking backlog (`IDEAS.md`); chat overlay's demo content. |
| [`docs/archive/`](./docs/archive/) | Superseded designs and debugging logs. Reference only. |

## Project structure

The repo is a yarn workspace monorepo. Each top-level folder is a
package; cross-package imports go through workspace package names
(`@react-cms/<pkg>`), not relative paths.

| Path | Role |
|---|---|
| `framework/` (`@react-cms/framework`) | The framework runtime. `framework/index.ts` is the public barrel; internals live under `framework/src/{lib,runtime,test}/`. `lib/` holds partials primitives (`partial.tsx` for `ReactCms.partial` + `ReactCms.block`, `frame.tsx` for `<Frame>`, `partial-client.tsx`, `partial-registry.ts`, `partial-context.ts`, `partial-error-boundary.tsx`, `partial-request-state.ts`, `partial-cache.ts`, `partial-debug.tsx`, `cache.tsx`, `cache-options.ts`, `flight-runtime.ts`, `hash.ts`, `stable-stringify.ts`, `multipart.ts`). `runtime/` holds RSC plumbing (`context.ts` request ALS, `cms-{runtime,storage,prerender}.ts`, `navigation-api.ts`, `router.ts`, `session.ts`, `session-actions.ts`, `errors.ts`, `request.tsx`, `error-boundary.tsx`, `redirect-client.tsx`). `test/` is the in-process Flight test harness (`rsc-server.ts`, fixtures). The vitest configs for the rsc + browser tiers also live here, plus the node-tier setup file (jsdom navigation API shim). |
| `cms/` (`@react-cms/cms`) | CMS editor UI — three-pane shell (`src/editor/shell.tsx`, `actions.ts`, `components/{address-bar,tree-link,add-block}.tsx`). The committed content store + per-author drafts live alongside as data: `cms/data/content.json` (committed) + `cms/data/draft.json` (gitignored). Public barrel `cms/index.ts` exports `EditorShell`. |
| `copies/` (`@react-cms/copies`) | Local copies of shadcn UI primitives (`src/components/ui/`), the AI-elements library (`src/components/ai-elements/`), shared hooks (`src/hooks/`), and the `cn` helper (`src/lib/utils.ts`). `components.json` (shadcn config) lives here too — that's where new components are added. |
| `e2e-testing/` (`@react-cms/e2e-testing`) | Example testing app (PokeAPI + GraphCommerce Magento backends) and Playwright specs. `src/entry.{rsc,ssr,browser}.tsx` are the framework entries (they import the local `Root`). `vite.config.ts` owns dev/build for this app. `e2e/` contains the Playwright specs + fixtures. |
| `e2e-magento/` (`@react-cms/e2e-magento`) | Empty showcase scaffold for a future Magento integration. Stub `Root`, mirrored vite config (port 5181). |
| `docs/` | All documentation (`reference/`, `internals/`, `archive/`, `notes/`). Not buildable code. |

The load-bearing code is in `framework/src/`, `cms/src/`, `copies/src/`,
and `e2e-testing/src/` — treat the rest as ignorable.

## Data layer

GraphQL via `graphql-request` + gql.tada. One `graphql()` helper per
backend (per schema); queries written as strings tagged with the
helper for end-to-end type inference. Don't pass manual type
generics to `client.request` — the typed document provides result
+ variable types.

```ts
// e2e-testing/src/app/magento-graphql.ts
import { initGraphQLTada } from "gql.tada";
import type { introspection } from "./magento-env.d.ts";
export const graphql = initGraphQLTada<{ introspection: introspection; scalars: { ... } }>();

// Usage
const CartQuery = graphql(`query Cart($cartId: String!) { cart(cart_id: $cartId) { total_quantity } }`);
const data = await client.request(CartQuery, { cartId });   // typed end-to-end
```

Conventions:

- One `graphql()` helper per backend — don't mix schemas in one document.
- Define fragments with `graphql()` and pass them to queries that use them.
- Prefer module-scope `const MyQuery = graphql(\`...\`)` over inlining — fragment composition is cleaner.

| API | Endpoint | For |
|---|---|---|
| PokeAPI | `https://beta.pokeapi.co/graphql/v1beta` | Primary example (Hasura) |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, `@defer`) |

## Tooling — `mcp-refactor-typescript`

The project ships an MCP server (`.mcp.json`) for type-aware TS
refactors. Prefer these over `Edit` / `mv` / `grep` for anything
that crosses file boundaries — they update imports, dynamic
imports, JSDoc refs, and type-only imports that hand edits miss.
All support `preview: true` for a dry run.

| Tool | Use for |
|---|---|
| `file_operations` | `rename_file`, `move_file`, `batch_move_files` — instead of `mv` for `.ts` / `.tsx`. |
| `refactoring` | `rename` (symbol-wide), `extract_function`, `extract_constant`, `extract_variable`, `move_to_file`, `infer_return_type` — instead of `Edit` for symbol renames or cross-file extractions. |
| `workspace` | `refactor_module` (move + organize + fix combined), `cleanup_codebase` (⚠️ can delete files — always run with `preview: true` first), `restart_tsserver`. **Skip `find_references`** — it times out on non-trivial symbols. Use `refactoring.rename` with `preview: true` instead. |
| `code_quality` | `fix_all`, `organize_imports`, `remove_unused` on a single file. Run before commits after significant edits. |

For symbol-scoped blast-radius checks, prefer `refactoring.rename`
(preview) over `workspace.find_references` — same lookup,
succeeds where find-refs fails, returns the full edit plan.

## Development

```bash
yarn dev                # Vite 8 + RSC dev server (e2e-testing app)
yarn dev:magento        # Same, but against the empty e2e-magento showcase (port 5181)
yarn build              # Production build for e2e-testing
yarn build:magento      # Production build for e2e-magento
yarn test               # Vitest — node + rsc projects (fast), all workspaces
yarn test:node          # node project only (jsdom)
yarn test:rsc           # rsc project only (in-process Flight)
yarn test:browser       # Real Chromium via Vitest browser mode
yarn test:all           # All three Vitest projects
yarn test:watch         # Watch mode — node project
yarn test:watch:rsc     # Watch mode — rsc project
yarn test:e2e           # Playwright — full-stack specs in e2e-testing/e2e/
```

The root `yarn dev` / `yarn build` scripts delegate via
`yarn workspace @react-cms/<pkg> <cmd>`. Each app's vite config sets
`CMS_DATA_DIR` to the repo-level `cms/data/` so the framework's storage
points at the shared content store regardless of which workspace the
dev server runs from.

`yarn test` and `yarn test:e2e` cover disjoint suites — both must
pass before a change is done. Tier picking and harness mechanics
are in [`docs/internals/testing.md`](./docs/internals/testing.md).

`yarn test:e2e` auto-starts a dev server if nothing's on port 5179.
HMR dispose hooks clear cache + registry on edits, so server
restart is rarely needed during dev.

## Spec authoring rules

- Three constructors, one engine. Pick by role:
  - `ReactCms.partial(Render, '/path')` / `ReactCms.partial(Render, {match, vary, …})` — addressable subtree, request-dimensions only. The everything-else case.
  - `ReactCms.block(Render, {selector, schema, …})` — slot-placeable, CMS-driven. `schema({cms}) => ({…})` is where CMS reads live.
  - `<Frame name initialUrl parent>{(p) => …}</Frame>` — plain component, opens a per-name URL scope for descendants.
- `vary` is sync and must be pure. It sees `{url, pathname, search, cookies, headers, params, session}` — **no `cms`**. CMS reads (`cms.text(...)`, `cms.enum(...)`, `cms.reference(...)`, `cms.blocks(...)`, `cms.block(...)`) live inside a block's `schema` callback. Async loaders run in `render`.
- **Wrapper specs need a `vary` that captures their descendants'
  URL deps**, otherwise fp-skip on the wrapper blocks descendant
  re-renders. With no `vary`, only NAMED `match` params (`:id`)
  flow into the default dependency surface — anonymous `*` captures
  and unspecified URL parts (search/hash) do NOT. So `match:
  "/inspect{/*}?"` produces a stable fingerprint across `/inspect`
  and `/inspect/p/3`; specs that genuinely depend on the wildcard
  tail or query string declare `vary` and read `pathname` /
  `search` off the scope explicitly.
- **`match` is strict URLPattern** — no auto-suffixing. `match:
  "/inspect/*"` means `/inspect/<rest>` and does NOT match bare
  `/inspect`. To match both, use `match: "/inspect{/*}?"`.
- **Slot blocks** are constructed via `ReactCms.block`; they self-register in the type catalog under their auto-derived `type` (`HeroRender` → `"hero"`). `selector` declares class identity (`".page-block"`) for slot-allow filters and shared-token refetch; embed a `#token` to make it a singleton. Slots are composed from inside a host's `schema` via `cms.blocks(slot, selector?)` / `cms.block(slot, selector?)` — author code never threads `host` / `hostCmsId`; the framework wires it.
- `parent: PartialCtx` is required on every spec call site. `Render` receives `{...vary, ...schema, parent, cmsId, children}` — pass `parent` to descendant spec calls.

## Workflow — after a task is done

When a non-trivial task reaches a clean end state (feature landed,
bug fixed, refactor finished) AND `yarn test` + `yarn test:e2e` are
both green:

1. **Update the docs.** Find every `docs/reference/` or
   `docs/internals/` file that touches the changed area and amend
   it to match the new reality. No history banners ("we used to do
   X"), no progression — the docs always describe latest state.
   Design rationale that future readers might need stays in
   `docs/notes/` (active) or `docs/archive/` (superseded).

2. **Move stale notes to `docs/archive/`.** A note earns archival
   when its design is no longer wired in OR has been fully
   superseded by a `docs/reference/` entry. Add a
   `Superseded YYYY-MM-DD by docs/reference/X.md` banner at the top
   of the note before moving. Update `docs/archive/README.md` with
   the index entry.

3. **Confirm the test suites are green.** `yarn test` and
   `yarn test:e2e` from a clean working tree. Don't commit red.

4. **Commit.** One commit per logical change, focused on the WHY.
   Include docs + tests alongside the code. Prefer a short
   imperative subject (under 70 chars) and a body that captures the
   motivation + any non-obvious tradeoff. Don't amend; don't
   `--no-verify`.

The two test tiers + the docs surface are load-bearing — a fix
without the corresponding doc/test update is incomplete work.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `paales/react-cms` (the `gh` CLI). See `docs/reference/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/reference/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. `docs/adr/` is wired up (one ADR landed); `CONTEXT.md` is still lazy — the `improve-codebase-architecture` skill creates it on first use. See `docs/reference/agents/domain.md`.
