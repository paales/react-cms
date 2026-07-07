# `parton(Render, …)`

The framework's base addressable-render-unit constructor. A spec is
constructed once at module scope from a `Render` function and an
options object; the call returns a placeable React component. The
constructor declares placement and replay — which instance exists
(`match`), how it's addressed (`selector`), how it's served (`cache`,
`defer`, `fallback`, `keepalive`, `fpSkip`). Everything else happens
in the body: every request dependency the spec has — search params,
cookies, headers, session — is whatever its `Render` actually reads
through the tracked server-hooks (`searchParam()`, `cookie()`, …),
and its data is whatever cells it resolves there: the read IS the
dependency, recorded per render and folded into the fingerprint.

> **Three constructors, one engine.** `parton` is the base case.
> Slot-placeable CMS-driven units use [`block`](./block.md);
> frame-scope openers use the `<Frame>` component
> ([frames-navigation.md](./frames-navigation.md)). All three produce
> partials at runtime — same registry, same fingerprint pipeline,
> same refetch path.

```tsx
import { parton, type RenderArgs } from "@parton/framework"

const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

// Anywhere in JSX:
<PokemonPage />
```

## Tier 1 — pattern-match shorthand

When a string is passed as the second argument, it's treated as the
`match` pattern (a pathname gate). On miss, the spec doesn't render.
Pattern params flow into `Render`'s props directly.

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
unparseable corners fall through and the prop is just absent. Params
are always strings — coerce inside `Render` where you use them
(`Number(id)`); `param()` is a pure read of an already-folded match
param when a nested component needs one without threading props.

## Tier 2 — options object

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60 },
})

async function ProductHeroRender({
  slug,
}: { slug: string } & RenderArgs) {
  const variant = searchParam("variant", "default")   // tracked read
  const product = await getProduct(slug)
  return <Hero product={product} variant={variant} />
}
```

For CMS-driven content (text, images, references), use
[`block`](./block.md) — its `schema({cms})` callback is the CMS
resolution surface.

## Options

```ts
interface PartialOptions {
  match?: MatchPattern                             // request gate (string or MatchInit)
  selector?: SelectorTokens                        // auto-derived from Render.name
  cache?: CacheOptions
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  keepalive?: boolean                              // default true
  fpSkip?: boolean                                 // default true
  capabilityType?: string                          // remote-manifest typing
}
```

| Option | Notes |
|---|---|
| `match` | The request gate. A URLPattern pathname string (`/p/:slug`, `/inspect/*` — descendants only, `/inspect{/*}?` — bare + descendants), or a `MatchInit` object gating any request dimension — URL components, search params, cookies, headers — with per-value predicates. Gate miss → the spec parks (or emits nothing when the client has no cached variant). See [The match gate](#the-match-gate--gating-the-request). Anonymous `*` captures don't fold into the fingerprint — only named groups (`:foo`) do; a spec that genuinely depends on the wildcard tail reads `pathname()` explicitly. |
| `selector` | One or more refetch labels. Plain strings; leading `#` / `.` are cosmetic and stripped on parse (`"#hero"` and `"hero"` are equivalent). Defaults to `<kebab-cased Render.name minus Page/Block/Render/Partial suffix>`. The first label is the spec's catalog id; additional labels are extra fan-out targets. Multiple placements of the same spec share their labels; `nav.reload({selector: "label"})` hits every carrier. |
| `cache` | See [`cache.md`](./cache.md). |
| `defer` | `true` for app-driven, an activator element to wire automatically. |
| `fallback` | React node rendered while the partial's body is suspended. |
| `keepalive` | When `true` (default), the rendered body is wrapped in a `<Activity mode="visible" key={matchKey}>` while active and the spec emits `<Activity mode="hidden">` + placeholder for each cached variant on a `match` miss (instead of returning nothing). The client substitutes its cached subtree at each placeholder, so the React fiber tree stays shape-stable across active ↔ parked transitions — `useState`, `useRef`, and DOM state survive a navigate-away-and-back round-trip. Multiple variants of the same spec (e.g. `/pokemon/1` ↔ `/pokemon/2`) coexist as hidden Activity siblings keyed by `matchKey` so each variant's fiber stays alive across cross-variant navigation. Set to `false` for partials whose state should reset on cross-route nav (heavy video/iframe DOM, debug-only specs, anything where stale state is worse than re-mount cost). |
| `fpSkip` | When `false`, this spec is never served from the client's fingerprint cache — every request renders it fresh. The spec still fingerprints normally (folds, trailer, addressability all unchanged); only the serve-from-cache decision is disabled. For always-authoritative surfaces whose output must track the request exactly: the CMS editor chrome opts out because its links embed the full request URL, which no individually-tracked dimension covers. Default `true`. |
| `capabilityType` | Capability schema name referenced by the `/__remote/manifest.json` endpoint so `parton add` can generate typed bindings. Omit if the spec doesn't read capability values. See [`remote-frame.md`](./remote-frame.md). |

## The match gate — gating the request

`match` decides **which instance exists**: variant identity (named
params → `matchKey`), route buckets (the URL-pattern half feeds route
keying), and existence (a miss parks the client's cached variants).
The gate surface is the whole request, not just the URL:

```ts
type FieldTest = string | ((value: string) => boolean)
type ValueTest = string | ((value: string | null) => boolean)

interface MatchInit {
  protocol?, hostname?, port?, pathname?, hash?: FieldTest
  username?, password?, baseURL?: string
  search?: string                            // raw URLPattern search string
  searchParams?: Record<string, ValueTest>   // per-param gates
  cookies?: Record<string, ValueTest>        // per-cookie gates
  headers?: Record<string, ValueTest>        // per-header gates
}
```

- **URL components** (`pathname`, `hostname`, …) take URLPattern
  strings or per-value predicates `(value: string) => boolean`. String
  semantics are strict URLPattern — no auto-suffixing: `match:
  "/inspect/*"` matches `/inspect/…` and NOT bare `/inspect`; write
  `"/inspect{/*}?"` for both.
- **`searchParams` / `cookies` / `headers`** gate on individual
  values, order-independent (unlike a raw URLPattern `search` string).
  A string value tests equality; a predicate receives the value or
  `null` when absent — absence is a value (`?q=` is `""`, no `?q` at
  all is `null`).
- **`search`** stays as the raw, order-sensitive URLPattern
  search-string pattern — it exists for full-string patterns with
  capture groups (`"*q=:query"`) where the named capture matters;
  prefer `searchParams` for gating individual params.

Rules that make the gate sound:

- **Predicates are the gate itself — pure and sync.** The framework
  re-runs them outside any render (the descendant fold, route keying,
  isolated snapshot reconstruction). Each predicate sees one value; a
  gate that needs two request dimensions is two fields (fields AND
  together). Gates sign by their source text, so HMR dedups an
  unchanged gate and an edited predicate body correctly counts as a
  new one.
- **Gates read the request as sent.** The `cookies` fields parse the
  raw `Cookie` header, deliberately bypassing the same-request
  `setCookie` overlay that body reads (`cookie()`) see. A gate verdict
  is therefore a pure function of the incoming request — every
  re-evaluation during the request's lifetime agrees by construction.
  A mid-request cookie write re-gates on the NEXT request, while the
  body's reads see it immediately: the gate is who you were when you
  asked; the content is who you are now.
- **Header names are lowercased** per HTTP semantics;
  framework-internal `x-parton-*` headers are invisible (they test as
  `null`).
- **Named params come only from URLPattern string components.** A
  predicate can gate but not name (there's no capture group to
  extract), so `ParseRoute` typing and matchKey identity flow from the
  string half untouched. Predicates and the `searchParams` / `cookies`
  / `headers` records gate specs but never split route buckets —
  route keys come from the URL-pattern half alone.
- **Transport params are invisible.** The framework mints search
  params for its own transport — the client cache manifest (`cached`,
  the capped URL form an action POST carries) and document-level
  frame routing (`__frame`, `__frameUrl` — a degraded page's frame
  navigation, the CMS preview iframe) — so the SAME page arrives with
  and without them. Everything else rides the channel (the attach
  statement's body and `url` frames on envelopes), never a page URL.
  Match evaluation and param extraction strip them first; a wildcard
  search capture like `"*q=:query"` never swallows them into the
  named param, so transport noise can't split variant identity. The
  list is exported as `TRANSPORT_PARAMS` — the single source of truth
  for code that needs to strip them too (the CMS editor's href
  builder does).

### Match miss = park

A gate miss doesn't just skip rendering — when the client has one or
more variants of the spec cached (and `keepalive` is on), the spec
emits a hidden-`<Activity>` placeholder per cached variant, so the
client's fibers and state stay alive, parked. Parking is automatic;
the gate IS the park trigger. Because the gate covers values, not
just URL shape, value-conditional existence is a match gate too:

```tsx
// Page N of a load-more list exists iff the URL admits it — a miss
// parks the cached page (back/forward across a load-more boundary
// restores it).
match: { searchParams: { pages: (v) => Math.max(1, Number(v) || 1) >= page } }
```

Contrast `return null` from Render: that's render-emptiness — the
spec registers (deps recorded, fp emitted) and REPLACES the client's
cached variant with an empty body. A gate miss preserves the parked
client state. Two distinct semantics: "this instance doesn't exist
here" is a gate; "this instance exists and is empty" is a body
decision.

## Tracked reads — the server hooks

Free functions imported from the framework, callable anywhere inside
a parton's `Render` body. Each returns the request value AND records
a dependency key on the parton's live dep set, so the read folds into
the fingerprint — a changed cookie / search param / header moves the
fp and the parton re-renders on the next navigation. The read IS the
dependency, exactly like a cell.

| Hook | Reads | Records |
|---|---|---|
| `cookie(name)` | Request cookie. | `cookie:<name>` |
| `searchParam(name, fallback?)` | URL search param. The two-argument form defaults an ABSENT param only — a present-but-empty `?q=` still returns `""`. Absence is a value; the fp folds the two distinctly. | `search:<name>` |
| `header(name)` | Request header, name lowercased per HTTP semantics. Framework-internal `x-parton-*` headers are invisible — the read returns `undefined` and records nothing. | `header:<name>` |
| `pathname()` | The (frame-resolved) request pathname. The whole-pathname axis — it moves the fp on EVERY path change, so prefer `match()` / `param()` when a named segment is enough. | `pathname:` |
| `match(pattern)` | Runs `pattern` — a pathname string (typed via `ParseRoute`) or a `URLPatternInit` — against the request URL; returns the named captures or `null`. URL-pattern matching only, no predicate gates (those live on the `match` option). Folds only the MATCHED PARAMS — the spec varies when its captured segment changes, never on every navigation. | `match:<pattern>` |
| `param(name)` | A resolved match param (`/pokemon/:id` → `param("id")`). Pure read, records NOTHING — match params already fold into the fp via `matchKey`. | — |
| `session()` | `{ id }` — the session identity; `""` for an anon request with no session yet. | `session:` |
| `tag(name)` | Registers an invalidation tag computed per render (`` tag(`product:${id}`) ``), so a matching `refreshSelector(name)` shifts the fp and the name becomes a refetch target. Records a `tag:<name>` dep riding store-and-reread — the natural slot for tags a loader's response yields. | `tag:<name>` |

(Viewport visibility is not a body read — it gates existence via the
spec-level `cull` option, which records `visible:<id>?seed=<0|1>`
itself. See [View culling](#view-culling--the-cull-gate).)

All hooks read from the parton's frame-resolved request, so a framed
spec tracks its frame's URL and cookies. Outside a parton body
they're no-ops returning the empty value.

`cookie()` overlays any in-request `setCookie()` writes on top of the
request header — so a partial re-rendered immediately after a server
function calls `setCookie("cart_id", X) + getServerNavigation().reload({
selector: "cart" })` reads the new value (consistent with
`readCookie`). `Max-Age=0` follows browser deletion semantics and
removes the cookie from the overlay; a non-zero `Max-Age` with an
empty value reads as the empty string. (Match `cookies` gates
deliberately bypass this overlay — see
[The match gate](#the-match-gate--gating-the-request).)

### View culling — the `cull` gate

Culling gates EXISTENCE, like `match`: the `cull` spec option makes
the parton **cullable**, and a culled instance's body never runs.

```tsx
export const BrowsePage = parton(
  ({ page }) => <PageProducts page={page} products={productsCell.with({ page })} />,
  {
    cull: {
      rootMargin: "900px 0px",                                 // observer runway
      seed: ({ page }) => Math.abs(page - (Number(searchParam("page")) || 1)) <= 2,
      skeleton: GridSkeleton,                                  // "use client"
    },
  },
)
```

- **`skeleton`** (required) — the culled body: a CLIENT component
  rendered from the placement's serializable props (match params +
  call-site props, cell props excluded). On the wire a culled
  instance costs one module reference + props — a couple hundred
  bytes instead of a rendered body — and needs no cache variant, no
  fingerprint, no cached-manifest slot. It must render real DOM:
  it reserves the parton's space (a culled parton that collapses
  shifts the document) and hosts its viewport observer.
- **`seed`** (optional, default "in view") — the cold-state
  resolution: is this placement in view BEFORE any client
  measurement (SSR, first paint, no-JS)? Runs in the parton's
  tracking context, so an anchor-driven seed's `searchParam()` read
  records as a dep and the gate re-resolves when the anchor moves.
- **`rootMargin`** (optional) — how far beyond the viewport still
  counts as in view. Default `"600px 0px"`. For NESTED culling — a
  cullable parton whose flip-in is what mounts other cullable
  partons (the website world's quadtree) — STAGGER the margins: the
  parent's runway must exceed its children's by at least a lane
  round trip of scroll distance, so a crossing flips observers that
  are already mounted and the IntersectionObserver batches the whole
  crossing into one visibility statement. Equal margins serialize
  instead — mount → measure → flip → lane → mount, one single-id
  statement per frame (`website/src/app/world/constants.ts` has the
  worked arithmetic).

The fingerprint folds the RESOLVED state — `measurement ?? seed` —
via the dep key `visible:<id>?seed=<0|1>`. Unmeasured and measured
renders that resolve the same way fold the SAME fp: the client's
first viewport report moves only the partons it actually flips, so a
boot whose seed matched the viewport revalidates nothing.

On the client the pair's slots observe their children through a
`<Fragment ref>` + IntersectionObserver (no wrapper element); the
controller compares each measurement against the DISPLAYED state
(primed from the emission, overlaid by any live report for the id)
and coalesces a frame's worth of real flips into one `visible` frame
on the channel — a fire-and-forget envelope POST (`204`, no body),
addressed to the held connection by its explicit id. The server
stores the set as connection-session state and renders the
flipped-IN partons as lane segments on the EXISTING stream — the
gate reads the connection's current set, so flips never race the
live connection with a second render channel. A cull-OUT lanes
nothing: the pair swaps to its inline skeleton locally, and the
report's only server effect is the session-set update that keeps
lane parking honest.

With no connection open (pre-establishment, or between a keepalive
close and the next attach) flips PEND: the next attach's `visible`
seed states the full set, its whole-tree first segment materializes
anything in view, and the queued flips ride the fresh connection's
first flush.

The visible set is connection-session state, full stop — the attach
statement seeds it and `visible` frames move it; no URL ever carries
it. Worked demo:
`e2e-testing/src/app/pages/magento/product-browse.tsx`; design
rationale in [`../notes/view-culling.md`](../notes/view-culling.md);
wire mechanics in
[`../internals/streaming.md`](../internals/streaming.md).

**Cull-to-park.** For a keepalive spec (the default), the culled
state doesn't replace the content — it parks it. The parton renders
as one `<CullPair>` holding two `<Activity>` slots: the content slot
(this render's body, or the placeholder hole its next bytes will
substitute into) and the skeleton slot (the inline skeleton element —
always present, always renderable). A culling flip is a MODE change
on the pair: the out-of-view content PARKS (fiber alive, DOM kept,
`useState` / `useRef` / DOM state preserved, effects unmounted)
behind the skeleton, the moment the observer reports, before any
network. The content slot's observer mounts only over REAL content —
an unbacked hole is a zero-size node whose testimony would flip the
parton right back out.

A flip-IN is a REVALIDATION — the flipped-in parton comes back as a
lane on the held stream. The lane settles the restored copy: an fp
match returns the confirmation placeholder — zero content bytes, the
parked subtree is current (the marker rides any skip verdict at a
MEASURED visible set) — while a moved fp (data changed while parked)
returns fresh bytes that REPLACE the slot and drop the parked fiber
(a real remount). Repeat flips whose content is unchanged are
near-zero-byte round trips.

Parked-by-culling subtrees are budgeted: an LRU of the 64
most-recently-culled ids keeps its content alive; past the budget the
oldest parked content is destroyed (the inline skeleton keeps holding
the space) and a return visit renders cold — the behavior a
non-keepalive cullable spec (`keepalive: false`) has on every flip.

### Timing — store-and-reread

Body reads are recorded during the render, but the fp was computed
before the body ran — so the fold uses the PRIOR render's recorded
keys, re-read at the current request (store-and-reread). The first
render of a variant folds nothing and emits a cold fp; the fp-trailer
ships the cold→warm drift in the same response, so the very next
navigation is fp-accurate.

Declared `match` gates have no such lag: they're request-reproducible
(pure functions of the request, re-runnable outside any render), so
they gate and key correctly from render 1 with nothing to record.

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

## Cells — resolved in the body

A parton's data comes from [cells](./cells.md), resolved where it's
used:

```tsx
const FormsDemoPage = parton(
  async function FormsDemoRender(_: RenderArgs) {
    const notes = await notesCell.resolve()          // module cell
    const draft = await localCell("draft", {          // parton-scoped cell
      shape: "string", initial: "",
    })
    return <Editor notes={notes} draft={draft} />
  },
  { match: "/forms-demo" },
)
```

`await handle.resolve(args?)` reads the value (running the loader on
a storage miss), records the partition-scoped `cell:` dependency on
the rendering parton — a write re-renders it, and the label rides for
selector refetch — and returns a Flight-portable `ResolvedCell<T>`.
The inline `localCell("key", {…})` form declares a cell owned by the
calling parton (wire id `<partonId>/<key>`). Cells can also be bound
at a JSX call site (`<CartLine item={cartItemCell.with({uid})} />`) —
the framework resolves cell-bearing props before Render runs. Full
surface in [`cells.md`](./cells.md).

## Writes — plain server functions + `atomic()`

There is no action option on the constructor. Writes are plain
`"use server"` functions that import cells and call `.set`, wrapped
in `atomic(fn)` — the transactional boundary: every write inside `fn`
commits together (one invalidation fan-out, one live-driver wake),
reads inside the transaction see the buffered writes, and a throw
discards them all. Client-side optimism is cell-level via `useCell`.

```ts
// forms-demo-actions.ts
"use server"
import { atomic } from "@parton/framework"
import { cardName, cardCvc, saves } from "./forms-demo-state.ts"

export async function saveCard(args: { cardName?: string; cardCvc?: string }) {
  await atomic(async () => {
    if (args.cardName !== undefined) await cardName.set(args.cardName)
    if (args.cardCvc !== undefined) await cardCvc.set(args.cardCvc)
    await saves.set(JSON.stringify({ ...args, at: Date.now() }))
  })
}
```

The Render passes the function to a client component like any bound
server reference; the client calls it directly. The canonical worked
example is the forms demo
(`e2e-testing/src/app/pages/forms-demo{-state.ts,-actions.ts,.tsx}`).
See [`cells.md`](./cells.md#mutation-patterns) for the full write
surface.

## Wake hints — `expires()` / `staleUntil()` / `time()`

`expires(at)` declares a freshness boundary for this render: after
`at` (epoch ms) the output is no longer fresh. Two consumers:

- the live segment driver arms its expiry timer on the earliest
  boundary across the route's snapshots, so a held live connection
  wakes and re-renders the parton on time;
- fp-skip declines to serve a snapshot past its boundary, even on an
  fp match — the boundary IS the declaration that identical inputs
  stop being fresh at that time.

`staleUntil(at)` declares the stale-while-revalidate window beyond
`expires()`. Multiple calls keep the EARLIEST boundary. Both are
callable anywhere in Render — they write a live box on the snapshot,
so post-await calls still land before the driver consults it, and a
skip/defer pass threads the prior snapshot's box through so a wake
schedule survives a skip.

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

`Render` receives the call-site JSX props (with cell-bearing props
resolved to `ResolvedCell<T>`s), the named match params, and the
framework-injected `children`. Later rows win on collision.

| Key | Source |
|---|---|
| `<JSX call-site props>` | placing spec, e.g. `<Hero pokemonId={id} />` — `CellInterface` / `BoundCell` props arrive resolved |
| `<named match params>` | the `match` pattern's string half — `/pokemon/:id` → `{ id }` |
| `children` | framework — passes outer JSX children through |

Everything else the body reads itself: tracked hooks for request
dimensions, `cell.resolve()` / inline `localCell` for data.

A parton neither receives nor threads a `parent` — nested specs and
slot hosts read their parent (id path + frame chain) from server
context (the ambient parton; see
[`server-context.md`](../internals/server-context.md)). There is no
`id` prop on the Render surface either — CMS-bound blocks
([`block.md`](./block.md)) get their content via their `schema`
reads, and the framework binds the read surface to the right row
internally.

### `typeof Spec.props` — derive the prop bag from the spec

The returned spec carries a phantom `.props` type that resolves to the
prop bag the framework supplies to `Render` (match params +
`RenderArgs`). Use it to skip retyping the same shape across sibling
factories or hooks:

```tsx
const Hero = parton(HeroRender, { match: "/pokemon/:id" })
type HeroProps = typeof Hero.props          // { id: string } & RenderArgs
function HeroRender({ id }: HeroProps) { … }

// `.props` has no runtime value — it's a type-only phantom.
```

The forward-reference shape (`const Spec = parton(R, opts);
function R(p: typeof Spec.props)`) hits a circular initializer in TS.
Use the two-step builder below if you need the type before the Render
exists.

### Two-step builder — `parton(opts)`

When the Render is declared after the spec OR you want the prop type
to drive the function signature directly, call `parton` with just
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
the keys the framework already provides (match params) minus the
framework-injected keys. TypeScript subtracts both, so the call site
is exactly the props you still have to supply.

```tsx
// match fills `id` → call site takes nothing
const Hero = parton(HeroRender, { match: "/pokemon/:id" })
function HeroRender({ id }: { id: string } & RenderArgs) { … }
<Hero />
```

```tsx
// no match → `pokemonId` is required at the call site
const Hero = parton(function HeroRender({
  pokemonId,
}: { pokemonId: number } & RenderArgs) { … })
<Hero pokemonId={9} />
```

This is what makes nested wrappers work: an outer wrapper matches
the URL once, then threads typed props down to its children without
forcing each child to re-parse the URL — see
[Page-level routing](#page-level-routing--wrapper-specs) for the
worked example.

Call-site props are part of the fingerprint automatically — and part
of the render identity: a placement with call-site props gets a
per-instance id (`<spec-id>:<props-hash>`), so `<LivePrice sku="A" />`
and `<LivePrice sku="B" />` are distinct registry entries with
independent snapshots and cache slots, while both still carry the
spec's labels for fan-out refetch. The framework captures the
call-site props in the snapshot so an isolated re-render (a lane's
`partialFromSnapshot` reconstruction) can re-invoke the child without
going through its parent and still receive the same props.

## Slots

Slot composition is a block-spec concern. A parton has no `cms`
surface and can't read CMS slot entries — if you need a unit that
hosts CMS-managed children, use [`block`](./block.md) and declare the
slot via `cms.blocks(slot, selector?)` / `cms.block(slot, selector?)`
inside its `schema`. A partial that happens to render a singleton
block can still place it directly via JSX (`<SomeBlock />`); the
block's CMS row falls out of its spec id (a `#`-pinned selector
label, or `Render.name`-derived — see [`block.md`](./block.md)).

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

Leading `#` and `.` are stripped on parse — cosmetic on `parton`.
`"#hero"`, `".hero"`, and `"hero"` are equivalent. (On `block`, a
leading `#` pins the spec id — see [`block.md`](./block.md).)

The **first label** is also the spec's catalog id (the wire `id`,
the snapshot key, the id that `selector: "@self"` resolves to from
inside the partial).

Auto-derived from `Render.name` when omitted: `PokemonHeroRender` →
`"pokemon-hero"`.

There's no per-page uniqueness check. Multiple placements of the
same spec share their labels and fan out under refetch — for the
common LivePrice-per-product case, that's the intended model.
Placements with distinct call-site props additionally get distinct
per-instance render ids (`<spec-id>:<props-hash>`), so each is
individually addressable (`@self`, view culling) while the shared
labels keep the fan-out; zero-prop placements collapse onto the
spec id and refetch as one.

## Skip semantics

A spec emits in one of four shapes, in priority order:

1. **`match` miss, no cached entry on the client.** Spec emits
   nothing — the JSX position is empty.
2. **`match` miss, AND the client has one or more variants cached
   (declared via the cached manifest's `id:matchKey:fp` tokens), AND
   `keepalive` is on (default).** Spec emits one
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
   [cold-record gate](#cold-record-gate), the
   [wake-hint TTL](#wake-hints--expires--staleuntil--time), and the
   spec's [`fpSkip`](#options) option — a cold dep record, an expired
   snapshot, or `fpSkip: false` declines the skip and renders.)
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

A parton resolves its cell-bearing props and runs its `Render`
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

`getRegisteredMatchPatterns()` returns the URL-pattern half of every
`match` gate any spec was constructed with (predicate-only gates
carry no URL structure and are excluded). A `NotFoundFallback` spec
checks the URL against that set; if no pattern matches, it calls
`notFound()`, which `Root` catches and turns into HTTP 404 +
`<NotFoundPage>`.

```tsx
import { parton, getRegisteredMatchPatterns, getCurrentParton, notFound } from "@parton/framework"

export const NotFoundFallback = parton(function NotFoundFallbackRender() {
  // Non-addressable gate: it declares no selector/match, so it never
  // fp-skips — the check re-evaluates on every render pass, no dep
  // to record.
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
- **No ancestor data channel.** There is no `closest`/`provides`
  lookup — specs that need ancestor data accept it as a JSX prop
  (manual threading from a parent spec).
- **Spec metadata doesn't cross the RSC boundary.** Spec components
  are server-only — don't import a spec into a client component to
  reach for its `id`. Reload calls stay stringly-typed
  (`reload({ selector: "hero" })`).
