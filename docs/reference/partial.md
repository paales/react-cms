# `ReactCms.partial(Render, …)`

The framework's only public render primitive. A spec is constructed
once at module scope from a `Render` function and an options object;
the call returns a placeable React component. Every dependency the
spec has on the request, route, or CMS lives in a single sync `vary`
function whose result is also the cache-key surface.

```tsx
import { ReactCms, ROOT, type RenderArgs } from "./lib"

const PokemonPage = ReactCms.partial(PokemonRender, "/pokemon/:id")

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
const HomePage = ReactCms.partial(Home, "/")
const PokemonPage = ReactCms.partial(PokemonRender, "/pokemon/:id")
```

## Tier 2 — options object

```tsx
const ProductHero = ReactCms.partial(ProductHeroRender, {
  match: "/p/:slug",
  cmsId: "product-hero",
  cache: { maxAge: 60 },
  vary: ({ params, request, cms }) => ({
    slug: params.slug,
    variant: new URL(request.url).searchParams.get("variant") ?? "default",
    headline: cms.text("headline"),
    productRef: cms.reference("featured", "product"),
  }),
})

async function ProductHeroRender({
  slug, variant, headline, productRef, parent,
}: { slug: string; variant: string; headline: string; productRef: string | null } & RenderArgs) {
  const product = productRef ? await getProduct(productRef) : null
  return <Hero parent={parent} product={product} headline={headline} />
}
```

`match` runs first; on miss, `vary` doesn't run. On match, the
pattern's params land in `vary`'s `params` arg. When `vary` returns
`null`, the spec also doesn't render.

## Options

```ts
interface PartialOptions<V> {
  match?: string                                  // pathname pattern
  vary?: (scope: VaryScope) => V | null           // null = skip render
  selector?: SelectorTokens                       // auto-derived from Render.name
  cmsId?: string                                  // defaults to selector
  type?: string                                   // catalog tag (slot lookup)
  tags?: ReadonlyArray<`.${string}`>              // class tokens for slot blocks
  cache?: CacheOptions
  frame?: string
  frameUrl?: string
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  errorWith?: ReactNode
}
```

| Option | Notes |
|---|---|
| `match` | URLPattern pathname (or full `URLPatternInit`). `/p/:slug`, `/p/:slug/reviews/:page`, `/inspect/*` (descendants only), `/inspect{/*}?` (bare + descendants). Pattern miss → spec emits nothing. Anonymous `*` captures don't flow into the default fingerprint — only named groups (`:foo`) do. |
| `vary` | Sync function. Receives `{ request, params, cms }`. Returns the dependency surface or `null`. |
| `selector` | Defaults to `#<kebab-cased Render.name minus Page/Block/Render/Partial suffix>`. |
| `cmsId` | Defaults to the effective id (selector minus `#`). |
| `tags` | When set, the spec is a slot block — `[#<entry.id>, ...tags]` per instance. |
| `frame` | Opens a frame scope. `vary` receives the frame-resolved request. |
| `defer` | `true` for app-driven, an activator element to wire automatically. |

## `VaryScope`

```ts
interface VaryScope {
  request: Request                  // frame-resolved if framed
  params: Record<string, string>    // populated by `match`
  cms: CmsReadSurface               // sync getters bound to this spec's cmsId
}

interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
}
```

`cms.reference` returns the **id only**. Async loaders run inside
`Render`. The reference id contributes to the cache key; entity-
content invalidation is the loader's concern.

## `Render` props

`Render` receives, in order: any extra props passed at the JSX call
site, the `vary` result spread, the framework-injected
`parent`/`cmsId`/`children`. Vary keys win on collision.

| Key | Source |
|---|---|
| `<JSX call-site props>` | parent spec, e.g. `<Hero parent={p} pokemonId={id} />` |
| `<every key from vary's return>` | author |
| `parent` | framework — fresh `PartialCtx` for descendants |
| `cmsId` | framework — effective cmsId (override-aware) |
| `children` | framework — passes outer JSX children through |

`parent` is what nested specs and slot hosts use; `cmsId` is what
slot primitives pass as `hostCmsId`.

### Call-site prop pass-through

`ReactCms.partial(Render, …)` feels like `React.memo(Render)`: the
returned component's prop signature is Render's prop signature minus
the keys `vary` already provides minus the framework-injected keys.
TypeScript subtracts both, so the call site is exactly the props the
parent has to supply.

```tsx
// vary fills `pokemonId` → call site only takes `parent`
const Hero = ReactCms.partial(HeroRender, {
  match: "/pokemon/:id",
  vary: ({ params }) => ({ pokemonId: Number(params.id) }),
})
function HeroRender({ pokemonId }: { pokemonId: number } & RenderArgs) { … }
<Hero parent={ROOT} />
```

```tsx
// no vary → `pokemonId` is required at the call site
const Hero = ReactCms.partial(function HeroRender({
  pokemonId,
}: { pokemonId: number } & RenderArgs) { … })
<Hero parent={parent} pokemonId={9} />
```

This is what makes nested wrappers work: an outer wrapper matches
the URL once, then threads typed props down to its children without
forcing each child to re-parse the URL.

```tsx
const PokemonDetailPage = ReactCms.partial(
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
const Hero = ReactCms.partial(async function HeroRender({
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

```tsx
import { Children, Child } from "./lib"

function PageRootRender({ parent, cmsId }: RenderArgs) {
  return (
    <main>
      <Children name="body" allow=".page-block" host={parent} hostCmsId={cmsId} />
      <aside>
        <Child name="sidebar" allow=".widget" host={parent} hostCmsId={cmsId} />
      </aside>
    </main>
  )
}
```

| Component | Renders |
|---|---|
| `<Children name allow host hostCmsId>` | Every entry in `node.slots[name]` in stored order, each rendered through its registered spec with `cmsId={entry.id}` override. |
| `<Child name allow host hostCmsId>` | At most one entry. |

`host` becomes the slot block's `parent`. `hostCmsId` is the parent
node whose `slots[name]` array to read.

## Selector grammar

CSS-style. Tokens separated by whitespace.

- `#foo` — unique. A second spec with the same `#foo` is a render
  error. Drives `reload({ selector: "#foo" })` lookup.
- `.foo` — shared. Multiple specs may carry it. Refetches by `.foo`
  union across every carrier.

Auto-derived from `Render.name`: `PokemonHeroRender` → `#pokemon-hero`.

## Skip semantics

A spec doesn't render in three cases:

1. `match` is set and the URL didn't match.
2. `vary` returned `null`.
3. The client's cached fingerprint matches this render's fingerprint
   (the `?cached=` skip handshake).

Cases 1 and 2 emit nothing. Case 3 emits a placeholder so the client
paints from `_cache`.

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
const PokemonDetailPage = ReactCms.partial(
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
import { ReactCms, getRegisteredMatchPatterns } from "./lib"
import { matchRoutePattern } from "./framework/context"
import { notFound } from "./framework/errors"

export const NotFoundFallback = ReactCms.partial(
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

The set is populated as a side-effect of every `ReactCms.partial(…,
{ match: … })` call; no explicit registration needed.

## Sharp edges

- **Slot block specs need `tags`.** Specs without `tags` aren't
  registered as slot blocks; they always render with their fixed
  selector / cmsId. To author a reusable block, set `tags:
  [".my-block"]` and an explicit `type`.
- **`closest` / ancestor `provides`.** Punted out of this design
  pass. Specs that need ancestor data should accept it as a render
  prop (manual threading from a parent spec's `vary`).
- **Spec metadata doesn't cross the RSC boundary.** Spec components
  are server-only — don't import a spec into a client component to
  reach for its `id`. Reload calls stay stringly-typed
  (`reload({ selector: "#hero" })`).

## Migration notes (2026-04-28)

The previous `<Partial>` JSX wrapper, tracked accessors
(`getSearchParam`, `getCookie`, …), per-Partial frame/CMS/manifest
ALS cells, `HoistingViolationError`, and `registerBlock` are gone.
See `archive/VARY_RENDER_API.md` and
`notes/partial-define-step-api.md` for the design rationale.
