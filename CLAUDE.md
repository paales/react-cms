# parton — project instructions

A React Server Components framework for commerce-shaped UIs:
server-owned state — `useState` on the server — with Flight as the
communication layer, and independently re-renderable, addressable,
cacheable subtrees as the unit. Research project — the bet is
*dynamic range*: one primitive that stretches from the leanest,
mobile-snappy storefront to a realtime streaming dashboard, so a
commerce stack never has to bifurcate (Liquid + a React checkout,
Luma/Hyvä + yet another React app) the way it must today. The
primitive is `parton(Render, options)` — a define-step constructor
that returns a placeable React component; the contract and full
surface live in [`docs/reference/`](./docs/reference/). GraphQL and
disk/local storage are pluggable tiers under the cell, not the point.

This file is for working in this repo — structure, tooling,
workflow. For framework architecture and APIs, read the docs.

## Where to read what

| Folder | For |
|---|---|
| [`docs/reference/`](./docs/reference/) | Framework reference. `intro` · `partial` · `block` · `cells` · `frames-navigation` · `remote-frame` · `cache` · `cms` · `prior-art`. Read these to use the framework. |
| [`docs/internals/`](./docs/internals/) | Framework internals. `testing` · `render-pipeline` · `streaming` · `cache-internals` · `cell-internals` · `registry-internals` · `frame-scope` · `server-isolation` · `server-context` · `flight-gotchas`. Read these to modify the framework. |
| [`docs/notes/`](./docs/notes/) | Active research. Forward-looking backlog (`IDEAS.md`); live design docs for unshipped work (`replicated-state`, `remote-frame-design`); framing notes (`perspectives`); chat overlay's demo content. |
| [`docs/archive/`](./docs/archive/) | Superseded designs and debugging logs. Reference only. |

## Project structure

The repo is a yarn workspace monorepo. Each top-level folder is a
package; cross-package imports go through workspace package names
(`@parton/<pkg>`), not relative paths.

| Path | Role |
|---|---|
| `framework/` (`@parton/framework`) | The framework runtime. `framework/index.ts` is the public barrel; internals live under `framework/src/{lib,runtime,test}/`. `lib/` holds partials primitives (`partial.tsx` for `parton` + `block`, `frame.tsx` for `<Frame>`, `remote-frame.tsx` for `<RemoteFrame>`, the client merge layer (`partial-client.tsx` is the `"use client"` boundary + `PartialsClient`; state in `partial-client-state.ts`, tree walks in `partial-cache.ts`, template in `partial-template.tsx`, batched refetch in `refetch.ts`, frame handles in `frame-client.tsx`, hooks in `use-navigation.tsx` — see the module map in `docs/internals/render-pipeline.md`), `partial-registry.ts`, `partial-context.ts`, `partial-error-boundary.tsx`, `partial-request-state.ts`, `server-context.ts` (parton `parent` threaded through a per-component ALS frame via the `@vitejs/plugin-rsc` patch in `.yarn/patches/`), `cache.tsx`, `cache-options.ts`, `flight-runtime.ts`, `flight-rewrite.ts` (line-level Flight transformer for RemoteFrame), `flight-graph.ts` (ref-graph rewriter powering the cache's hole strip/splice), `snapshot-trailer.ts` (wire-level snapshot sidecar for RemoteFrame), `hash.ts`, `stable-stringify.ts`, `multipart.ts`). `runtime/` holds RSC plumbing (`context.ts` request ALS, `capability.ts` host→remote scoping, `cms-{runtime,storage,prerender}.ts`, `navigation-api.ts`, `router.ts`, `session.ts`, `session-actions.ts`, `errors.ts`, `request.tsx`, `error-boundary.tsx`, `redirect-client.tsx`). `test/` is the in-process Flight test harness (`rsc-server.ts`, fixtures). The vitest configs for the rsc + browser tiers also live here, plus the node-tier setup file (jsdom navigation API shim). |
| `cms/` (`@parton/cms`) | CMS editor UI — three-pane shell (`src/editor/shell.tsx`, `actions.ts`, `components/{address-bar,tree-link,add-block}.tsx`). The committed content store + per-author drafts live alongside as data: `cms/data/content.json` (committed) + `cms/data/draft.json` (gitignored). Public barrel `cms/index.ts` exports `EditorShell`. |
| `copies/` (`@parton/copies`) | Local copies of shadcn UI primitives (`src/components/ui/`), the AI-elements library (`src/components/ai-elements/`), shared hooks (`src/hooks/`), and the `cn` helper (`src/lib/utils.ts`). `components.json` (shadcn config) lives here too — that's where new components are added. |
| `e2e-testing/` (`@parton/e2e-testing`) | Example testing app (PokeAPI + GraphCommerce Magento backends) and Playwright specs. `src/entry.{rsc,ssr,browser}.tsx` are the framework entries (they import the local `Root`). `vite.config.ts` owns dev/build for this app. `e2e/` contains the Playwright specs + fixtures. |
| `e2e-magento/` (`@parton/e2e-magento`) | Companion app on port 5181. Hosts remote partons exposed at `/__remote/<id>` for cross-origin `<RemoteFrame>` demos. Run alongside `e2e-testing` with `yarn dev:magento`. |
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
yarn dev                # Vite 8.1 (Rolldown) + RSC dev server (e2e-testing app)
yarn dev:magento        # Same, but against the empty e2e-magento showcase (port 5181)
yarn build              # Production build for e2e-testing
yarn build:magento      # Production build for e2e-magento
yarn typecheck          # tsc --noEmit across every workspace (runs first in `yarn test`)
yarn test               # typecheck + Vitest node + rsc projects
yarn test:node          # node project only (jsdom) — fast, skips typecheck
yarn test:rsc           # rsc project only (in-process Flight)
yarn test:browser       # Real Chromium via Vitest browser mode
yarn test:all           # All three Vitest projects
yarn test:watch         # Watch mode — node project
yarn test:watch:rsc     # Watch mode — rsc project
yarn test:e2e           # Playwright — full-stack specs in e2e-testing/e2e/
yarn lint               # ESLint — React Compiler + rules-of-hooks (Biome stays the formatter)
yarn bench:server       # Server-side warm-tick benchmark (live-tick CPU cost) — see bench/README.md
```

The root `yarn dev` / `yarn build` scripts delegate via
`yarn workspace @parton/<pkg> <cmd>`. Each app's vite config sets
`CMS_DATA_DIR` to the repo-level `cms/data/` so the framework's storage
points at the shared content store regardless of which workspace the
dev server runs from.

`yarn test` (which type-checks every workspace, then runs the node +
rsc Vitest projects) and `yarn test:e2e` cover disjoint suites — both
must pass before a change is done. The typecheck is `tsc --noEmit` per
package; `copies/`'s vendored, unused `ai-elements` is excluded (see
its tsconfig). Tier picking and harness mechanics are in
[`docs/internals/testing.md`](./docs/internals/testing.md).

`yarn test:e2e` auto-starts a dev server if nothing's on port 5179.
HMR dispose hooks clear cache + registry on edits, so server
restart is rarely needed during dev.

`yarn lint` is separate: ESLint with `eslint-plugin-react-hooks`
(`recommended-latest`) for the rules-of-hooks + React Compiler diagnostics
Biome doesn't implement. Scoped to the workspace `src/` trees via the root
`eslint.config.js`; it's advisory — NOT part of `yarn test`. Biome
(`biome.json`) stays the formatter and general linter.

`yarn bench:server` measures the server CPU cost of a live re-render
("warm tick") in-process — the parton hot path's recalculate-the-world
cost as world size and update density scale. The distilled numbers are
committed at
[`bench/results/server-warm-tick.json`](./bench/results/server-warm-tick.json)
as the regression substrate (re-run and re-commit to update the
baseline); CPU profiles (`--prof`) and scratch logs stay local
(gitignored). Scenarios, flags, and how to read the curves live in
[`bench/README.md`](./bench/README.md).

## Spec authoring rules

- Three constructors, one engine. Pick by role:
  - `parton(Render, '/path')` / `parton(Render, {match, schema, …})` — addressable subtree, request-dimensions only. The everything-else case.
  - `block(Render, {selector, schema, …})` — slot-placeable, CMS-driven. `schema({cms}) => ({…})` is where CMS reads live.
  - `<Frame name initialUrl>{…}</Frame>` — plain component, opens a per-name URL scope for descendants (which inherit the frame chain via server context).
- **The read IS the dependency.** A spec's request surface is what
  its schema/body actually reads via tracked hooks — `cookie()`,
  `searchParam()`, `header()`, `pathname()`, `match()`, `session()`,
  `visible()`, `tag()` — recorded per render and folded into the
  fingerprint by store-and-reread. Schema-phase reads fold with no
  cold lag (schema runs pre-fp); render-body reads lag one render,
  healed in-response by the fp-trailer. The tracking invariant: a
  body's read set must be a function of tracked inputs, props, and
  invalidation-covered data (cells/tags) — never of untracked
  nondeterminism (no `Date.now()` branching into a `cookie()` read).
  CMS reads (`cms.text(...)`, `cms.blocks(...)`, …) live inside a
  block's `schema` callback. Async loaders run in `render`.
- **Wake hints are hooks, park is a hook.** `expires(at)` /
  `staleUntil(at)` declare freshness boundaries (live-driver wakes +
  the fp-skip TTL gate); `time()` is the render clock
  (`expires(time().nextSecond)`). `park()` (schema-phase) is the
  value-conditional gate `match` can't express — parked keepalive,
  cached client variants preserved; `return null` from Render renders
  an empty body instead. Wrappers need NO declaration for their
  descendants' sake: same-bucket changes ride the descendant fold,
  new-bucket first visits ride the cold-record gate (over-fetch,
  never stale).
- **`match` is strict URLPattern** — no auto-suffixing. `match:
  "/inspect/*"` means `/inspect/<rest>` and does NOT match bare
  `/inspect`. To match both, use `match: "/inspect{/*}?"`.
- **Slot blocks** are constructed via `block`; they self-register in the type catalog under their auto-derived `type` (`HeroRender` → `"hero"`). `selector` is a flat list of refetch labels (`"page-block"` or `["page-block", "composed-hero"]`); leading `#`/`.` is cosmetic and stripped. The first label is the spec's catalog id — and for singleton blocks, also the CMS storage key. Slots are composed from inside a host's `schema` via `cms.blocks(slot, selector?)` / `cms.block(slot, selector?)` — author code never threads `host` / per-instance content keys; the framework wires it internally.
- **No `parent` prop.** A parton reads its `parent` (id path + frame chain) from server context — the ambient parton, threaded through a per-component ALS frame (see [`docs/internals/server-context.md`](./docs/internals/server-context.md), backed by a `@vitejs/plugin-rsc` patch in `.yarn/patches/`). Place specs as `<Spec />`, never `<Spec parent={…} />`. `Render` receives `{...matchParams, ...schema, ...actions, children}` — no `parent`, no `id`. CMS content flows via `schema` reads bound by the framework.

## Comments

Code comments describe the present — what the code does and why it is
the way it is now. They never narrate change: no "used to be X", no
"we removed Y", no arguing against an approach that's no longer in the
file. That rationale is real and worth keeping — it goes in the commit
message and the diff, not the source. The code a future reader sees
should read as if it was always this way. Same principle as the docs
rule below ("latest state only, no progression"): a comment that only
makes sense if you know what the code replaced is transient — move it
to the commit.

## No heuristics

Solve a problem with the real signal, never a proxy that's merely
*usually* right. A heuristic infers intent from a coincidence — matching
a pathname to guess "same page", a timeout to guess "settled", a string
match to guess "benign abort". It works until the coincidence breaks,
and it bakes in the wrong mental model so the next reader reasons from a
fiction. When the signal you need doesn't exist yet, **add it** — an
explicit marker the producer writes, a milestone, a state flag — rather
than guessing from what happens to be observable. Example: the live
heartbeat learns a stream is safe to abort from a done-marker the stream
itself writes, not by comparing URLs and hoping.

## Navigation — the Navigation API only

All client-side URL work goes through the framework's Navigation API
surface — `useNavigation()` (`navigate` / `reload` / `preload`) and the
ambient browser Navigation API it wraps. **Never touch the legacy
History API** (`history.pushState`, `history.replaceState`,
`window.onpopstate`, `location.assign`): it bypasses the framework's
entry state, scroll restoration, and intercept()-based interception, and
silently desyncs `useNavigation().currentEntry`. A bare URL update with
no refetch is `navigate(url, { history: "replace", silent: true })`, not
`replaceState`. There is no case in this codebase where the History API
is the right tool.

## React 19.3 + canary — use the current patterns

This repo runs React 19.3 canary. Reach for the modern primitive, not the
older workaround:

- **`useEffectEvent(fn)`** — a stable callback that always sees the latest
  props/state; call it *from* effects/handlers. Use it instead of writing
  `ref.current = latest` during render to smuggle a fresh value into a
  mount-only effect.
- **`useNavigation().currentEntry.url`** for the URL (isomorphic) — never
  `window.location` or the History API (see above).
- **`ref` is a plain prop** — no `forwardRef`.
- **`<Context value=…>` is the provider** — no `<Context.Provider>`.
- **`use(promise)` / `use(context)`** — conditional/unwrapping reads.
- **`<Fragment ref>`** → a `FragmentInstance` (`observeUsing` /
  `unobserveUsing`, `getClientRects`, …) to observe/measure children with
  no wrapper element.
- **`<Activity mode="hidden">`** to keep a subtree mounted but inert (state
  kept, effects unmounted) — the React-native way to park off-screen UI.
- **Document metadata** (`<title>` / `<meta>` / `<link>`) hoists from
  anywhere — render it where it's owned.
- **Forms/actions:** `<form action>`, `useActionState`, `useFormStatus`,
  `useOptimistic`, and `startTransition` around async actions.
- **React Compiler** — opt-in (`compilationMode: "annotation"`): add a
  `"use memo"` directive to a component/hook to compile it; nothing compiles
  otherwise. Wired (via `@rolldown/plugin-babel` + plugin-react's
  `reactCompilerPreset`) on the browser (`client`) environment only, so server
  components and their read-tracking / fingerprinting are never compiled.
  `yarn lint` surfaces what blocks a component from compiling.

## Working in a worktree

Prefer running a task in a fresh git worktree over editing the main
checkout directly — it keeps the author's tree free and lets the work
be committed and merged as a unit.

When you do:

1. **Remap the e2e ports first.** Change the `PORT` and
   `MAGENTO_PORT` constants at the top of
   `e2e-testing/playwright.config.ts` (canonically `5179` / `5181`) to
   random-ish free ports (`53xx`/`54xx` values). Everything else —
   baseURL, webServer commands and readiness URLs, the remote-binding
   origin, the cross-origin spec — derives from those two constants.
   Playwright's `webServer` runs with `reuseExistingServer: true`, so
   on the default ports it silently reuses dev servers the author
   already has open — your specs then run against THEIR code, not the
   worktree's. Distinct ports force fresh servers on your changes.
   This remap is worktree-local scaffolding: **leave it out of your
   commits** (revert it before committing) so master keeps the
   canonical `5179` / `5181`.

2. **When everything is done and both test tiers are green, commit and
   merge back to master, then remove the worktree.** See the
   done-workflow below for the commit bar.

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

Issues live in GitHub Issues at `partonjs/parton` (the `gh` CLI). See `docs/reference/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/reference/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. `docs/adr/` is wired up (one ADR landed); `CONTEXT.md` is still lazy — the `improve-codebase-architecture` skill creates it on first use. See `docs/reference/agents/domain.md`.
