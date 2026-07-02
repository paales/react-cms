# `block(Render, …)`

Slot-placeable, type-catalog-registered partial. A block is what slots
look up by `type` to render their entries; its `schema` callback
declares both CMS content reads and child slot composition.

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
  auto-derived name (`HeroRender` → `"hero"`); slots look it up via
  `cms.blocks("body", "page-block")` calls in their host's `schema`.
- **`selector` declares refetch labels.** Same grammar as `partial`'s
  selector; the labels are matched by `nav.reload({selector: "…"})`
  and by slot-allow filters. Multiple labels per spec are allowed.
- **Singleton CMS binding falls out of the spec's id.** A spec like
  `selector: "#app-nav"` (or just `selector: "app-nav"`) has id
  `"app-nav"` — also the CMS storage row it reads from. Placed once
  via JSX; the framework binds its CMS content by id.
- **Content changes move the fingerprint via a tracked dep.** The
  block wrapper records a `cms:<contentKey>` dependency for the
  instance's content row; every fingerprint fold re-reads the row's
  content hash (committed store plus the requester's draft overlay),
  so a CMS edit re-renders exactly the blocks that read the edited
  row.

## Options

```ts
interface BlockOptions<S> {
  /** Refetch labels. Plain strings; leading `#` / `.` are cosmetic
   *  and stripped. The first label is also the spec's catalog id
   *  (slot lookup type, and for singletons the CMS storage key).
   *  Auto-derives from `Render.name` when omitted (`HeroRender`
   *  → `"hero"`). */
  selector?: SelectorTokens
  /** CMS reads + child slot composition. Result is merged into
   *  Render's prop bag alongside the match params. */
  schema?: (scope: { cms: CmsReadSurface }) => S
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
}
```

| Option | Notes |
|---|---|
| `selector` | One or more refetch labels. The first label is the spec's catalog id (also the CMS storage row for singletons). Slot-allow filters and `nav.reload({selector: "…"})` match any label. Cosmetic `#`/`.` prefixes are stripped. |
| `schema` | Sync. Returns content reads (`cms.text(...)`, `cms.enum(...)`) and child slot compositions (`cms.blocks(...)`, `cms.block(...)`). Both flow into Render as props. Request-dimension deps come from the tracked server-hooks (`searchParam()`, `cookie()`, …), same as on `parton` — rare on blocks, whose content side lives on the `cms` surface. |
| `cache`, `defer`, `fallback` | Same as `parton`. |

## `cms` surface on schema

```ts
interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
  block(slot: string, selector?: string): ReactNode
  blocks(slot: string, selector?: string): ReactNode
}
```

Field reads (`text`/`enum`/etc.) return values from the host's CMS
content row; `block` / `blocks` return ReactNode for the host's slot
children. The framework binds the surface to the host's content row
internally — the schema never threads any of it.

`cms.blocks(slot, selector?)` resolves the slot's entries against the
selector (label filter, e.g. `"page-block"`), looks each entry up by
its `type` in the catalog, and renders the matching block. The
returned ReactNode is dropped into the Render's JSX position.

`cms.block(slot, selector?)` is the singular variant — renders at
most one entry, returns `null` when the slot is empty.

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
content row matches its spec id (the first selector label, or
`Render.name`-derived):

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
instance via the `@self` selector token. For singleton blocks and
slot-placed instances (each entry has a unique id), this gives
per-instance addressing. For keyless multi-instance specs (multiple
JSX placements sharing an id) it refreshes the spec's whole fan-out.

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

`@self` resolves to a React Context the framework populates in
`PartialErrorBoundary` — every block instance has the context set to
its runtime effective id (the slot entry id for slot-placed, the spec
id for singletons). Used outside any partial, `@self` throws a
typed `NavigationError` at fire time so the wiring mistake is loud.

## Editor catalog manifest

`schema` is the SOLE declarative surface the editor reads. At first
catalog request, `cms-prerender.ts` walks every registered block
type and invokes its `schema` with a tracking CMS surface. Each
`cms.text(name)` / `cms.enum(name, values)` / `cms.image(name)` /
`cms.reference(name, type)` records the field's name + kind. Each
`cms.block(slot, selector)` / `cms.blocks(slot, selector)` records
the slot's allow filter + arity.

The resulting `BlockManifest` drives:

- Which field inputs the editor's field panel shows.
- Slot-allow filtering when offering "Add block" options for each
  slot — the manifest's `labels` are matched against the slot's
  `allow` string.

Pure runtime — no static analysis, no JSX walking.

## Sharp edges

- **There is no `id` JSX prop.** A block's CMS row is determined
  by placement: slot wiring carries the entry's id internally;
  singletons read from the row matching their spec id. Don't try to
  override CMS bindings from a JSX call site.
- **There is no public per-instance id override.** If you place the
  same spec multiple times in JSX with no slot wiring, all placements
  share the spec's id and fan out under refetch. To get per-instance
  CMS rows, route through a slot.
- **Refetch addressing is by label OR by id.** Both work the same.
  `reload({selector: "app-nav"})` matches the singleton; the same
  call matches every spec whose `selector` includes `"app-nav"` as
  a label. `#` and `.` prefixes on a selector are cosmetic.

## Related

- [`partial.md`](./partial.md) — the base addressable-render-unit
  constructor.
- [`cms.md`](./cms.md) — content store, draft/published model, match
  clauses on configs.
- [`frames-navigation.md`](./frames-navigation.md) — `<Frame>` scope
  opener (separate from partials/blocks).
