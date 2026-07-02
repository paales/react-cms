# `parton(Render, …)`

The framework's base addressable-render-unit constructor. A spec is
constructed once at module scope from a `Render` function and an
options object; the call returns a placeable React component. Every
request dependency the spec has — search params, cookies, headers,
session — is whatever its `schema` and `Render` actually read through
the tracked server-hooks (`searchParam()`, `cookie()`, …): the read
IS the dependency, recorded per render and folded into the
fingerprint.

> **Three constructors, one engine.** `partial` is the base case.
> Slot-placeable CMS-driven units use [`block`](./block.md);
> frame-scope openers use the `<Frame>` component
> ([frames-navigation.md](./frames-navigation.md)). All three produce
> partials at runtime — same registry, same fingerprint pipeline,
> same refetch path.

```tsx
import { parton, ROOT, type RenderArgs } from "./lib"

const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

// Anywhere in JSX:
<PokemonPage />
```

## Tier 1 — pattern-match shorthand

When a string is passed as the second argument, it's treated as the
`match` pattern. On miss, the spec doesn't render. Pattern params
flow into `Render`'s props directly.

```tsx
const HomePage = parton(Home, "/")
const PokemonPage = parton(PokemonRender, "/pokemon/:id")
```

### Match grammar — what flows into props

`ParseRoute<T>` infers a `{ name: string }` shape from the pattern at
the type level. URLPattern syntax handled:

| Pattern | Type |
|---|---|
| `/:foo` | `{ foo: string }` |
| `/:foo?` | `{ foo?: string }` (optional) |
| `/:foo+` / `/:foo*` | `{ foo: string }` (URLPattern flattens repeats to one string) |
| `/:foo(\d+)` | `{ foo: string }` (regex constraint at runtime; value stays string) |
| `/*` | not in result (anonymous wildcard) |
| `/{group}?` | bracket-stripped; named params inside parse normally |

URLPattern is the source of truth for what actually matches at runtime;
unparseable corners fall through and the prop is just absent. Coerce
inside `schema` (or `Render`) when you need a non-string shape —
`param()` is a pure read of an already-folded match param:

```tsx
schema: () => ({ id: Number(param("id")) })
```

## Tier 2 — options object

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60 },
  schema: () => ({ variant: searchParam("variant", "default") }),
})

async function ProductHeroRender({
  slug, variant,
}: { slug: string; variant: string } & RenderArgs) {
  const product = await getProduct(slug)
  return <Hero product={product} variant={variant} />
}
```

For CMS-driven content (text, images, references), use
[`block`](./block.md) with a `schema` callback.

`match` runs first; on miss, `schema` doesn't run. On match, the
pattern's named params flow straight into Render's props, and
`schema`'s result merges alongside. A schema-phase
[`park()`](#park--the-value-conditional-gate) is the
value-conditional "don't render" gate.

## Options

```ts
interface PartialOptions {
  match?: MatchPattern                             // URLPattern gate
  schema?: (scope: ScopedCellFactories) => Record<string, unknown>
  actions?: Record<string, (scope, args) => Promise<unknown>>
  selector?: SelectorTokens                        // auto-derived from Render.name
  cache?: CacheOptions
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  keepalive?: boolean                              // default true
  capabilityType?: string                          // remote-manifest typing
}
```

| Option | Notes |
|---|---|
| `match` | URLPattern pathname (or full `URLPatternInit`). `/p/:slug`, `/p/:slug/reviews/:page`, `/inspect/*` (descendants only), `/inspect{/*}?` (bare + descendants). Pattern miss → spec emits nothing. Anonymous `*` captures don't fold into the fingerprint — only named groups (`:foo`) do; a spec that genuinely depends on the wildcard tail reads `pathname()` explicitly. |
| `schema` | Sync callback, runs before the fingerprint. Returns the record merged into Render's prop bag: scoped cell descriptors (via the injected `{ localCell }` factory), module cell handles / `.with()` bindings (resolved into `ResolvedCell<T>`s), or plain values. Tracked hooks work here and fold into the CURRENT fingerprint with no cold lag — the natural home for request-derived reads (`schema: () => ({ q: searchParam("q", "") })`) and request-derived cell bindings (`cart: cartCell.with({ cartId: cookie("cart_id") })`). **No `cms` here** — CMS reads live on `block`'s `schema` callback. |
| `actions` | Server-side handlers exposed as `ResolvedAction`s in Render's prop bag. See [Actions](#actions). |
| `selector` | One or more refetch labels. Plain strings; leading `#` / `.` are cosmetic and stripped on parse (`"#hero"` and `"hero"` are equivalent). Defaults to `<kebab-cased Render.name minus Page/Block/Render/Partial suffix>`. The first label is the spec's catalog id; additional labels are extra fan-out targets. Multiple placements of the same spec share their labels; `nav.reload({selector: "label"})` hits every carrier. |
| `cache` | See [`cache.md`](./cache.md). |
| `defer` | `true` for app-driven, an activator element to wire automatically. |
| `fallback` | React node rendered while the partial's body is suspended. |
| `keepalive` | When `true` (default), the rendered body is wrapped in a `<Activity mode="visible" key={matchKey}>` while active and the spec emits `<Activity mode="hidden">` + placeholder for each cached variant on cross-route nav (instead of returning nothing on a `match` miss or a schema `park()`). The client substitutes its cached subtree at each placeholder, so the React fiber tree stays shape-stable across active ↔ parked transitions — `useState`, `useRef`, and DOM state survive a navigate-away-and-back round-trip. Multiple variants of the same spec (e.g. `/pokemon/1` ↔ `/pokemon/2`) coexist as hidden Activity siblings keyed by `matchKey` so each variant's fiber stays alive across cross-variant navigation. Set to `false` for partials whose state should reset on cross-route nav (heavy video/iframe DOM, debug-only specs, anything where stale state is worse than re-mount cost). |
| `capabilityType` | Capability schema name referenced by the `/__remote/manifest.json` endpoint so `parton add` can generate typed bindings. Omit if the spec doesn't read capability values. See [`remote-frame.md`](./remote-frame.md). |

## Tracked reads — the server hooks

Free functions imported from the framework, callable anywhere inside
a parton's `schema` or `Render` body. Each returns the request value
AND records a dependency key on the parton's live dep set, so the
read folds into the fingerprint — a changed cookie / search param /
header moves the fp and the parton re-renders on the next
navigation. The read IS the dependency, exactly like a cell.

| Hook | Reads | Records |
|---|---|---|
| `cookie(name)` | Request cookie. | `cookie:<name>` |
| `searchParam(name, fallback?)` | URL search param. The two-argument form defaults an ABSENT param only — a present-but-empty `?q=` still returns `""`. Absence is a value; the fp folds the two distinctly. | `search:<name>` |
| `header(name)` | Request header, name lowercased per HTTP semantics. Framework-internal `x-parton-*` headers are invisible — the read returns `undefined` and records nothing. | `header:<name>` |
| `pathname()` | The (frame-resolved) request pathname. The whole-pathname axis — it moves the fp on EVERY path change, so prefer `match()` / `param()` when a named segment is enough. | `pathname:` |
| `match(pattern)` | Runs `pattern` (same shape as the `match` option; string patterns typed via `ParseRoute`) against the request URL; returns the named captures or `null`. Folds only the MATCHED PARAMS — the spec varies when its captured segment changes, never on every navigation. | `match:<pattern>` |
| `param(name)` | A resolved match param (`/pokemon/:id` → `param("id")`). Pure read, records NOTHING — match params already fold into the fp via `matchKey`. | — |
| `session()` | `{ id }` — the session identity; `""` for an anon request with no session yet. | `session:` |
| `visible(options?)` | The parton's viewport visibility (tri-state; `undefined` pre-measurement). Calling it makes the parton cullable — entering/leaving the viewport moves its fp. | `visible:<id>` |
| `tag(name)` | Registers an invalidation tag computed per render (`` tag(`product:${id}`) ``), so a matching `refreshSelector(name)` shifts the fp and the name becomes a refetch target. Schema-phase: folds into this render's label set directly — zero lag. Render-body: records a `tag:<name>` dep riding store-and-reread (the natural slot for tags a loader's response yields). | `tag:<name>` |

All hooks read from the parton's frame-resolved request, so a framed
spec tracks its frame's URL and cookies. Outside a parton body
they're no-ops returning the empty value.

`cookie()` overlays any in-request `setCookie()` writes on top of the
request header — so a partial re-rendered immediately after an action
calls `setCookie("cart_id", X) + getServerNavigation().reload({
selector: "cart" })` reads the new value (consistent with
`readCookie`). `Max-Age=0` follows browser deletion semantics and
removes the cookie from the overlay; a non-zero `Max-Age` with an
empty value reads as the empty string.

### Timing — store-and-reread

Where the read runs decides its fingerprint lag:

- **Schema-phase reads** fold into the CURRENT fingerprint with no
  cold lag — `schema` runs before the fp is computed.
- **Render-body reads** are recorded during the render, but the fp
  was computed before the body ran — so the fold uses the PRIOR
  render's recorded keys, re-read at the current request
  (store-and-reread). The first render of a variant folds nothing and
  emits a cold fp; the fp-trailer ships the cold→warm drift in the
  same response, so the very next navigation is fp-accurate.

### Cold-record gate

With no prior snapshot for a route bucket, a spec's fp folds no deps
— it could collide with a fingerprint the client cached under
DIFFERENT read values. fp-skip is therefore DECLINED on a cold record
unless the committed evidence proves the id is depless (every
committed variant recorded an empty read set — a fixed point, since
reads are conditioned only on tracked inputs). Cold degrades to
over-fetch, never staleness.

### The tracking invariant

A Render's tracked-read set must be a function of tracked inputs,
call-site props, and invalidation-covered data (cells, tags) — never
of untracked nondeterminism. `if (Date.now() % 2) cookie("x")` breaks
the model: the read set changes with nothing to move the fp first.
Keep the invariant and the machinery is airtight — any change in the
read set is preceded by a change in some previously-read value, which
moves the fp, re-renders, and re-records.

### Custom dep kinds — `registerDepKind`

`registerDepKind(kind, evaluate)` is the extension point for external
re-readable dependencies the built-in hooks don't cover. `evaluate`
must be a pure sync read of `(name, request)`; every fingerprint fold
re-reads it (store-and-reread), so a changed value moves the fp like
any tracked read. It returns the kind's tracked-read hook:

```ts
const docMtime = registerDepKind("docmtime", (abs) =>
  String(statSync(abs).mtimeMs))
// in a Render:
docMtime(resolved.abs)
```

The CMS layer registers its `cms:<contentKey>` content-hash kind this
way — a block's fingerprint tracks its content row through the same
channel as every other dependency.

## `park()` — the value-conditional gate

`match` gates on URL shape; `park()` gates on values. A schema-phase
hook that throws a branded signal; the wrapper catches it before the
fingerprint is computed and emits the parked keepalive (hidden
`<Activity>` per cached client variant — no snapshot registration, no
fp) instead of rendering:

```tsx
schema: () => {
  const page = Number(param("page") ?? "1")
  const pages = Math.max(1, Number(searchParam("pages")) || 1)
  if (page > pages) park()
  return { page }
},
```

Schema-phase only — a `park()` in the Render body throws (parking
must happen before the fp exists). The decision re-evaluates from
live reads on every parent render pass, so no dep record is needed
for un-parking.

Contrast `return null` from Render: that registers the spec (deps
recorded, fp emitted) and replaces the client's cached variant with
an empty body. `park()` preserves the parked client state — exactly
the cross-route keepalive emission. During action dispatch a `park()`
converts to a dispatch error — a parked parton cannot handle actions.

## Wake hints — `expires()` / `staleUntil()` / `time()`

`expires(at)` declares a freshness boundary for this render: after
`at` (epoch ms) the output is no longer fresh. Two consumers:

- the live segment driver arms its expiry timer on the earliest
  boundary across the route's snapshots, so an open `?live=1`
  connection wakes and re-renders the parton on time;
- fp-skip declines to serve a snapshot past its boundary, even on an
  fp match — the boundary IS the declaration that identical inputs
  stop being fresh at that time.

`staleUntil(at)` declares the stale-while-revalidate window beyond
`expires()`. Multiple calls keep the EARLIEST boundary. Both are
callable anywhere in schema or Render — they write a live box on the
snapshot, so post-await calls still land before the driver consults
it, and a skip/defer pass threads the prior snapshot's box through so
a wake schedule survives a skip.

Wake hints never enter the fingerprint — folding a wall-clock
timestamp would shift the fp every millisecond.

`time()` is the render clock — quantized boundaries for deriving wake
hints without inline `Date.now()` math. Reading it records nothing;
it is not a dependency.

```ts
expires(time().nextSecond)   // live ticker
expires(time().in(60_000))   // one-minute TTL
time().never                 // +Infinity — sentinel for "no expiry"
```

## `Render` props

`Render` receives, in order: any extra props passed at the JSX call
site, the named match params, the resolved `schema` result, the
resolved actions, and the framework-injected `children`. Later rows
win on collision.

| Key | Source |
|---|---|
| `<JSX call-site props>` | placing spec, e.g. `<Hero pokemonId={id} />` |
| `<named match params>` | the `match` pattern — `/pokemon/:id` → `{ id }` |
| `<every key from schema's return>` | author — cell descriptors/handles resolve to `ResolvedCell<T>`, plain values pass through |
| `<every key from actions>` | author — each handler becomes a `ResolvedAction` |
| `children` | framework — passes outer JSX children through |

A parton neither receives nor threads a `parent` — nested specs and
slot hosts read their parent (id path + frame chain) from server
context (the ambient parton; see
[`server-context.md`](../internals/server-context.md)). There is no
`id` prop on the Render surface either — CMS-bound blocks
([`block.md`](./block.md)) get their content via `schema` reads, and
the framework binds the read surface to the right row internally.

### `typeof Spec.props` — derive the prop bag from the spec

The returned spec carries a phantom `.props` type that resolves to the
prop bag the framework supplies to `Render` (match params + schema
result + actions + `RenderArgs`). Use it to skip retyping the same
shape across sibling factories or hooks:

```tsx
const Hero = parton(HeroRender, { match: "/pokemon/:id" })
type HeroProps = typeof Hero.props          // { id: string } & RenderArgs
function HeroRender({ id }: HeroProps) { … }

// `.props` has no runtime value — it's a type-only phantom.
```

The forward-reference shape (`const Spec = partial(R, opts);
function R(p: typeof Spec.props)`) hits a circular initializer in TS.
Use the two-step builder below if you need the type before the Render
exists.

### Two-step builder — `partial(opts)`

When the Render is declared after the spec OR you want the prop type
to drive the function signature directly, call `partial` with just
options. The result is a callable builder that exposes `.props` for
forward-reference inference:

```tsx
const HeroBuilder = parton({ match: "/pokemon/:id" })
function HeroRender(p: typeof HeroBuilder.props) {
  return <article>#{p.id}</article>
}
const Hero = HeroBuilder(HeroRender)
```

The two-step form produces an identical spec to the single-step form;
it just orders the type plumbing differently to dodge the cycle.

### Call-site prop pass-through

`parton(Render, …)` feels like `React.memo(Render)`: the
returned component's prop signature is Render's prop signature minus
the keys the framework already provides (match params, schema keys,
actions) minus the framework-injected keys. TypeScript subtracts
both, so the call site is exactly the props you still have to supply.

```tsx
// schema fills `pokemonId` → call site takes nothing
const Hero = parton(HeroRender, {
  match: "/pokemon/:id",
  schema: () => ({ pokemonId: Number(param("id")) }),
})
function HeroRender({ pokemonId }: { pokemonId: number } & RenderArgs) { … }
<Hero />
```

```tsx
// no match, no schema → `pokemonId` is required at the call site
const Hero = parton(function HeroRender({
  pokemonId,
}: { pokemonId: number } & RenderArgs) { … })
<Hero pokemonId={9} />
```

This is what makes nested wrappers work: an outer wrapper matches
the URL once, then threads typed props down to its children without
forcing each child to re-parse the URL.

```tsx
const PokemonDetailPage = parton(
  function PokemonDetailRender({ id }: { id: string } & RenderArgs) {
    return (
      <>
        <Hero id={id} />
        <Stats id={id} />
        <Species id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)

// Inner specs have no `match`, no reads of their own — the wrapper
// gates the route once and passes `id` as a prop.
const Hero = parton(async function HeroRender({
  id,
}: { id: string } & RenderArgs) {
  const data = await client.request(PokemonHeroQuery, { id: Number(id) })
  …
})
```

`{ match: "/pokemon/:id" }` alone is enough — `ParseRoute<P>` extracts
`:id` from the pattern at the type level and auto-flows it as a typed
`{ id: string }` into Render. Add a `schema` only when you need to
reshape the params (coercion, defaults, derived values). Call-site
props are part of the cache fingerprint automatically — two parents
passing different `id` values produce different cache entries.

The framework captures the call-site props in the spec's snapshot
so a partial-refetch (cache-mode `?partials=…`) can re-invoke the
child without going through its parent and still receive the same
props. This is per-user-session state — concurrent requests from
the same scope passing different prop values for the same partial
id could race; the proper fix is wiring props through the client
so refetches carry the props they were originally rendered with.

## Slots

Slot composition is a block-spec concern. A parton's `schema` has no
`cms` surface and can't read CMS slot entries — if you need a unit
that hosts CMS-managed children, use [`block`](./block.md)
and declare the slot via `cms.blocks(slot, selector?)` /
`cms.block(slot, selector?)` inside `schema`. A partial that happens
to render a singleton block can still place it directly via JSX
(`<SomeBlock />`); the block's CMS row falls out of
its spec id (the first selector label, or `Render.name`-derived).

## Selector grammar

A flat list of labels — whitespace-separated tokens, OR an array. Each
label is a refetch target; `nav.reload({selector: "label"})` matches
every spec whose label list includes `"label"` (or whose catalog id
equals it).

```ts
selector: "hero"                   // one label
selector: "page-block hero"        // two labels
selector: ["page-block", "hero"]   // same
```

Leading `#` and `.` are stripped on parse — cosmetic only, kept for
back-compat. `"#hero"`, `".hero"`, and `"hero"` are equivalent.

The **first label** is also the spec's catalog id (the wire `id`,
the snapshot key, the id that `selector: "@self"` resolves to from
inside the partial). For singleton blocks, it's also the CMS storage
row the spec reads from.

Auto-derived from `Render.name` when omitted: `PokemonHeroRender` →
`"pokemon-hero"`.

There's no per-page uniqueness check. Multiple placements of the
same spec share their labels and fan out under refetch — for the
common LivePrice-per-product case, that's the intended model.
Per-instance addressing for keyless multi-placements isn't a
framework concern; if you need per-row identity, route the content
through a CMS slot.

## Skip semantics

A spec emits in one of four shapes, in priority order:

1. **`match` miss or schema `park()`, no cached entry on the
   client.** Spec emits nothing — the JSX position is empty.
2. **`match` miss or schema `park()`, AND the client has one
   or more variants cached (declared via `?cached=id:matchKey:fp`),
   AND `keepalive` is on (default).** Spec emits one
   `<Activity mode="hidden" key={matchKey}>{placeholder}</Activity>`
   per cached variant. The client substitutes each placeholder with
   its cached subtree, so every cached variant stays parked under
   its own hidden Activity. React reconciles each Activity by its
   `matchKey` against the prior render, preserving inner fibers
   across the cross-route transition.
3. **`match` succeeded, fingerprint matches the client's cached
   one.** Spec emits
   `<Activity mode="visible" key={matchKey}>{placeholder}</Activity>`
   plus a hidden Activity sibling for each other cached matchKey.
   Client substitutes from cache — same bytes as last render, no
   body re-execution. (The fp-skip is also gated by the
   [cold-record gate](#cold-record-gate) and the
   [wake-hint TTL](#wake-hints--expires--staleuntil--time) — a cold
   dep record or an expired snapshot declines the skip and renders.)
4. **`match` succeeded, fingerprint differs (fresh render).** Spec
   executes its `Render`, wraps the result in
   `<Activity mode="visible" key={matchKey}>
   <Suspense …><PartialErrorBoundary …>{body}</PartialErrorBoundary>
   </Suspense></Activity>`, plus a hidden Activity sibling for each
   other cached matchKey, and streams it.

**Mental model: `match` chooses *which instance*, its reads choose
*what that instance shows*.** A new `match` param value mints a new
variant — a separate, independently-parked subtree, like a React
`key`; a changed read value transitions the *same* instance in place,
like props.

`matchKey` is that variant identity. A spec with its OWN `match`
having named params hashes those (`hash(stableStringify(params))`).
A spec WITHOUT named match params walks `parent.path` and inherits
the closest ancestor's matchKey — so a `<Hero>` inside `/pokemon/:id`
gets a distinct matchKey per `:id` value, even though `Hero` itself
has no `match`. This propagates URL-derived variant identity through
the JSX tree without threading extra state.

So:
- `/pokemon/1` ↔ `/pokemon/2`: different variants, independent
  cache slots, React keeps each fiber alive in its own Activity
  sibling.
- `/cache-demo?flavor=A` ↔ `?flavor=B`: same variant (parent
  `match: "/cache-demo"` has no named params, descendants inherit
  the constant root key), content updates in place via tracked
  reads/fp.
- Same-URL refresh (a read's value changed): same variant, content
  updates, fiber preserved.

CMS data changes flow through `fp`, not `matchKey`.

The active emission and the parked emission produce a structurally
identical fiber tree (Activity > Suspense > PEB > body), so React's
reconciler treats a cross-route transition as a `mode` prop update
on the Activity fiber rather than an unmount/remount. The cached
element ref is the same across renders (until the next fresh
render overwrites it), so the inner fiber chain stays alive.

When `keepalive: false`, the spec falls back to the classic two-case
behavior: case 1 returns `null`, case 4 emits the wrappers without
the Activity layer. The fp-skip path (case 3) still emits a
placeholder for the same-route refetch optimization, just unwrapped.

### Transitive fingerprint propagation

A spec's fingerprint folds every previously-registered descendant
spec's contribution — the descendant's stored dep keys re-read
against the *current* request (store-and-reread), plus its match
params and invalidation state. A wrapper that reads nothing from the
request itself still produces a different fingerprint when any of
its descendants would render differently. So an ancestor fp-skip can
never serve a stale subtree, and ancestors need no declaration for
their descendants' sake: same-bucket changes ride this fold; first
visits to a new route bucket ride the
[cold-record gate](#cold-record-gate) (render once, then warm). A
wrapper that genuinely consumes the URL reads `pathname()` /
`match()` like any other dependency.

Wrappers called with `outerChildren` (transparent passthrough)
skip fp-skip entirely — their output IS their children, which the
JSX parent renders directly.

## Error containment

A parton resolves its `schema` / props cells and runs its `Render`
*above* the per-partial `PartialErrorBoundary` (which wraps only the
already-resolved body). So a throw during resolution — a cell loader
that rejects, a failed GraphQL read — or a synchronous throw in
`Render` escapes that boundary. The spec wrapper catches those throws
and renders the parton's own error card in place, so one failing
parton degrades to a contained card while its siblings and the
surrounding chrome keep rendering. A cold SSR load of a route whose
parton throws still returns its page (carrying the card), not a 500.

Framework controls are exempt: `notFound()`, `redirect()`, and a
client-refetch `NavigationError` carry the `__framework` brand and
keep bubbling — to the RSC entry (404 / `Location`) or the host's
enclosing error boundary — rather than being swallowed into a card.

A throw raised *later*, while a child of the resolved body streams,
is caught by the `PartialErrorBoundary` itself, as before.

## Page-level routing — wrapper specs

Page routing is just specs with `match`. There's no separate router
primitive — an outer wrapper spec gates the URL once, its children
are nested specs that take their data via JSX props or tracked
reads.

```tsx
const PokemonDetailPage = parton(
  function PokemonDetailRender({ id }: { id: string } & RenderArgs) {
    return (
      <>
        <Hero id={id} />
        <Stats id={id} />
        <Species id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)

// Place every page wrapper as a sibling at the root; only the
// matching one renders.
<PokemonOverviewPage />
<PokemonDetailPage />
<CmsDemoPage />
…
```

Each wrapper self-gates: on a `match` miss it emits nothing. Inner
specs don't need their own `match` — the wrapper already filtered.

### 404 fallback

`getRegisteredMatchPatterns()` returns every `match` pattern any
spec was constructed with. A `NotFoundFallback` spec checks the URL
against that set; if no pattern matches, it calls `notFound()`,
which `Root` catches and turns into HTTP 404 + `<NotFoundPage>`.

```tsx
import { parton, getRegisteredMatchPatterns, getCurrentParton, notFound } from "@parton/framework"

export const NotFoundFallback = parton(function NotFoundFallbackRender() {
  // Non-addressable gate: it declares no selector/schema/match, so it
  // never fp-skips — the check re-evaluates on every render pass, no
  // dep to record.
  const url = getCurrentParton()?.request.url
  if (url) {
    for (const pattern of getRegisteredMatchPatterns()) {
      if (pattern.test(url)) return null
    }
  }
  notFound()
  return null
})

// Place once alongside the other page wrappers.
<NotFoundFallback />
```

The set is populated as a side-effect of every `parton(…,
{ match: … })` call; no explicit registration needed.

## Actions

Server-side handlers declared on a parton. Each action becomes a
`ResolvedAction` in Render's prop bag — a Flight-portable server
reference paired with a `writes` map for client-side optimistic
tracking.

```tsx
const CheckoutForm = parton(
  function Render({ cardName, cardCvc, saves, save }) {
    return <CheckoutClient cardName={cardName} cardCvc={cardCvc} saves={saves} onSave={save} />
  },
  {
    match: "/checkout",
    schema: ({ localCell }) => ({
      cardName: localCell({ shape: "string", initial: "" }),
      cardCvc:  localCell({ shape: "string", initial: "" }),
      saves:    localCell({ shape: "number", initial: 0 }),
    }),
    actions: {
      // Handler receives `(scope, args)` — scope is the same prop bag
      // Render gets (match params + resolved schema); args is
      // caller-supplied.
      save: async ({ saves }, args: { cardName?: string; cardCvc?: string }) => {
        await saves.set(saves.value + 1)
        // No need to write cardName/cardCvc — args matching schema
        // cell keys auto-write at commit time.
      },
    },
  },
)
```

### Auto-write semantic

When the action commits successfully, the framework iterates `args`.
For each key matching a schema cell, the framework writes `args[K]`
to that cell — same name = same cell, no drift. Keys that don't
match a cell are passed to the handler as opaque data.

The handler's `scope` view is overlay-aware: `scope.cardName.value`
reflects `args.cardName` if provided, otherwise the stored value.
Subsequent `cell.set(v)` calls inside the handler further overlay the
view — `set` then `value` reads back the new value.

### Transactional commit / rollback

The whole action body — auto-writes AND handler-explicit `cell.set`
calls — is staged in a pending-writes map. The framework commits the
map to storage AFTER the handler returns successfully. A throw
discards the pending map; no storage write lands, no `cell:<id>`
selector fires.

Client-side, `usePartonAction` tracks the args in the optimistic-
value map; on settle (success or failure), it clears the optimistic
view. Success → server refetch carries the new value (committed)
through Render's prop bag. Failure → server unchanged, the cell view
falls back to the prior server value → optimistic UI rewinds.

```tsx
"use client"
import { useCell, usePartonAction } from "@parton/framework/lib/cell-client.tsx"

function CheckoutClient({ cardName, cardCvc, saves, onSave }) {
  const save = usePartonAction(onSave)
  const name = useCell(cardName)
  const [draftName, setDraftName] = useState(name.serverValue)

  return (
    <form action={() => save({ cardName: draftName })}>
      <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
      <div>optimistic: {name.value}</div>
      <div>server: {name.serverValue}</div>
      <div>saves: {useCell(saves).value}</div>
      <button>Save</button>
    </form>
  )
}
```

### Action handler scope

| Key | Source |
|---|---|
| `<named match params>` | baked into the action ref at render time |
| `<every key from schema's return>` | re-resolved at dispatch: scoped descriptors → `ResolvedCell`; module cells → `ResolvedCell`; plain values pass through |
| `args` | second parameter, caller-supplied |

An action ref bakes `(actionId, matchParams)` when it crosses Flight;
dispatch runs under a stamped current-parton identity (the parton's
id, the action's OWN request, the baked params), so tracked hooks
inside the schema callback or the handler read the caller's *current*
cookies and session — not a replay of render-time values.

Cells in the handler scope have deferred-write `set`: the call
pushes into the pending map instead of hitting storage directly.
This is what makes the body transactional — the framework can
discard the map on throw without partial commits leaking through.

## Sharp edges

- **Slot-placeable units use `block`.** `parton`
  produces non-slot-placeable specs — they're placed by JSX, addressed
  by selector. Slots look up their entries through the type catalog,
  which only `block`-constructed specs register in. See
  [`block.md`](./block.md).
- **CMS reads live on blocks, not partials.** The tracked hooks are
  strictly request-dimensions (URL / cookies / headers / session). To
  bind a partial's content to the CMS, use `block` with its
  `{ cms }` schema — that's where `cms.text(...)`, `cms.blocks(slot)`,
  etc. live.
- **Presentational URL-derived state is client, not a server read.**
  An active nav highlight, a "you are here" marker — anything derived
  purely from the current URL with no server data — reads the URL on
  the client via `useNavigation().currentEntry.url`, rather than gating
  a `match` (which would mint a parked variant per route) or tracking a
  server-side `pathname()` (which would re-render the spec on every
  navigation instead of letting it fp-skip). `useNavigation()` is
  isomorphic, so the value is correct on the first server paint too —
  see [`frames-navigation.md`](./frames-navigation.md#navigation).
- **`closest` / ancestor `provides`.** Punted. Specs that need
  ancestor data should accept it as a render prop (manual threading
  from a parent spec).
- **Spec metadata doesn't cross the RSC boundary.** Spec components
  are server-only — don't import a spec into a client component to
  reach for its `id`. Reload calls stay stringly-typed
  (`reload({ selector: "hero" })`).
