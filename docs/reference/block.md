# `block(Render, …)`

Slot-placeable, type-catalog-registered partial. A block is what slots
look up by `type` to render their entries; its `schema` callback
declares both CMS content reads and child slot composition. `schema`
is the CMS resolution surface — the one declared schema in the
framework, and it exists because the editor needs a declarative
manifest of a block's content fields (the catalog prerender invokes
it with a tracking surface). Everything request-shaped stays in the
Render body, exactly as on `parton`.

```tsx
const HeroBlock = block(
  function HeroRender({ headline, subhead, tone }) {
    return (
      <article data-tone={tone}>
        <h1>{headline}</h1>
        <p>{subhead}</p>
      </article>
    )
  },
  {
    selector: "page-block composed-hero",
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      subhead: cms.text("subhead"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
```

A block is internally a partial — same fingerprint pipeline, same
refetch path. Differences:

- **Slot-placeable, type-catalog-registered.** Registered under its
  spec id (see [Spec id](#spec-id--the--rule) below; `HeroRender` →
  `"hero"`); slots look it up via `cms.blocks("body", "page-block")`
  calls in their host's `schema`.
- **`selector` declares refetch labels.** Same grammar as `parton`'s
  selector; the labels are matched by `nav.reload({selector: "…"})`
  and by slot-allow filters. Multiple labels per spec are allowed.
- **Singleton CMS binding falls out of the spec's id.** A singleton
  block placed directly via JSX reads the CMS storage row matching
  its spec id.
- **Content changes move the fingerprint via a tracked dep.** The
  block wrapper records a `cms:<contentKey>` dependency for the
  instance's content row; every fingerprint fold re-reads the row's
  content hash (committed store plus the requester's draft overlay),
  so a CMS edit re-renders exactly the blocks that read the edited
  row.

## Spec id — the `#` rule

A block's spec id (catalog type, and for singletons the CMS storage
key) comes from exactly one of two places:

- **A leading-`#` selector token pins it.** `selector: "#app-nav"` →
  id `"app-nav"`.
- **Otherwise it auto-derives from `Render.name`** (`HeroRender` →
  `"hero"`, `Page`/`Block`/`Render`/`Partial`/`Component` suffixes
  stripped, kebab-cased).

Unprefixed labels (and `.`-prefixed ones) are refetch labels only —
they never set the id. `selector: "page-block composed-hero"` on
`HeroRender` gives id `"hero"` with labels
`["hero", "page-block", "composed-hero"]`. This differs from
`parton`, where the first label (prefix-stripped) IS the id.

## Options

```ts
interface BlockOptions<V, S> {
  /** Refetch labels. A leading-`#` token pins the spec id; other
   *  tokens are fan-out labels. Id auto-derives from `Render.name`
   *  when no `#` token is present. */
  selector?: SelectorTokens
  /** CMS reads + child slot composition. Result is merged into
   *  Render's prop bag alongside the match params. */
  schema?: (scope: { cms: CmsReadSurface }) => S
  match?: MatchPattern
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
  keepalive?: boolean
}
```

| Option | Notes |
|---|---|
| `selector` | Refetch labels; `#` pins the id (see above). Slot-allow filters and `nav.reload({selector: "…"})` match any label. |
| `schema` | Sync. Receives `{ cms }` — the CMS read surface, nothing else. Returns content reads (`cms.text(...)`, `cms.enum(...)`) and child slot compositions (`cms.blocks(...)`, `cms.block(...)`); both flow into Render as props. Request-dimension deps come from the tracked server-hooks (`searchParam()`, `cookie()`, …) read in the Render body, same as on `parton` — rare on blocks, whose content side lives on the `cms` surface. |
| `match`, `cache`, `defer`, `fallback`, `keepalive` | Same as [`parton`](./partial.md#options). |

## `cms` surface on schema

The `cms` argument is the read surface bound to the block's effective
CMS content row. Field getters (`text`, `richText`, `number`,
`boolean`, `enum`, `image`, `reference`) return values resolved from
the row's config cascade; `block(slot, selector?)` /
`blocks(slot, selector?)` return ReactNode for the block's slot
children. All sync; the full getter table with return types and
empty-row defaults is in [`cms.md`](./cms.md#read-surface).

`cms.blocks(slot, selector?)` resolves the slot's entries against the
selector (label filter, e.g. `"page-block"`), looks each entry up by
its `type` in the catalog, and renders the matching block. The
returned ReactNode is dropped into the Render's JSX position.
`cms.block(slot, selector?)` is the singular variant — renders at
most one entry, returns `null` when the slot is empty.

The framework binds the surface to the block's content row internally
— the schema never threads any of it.

## How blocks get placed

### 1. By a slot (from a host's schema)

A parent block hosts slots via its `schema`. The framework's slot
wiring passes the entry's id through to the rendered block instance —
internally, via a private channel — so the block's schema reads
content from the right CMS row. Author code never touches the id.

```tsx
const PageRoot = block(
  function PageRootRender({ body }) {
    return <main>{body}</main>
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", "page-block"),
    }),
  },
)
```

Each slot entry's id becomes its rendered effective id; refetch by
`reload({selector: "<entry-id>"})` works.

### 2. By direct JSX (singleton)

A singleton block is constructed once and placed once. Its CMS
content row matches its spec id — pin it with a `#` token (or rely on
the `Render.name` derivation):

```tsx
const AppNav = block(NavRootRender, {
  selector: "#app-nav",                                   // id "app-nav"
  schema: ({ cms }) => ({ links: cms.blocks("links", "nav-item") }),
})

<AppNav/>
```

The spec reads from CMS row `"app-nav"`. External code refetches via
`nav.reload({selector: "app-nav"})` (or the cosmetic `"#app-nav"`).

### 3. By direct JSX (non-CMS, fan-out only)

A spec without CMS binding doesn't need `block` at all — use
`parton`. The spec gets a refetch label via `selector`;
multiple placements share the label and refetch together:

```tsx
const LivePrice = parton(LivePriceRender, { selector: "price" })

{products.map(p => (
  <LivePrice key={p.sku} sku={p.sku} basePrice={p.price} />
))}
```

`nav.reload({selector: "price"})` fans out across every placement.

## Self-refresh from inside an instance

Client components inside a block's render can refetch their enclosing
instance via the `@self` selector token — resolved at fire time to
the instance's effective id (the slot entry id for slot-placed
blocks, the spec id for singletons), so per-instance addressing needs
no threading:

```tsx
"use client"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

export function RefreshSelfButton() {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <button onClick={() => reload({ selector: "@self" })} disabled={pending}>
      Refresh
    </button>
  )
}
```

Full `@self` semantics — mixing with other labels, the loud failure
when fired outside any partial — are in
[`frames-navigation.md`](./frames-navigation.md#self--refetch-the-enclosing-partial).

## Editor catalog manifest

`schema` is the SOLE declarative surface the editor reads: the
catalog prerender invokes each block type's `schema` once with a
tracking CMS surface and records the field reads and slot
declarations into the `BlockManifest` that drives the editor's field
panel and slot-allow filtering. Pure runtime — no static analysis, no
JSX walking. Details in
[`cms.md`](./cms.md#catalog-prerender).

## Sharp edges

- **There is no `id` JSX prop.** A block's CMS row is determined
  by placement: slot wiring carries the entry's id internally;
  singletons read from the row matching their spec id. Don't try to
  override CMS bindings from a JSX call site.
- **There is no public per-instance id override.** If you place the
  same spec multiple times in JSX with no slot wiring, all placements
  share the spec's labels and fan out under refetch (placements with
  distinct call-site props get distinct render ids — see
  [`partial.md`](./partial.md#selector-grammar)). To get
  per-instance CMS rows, route through a slot.
- **Refetch addressing is by label OR by id.** Both work the same.
  `reload({selector: "app-nav"})` matches the singleton; the same
  call matches every spec whose `selector` includes `"app-nav"` as
  a label.

## Related

- [`partial.md`](./partial.md) — the base addressable-render-unit
  constructor.
- [`cms.md`](./cms.md) — content store, draft/published model, match
  clauses on configs, the `cms` getter table.
- [`frames-navigation.md`](./frames-navigation.md) — `<Frame>` scope
  opener (separate from partials/blocks) and the `useNavigation`
  surface.
