# CMS

CMS-driven content lives on [`block`](./block.md) specs via
a `schema` callback — the CMS resolution surface, and the one
declared schema in the framework. The callback receives a sync `cms`
read surface bound to the block's effective CMS content row (the
storage key of the rendered instance); its return is merged into the
Render function's prop bag. Request dimensions never appear here —
they're tracked-hook reads in the Render body, same as on any parton.

```tsx
const PromoBlock = block(
  function PromoRender({ headline, body, tone, dismissAfter }) {
    return <div data-tone={tone}>...</div>
  },
  {
    selector: "promo",
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["info", "warn"] as const),
      dismissAfter: cms.number("dismissAfter"),
    }),
  },
)
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
cascade for the block's CMS content row. `cms.reference` returns the
**id only** — async loaders run inside `Render`, not `schema`.

## Content store schema

`cms/data/content.json` (committed) + `cms/data/draft.json` (gitignored).
Both share one shape:

```jsonc
{
  "partials": {
    "<id>": {
      "id": "<id>",
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
more-specific overrides win. Specificity: longer score wins; ties
break by config-array order (earlier wins).

## Authoring a block

```tsx
// e2e-testing/src/app/blocks/promo.tsx
import { block, type RenderArgs } from "@parton/framework"

export const PromoBlock = block(
  function PromoRender({ headline, body, tone }: { ... } & RenderArgs) {
    return <div data-tone={tone}>...</div>
  },
  {
    selector: "promo demo-block",
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
```

That's it — no `registerBlock` call. The constructor self-registers
under its auto-derived id (`PromoRender` → `"promo"`); pin a
different id with a leading-`#` selector token (see
[`block.md`](./block.md#spec-id--the--rule)). Import the file once
for its side effect (`e2e-testing/src/app/blocks/catalog.ts` does
this for the demo app).

## Slots

Slot composition lives on the schema. `cms.blocks(slot, selector?)`
returns a ReactNode that resolves every entry under `node.slots[slot]`
to a rendered block via the type catalog; `cms.block(slot, selector?)`
is the singular variant (at most one entry). The framework wires each
slot entry's id into the rendered instance's `cms` surface as its
effective CMS row — author code doesn't thread any of it. Placement
patterns and a worked host example are in
[`block.md`](./block.md#how-blocks-get-placed).

## References + entity loaders

```tsx
const ProductHero = block(
  async function ProductHeroRender({ productRef }: { productRef: string | null } & RenderArgs) {
    const product = productRef ? await getProduct(productRef) : null
    if (!product) return null
    return <Hero product={product} />
  },
  {
    selector: "product-hero",
    schema: ({ cms }) => ({
      productRef: cms.reference("featured", "product"),
    }),
  },
)
```

A changed reference moves the row's content hash, and with it the
block's `cms:<contentKey>` tracked dep and fingerprint; the async
loader runs in `Render`. Loaders are userspace (`e2e-testing/src/app/loaders/`).

## Draft + published

| Signal | Where |
|---|---|
| `?cms-draft=1` | Editor stamps it on the preview URL. |
| `Cookie: cms-draft=1` | Editor sets on first response. |
| `Cookie: __editor=1` | Editor mode implies draft visibility. |

`lookupCmsNode(id, request)` checks draft first when any of these
hold, else falls back to published. Fingerprints vary across modes
because the block's `cms:<contentKey>` dep folds the row's content
hash with the requester's draft overlay applied — an edit re-renders
exactly the blocks that read the edited row, for draft viewers only
until publish.

## Editor mode

The `__editor` cookie is the sole source of truth for editor on/off.
Click-driven entry/exit flows through `nav.navigate(url, {cookies:
{[EDITOR_COOKIE]: "1" | ""}, selector: "editor-shell"})` —
`EditorOpenLink` / `EditorCloseLink` wrap this pattern. Tests set the
cookie directly via Playwright's `context.addCookies` before
navigating. There is no `?editor=1` URL trigger.

When the cookie is set, `<EditorShell>` paints three panes:

- Tree (`cms-edit-tree`) — registry-driven view of the CMS content
  rows that rendered for the previewed page. The tree reads
  `getRouteSnapshots()` (every CMS-bound block self-registers at
  render time), filters to the ids whose spec is registered as a
  slot block via `getSlotBlockMeta(snap.type)`, and walks each as a
  tree root through `listAllCmsNodes(rootIds)`; slot-children-of-
  other-roots are filtered out automatically. Chrome that renders on every
  page (e.g. the `AppNavBlock` singleton placed at the page root)
  appears on every page; per-page roots only appear where their
  partial mounts. Reads the previewed `pathname()` (a tracked dep)
  so cross-page navigation invalidates the tree fp.
- Preview — the page itself, rendered inline inside the editor's
  middle pane. Page placements render at the root; their tracked
  reads see the window URL with editor-internal params present
  (`?select=…`, `?config=…`). Specs that only read the pathname or
  page-relevant search params naturally ignore those.
- Field form (`#cms-edit-fields`) — per-config tabs + form fields
  derived from the catalog manifest. Reads `pathname()` so
  `pickBestConfigIndex` re-evaluates as the previewed page changes.

Server actions (`saveCmsFields`, `publishCmsDraft`,
`addBlockToSlot`, `removeBlockFromSlot`, `moveBlockInSlot`,
`resetCmsDraft`) live in `cms/src/editor/actions.ts`.

## Catalog prerender

The editor's field form needs to know which fields each block type
declares. The catalog prerender walks every registered block type,
calls its `schema` once with a tracking CMS surface, and records
the field reads.

`schema` is sync and pure-of-state — the prerender doesn't enter
React, doesn't render JSX, doesn't suspend. Every accessor read in
`schema` is captured, regardless of order or position relative to
hypothetical awaits.
