# parton — project instructions

A React Server Components framework for commerce-shaped UIs:
**server-owned state** — `useState` on the server — with Flight as the
communication layer, and independently re-renderable, addressable,
cacheable subtrees as the unit. Research project — the bet is _dynamic
range_: one primitive that stretches from the leanest, mobile-snappy
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
   `headers`. A miss _parks_ the client's cached variant (kept hidden,
   restored on re-match); named params from string patterns become the
   variant's identity (matchKey). The `cull` option is the second
   existence gate — viewport-driven: a culled instance's body never
   runs; the wire carries its client-rendered `skeleton` + props, the
   fp folds the RESOLVED visibility (`measurement ?? seed(props)`).
   Framework transport params (`TRANSPORT_PARAMS`: partials, live,
   streaming, visible, **frame, **frameUrl, **cullFlip, **force) are
   stripped before evaluation — match never sees them. (The fp-skip
   manifest is never a URL param — it rides the `x-parton-cached`
   header, self-stripping since match drops all `x-parton-*`.)
2. **The body reads; the read IS the dependency.** Tracked hooks —
   `searchParam()`, `cookie()`, `header()`, `pathname()`, `match()`,
   `session()`, `tag()` — record what the body actually
   consumed. Cells resolve in place: `await cell.resolve(args?)` for
   module cells, inline `localCell(key, opts)` for parton-scoped ones,
   `.with(args)` to bind on a JSX prop — each records a
   partition-scoped `cell:` dep. Wake hints (`expires()` /
   `staleUntil()`, clock via `time()`) declare freshness boundaries.
   There is no schema, no vary, no declared dependency list.
3. **The fingerprint decides re-sending.** The recorded read set
   re-reads against the request + invalidation timestamps and folds
   into an fp. The client presents cached fps (its manifest — the
   `x-parton-cached` header on an unattached action POST, the
   connection's session mirror when attached); a match skips the bytes. Body reads lag one render, healed in-response by
   the fp-trailer; declared match gates are skip-safe from render 1.
   `fpSkip: false` opts a spec out entirely (always-authoritative
   surfaces, e.g. the CMS editor chrome).
4. **The wire is per-parton.** Every parton is addressable — no
   opt-in: each is independently refetchable (`?partials=`,
   framework-internal), byte-cacheable, and live-updatable — a held
   connection streams per-parton lanes, each parton at its own
   cadence. Identity is the Render function's name (kebab-cased),
   placement-folded (`~<hash>`) when nested; anonymous Renders throw.
5. **Writes are plain server functions.** Import cells, call `.set`,
   wrap multi-writes in `atomic(fn)` — one commit, one driver wake, a
   throw rolls the batch back. Invalidation fans out by selector
   (`cell:<id>?<partition>`, `tag:<name>`) and wakes exactly the
   partons whose recorded deps match — cells for state-shaped
   signals, `tag()` for event-shaped ones; there is no imperative
   targeted refresh in the author surface.

The canonical shapes:

```tsx
export const SearchResults = parton(
  async function SearchResultsRender(_: RenderArgs) {
    const q = searchParam("q") ?? "" // tracked read → fp
    const results = await searchCell.resolve({ q }) // cell dep → re-renders on write
    return <List items={results.value} />
  },
  {
    match: { pathname: "/search", searchParams: { q: (v) => v !== null } },
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
  - `parton(Render, '/path')` / `parton(Render, {match, cull, cache, defer, fallback, keepalive, fpSkip})` — the base addressable subtree, request-dimensions only. The everything-else case. A bare `parton(Render)` is first-class: it fp-skips across navigations exactly like a match-gated surface.
  - `block(Render, {schema, …})` — slot-placeable, CMS-driven. `schema({cms}) => ({…})` is the CMS resolution surface — the one declared schema in the framework.
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
  auto-derived `type` (`HeroRender` → `"hero"`) — the catalog id slot
  lookups resolve, and for singleton blocks, the CMS storage key.
  Slots compose from a host's
  `schema` via `cms.blocks(slot)` / `cms.block(slot)`; author code
  never threads content keys.
- **No `parent` prop.** A parton reads its parent (id path + frame
  chain) from server context — per-component ALS, backed by the
  `@vitejs/plugin-rsc` patch in `.yarn/patches/` (see
  [`docs/internals/server-context.md`](./docs/internals/server-context.md)).
  Place specs as `<Spec />`. `Render` receives
  `{...resolvedProps, ...matchParams, children}` — call-site props
  (cell-bearing ones resolved), then match params; no `parent`, no `id`.

## Where to read what

| Folder                                 | For                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/reference/`](./docs/reference/) | Framework contracts. `intro` · `partial` · `block` · `cells` · `frames-navigation` · `remote-frame` · `cache` · `cms` · `prior-art`. Read these to USE the framework.                                                                             |
| [`docs/internals/`](./docs/internals/) | Mechanisms. `testing` · `render-pipeline` · `streaming` · `channel` · `cache-internals` · `cell-internals` · `registry-internals` · `frame-scope` · `server-isolation` · `server-context` · `flight-gotchas`. Read these to MODIFY the framework. |
| [`docs/notes/`](./docs/notes/)         | Active research: backlog (`IDEAS.md`), live design docs for unshipped work, framing notes.                                                                                                                                                        |
| [`docs/archive/`](./docs/archive/)     | Superseded designs and debugging logs. Reference only.                                                                                                                                                                                            |

Fastest orientation path for a new task: this file → the
`docs/reference/` page for the surface you're touching → the matching
`docs/internals/` page if you're changing framework code.

## Project structure

Yarn workspace monorepo. Cross-package imports go through workspace
names (`@parton/<pkg>`), never relative paths.

| Path                                   | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework/` (`@parton/framework`)     | The runtime. `framework/index.ts` is the public barrel. `src/lib/` — partials primitives: `partial.tsx` (`parton` + `block` wrapper pipeline), `match.ts` (the compiled match gate), `cell.ts` (cells + `atomic()`), `frame.tsx`, `remote-frame.tsx`, the client merge layer (`partial-client.tsx` boundary + `PartialsClient`; state `partial-client-state.ts`, tree walks `partial-cache.ts`, template `partial-template.tsx`, refetch `refetch.ts`, frame handles `frame-client.tsx`, hooks `use-navigation.tsx`), `partial-registry.ts` (snapshots + route buckets), `server-hooks.ts` (tracked reads + wake hints), `server-context.ts`, `fp-trailer.ts`, `cache.tsx`, `flight-rewrite.ts` / `flight-graph.ts` / `snapshot-trailer.ts` (wire transforms). `src/runtime/` — RSC plumbing: `context.ts` (request ALS), `cell-actions.ts` (write endpoints), `invalidation-registry.ts`, `cms-{runtime,storage,prerender}.ts`, `navigation-api.ts`, `router.ts`, `session.ts`. `src/entry/` — the app entry factories (`createRscHandler`, `renderHTML`, `bootBrowser`) that thin app `entry.{rsc,ssr,browser}.tsx` files delegate to. `src/test/` — in-process Flight harness (`rsc-server.ts`). Module map: [`docs/internals/render-pipeline.md`](./docs/internals/render-pipeline.md). |
| `cms/` (`@parton/cms`)                 | CMS editor UI — three-pane shell (`src/editor/shell.tsx`, `actions.ts`, `components/`). Content store as data: `cms/data/content.json` (committed) + `draft.json` (gitignored). Public barrel exports `EditorShell`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `copies/` (`@parton/copies`)           | Vendored shadcn UI primitives (`src/components/ui/`), ai-elements, shared hooks, the `cn` helper. `components.json` lives here — where new shadcn components are added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `e2e-testing/` (`@parton/e2e-testing`) | Example app (PokeAPI + GraphCommerce Magento backends) + Playwright specs in `e2e/`. `src/entry.{rsc,ssr,browser}.tsx` are thin delegations to `@parton/framework/entry/*`. `vite.config.ts` owns dev/build (its `environments.*.build.rollupOptions.input` map is what wires the three entries together).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `e2e-magento/` (`@parton/e2e-magento`) | Companion app on port 5181 publishing embeddable PAGES for cross-origin `<RemoteFrame>` (pages are the unit of federation; there is no special remote route). Run alongside via `yarn dev:magento`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `website/` (`@parton/website`)         | The parton demo site (port 5183, `yarn dev:website`) — a Factorio-inspired infinite tile world: a quadtree of cullable quad-tile partons over 512px chunk partons, so the document is O(viewport + log world); the framework's story told in-world.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Load-bearing code: `framework/src/`, `cms/src/`, `copies/src/`,
`e2e-testing/src/`. Treat the rest as ignorable.

## Development

```bash
yarn dev                # Vite 8.1 (Rolldown) + RSC dev server (e2e-testing, port 5179)
yarn dev:magento        # Companion e2e-magento showcase (port 5181)
yarn dev:website        # The parton demo site (port 5183)
yarn build / build:magento
yarn build:all && yarn preview:all  # prod build + preview (e2e :5173, magento :5181)
yarn typecheck          # tsc --noEmit, every workspace
yarn test               # typecheck + Vitest node + rsc projects
yarn test:node          # node tier only (jsdom) — fast, skips typecheck
yarn test:rsc           # rsc tier only (in-process Flight)
yarn test:browser       # real Chromium via Vitest browser mode
yarn test:e2e           # Playwright, e2e-testing/e2e/ (auto-starts dev servers)
yarn lint               # ESLint: React Compiler + rules-of-hooks (advisory)
yarn format             # Prettier --write (config in .prettierrc)
yarn bench:server       # warm-tick CPU benchmark — see bench/README.md
node website/validate-world.mjs  # FETCH-transport world gate (prod build):
                        # forces ?transport=fetch (its byte/beacon budgets
                        # are fetch contracts). Boot wire budgets incl. the
                        # attach catch-up, 4-direction stream-in timing,
                        # refresh/stress/parked checks. Run after any
                        # streaming/culling change: `yarn build:website` first.
node website/validate-ws.mjs     # forced-WS gate: drives the world at
                        # ?transport=ws and proves establish/attach/
                        # stream/upstream all ride the one /__parton/ws
                        # socket (zero fetch to /__parton/{live,channel}),
                        # HMR intact. Preview by default; `--dev` for dev.
                        # `yarn build:website` first (preview mode).
node website/validate-upgrade.mjs # AUTO-UPGRADE gate: boots the world with NO
                        # ?transport= param and proves fetch-first (a POST
                        # /__parton/live), then the NO-TEAR handover to the
                        # /__parton/ws socket (the held fetch attach closes
                        # CLEANLY — requestfinished, only after the socket
                        # opened), streaming/culling intact across the
                        # switch, zero further fetch POSTs.
                        # `yarn build:website` first.
node website/validate-no-ws.mjs  # CAPABILITY-GATE gate: every in-repo app now
                        # ships partonChannelServer, so the unadvertised page
                        # is produced by SUPPRESSING the bootstrap's
                        # `self.__partonWsAvailable` write client-side; it
                        # proves the auto-upgrade stands down — ZERO
                        # `/__parton/ws` sockets, no WS console error, fetch
                        # channel stays live (the served document carrying
                        # the flag is the control). Run after any
                        # auto-upgrade / capability-gate change: `yarn build`
                        # first (builds e2e-testing).
node website/validate-two-viewers.mjs # BROADCAST-LANE gate: TWO independent
                        # browser contexts on ONE world (default transport)
                        # — both stay live at their cadences, one viewer's
                        # scroll never disturbs the other's position/content/
                        # pulses. Run after any broadcast-lane / delivery-
                        # plane change: `yarn build:website` first.
node website/validate-bidding.mjs # COMPOSED-WRITE gate: the auction district —
                        # THREE browser contexts on ONE lot; a 50-bid
                        # storm from two of them must compose exactly
                        # (`cell.update` — zero lost updates, final
                        # amount/bids to the digit), every viewer
                        # converges on screen, the third watcher's
                        # render-line count proves the bid lane fanned
                        # out as ONE broadcast render, and a neighbour
                        # lot's partition stays untouched. Run after
                        # any cell-write / broadcast change:
                        # `yarn build:website` first.
node website/validate-scroll-stress.mjs # ADVERSARIAL-SCROLL gate: drives the
                        # dense world (?chunk=128, 2560×1440) through bursts,
                        # reversals, backtracks, diagonals; after every stop
                        # the hole detector asserts the viewport converges —
                        # no missing chunk coords, no quad placeholders, only
                        # 1-2 known-transient shells that clear. Advisory in
                        # CI while the backtrack-hole residual is open.
                        # `yarn build:website` first.
node website/validate-embassy.mjs # EMBASSY-DISTRICT gate: the world's
                        # Paint-tier exhibit — /embassy/bulletin is
                        # browsable standalone (contraband raw HTML +
                        # a raw <a href> included), splices into the
                        # building's contained embed box under
                        # grant="paint", host --parton-* theming
                        # crosses the containment boundary, neither
                        # contraband row paints (dev marker / prod
                        # silent + the structured log line either
                        # way), the escalation probe (clicks inside
                        # the box never move the host document —
                        # realm token + URL), district tint, world
                        # hygiene. Run after any embed / grant /
                        # vocabulary change: `yarn build:website`
                        # first.
node e2e-testing/validate-hmr.mjs # DEV-HMR LIVE-EDIT gate: boots its own
                        # dev server (:5327), rewrites /hmr-probe's
                        # source through every transport phase
                        # (fetch-era, consecutive, post-WS-upgrade,
                        # framework-file edit, reload) and asserts the
                        # browser updates LIVE — plain AND byte-cached
                        # partons. No build step. Run after any change
                        # to the HMR wiring, channel drives, or the fp
                        # formula (docs/internals/render-pipeline.md
                        # § Dev HMR).
```

`yarn test` and `yarn test:e2e` cover disjoint suites — **both must
pass before a change is done.** Tier picking and harness mechanics:
[`docs/internals/testing.md`](./docs/internals/testing.md). Each app's
vite config points `CMS_DATA_DIR` at the repo-level `cms/data/`.

Operational notes that save hours:

- **Flake census.** Under full-suite load these specs occasionally
  wobble but pass in isolation: `defer-concurrent-refetches.spec.ts:76`,
  `chat-streaming.spec.ts`, `cms-edit.spec.ts` (various),
  `remote-frame-crossorigin.spec.ts` (companion cold-start),
  `use-navigation-tuple.test.tsx` "@self" (node tier — cold vitest
  transform cache leaks stale statements into `statedForce()`; fails
  on clean HEAD too, passes warm/isolated). Protocol:
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
- **Prod-parity verification matters**: the canonical way to verify a
  change is the prod build+preview, not `yarn dev` —
  `yarn build:all && yarn preview:all` (e2e-testing on
  `http://localhost:5173`, magento companion on `:5181`). Prod redacts
  error messages (DEV-gated), so a fix verified only in dev can hide
  behind a debug row — reproduce in prod, but read the actual message
  in dev. Dev-build Flight also captures raw props into debug-info
  rows — don't read those rows as fresh renders in wire-level
  assertions. `preview-all.sh` detaches its vite grandchildren, so to
  restart cleanly kill the whole `yarn preview:all` tree (or the port
  holders on `:5173` / `:5181`), not just the yarn shim.
- Server-code edits reach connected pages LIVE (no reload): a dev-only
  code-version term moves every fp on an rsc-graph edit, held drives
  detach (the client reattaches through a fresh entry import), and the
  `rsc:update` silent renav carries the fresh bodies — see
  `docs/internals/render-pipeline.md` § Dev HMR. Full-reload dispose
  hooks still clear cache + registry; server restarts are rarely
  needed during dev.

## Data layer

GraphQL lives under the framework at `@parton/framework/graphql` —
gql.tada + graphql-request are framework dependencies; an app never adds
them. One `graphqlBackend()` call per backend (per schema) binds the
client, the gql.tada tag, and the cell constructors, fully typed
end-to-end. Queries are tagged strings — never pass manual type generics
to `client.request`.

```ts
// e2e-testing/src/app/magento.ts
import { graphqlBackend } from "@parton/framework/graphql"
import type { introspection } from "./magento-env.d.ts"

export const magento = graphqlBackend<{
  introspection: introspection
  scalars: { DateTime: string; Date: string }
}>({ endpoint: MAGENTO_ENDPOINT, prefix: "magento" })

export const { graphql, client } = magento
const CartQuery = graphql(`
  query Cart($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`)
const data = await client.request(CartQuery, { cartId }) // typed end-to-end
```

- The introspection `-env.d.ts` is generated by `parton gql <url> --name
<name>` (a framework bin — the app needs no gql.tada dep). The full
  zero-to-backend recipe is [`framework/src/graphql/README.md`](./framework/src/graphql/README.md).
- One backend per schema — don't mix schemas in a document. `prefix`
  namespaces cell wire ids; `backend.query()` / `backend.fragment()` build
  cells (raw `graphql()` hidden); `graphql` + `client` handle mutations.
- Define fragments with `backend.fragment()`; compose them into queries by
  passing the CELL. Prefer module-scope `const MyQuery = graphql(\`...\`)`.

| API           | Endpoint                                       | For                             |
| ------------- | ---------------------------------------------- | ------------------------------- |
| PokeAPI       | `https://beta.pokeapi.co/graphql/v1beta`       | Primary example (Hasura)        |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, `@defer`) |

## Tooling — `mcp-refactor-typescript`

The project ships an MCP server (`.mcp.json`) for type-aware TS
refactors. Prefer these over `Edit` / `mv` / `grep` for anything
crossing file boundaries — they update imports, dynamic imports, JSDoc
refs, and type-only imports that hand edits miss. All support
`preview: true`.

| Tool              | Use for                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_operations` | `rename_file`, `move_file`, `batch_move_files` — instead of `mv` for `.ts`/`.tsx`.                                                                                                                                                     |
| `refactoring`     | `rename` (symbol-wide), `extract_function`, `extract_constant`, `extract_variable`, `move_to_file`, `infer_return_type`.                                                                                                               |
| `workspace`       | `refactor_module`, `cleanup_codebase` (⚠️ deletes files — always `preview: true` first), `restart_tsserver`. **Skip `find_references`** — it times out; use `refactoring.rename` with `preview: true` for blast-radius checks instead. |
| `code_quality`    | `fix_all`, `organize_imports`, `remove_unused` per file. Run before commits after significant edits.                                                                                                                                   |

## Working rules

### Comments describe the present

What the code does and why it is the way it is NOW. Never narrate
change: no "used to be X", no "we removed Y". That rationale goes in
the commit message, not the source. The code a future reader sees
should read as if it was always this way. (Same rule as the docs:
latest state only, no progression.)

### No heuristics

Solve a problem with the real signal, never a proxy that's merely
_usually_ right. A heuristic infers intent from a coincidence —
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

### API surface discipline

- **Plain components over factories.** Only reach for a `parton()` /
  `block()`-style constructor when define-time work genuinely requires
  it (catalog registration, match/URLPattern compile, the
  Render→Component bridge). When the only "construction" is reading
  props, use a plain component — `<Frame name initialUrl>` carries the
  same information as a factory would, without the indirection.
- **No speculative primitives (YAGNI).** Don't add a hook, helper, or
  factory until a real in-tree call site needs it — "the use cases
  sound reasonable" is not enough. If nothing in the tree hits the
  manual form yet, it stays in `docs/notes/IDEAS.md`, not the code;
  when you do ship a primitive, ship it with its first caller.
  (Exception: framework infrastructure where the framework itself is
  the caller.)
- **The framework provides, not the app.** Cross-cutting capabilities
  wire into the root primitives — `PartialRoot` (page scope) and
  `Frame` (frame scope) — so every app gets them with zero app-side
  plumbing. Never introduce an app-placed provider the app must mount;
  keep such components framework-internal (out of the public barrel).

### Formatting — Prettier owns it

Formatting is Prettier, config in `.prettierrc` (`printWidth: 100`,
`semi: false`; 2-space and double quotes by default). It runs on save
and via `yarn format` (`yarn format:check` verifies). Let Prettier
format — don't hand-tune spacing or wrapping against it, and don't add
a second formatter. `.prettierignore` holds out the vendored shadcn
under `copies/` and the generated `*-env.d.ts` files. `yarn lint` is
ESLint, scoped to the React Compiler / rules-of-hooks diagnostics only.

### Research mode — shave to the core

This is a primitives-research project, not a roadmap. The mode is an
elegance game: work a problem through, make it as elegant as possible,
then shave to the essential core. A dead end is an acceptable
outcome — exploration that ends in deletion is a success, not waste;
the win is a primitive that couldn't exist in an existing framework
(the move that replaced explicit `vary` with auto-tracked reads is the
model). Frame proposals as consolidation and surface-deletion, not
productionization checklists. Multi-process is expected to work;
sticky sessions are an acceptable constraint. Don't pitch the project
as a CMS framework — the CMS editor is one demo surface among several
(its storage is deliberately demo-grade); the leverage is the wire
format, streaming, and server-state substrate.

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
