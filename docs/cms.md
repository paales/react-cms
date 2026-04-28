# CMS

The CMS is a thin layer on top of `<Partial>`. A Partial with a
`cmsId` prop opens a CMS scope; descendant content accessors
(`getText`, `getEnum`, …) read fields out of a JSON store keyed by
that id. The same manifest that drives `<Partial cache>` keys also
drives the CMS configuration space — a Partial that reads
`getPathname("/p/:slug")` has per-slug configurations; a Partial
that reads `getSearchParam("variant")` has per-variant ones.

The store is committed JSON (`src/cms/content.json`); the editor
writes a sibling `src/cms/draft.json` (gitignored) which the runtime
prefers when the request carries a draft cookie or query param.
Publishing copies draft entries into published.

Three-pane editor at `/?editor=1` (cookie-gated, applied to every
page via `<EditorShell>` in `src/editor/shell.tsx`): tree on the
left, address-bar + previewed page in the middle, field form on
the right.

## Content store schema

Both `content.json` and `draft.json` share one shape:

```jsonc
{
  "partials": {
    "<cmsId>": {
      "id": "<cmsId>",
      "type": "<blockType>",       // optional; set for block instances
      "displayName": "#header",     // optional; what the editor tree shows
      "configs": [
        { "match": { /* zero or more dimension keys */ },
          "fields": { /* field name → value */ } }
      ],
      "slots": {                    // optional; recursive child blocks
        "<slotName>": [
          { "id": "...", "type": "...", "configs": [...], "slots": {...} }
        ]
      }
    }
  }
}
```

Keys you'll see in `match`:

| Key                  | Source           | Example                                    |
| -------------------- | ---------------- | ------------------------------------------ |
| `url:<param>`        | `getSearchParam` | `"url:variant": "A"`                       |
| `cookie:<name>`      | `getCookie`      | `"cookie:locale": "fr"`                    |
| `header:<name>`      | `getHeader`      | `"header:x-region": "eu"`                  |
| `pathname:<pattern>` | `getPathname`    | `"pathname:/p/:slug": { "slug": "alpha" }` |

A match clause value is one of:

- A scalar (`string | number | boolean`) — exact equality (stringified).
- `{in: [...]}` — membership.
- For `pathname:` keys, an object of `paramName → scalar | {in: [...]}`.

Multi-key matches AND together — every key must match. An empty
`match: {}` always matches (the cascade default).

```jsonc
"configs": [
  { "match": { "url:variant": "A" },
    "fields": { "headline": "Variant A" } },
  { "match": { "pathname:/p/:slug": { "slug": "alpha" } },
    "fields": { "headline": "Alpha welcome" } },
  { "match": {},
    "fields": { "headline": "Default", "body": "Always" } }
]
```

## Cascade resolution

The resolver picks every config whose match is satisfied, scores by
matched-dimension count, then merges fields least-specific-first so
more-specific overrides win.

```
?variant=A on /p/alpha → { headline: "Alpha welcome", body: "Always" }
?variant=A on /p/beta  → { headline: "Variant A",     body: "Always" }
?variant=B on /p/beta  → { headline: "Default",       body: "Always" }
```

V1 specificity: longer score (more dimensions matched) wins. Ties
break by config-array order (earlier wins).

Fields the more-specific config doesn't set inherit from
less-specific configs. Same shape as CSS cascade, Drupal contexts,
or Magento store-views.

## Authoring a block

Three things, all in userspace:

### 1. The block component

```tsx
// src/app/blocks/promo.tsx
import { getEnum, getNumber, getText } from "../../framework/context.ts";

export function PromoBlock() {
  const headline = getText("headline");
  const body = getText("body");
  const tone = getEnum("tone", ["info", "warning"] as const);
  const dismissAfter = getNumber("dismissAfter");
  return (
    <div data-tone={tone} data-dismiss-after={dismissAfter}>
      <h3>{headline}</h3>
      <p>{body}</p>
    </div>
  );
}
```

Read accessors at the **synchronous top** of the body, before any
`await`. Same hoisting rule as cache manifest and frame scope; same
`HoistingViolationError` if a render reads a key the previous one
didn't.

Every accessor returns a safe default when the store has nothing
(`""`, `0`, `false`, `values[0]` for enums, `{src: "", alt: ""}` for
images), so a block with no stored data still renders. The editor
populates real values later.

Don't take props. The block runs inside a `<Partial cmsId={…}>`
wrapper, and its CMS scope is keyed by the cmsId — cross-instance
config resolution happens automatically.

### 2. Register it in the catalog

```ts
// src/app/blocks/catalog.ts
import { registerBlock } from "../../framework/cms-runtime.ts";
import { PromoBlock } from "./promo.tsx";

registerBlock("promo", {
  tags: [".promo", ".demo-block"],
  component: PromoBlock,
});
```

`tags` are class-only selectors that go on every instance of this
block. The framework prepends `#<cmsId>` per instance for
addressability, so blocks don't need to declare a `#`-token.

The catalog file is imported once for its side effects in
`src/app/root.tsx`. HMR-friendly: a re-import replaces the prior
spec.

### 3. Optional — seed an instance

Either edit `content.json` directly:

```jsonc
{
  "partials": {
    "homepage-promo": {
      "id": "homepage-promo",
      "type": "promo",
      "configs": [{ "match": {}, "fields": { "headline": "Welcome", "tone": "info" } }],
    },
  },
}
```

…or open `/?editor=1` and add an instance via a slot's `+ Block`
palette.

## Content-field accessors

| Accessor                | Returns                      | Empty value                          |
| ----------------------- | ---------------------------- | ------------------------------------ |
| `getText(name)`         | `string`                     | `""`                                 |
| `getRichText(name)`     | `string`                     | `""` (v1; structured value reserved) |
| `getNumber(name)`       | `number`                     | `0`                                  |
| `getBoolean(name)`      | `boolean`                    | `false`                              |
| `getEnum(name, values)` | `T extends string`           | `values[0]`                          |
| `getImage(name)`        | `{src: string; alt: string}` | `{src: "", alt: ""}`                 |

Each accessor records its `(name, kind)` into the active CMS
scope's `contentFields` map — the catalog prerender uses that
manifest to populate the editor's form for this block type.

The dev-time prerender (`src/framework/cms-prerender.ts`) runs each
registered block once at editor startup with no real data. It
captures the field manifest by calling the component as a function
inside an ALS-backed CMS scope. **Reads after the first `await` are
not captured** — keep block bodies sync at the top, async work after.

## Slots

```tsx
import { Children, Child } from "../../lib";

export function PageRoot() {
  return (
    <main>
      <Children name="body" allow=".page-block" />
      <aside>
        <Child name="sidebar" allow=".widget" />
      </aside>
    </main>
  );
}
```

| Component               | Renders                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `<Children name allow>` | Every entry in `node.slots[name]` in stored order, each wrapped in its own `<Partial cmsId={entry.id}>`. |
| `<Child name allow>`    | At most one entry from `node.slots[name]`.                                                               |

`allow` is a selector grammar (same as `<Partial selector>`)
controlling which block types the editor's `+ Block` palette offers
for this slot. Wildcard `allow="*"` accepts every registered block.
The runtime doesn't enforce `allow` at render time — a misplaced
block still renders; the editor is where the invariant gets policed.

Slots are recursive: a block's own component can declare
`<Children>` / `<Child>` of its own. The runtime walks indefinitely.

Slot children are addressable by `cmsId`. `lookupCmsNode("foo")`
finds `foo` whether it lives at `partials.foo` (top level) or
nested deep inside a slot array. The runtime builds a flat
`cmsId → node` index on every load.

## References and entity loaders

Block content scoped to the Partial lives in `getText` / etc.
Entity data — products, collections, articles — lives in a backend
the CMS doesn't own. `getReference(name, type)` declares a typed
reference; userspace **loaders** resolve the reference into a
concrete entity.

```tsx
import { getReference } from "../../framework/context.ts";
import { getProduct } from "../loaders/product.ts";

export async function ProductHero() {
  const ref = getReference("featured", "product");
  const product = await getProduct(ref);
  if (!product) return null;
  return <Hero product={product} />;
}
```

`getReference(name, type)` returns a `Reference<T>`:

```ts
interface Reference<T extends string> {
  readonly type: T; // "product", "collection", …
  readonly value: string | null; // concrete id from the store
  readonly fallback: "closest" | null; // default "closest"
}
```

The loader (in userspace) decides what to do:

```ts
// src/app/loaders/product.ts
import type { Reference } from "../../framework/cms-runtime.ts";
import { getClosest } from "../../framework/context.ts";

export async function getProduct(ref: Reference<"product">): Promise<Product | null> {
  if (ref.value) return fetchProductById(ref.value);
  if (ref.fallback === "closest") return getClosest<Product>("product");
  return null;
}
```

The editor renders an entity picker per type tag (`product`,
`collection`, etc.) — userspace registers picker widgets in a
registry the framework provides. Without a registered widget the
editor falls back to a plain text id input.

## `provides` and `getClosest`

```tsx
<Partial parent={ROOT} selector="#pdp" provides={{ product: await fetchProduct(slug) }}>
  <ProductDetail />
</Partial>
```

Descendants read via `getClosest<T>(key)`, which walks the parent
chain's merged `provides` bag and returns the first match. The
chain is built up by `<Partial provides={…}>` extending the parent's
provides; child entries override parent entries of the same key.

`getClosest` records into the CMS scope's `contextConsumes` set so
the editor can show a "this block depends on an ancestor providing
X" badge.

**Cache-mode refetch limitation.** Snapshots don't carry ancestor
provides. A Partial running from its snapshot in cache mode reads
`null` for any key that came from an ancestor. Blocks that must
survive cache-mode refetches should either:

1. Carry a concrete `getReference` value alongside the closest
   fallback, or
2. Branch on the missing closest and short-circuit.

## Draft and published

Two stores share one schema. The runtime prefers draft when the
request signals draft mode:

| Signal                                          | Where                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `?cms-draft=1` query param                      | The editor's preview frame URL stamps it for first load.                                 |
| `Cookie: cms-draft=1`                           | The editor sets it on first response; covers subsequent requests including action POSTs. |
| `?editor=1` query param OR `Cookie: __editor=1` | Editor mode implies draft visibility.                                                    |

`lookupCmsNode(cmsId, request)` checks draft first when any of these
hold, else falls back to published. The draft cookie also folds into
cache keys via the manifest — cached bytes never leak across modes.

### Writing to draft

```ts
import { writeDraftNode } from "../framework/cms-runtime.ts";
await writeDraftNode("homepage-promo", {
  id: "homepage-promo",
  type: "promo",
  configs: [{ match: {}, fields: { headline: "New copy" } }],
});
```

Whole-node overrides in v1. Drafts are full snapshots; the editor's
server actions clone the existing node, mutate, and write the
result. Atomic file writes (temp + rename) prevent half-writes from
corrupting the on-disk state.

### Top-level wins for slot children

Slot children live nested in their parent's `slots[name]` array.
When the editor edits a slot child's fields, `saveCmsFields` writes
a top-level draft entry for the child id — and the runtime's flat
index gives top-level entries precedence over nested copies of the
same id. Means an edited slot child's draft is immediately visible
even though the parent's slot array still has the old shape.

### Publishing

`publishDraft()` copies every draft entry into published, then
clears the draft file. No partial publish in v1 — it's all or
nothing per author.

### Reverting

`revertDraftNode(cmsId)` removes a single id's draft override.
Falls back to the published value on the next read. The editor's
"Reset draft → published" button calls this.

## Editor mode

Cookie-gated chrome that wraps every page. Visiting any URL with
`?editor=1` sets the `__editor` cookie and renders the page inside
`<EditorShell>` (`src/editor/shell.tsx`); subsequent navs keep the
chrome on without the URL flag. `?editor=0` clears the cookie.
Visitors without the cookie pay no editor cost.

### Three panes

| Pane                  | Role                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left (sticky, 320px)  | Tree of CMS nodes for the previewed page (filtered by `PAGE_CMS_ROOTS` in `shell.tsx`). Click to select; selection drives `?select=<cmsId>`.                                                        |
| Center                | Address bar pinned to top, previewed page below. The address bar drives `useNavigation()` (window-scoped) — typing a path navigates the browser, browser back/forward walks preview history.        |
| Right (sticky, 360px) | Field form for the selected node. One tab per `CmsConfig`; the matching tab auto-selects from the previewed page URL. Inputs derive from the catalog manifest unioned with currently-stored fields. |

The previewed page renders inside a `<Partial frame="preview">` so
tracked accessors inside the page resolve against the **frame URL**
(window URL minus editor-internal params), not the page URL with
`?select=…&config=…` riding on it. Without the frame, a search
Partial inside the preview would pick up `?select=` as a manifest
read and trip `HoistingViolationError` the moment the user clicks
a tree entry.

The frame's session URL is **overwritten on every Root render**
with the window URL minus editor params. This reconciles
"address-bar drives window navigation" (bookmarkable, browser-back
walks preview history) with "frame scopes accessor reads" (no
editor-state pollution into page Partials).

### Editor-state params

| Param                     | Purpose                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `?editor=1` / `?editor=0` | Sticky toggle (sets / clears cookie).                                                                                                |
| `?select=<cmsId>`         | Currently-selected node. Preserved across address-bar navs; dropped by preview-internal `<a>` clicks.                                |
| `?config=<index>`         | Active config tab. Defaults to the highest-scoring tab for the previewed page URL via `pickBestConfigIndex`; explicit override wins. |

The shell does **not** wrap itself in a `<Partial>`. The inner page
Partial needs to fp-differ when its CMS-resolved bytes change, and
a wrapping Partial would fp-match (no URL deps in editor chrome) and
short-circuit the inner re-render.

### Adding a page to the editor's tree

```ts
// src/editor/shell.tsx
const PAGE_CMS_ROOTS: ReadonlyArray<readonly [pattern: string, roots: readonly string[]]> = [
  ["/cms-demo", ["cms-demo-root"]],
  ["/cms-demo/:slug", ["cms-demo-root"]],
  ["/your-route", ["your-page-root"]],
];
```

Routes without an entry surface an empty tree with a hint pointing
the author at a CMS-aware page.

## Editor server actions

In `src/editor/actions.ts` — every action returns
`{invalidate: {selector: "#<cmsId> #cms-edit-tree #cms-edit-fields"}}`
so the preview, tree, and form all refetch in sync.

| Action                                                               | Behavior                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveCmsFields(cmsId, configIndex, formData)`                        | Merge form entries into the targeted config (or create the default config if `configIndex < 0`), write to draft. Edits never bleed across configs. |
| `publishCmsDraft()`                                                  | Copy draft → published, clear draft. Invalidates `#cms-edit-tree` (broad — refines as a follow-up).                                                |
| `resetCmsDraft(cmsId)`                                               | Drop a single id's draft override.                                                                                                                 |
| `addBlockToSlot(parentCmsId, slotName, blockType)`                   | Append a new block instance to the slot. Throws if the type isn't registered.                                                                      |
| `removeBlockFromSlot(parentCmsId, slotName, childCmsId)`             | Remove. Idempotent.                                                                                                                                |
| `moveBlockInSlot(parentCmsId, slotName, childCmsId, "up" \| "down")` | Swap with sibling. No-op at boundaries.                                                                                                            |

Actions clone the node (deep) before mutating — never write back the
cached object that `lookupCmsNode` returned, since concurrent reads
would see torn state.

## Sharp edges

- **Catalog prerender doesn't see post-await reads.** The block
  manifest comes from a single sync execution of the component with
  no real data; reads inside an async branch past the first `await`
  don't make it into `contentFields`. Keep accessors at the sync
  top — the same hoisting rule that already governs cache and frame
  scope.

- **Per-author draft isolation isn't built.** `draft.json` is
  process-global. One editor session at a time; concurrent edits
  conflict. Production-shape deployments need per-cookie /
  per-session draft scoping.

- **The CMS store is in-memory.** mtime-cached file load with an
  async warm-up before each request. A real deployment would point
  the storage backend at a database — `setCmsStorage()` swaps the
  implementation; the runtime doesn't care.

- **`getReference` editor support is partial.** The framework
  ships the registry mechanism; userspace registers picker widgets
  per type. Unregistered types fall back to a plain text input —
  authors paste an entity id by hand.

- **Hydration warning on long static slug navs.** Wrapping a
  large static-but-streamed sub-tree (a long `<nav>`, a list of
  cards) in its own `<Partial>` gives it a stable streaming
  boundary so React's SSR doesn't commit early and produce a
  server/client mismatch.
