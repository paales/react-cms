# CMS

A thin layer on top of `ReactCms.partial`. A spec with a `cmsId`
opens a CMS scope; its `vary` callback receives a sync `cms` read
surface bound to that id, and its render function gets the resolved
field values.

```tsx
const PromoBlock = ReactCms.partial(PromoRender, {
  type: "promo",
  tags: [".promo"],
  vary: ({ cms }) => ({
    headline: cms.text("headline"),
    body: cms.text("body"),
    tone: cms.enum("tone", ["info", "warn"] as const),
    dismissAfter: cms.number("dismissAfter"),
  }),
})

function PromoRender({
  headline, body, tone, dismissAfter,
}: { ... } & RenderArgs) {
  return <div data-tone={tone}>...</div>
}
```

## Read surface

| Getter | Returns | Empty default |
|---|---|---|
| `cms.text(name)` | `string` | `""` |
| `cms.richText(name)` | `string` | `""` |
| `cms.number(name)` | `number` | `0` |
| `cms.boolean(name)` | `boolean` | `false` |
| `cms.enum(name, values)` | `T` | `values[0]` |
| `cms.image(name)` | `{src, alt}` | `{src:"", alt:""}` |
| `cms.reference(name, type)` | `string \| null` | `null` |

All sync. Every getter resolves against the already-loaded config
cascade for the spec's `cmsId`. `cms.reference` returns the **id
only** — async loaders run inside `Render`, not `vary`.

## Content store schema

`cms/data/content.json` (committed) + `cms/data/draft.json` (gitignored).
Both share one shape:

```jsonc
{
  "partials": {
    "<cmsId>": {
      "id": "<cmsId>",
      "type": "<blockType>",
      "displayName": "...",
      "configs": [
        { "match": { ... }, "fields": { ... } }
      ],
      "slots": {
        "<slotName>": [ <CmsNode>, ... ]
      }
    }
  }
}
```

## Match clauses

Match keys you'll see:

| Key | Source |
|---|---|
| `url:<param>` | request search param |
| `cookie:<name>` | request cookie |
| `header:<name>` | request header |
| `pathname:<pattern>` | pathname pattern (e.g. `/p/:slug`) |

Clause values:
- scalar (string/number/boolean) → equality
- `{in: [...]}` → membership
- for `pathname:` keys → `{paramName: scalarOrIn, ...}`

Multi-key matches AND together. Empty `match: {}` always matches
(cascade default).

## Cascade resolution

The resolver picks every config whose match is satisfied, scores by
matched-dimension count, then merges fields least-specific-first so
more-specific overrides win. V1 specificity: longer score wins; ties
break by config-array order (earlier wins).

## Authoring a block

```tsx
// e2e-testing/src/app/blocks/promo.tsx
import { ReactCms, type RenderArgs } from "../../lib"

export const PromoBlock = ReactCms.partial(
  function PromoRender({ headline, body, tone }: { ... } & RenderArgs) {
    return <div data-tone={tone}>...</div>
  },
  {
    type: "promo",
    tags: [".promo", ".demo-block"],
    vary: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
```

That's it — no `registerBlock` call. The constructor self-registers
under `type` (or auto-derived id). Import the file once for its side
effect (`e2e-testing/src/app/blocks/catalog.ts` does this for the demo app).

## Slots

```tsx
import { Children, Child } from "../../lib"

export const PageRootBlock = ReactCms.partial(
  function PageRootRender({ parent, cmsId }: RenderArgs) {
    return (
      <main>
        <Children name="body" allow=".page-block" host={parent} hostCmsId={cmsId} />
        <aside>
          <Child name="sidebar" allow=".widget" host={parent} hostCmsId={cmsId} />
        </aside>
      </main>
    )
  },
  { type: "page-root", tags: [] as never },
)
```

| Component | Renders |
|---|---|
| `<Children name allow host hostCmsId>` | Every entry in `node.slots[name]` in stored order; each rendered through its registered spec with `cmsId={entry.id}` override. |
| `<Child name allow host hostCmsId>` | At most one entry. |

`host` is the `parent: PartialCtx` from the host spec's render args.
`hostCmsId` is the host's effective cmsId — pass `cmsId` from
`RenderArgs`.

## References + entity loaders

```tsx
const ProductHero = ReactCms.partial(
  async function ProductHeroRender({ productRef }: { productRef: string | null } & RenderArgs) {
    const product = productRef ? await getProduct(productRef) : null
    if (!product) return null
    return <Hero product={product} />
  },
  {
    type: "product-hero",
    cmsId: "product-hero",
    vary: ({ cms }) => ({
      productRef: cms.reference("featured", "product"),
    }),
  },
)
```

The id contributes to the cache key via the vary result; the async
loader runs in `Render`. Loaders are userspace (`e2e-testing/src/app/loaders/`).

## Draft + published

| Signal | Where |
|---|---|
| `?cms-draft=1` | Editor stamps it on the preview URL. |
| `Cookie: cms-draft=1` | Editor sets on first response. |
| `?editor=1` / `Cookie: __editor=1` | Editor mode implies draft visibility. |

`lookupCmsNode(cmsId, request)` checks draft first when any of these
hold, else falls back to published. Cache keys naturally vary across
modes because `cms.text/...` reads return different values.

## Editor mode

`/?editor=1` sets `__editor=1` cookie; subsequent requests render
inside `<EditorShell>`. Three panes:

- Tree (`#cms-edit-tree`) — registry-driven view of the cmsIds that
  rendered for the previewed page. The tree reads
  `getRouteSnapshots()` (every `<Spec cmsId>` self-registers at
  render time) and walks each snapshot's id as a tree root through
  `listAllCmsNodes(rootIds)`; slot-children-of-other-roots are
  filtered out automatically. Chrome that renders on every page
  (e.g. `<NavRootBlock cmsId="app-nav">` placed at the page root)
  appears on every page; per-page roots only appear where their
  partial mounts. Folds the previewed `pathname` into its `vary`
  so cross-page navigation invalidates the tree fp.
- Preview — the page itself, rendered inline inside the editor's
  middle pane. Page placements receive `parent={ROOT}`; their `vary`
  callbacks see the window URL with editor-internal params present
  (`?select=…`, `?config=…`). Specs whose `vary` only reads the
  pathname or page-relevant search params naturally ignore those.
- Field form (`#cms-edit-fields`) — per-config tabs + form fields
  derived from the catalog manifest. Folds `pathname` into its
  `vary` so `pickBestConfigIndex` re-evaluates as the previewed
  page changes.

Server actions (`saveCmsFields`, `publishCmsDraft`,
`addBlockToSlot`, `removeBlockFromSlot`, `moveBlockInSlot`,
`resetCmsDraft`) live in `cms/src/editor/actions.ts`.

## Catalog prerender

The editor's field form needs to know which fields each block type
declares. The catalog prerender walks every registered spec, calls
its `vary` once with a stub request and a tracking CMS surface, and
records the field reads.

`vary` is sync and pure-of-state — the prerender doesn't enter
React, doesn't render JSX, doesn't suspend. The old "render the
component once and hope reads happen at sync top before first await"
sharp edge is gone.
