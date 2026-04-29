# React CMS — project instructions

A research project: a React CMS data layer for pages composed of
independently re-renderable, addressable, cacheable subtrees built
on RSC. The primitive is `ReactCms.partial(Render, options)` — a
define-step constructor that returns a placeable React component;
the contract and full surface live in [`docs/`](./docs/).

This file is for working in this repo — structure, tooling,
workflow. For framework architecture and APIs, read the docs.

## Where to read what

| Folder | For |
|---|---|
| [`docs/`](./docs/) | Framework reference. `intro` · `partial` · `frames-navigation` · `cache` · `cms` · `prior-art`. Read these to use the framework. |
| [`docs-dev/`](./docs-dev/) | Framework internals. `testing` · `render-pipeline` · `cache-internals` · `registry-internals` · `frame-scope` · `manifest-internals` · `server-isolation` · `flight-gotchas`. Read these to modify the framework. |
| [`notes/`](./notes/) | Active research. Forward-looking backlog (`IDEAS.md`); chat overlay's demo content. |
| [`archive/`](./archive/) | Superseded designs and debugging logs. Reference only. |

## Project structure

| Path | Role |
|---|---|
| `src/lib/` | Partials library — `partial.tsx` (constructor + PartialRoot + render runtime), `partial-client.tsx`, `partial-registry.ts`, `partial-context.ts`, `partial-error-boundary.tsx`, `partial-request-state.ts`, `partial-cache.ts`, `partial-debug.tsx`, `cache.tsx`, `cache-options.ts`, `flight-runtime.ts` (env-aware Flight encode/decode shim), `slot.tsx`, `hash.ts`, `multipart.ts`. Public surface in `index.ts`. |
| `src/framework/` | RSC plumbing — `entry.{rsc,browser,ssr}.tsx`, `context.ts` (request ALS + cookies + matchRoutePattern), `cms-{runtime,storage,prerender}.ts`, `navigation-api.ts`, `router.ts`, `session.ts`, `errors.ts`, `request.tsx`, `error-boundary.tsx`, `redirect-client.tsx`. |
| `src/editor/` | CMS editor UI — three-pane shell. `shell.tsx`, `actions.ts`, `components/{address-bar,tree-link,add-block}.tsx`. Top-level package boundary in prep for a monorepo split. |
| `src/app/` | Example application — pages, blocks, components, GraphQL clients (PokeAPI + Magento). |
| `src/cms/` | CMS content store — `content.json` (committed) + `draft.json` (gitignored). |
| `src/test/` | In-process RSC test harness — `rsc-server.ts`, fixtures. |
| `e2e/` | Playwright specs and fixtures. |

The load-bearing code is in `src/test/`, `src/lib/`, `src/framework/`,
`src/editor/`, and `src/app/` — treat the rest as ignorable.

## Data layer

GraphQL via `graphql-request` + gql.tada. One `graphql()` helper per
backend (per schema); queries written as strings tagged with the
helper for end-to-end type inference. Don't pass manual type
generics to `client.request` — the typed document provides result
+ variable types.

```ts
// src/app/magento-graphql.ts
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
yarn dev                # Vite 8 + RSC dev server
yarn test               # Vitest — node + rsc projects (fast)
yarn test:node          # node project only (jsdom)
yarn test:rsc           # rsc project only (in-process Flight)
yarn test:browser       # Real Chromium via Vitest browser mode
yarn test:all           # All three Vitest projects
yarn test:watch         # Watch mode — node project
yarn test:watch:rsc     # Watch mode — rsc project
yarn test:e2e           # Playwright — full-stack specs in e2e/
```

`yarn test` and `yarn test:e2e` cover disjoint suites — both must
pass before a change is done. Tier picking and harness mechanics
are in [`docs-dev/testing.md`](./docs-dev/testing.md).

`yarn test:e2e` auto-starts `yarn dev` if nothing's on port 5173.
HMR dispose hooks clear cache + registry on edits, so server
restart is rarely needed during dev.

## Spec authoring rules

- Specs are constructed once at module scope:
  `const MyPage = ReactCms.partial(MyRender, '/path')` (string
  shorthand) or `ReactCms.partial(MyRender, {match, vary, ...})`
  (full options).
- `vary` is sync and must be pure; CMS reads (`cms.text(...)`,
  `cms.enum(...)`, `cms.reference(...)`) live inside `vary`. Async
  loaders run in `render`.
- **Wrapper specs need a `vary` that captures their descendants'
  URL deps**, otherwise fp-skip on the wrapper blocks descendant
  re-renders. The default behavior (no `vary`) folds the request
  URL search string into the dependency surface — leaf specs that
  legitimately don't depend on the URL can declare an explicit
  `vary` returning a stable shape.
- **Slot blocks** (specs with `tags: [".x"]`) are catalog-registered
  by `type` so slots can look them up. Page specs (with `selector`
  or auto-derived from Render name) are not slot-listable.
- `parent: PartialCtx` is required on every spec call site. The
  spec's render function receives `{...vary, parent, cmsId}` —
  pass `parent` to descendant `<SpecComponent>` calls and `cmsId`
  to `<Children hostCmsId>` / `<Child hostCmsId>`.

## Workflow — after a task is done

When a non-trivial task reaches a clean end state (feature landed,
bug fixed, refactor finished) AND `yarn test` + `yarn test:e2e` are
both green:

1. **Update the docs.** Find every `docs/` or `docs-dev/` file that
   touches the changed area and amend it to match the new reality.
   No history banners ("we used to do X"), no progression — the
   docs always describe latest state. Design rationale that future
   readers might need stays in `notes/` (active) or `archive/`
   (superseded).

2. **Move stale notes to `archive/`.** A note earns archival when
   its design is no longer wired in OR has been fully superseded
   by a docs/ entry. Add a `Superseded YYYY-MM-DD by docs/X.md`
   banner at the top of the note before moving. Update
   `archive/README.md` with the index entry.

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

Issues live in GitHub Issues at `paales/react-cms` (the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. Neither exists yet — skills create them lazily. See `docs/agents/domain.md`.
