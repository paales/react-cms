# parton — project instructions

A React Server Components framework for commerce-shaped UIs:
**server-owned state** — `useState` on the server — with Flight as the
communication layer, and independently re-renderable, addressable,
cacheable subtrees as the unit. Research project — the bet is *dynamic
range*: one primitive that stretches from the leanest, mobile-snappy
storefront to a realtime streaming dashboard, so a commerce stack never
has to bifurcate (Liquid + a React checkout, Luma/Hyvä + yet another
React app) the way it must today. GraphQL and disk/local storage are
pluggable tiers under the cell, not the point.

This file orients a fresh session: the mental model, the API surface,
where truth lives, and how to work in this repo. Framework contracts
live in [`docs/reference/`](./docs/reference/); mechanisms in
[`docs/internals/`](./docs/internals/) — read those before using or
modifying the framework. Trust the docs over your priors: this codebase
moves fast and its patterns are not the Next.js patterns.

## The mental model

The primitive is `parton(Render, options)` — a define-step constructor
returning a placeable component. Every render of one runs a single
pipeline:

1. **Match gates existence.** `match` evaluates the request — URL
   patterns and per-value predicates over `searchParams` / `cookies` /
   `headers`. A miss *parks* the client's cached variant (kept hidden,
   restored on re-match); named params from string patterns become the
   variant's identity (matchKey). Framework transport params
   (`TRANSPORT_PARAMS`: partials, cached, live, streaming, __frame,
   __frameUrl) are stripped before evaluation — match never sees them.
2. **The body reads; the read IS the dependency.** Tracked hooks —
   `searchParam()`, `cookie()`, `header()`, `pathname()`, `match()`,
   `session()`, `visible()`, `tag()` — record what the body actually
   consumed. Cells resolve in place: `await cell.resolve(args?)` for
   module cells, inline `localCell(key, opts)` for parton-scoped ones,
   `.with(args)` to bind on a JSX prop — each records a
   partition-scoped `cell:` dep. Wake hints (`expires()` /
   `staleUntil()`, clock via `time()`) declare freshness boundaries.
   There is no schema, no vary, no declared dependency list.
3. **The fingerprint decides re-sending.** The recorded read set
   re-reads against the request + invalidation timestamps and folds
   into an fp. The client presents cached fps (`?cached=`); a match
   skips the bytes. Body reads lag one render, healed in-response by
   the fp-trailer; declared match gates are skip-safe from render 1.
   `fpSkip: false` opts a spec out entirely (always-authoritative
   surfaces, e.g. the CMS editor chrome).
4. **The wire is per-parton.** Addressable specs (`selector || match`)
   are independently refetchable (`?partials=`), byte-cacheable, and
   live-updatable — a held connection streams per-parton lanes, each
   parton at its own cadence.
5. **Writes are plain server functions.** Import cells, call `.set`,
   wrap multi-writes in `atomic(fn)` — one commit, one driver wake, a
   throw rolls the batch back. Invalidation fans out by selector
   (`cell:<id>?<partition>`, `tag:<name>`, refetch labels) and wakes
   exactly the partons whose recorded deps match.

The canonical shapes:

```tsx
export const SearchResults = parton(
  async function SearchResultsRender(_: RenderArgs) {
    const q = searchParam("q") ?? ""                    // tracked read → fp
    const results = await searchCell.resolve({ q })     // cell dep → re-renders on write
    return <List items={results.value} />
  },
  {
    match: { pathname: "/search", searchParams: { q: (v) => v !== null } },
    selector: "#search-results",
  },
)
```

```ts
"use server"
export async function saveProfile(args: { name: string; bio: string }) {
  await atomic(async () => {
    await profileName.set(args.name)
    await profileBio.set(args.bio)
  })
}
```

## Spec authoring rules

- **Three constructors, one engine.** Pick by role:
  - `parton(Render, '/path')` / `parton(Render, {match, selector, cache, defer, fallback, keepalive, fpSkip})` — addressable subtree, request-dimensions only. The everything-else case. Addressability = `selector || match`.
  - `block(Render, {selector, schema, …})` — slot-placeable, CMS-driven. `schema({cms}) => ({…})` is the CMS resolution surface — the one declared schema in the framework.
  - `<Frame name initialUrl>{…}</Frame>` — plain component, opens a per-name URL scope for descendants (which inherit the frame chain via server context). Framed specs route and key on the frame's URL, not the page's.
- **The tracking invariant.** A body's read set must be a function of
  tracked inputs, props, and invalidation-covered data (cells/tags) —
  never of untracked nondeterminism (no `Date.now()` branching into a
  `cookie()` read). Wrappers need NO declaration for their descendants'
  sake: same-bucket changes ride the descendant fold, new-bucket first
  visits ride the cold-record gate (over-fetch, never stale).
- **`match` string form is strict URLPattern** — no auto-suffixing:
  `"/inspect/*"` does NOT match bare `/inspect`; use `"/inspect{/*}?"`
  for both. The object form (`MatchInit`) gates any request dimension:
  URL components take URLPattern strings or predicates
  `(value: string) => boolean`; `searchParams`/`cookies`/`headers` are
  per-value records (`string | (value: string | null) => boolean`,
  absence is `null`, order-independent). Predicates must be pure +
  sync (they re-run outside renders); named params come only from
  string components; `cookies` gates read the raw `Cookie` header, not
  the same-request `setCookie` overlay.
- **Existence vs emptiness.** Value-conditional existence is a match
  gate (`searchParams: {pages: (v) => Number(v) >= page}`) — a miss
  parks, cached client variants preserved. `return null` from Render
  is the other semantic: render an empty body, replacing the cached
  content.
- **Slot blocks** self-register in the type catalog under their
  auto-derived `type` (`HeroRender` → `"hero"`). `selector` is a flat
  list of refetch labels; the first label is the catalog id — and for
  singleton blocks, the CMS storage key. Slots compose from a host's
  `schema` via `cms.blocks(slot, selector?)` / `cms.block(slot,
  selector?)`; author code never threads content keys.
- **No `parent` prop.** A parton reads its parent (id path + frame
  chain) from server context — per-component ALS, backed by the
  `@vitejs/plugin-rsc` patch in `.yarn/patches/` (see
  [`docs/internals/server-context.md`](./docs/internals/server-context.md)).
  Place specs as `<Spec />`. `Render` receives
  `{...resolvedProps, ...matchParams, children}` — call-site props
  (cell-bearing ones resolved), then match params; no `parent`, no `id`.

## Where to read what

| Folder | For |
|---|---|
| [`docs/reference/`](./docs/reference/) | Framework contracts. `intro` · `partial` · `block` · `cells` · `frames-navigation` · `remote-frame` · `cache` · `cms` · `prior-art`. Read these to USE the framework. |
| [`docs/internals/`](./docs/internals/) | Mechanisms. `testing` · `render-pipeline` · `streaming` · `cache-internals` · `cell-internals` · `registry-internals` · `frame-scope` · `server-isolation` · `server-context` · `flight-gotchas`. Read these to MODIFY the framework. |
| [`docs/notes/`](./docs/notes/) | Active research: backlog (`IDEAS.md`), live design docs for unshipped work, framing notes. |
| [`docs/archive/`](./docs/archive/) | Superseded designs and debugging logs. Reference only. |

Fastest orientation path for a new task: this file → the
`docs/reference/` page for the surface you're touching → the matching
`docs/internals/` page if you're changing framework code.

## Project structure

Yarn workspace monorepo. Cross-package imports go through workspace
names (`@parton/<pkg>`), never relative paths.

| Path | Role |
|---|---|
| `framework/` (`@parton/framework`) | The runtime. `framework/index.ts` is the public barrel. `src/lib/` — partials primitives: `partial.tsx` (`parton` + `block` wrapper pipeline), `match.ts` (the compiled match gate), `cell.ts` (cells + `atomic()`), `frame.tsx`, `remote-frame.tsx`, the client merge layer (`partial-client.tsx` boundary + `PartialsClient`; state `partial-client-state.ts`, tree walks `partial-cache.ts`, template `partial-template.tsx`, refetch `refetch.ts`, frame handles `frame-client.tsx`, hooks `use-navigation.tsx`), `partial-registry.ts` (snapshots + route buckets), `server-hooks.ts` (tracked reads + wake hints), `server-context.ts`, `fp-trailer.ts`, `cache.tsx`, `flight-rewrite.ts` / `flight-graph.ts` / `snapshot-trailer.ts` (wire transforms). `src/runtime/` — RSC plumbing: `context.ts` (request ALS), `cell-actions.ts` (write endpoints), `invalidation-registry.ts`, `cms-{runtime,storage,prerender}.ts`, `navigation-api.ts`, `router.ts`, `session.ts`. `src/entry/` — the app entry factories (`createRscHandler`, `renderHTML`, `bootBrowser`) that thin app `entry.{rsc,ssr,browser}.tsx` files delegate to. `src/test/` — in-process Flight harness (`rsc-server.ts`). Module map: [`docs/internals/render-pipeline.md`](./docs/internals/render-pipeline.md). |
| `cms/` (`@parton/cms`) | CMS editor UI — three-pane shell (`src/editor/shell.tsx`, `actions.ts`, `components/`). Content store as data: `cms/data/content.json` (committed) + `draft.json` (gitignored). Public barrel exports `EditorShell`. |
| `copies/` (`@parton/copies`) | Vendored shadcn UI primitives (`src/components/ui/`), ai-elements, shared hooks, the `cn` helper. `components.json` lives here — where new shadcn components are added. |
| `e2e-testing/` (`@parton/e2e-testing`) | Example app (PokeAPI + GraphCommerce Magento backends) + Playwright specs in `e2e/`. `src/entry.{rsc,ssr,browser}.tsx` are thin delegations to `@parton/framework/entry/*`. `vite.config.ts` owns dev/build (its `environments.*.build.rollupOptions.input` map is what wires the three entries together). |
| `e2e-magento/` (`@parton/e2e-magento`) | Companion app on port 5181 hosting remote partons at `/__remote/<id>` for cross-origin `<RemoteFrame>`. Run alongside via `yarn dev:magento`. |
| `website/` (`@parton/website`) | The parton demo site (port 5183, `yarn dev:website`) — a Factorio-inspired infinite tile world where each 512px chunk is a parton; the framework's story told in-world. |

Load-bearing code: `framework/src/`, `cms/src/`, `copies/src/`,
`e2e-testing/src/`. Treat the rest as ignorable.

## Development

```bash
yarn dev                # Vite 8.1 (Rolldown) + RSC dev server (e2e-testing, port 5179)
yarn dev:magento        # Companion e2e-magento showcase (port 5181)
yarn dev:website        # The parton demo site (port 5183)
yarn build / build:magento
yarn typecheck          # tsc --noEmit, every workspace
yarn test               # typecheck + Vitest node + rsc projects
yarn test:node          # node tier only (jsdom) — fast, skips typecheck
yarn test:rsc           # rsc tier only (in-process Flight)
yarn test:browser       # real Chromium via Vitest browser mode
yarn test:e2e           # Playwright, e2e-testing/e2e/ (auto-starts dev servers)
yarn lint               # ESLint: React Compiler + rules-of-hooks (advisory; Biome formats)
yarn bench:server       # warm-tick CPU benchmark — see bench/README.md
```

`yarn test` and `yarn test:e2e` cover disjoint suites — **both must
pass before a change is done.** Tier picking and harness mechanics:
[`docs/internals/testing.md`](./docs/internals/testing.md). Each app's
vite config points `CMS_DATA_DIR` at the repo-level `cms/data/`.

Operational notes that save hours:

- **Flake census.** Under full-suite load these specs occasionally
  wobble but pass in isolation: `defer-concurrent-refetches.spec.ts:76`,
  `chat-streaming.spec.ts`, `cms-edit.spec.ts` (various),
  `remote-frame-crossorigin.spec.ts` (companion cold-start). Protocol:
  rerun the failing spec alone; if it passes in isolation AND behaves
  identically on master, it's census — don't chase it. A NEW failure
  that reproduces in isolation is yours. Probabilistic failures need
  `--repeat-each=3` minimum before trusting any bisect verdict.
- **Never start the e2e dev servers by hand for spec runs.**
  Playwright's config injects env the servers need (e.g.
  `MAGENTO_REMOTE_ORIGIN`); a hand-started `yarn dev` on the same port
  gets silently reused (`reuseExistingServer: true`) and cross-origin
  specs fail with `fetch failed`. Let `yarn test:e2e` own the servers;
  kill strays first.
- **Prod-parity verification matters**: prod redacts error messages
  (DEV-gated), so a fix verified only in dev can hide behind a debug
  row. Dev-build Flight also captures raw props into debug-info rows —
  don't read those rows as fresh renders in wire-level assertions.
- HMR dispose hooks clear cache + registry on edits — server restarts
  are rarely needed during dev.

## Data layer

GraphQL via `graphql-request` + gql.tada. One `graphql()` helper per
backend (per schema); queries are tagged strings with end-to-end type
inference — never pass manual type generics to `client.request`.

```ts
// e2e-testing/src/app/magento-graphql.ts
export const graphql = initGraphQLTada<{ introspection: introspection; scalars: { ... } }>()
const CartQuery = graphql(`query Cart($cartId: String!) { cart(cart_id: $cartId) { total_quantity } }`)
const data = await client.request(CartQuery, { cartId })   // typed end-to-end
```

- One `graphql()` helper per backend — don't mix schemas in a document.
- Define fragments with `graphql()` and pass them to queries that use them.
- Prefer module-scope `const MyQuery = graphql(\`...\`)` over inlining.

| API | Endpoint | For |
|---|---|---|
| PokeAPI | `https://beta.pokeapi.co/graphql/v1beta` | Primary example (Hasura) |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, `@defer`) |

## Tooling — `mcp-refactor-typescript`

The project ships an MCP server (`.mcp.json`) for type-aware TS
refactors. Prefer these over `Edit` / `mv` / `grep` for anything
crossing file boundaries — they update imports, dynamic imports, JSDoc
refs, and type-only imports that hand edits miss. All support
`preview: true`.

| Tool | Use for |
|---|---|
| `file_operations` | `rename_file`, `move_file`, `batch_move_files` — instead of `mv` for `.ts`/`.tsx`. |
| `refactoring` | `rename` (symbol-wide), `extract_function`, `extract_constant`, `extract_variable`, `move_to_file`, `infer_return_type`. |
| `workspace` | `refactor_module`, `cleanup_codebase` (⚠️ deletes files — always `preview: true` first), `restart_tsserver`. **Skip `find_references`** — it times out; use `refactoring.rename` with `preview: true` for blast-radius checks instead. |
| `code_quality` | `fix_all`, `organize_imports`, `remove_unused` per file. Run before commits after significant edits. |

## Working rules

### Comments describe the present

What the code does and why it is the way it is NOW. Never narrate
change: no "used to be X", no "we removed Y". That rationale goes in
the commit message, not the source. The code a future reader sees
should read as if it was always this way. (Same rule as the docs:
latest state only, no progression.)

### No heuristics

Solve a problem with the real signal, never a proxy that's merely
*usually* right. A heuristic infers intent from a coincidence —
matching a pathname to guess "same page", a timeout to guess
"settled", a string match to guess "benign abort". It works until the
coincidence breaks, and it bakes in a wrong mental model. When the
signal you need doesn't exist, **add it** — an explicit marker the
producer writes, a milestone, a state flag. Example: the live
heartbeat learns a stream is safe to abort from a done-marker the
stream itself writes, not by comparing URLs and hoping.

### Navigation — the Navigation API only

All client-side URL work goes through `useNavigation()`
(`navigate` / `reload` / `preload`) and the ambient browser Navigation
API it wraps. **Never the legacy History API** (`pushState`,
`replaceState`, `onpopstate`, `location.assign`) — it bypasses entry
state, scroll restoration, and interception, and silently desyncs
`currentEntry`. A bare URL update with no refetch is
`navigate(url, { history: "replace", silent: true })`. There is no
case in this codebase where the History API is the right tool.

### React 19.3 canary — use the current patterns

- **`useEffectEvent(fn)`** — stable callback seeing latest props/state; call it from effects/handlers. Not `ref.current = latest` during render.
- **`useNavigation().currentEntry.url`** for the URL (isomorphic) — never `window.location`.
- **`ref` is a plain prop** — no `forwardRef`. **`<Context value=…>`** is the provider. **`use(promise)` / `use(context)`** for conditional reads.
- **`<Fragment ref>`** → `FragmentInstance` (observe/measure children, no wrapper element).
- **`<Activity mode="hidden">`** keeps a subtree mounted but inert — the framework's parking uses this; reach for it for off-screen UI.
- **Document metadata** (`<title>`/`<meta>`/`<link>`) hoists from anywhere.
- **Forms/actions:** `<form action>`, `useActionState`, `useFormStatus`, `useOptimistic`, `startTransition` around async actions.
- **React Compiler** — opt-in (`compilationMode: "annotation"`): add `"use memo"` to compile a component/hook. Browser environment only — server components and their read-tracking are never compiled. `yarn lint` surfaces blockers.

## Working in a worktree

Prefer a fresh git worktree for a task over editing the main checkout —
it keeps the author's tree free and lands the work as a unit.

1. **Remap the e2e ports first.** Change `PORT` / `MAGENTO_PORT` at the
   top of `e2e-testing/playwright.config.ts` (canonical `5179`/`5181`)
   to random-ish free ports (`53xx`/`54xx`). Everything else derives
   from those two constants. Without the remap,
   `reuseExistingServer: true` silently runs your specs against the
   author's already-open dev servers — THEIR code, not yours. The remap
   is worktree-local scaffolding: keep it out of commits
   (`git update-index --skip-worktree` it, or revert before committing).
2. When done and both tiers are green: commit, merge to master, remove
   the worktree.

## Workflow — after a task is done

When a non-trivial task reaches a clean end state AND `yarn test` +
`yarn test:e2e` are both green:

1. **Update the docs.** Amend every `docs/reference/` +
   `docs/internals/` file touching the changed area. Latest state only.
   Design rationale for the future lives in `docs/notes/` (active) or
   `docs/archive/` (superseded).
2. **Archive stale notes.** A note earns archival when its design is no
   longer wired in or is superseded — add a
   `Superseded YYYY-MM-DD by docs/reference/X.md` banner, move it,
   update `docs/archive/README.md`.
3. **Confirm both suites green from a clean tree.** Don't commit red.
4. **Commit.** One commit per logical change, focused on the WHY.
   Imperative subject under 70 chars; body captures motivation +
   non-obvious tradeoffs. Docs + tests ride with the code. Don't amend;
   don't `--no-verify`.

The two test tiers + the docs surface are load-bearing — a fix without
the corresponding doc/test update is incomplete work.
