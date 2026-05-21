# `parton(Render, …)`

The framework's base addressable-render-unit constructor. A spec is
constructed once at module scope from a `Render` function and an
options object; the call returns a placeable React component. Every
request dependency the spec has — URL, search, cookies, headers,
session — lives in a single sync `vary` function whose result is the
cache-key surface.

> **Three constructors, one engine.** `partial` is the base case.
> Slot-placeable CMS-driven units use [`block`](./block.md);
> frame-scope openers use the `<Frame>` component
> ([frames-navigation.md](./frames-navigation.md)). All three produce
> partials at runtime — same registry, same fingerprint pipeline,
> same refetch path.

```tsx
import { parton, ROOT, type RenderArgs } from "./lib"

const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id, parent }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

// Anywhere in JSX:
<PokemonPage parent={ROOT} />
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
inside `vary` (or `Render`) when you need a non-string shape:

```tsx
vary: ({ params }) => ({ id: Number(params.id) })
```

## Tier 2 — options object

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60 },
  vary: ({ params, search: { variant = "default" } }) => ({
    slug: params.slug,
    variant,
  }),
})

async function ProductHeroRender({
  slug, variant, parent,
}: { slug: string; variant: string } & RenderArgs) {
  const product = await getProduct(slug)
  return <Hero parent={parent} product={product} variant={variant} />
}
```

For CMS-driven content (text, images, references), use
[`block`](./block.md) with a `schema` callback.

`match` runs first; on miss, `vary` doesn't run. On match, the
pattern's params land in `vary`'s `params` arg. When `vary` returns
`null`, the spec also doesn't render.

## Options

```ts
interface PartialOptions<V> {
  match?: MatchPattern                             // URLPattern gate
  vary?: (scope: VaryScope) => V | null            // null = skip render
  selector?: SelectorTokens                        // auto-derived from Render.name
  cache?: CacheOptions
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  keepalive?: boolean                              // default true
}
```

| Option | Notes |
|---|---|
| `match` | URLPattern pathname (or full `URLPatternInit`). `/p/:slug`, `/p/:slug/reviews/:page`, `/inspect/*` (descendants only), `/inspect{/*}?` (bare + descendants). Pattern miss → spec emits nothing. Anonymous `*` captures don't flow into the default fingerprint — only named groups (`:foo`) do. |
| `vary` | Sync function. Receives `{ url, pathname, search, cookies, headers, params, session }`. Returns the request-dimensions dependency surface or `null`. **No `cms` here** — CMS reads live on `block`'s `schema` callback. |
| `selector` | One or more refetch labels. Plain strings; leading `#` / `.` are cosmetic and stripped on parse (`"#hero"` and `"hero"` are equivalent). Defaults to `<kebab-cased Render.name minus Page/Block/Render/Partial suffix>`. The first label is the spec's catalog id; additional labels are extra fan-out targets. Multiple placements of the same spec share their labels; `nav.reload({selector: "label"})` hits every carrier. |
| `cache` | See [`cache.md`](./cache.md). |
| `defer` | `true` for app-driven, an activator element to wire automatically. |
| `fallback` | React node rendered while the partial's body is suspended. |
| `keepalive` | When `true` (default), the rendered body is wrapped in a `<Activity mode="visible" key={matchKey}>` while active and the spec emits `<Activity mode="hidden">` + placeholder for each cached variant on cross-route nav (instead of returning nothing on `match`/`vary` miss). The client substitutes its cached subtree at each placeholder, so the React fiber tree stays shape-stable across active ↔ parked transitions — `useState`, `useRef`, and DOM state survive a navigate-away-and-back round-trip. Multiple variants of the same spec (e.g. `/pokemon/1` ↔ `/pokemon/2`) coexist as hidden Activity siblings keyed by `matchKey` so each variant's fiber stays alive across cross-variant navigation. Set to `false` for partials whose state should reset on cross-route nav (heavy video/iframe DOM, debug-only specs, anything where stale state is worse than re-mount cost). |

## `VaryScope`

```ts
interface VaryScope {
  url: URL                                  // frame-resolved if framed
  pathname: string                          // shortcut for url.pathname
  search: Partial<Record<string, string>>   // destructurable
  cookies: Partial<Record<string, string>>  // destructurable
  headers: Partial<Record<string, string>>  // lowercase keys
  params: Record<string, string>            // from `match`
  session: SessionReadSurface               // per-key session reads
}
```

`vary` is strictly request-dimensions: URL fields, cookies, headers,
match params, session values. CMS content reads happen on
[`block`](./block.md)'s `schema` callback (which receives a
`{ cms }` scope) — the framework folds the resolved CMS shape into
the block's fingerprint via `cmsFingerprintContribution` independently
of whether the block's render touched specific fields.

`cookies` overlays any in-request `setCookie()` writes on top of the
request header — so a partial re-rendered immediately after an action
calls `setCookie("cart_id", X) + return {invalidate: {selector:
".cart"}}` sees the new value in its vary scope (consistent with
`readCookie`). `Max-Age=0` follows browser deletion semantics and
removes the cookie from the overlay; a non-zero `Max-Age` with an
empty value sets the cookie to the empty string.

## `Render` props

`Render` receives, in order: any extra props passed at the JSX call
site, the `vary` result spread, the framework-injected
`parent`/`children`. Vary keys win on collision.

| Key | Source |
|---|---|
| `<JSX call-site props>` | parent spec, e.g. `<Hero parent={p} pokemonId={id} />` |
| `<every key from vary's return>` | author |
| `parent` | framework — fresh `PartialCtx` for descendants |
| `children` | framework — passes outer JSX children through |

`parent` is what nested specs and slot hosts use. There is no
`id` prop on the Render surface — CMS-bound blocks
([`block.md`](./block.md)) get their content via `schema` reads,
and the framework binds the read surface to the right row internally.

### `typeof Spec.props` — derive the prop bag from the spec

The returned spec carries a phantom `.props` type that resolves to the
prop bag the framework supplies to `Render` (`vary` result + match
params + `RenderArgs`). Use it to skip retyping the same shape across
sibling factories or hooks:

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
the keys `vary` already provides minus the framework-injected keys.
TypeScript subtracts both, so the call site is exactly the props the
parent has to supply.

```tsx
// vary fills `pokemonId` → call site only takes `parent`
const Hero = parton(HeroRender, {
  match: "/pokemon/:id",
  vary: ({ params }) => ({ pokemonId: Number(params.id) }),
})
function HeroRender({ pokemonId }: { pokemonId: number } & RenderArgs) { … }
<Hero parent={ROOT} />
```

```tsx
// no vary → `pokemonId` is required at the call site
const Hero = parton(function HeroRender({
  pokemonId,
}: { pokemonId: number } & RenderArgs) { … })
<Hero parent={parent} pokemonId={9} />
```

This is what makes nested wrappers work: an outer wrapper matches
the URL once, then threads typed props down to its children without
forcing each child to re-parse the URL.

```tsx
const PokemonDetailPage = parton(
  function PokemonDetailRender({ id, parent }: { id: string } & RenderArgs) {
    return (
      <>
        <Hero parent={parent} id={id} />
        <Stats parent={parent} id={id} />
        <Species parent={parent} id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)

// Inner specs have no `match`, no `vary` — the wrapper gates the
// route once and passes `id` as a prop.
const Hero = parton(async function HeroRender({
  id,
}: { id: string } & RenderArgs) {
  const data = await client.request(PokemonHeroQuery, { id: Number(id) })
  …
})
```

`{ match: "/pokemon/:id" }` alone is enough — `ParseRoute<P>` extracts
`:id` from the pattern at the type level and auto-flows it as a typed
`{ id: string }` into Render. Add a `vary` only when you need to
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

Slot composition is a block-spec concern. Partials don't have a
`schema` callback and can't read CMS slot entries — if you need a unit
that hosts CMS-managed children, use [`block`](./block.md)
and declare the slot via `cms.blocks(slot, selector?)` /
`cms.block(slot, selector?)` inside `schema`. A partial that happens
to render a singleton block can still place it directly via JSX
(`<SomeBlock parent={parent} />`); the block's CMS row falls out of
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

1. **`match` miss or `vary` returned `null`, no cached entry on the
   client.** Spec emits nothing — the JSX position is empty.
2. **`match` miss or `vary` returned `null`, AND the client has one
   or more variants cached (declared via `?cached=id:matchKey:fp`),
   AND `keepalive` is on (default).** Spec emits one
   `<Activity mode="hidden" key={matchKey}>{placeholder}</Activity>`
   per cached variant. The client substitutes each placeholder with
   its cached subtree, so every cached variant stays parked under
   its own hidden Activity. React reconciles each Activity by its
   `matchKey` against the prior render, preserving inner fibers
   across the cross-route transition.
3. **`match` succeeded, `vary` returned non-null, fingerprint matches
   the client's cached one.** Spec emits
   `<Activity mode="visible" key={matchKey}>{placeholder}</Activity>`
   plus a hidden Activity sibling for each other cached matchKey.
   Client substitutes from cache — same bytes as last render, no
   body re-execution.
4. **`match` succeeded, `vary` returned non-null, fingerprint differs
   (fresh render).** Spec executes its `Render`, wraps the result in
   `<Activity mode="visible" key={matchKey}>
   <Suspense …><PartialErrorBoundary …>{body}</PartialErrorBoundary>
   </Suspense></Activity>`, plus a hidden Activity sibling for each
   other cached matchKey, and streams it.

`matchKey` is the variant identity. A spec with its OWN `match`
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
  the constant root key), content updates in place via vary/fp.
- Same-URL vary refresh: same variant, content updates, fiber
  preserved.

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
spec's contribution, resolved against the *current* request via the
spec catalog's `match` + `vary`. A wrapper that doesn't itself
declare a URL dependency still produces a different fingerprint when
any of its descendants would render differently. So an ancestor
fp-skip can never serve a stale subtree, and authors don't need to
hand-fold descendant deps (`__href: url.href`) into a wrapper's
vary just to keep the children fresh.

Wrappers called with `outerChildren` (transparent passthrough)
skip fp-skip entirely — their output IS their children, which the
JSX parent renders directly.

## Page-level routing — wrapper specs

Page routing is just specs with `match`. There's no separate router
primitive — an outer wrapper spec gates the URL once, its children
are nested specs that take their data via JSX props or `vary`.

```tsx
const PokemonDetailPage = parton(
  function PokemonDetailRender({ id, parent }: { id: string } & RenderArgs) {
    return (
      <>
        <Hero parent={parent} id={id} />
        <Stats parent={parent} id={id} />
        <Species parent={parent} id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)

// Place every page wrapper as a sibling at the root; only the
// matching one renders.
<PokemonOverviewPage parent={ROOT} />
<PokemonDetailPage parent={ROOT} />
<CmsDemoPage parent={ROOT} />
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
import { parton, getRegisteredMatchPatterns } from "./lib"
import { matchRoutePattern } from "./framework/context"
import { notFound } from "./framework/errors"

export const NotFoundFallback = parton(
  function NotFoundFallbackRender() {
    notFound()
    return null
  },
  {
    vary: ({ request }) => {
      const p = new URL(request.url).pathname
      for (const pattern of getRegisteredMatchPatterns()) {
        if (matchRoutePattern(p, pattern) !== null) return null
      }
      return {}
    },
  },
)

// Place once alongside the other page wrappers.
<NotFoundFallback parent={ROOT} />
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
  function Render({ cardName, cardCvc, saves, save, parent }) {
    return <CheckoutClient cardName={cardName} cardCvc={cardCvc} saves={saves} onSave={save} />
  },
  {
    match: "/checkout",
    schema: ({ cell }) => ({
      cardName: cell.string({ initial: "" }),
      cardCvc:  cell.string({ initial: "" }),
      saves:    cell.number({ initial: 0 }),
    }),
    actions: {
      // Handler receives `(scope, args)` — scope is the same prop bag
      // Render gets (resolved cells + vary output + parent); args is
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
| `<every key from vary's return>` | author's `vary` callback |
| `<every key from schema's return>` | scoped descriptors → `ResolvedCell`; module cells → `ResolvedCell`; plain values pass through |
| `parent` | framework — `ROOT` for actions (no descendant render context) |
| `args` | second parameter, caller-supplied |

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
- **CMS reads live on blocks, not partials.** `vary` is strictly
  request-dimensions (URL / cookies / headers / session). To bind a
  partial's content to the CMS, use `block` with `schema`
  — that's where `cms.text(...)`, `cms.blocks(slot)`, etc. live.
- **`closest` / ancestor `provides`.** Punted. Specs that need
  ancestor data should accept it as a render prop (manual threading
  from a parent spec's `vary`).
- **Spec metadata doesn't cross the RSC boundary.** Spec components
  are server-only — don't import a spec into a client component to
  reach for its `id`. Reload calls stay stringly-typed
  (`reload({ selector: "hero" })`).
