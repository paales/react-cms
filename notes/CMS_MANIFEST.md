# CMS via accessor-tracked manifest — data model

**Added:** 2026-04-25
**Status:** chunk 1 (content-field accessors + resolver + `cmsId`) and chunk 2a (slots + block registry) both shipped 2026-04-25 — see `CMS_VISION.md § First milestone`. Still design-sketch: `provides` / `getClosest`, `getReference` + entity loaders, presets, editor. Companion: `CMS_VISION.md` (why), `CMS_EDITOR.md` (authoring UX).

---

## One-liner

The same manifest the framework already uses for cache-key derivation is also the CMS's schema, scope map, and form generator. Accessor reads at render time populate the manifest; consumers (cache layer, CMS editor, invalidation graph) read the relevant sections. No schema file, no codegen, no build step — the component IS the schema.

## Accessor families — five kinds

The manifest has five categorized entry kinds. They share population mechanics (ALS-backed, hoisting-enforced, per-Partial) but drive different downstream behavior:

| Kind            | Example call                                                                                                        | Scopes config?        | Shows in editor?         | Editor treatment                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ | ------------------------------------------------ |
| Request-input   | `getSearchParam("abtest")`, `getCookie("locale")`, `getHeader("accept-language")`, `getPathname("/p/:slug")`        | **Yes** (config axis) | As "varies by" indicator | Axis selector; author scopes overrides per value |
| Content-field   | `getText("headline")`, `getEnum("variant", [...])`, `getNumber("count")`, `getRichText("body")`, `getImage("hero")` | No                    | **Yes**                  | Form field                                       |
| Child-slot      | `<Children name="items" allow=".card"/>`, `<Child name="primary-cta" allow=".cta"/>`                                | No                    | **Yes**                  | Drop zone                                        |
| Reference       | `getReference("featured", "product")`                                                                               | No                    | **Yes**                  | Entity picker                                    |
| Context-consume | `getClosest<Product>("product")`                                                                                    | No                    | Doc only                 | "Requires ancestor context" badge                |

**Implementation note.** Today `ManifestScope.current: Set<string>` holds only request-input entries keyed as `"kind:name"` (see `src/framework/context.ts`). To support the CMS, split the manifest into five typed sections — one per kind. Cache-key derivation reads only the request-input section; editor form generation reads content-field + slot + reference; ancestry-lint reads context-consume. One data structure, five consumers, no coupling between them. Cheap refactor today, load-bearing later.

## Request-input accessors — unchanged

`getCookie`, `getHeader`, `getSearchParam`, `getPathname(pattern)`. Already documented in `AUTO_TRACKED_CACHE_KEYS.md`. The CMS addition is that these also dimension the **configuration space** — a Partial that reads `getPathname("/p/:slug")` has per-slug configurable fields, not just per-slug cache entries.

## Content-field accessors

Primitive-valued fields authors edit in forms. Signatures:

```ts
getText(name: string): string
getRichText(name: string): RichTextValue
getNumber(name: string): number
getEnum<T extends string>(name: string, values: readonly T[]): T
getImage(name: string): ImageValue
getBoolean(name: string): boolean
```

No default-value argument — first render on a fresh instance returns an empty value (`""`, `0`, `false`, `values[0]` for enums, empty for images/rich-text). The hoisting rule still applies: the same field names must be read on every render. Presets (Shopify-style initial-value bundles) can supply non-empty starting values when a block is first added from the palette — see §Presets below; not required for v1.

**Component sugar** for rendering:

```tsx
<Text name="headline" />       // ~ <span>{getText("headline")}</span>
<RichText name="body" />
<Image name="hero" alt={getText("heroAlt")} />
```

The component form is a convenient site for future inline-editing affordances (click to edit in preview mode). The function form is for when the value feeds into logic (branching, computed props). Both record identically into the manifest.

## Reference accessors + typed loaders

```ts
const productRef = getReference("featured", "product");
const product = await getProduct(productRef);
```

`getReference(name, type)` declares a typed entity reference:

- `name` — field name in the Partial's manifest
- `type` — entity-family tag ("product", "collection", "page", "user", …)

Default semantic: `closest.<type>` — if the CMS hasn't set this reference explicitly, the loader resolves via `getClosest<Product>("product")` from the parent chain. Authors can override in the editor by picking a specific entity.

`getProduct(ref)` (or `getCollection(ref)`, etc.) is the typed loader. It's responsible for:

- Resolving the reference (specific ID → fetch; "closest" sentinel → ancestor-chain walk)
- Deduping concurrent requests within one render (two blocks on the same product don't double-fetch)
- Typing the result

Loaders live in userspace (app-owned) or in framework-level adapters (`src/app/loaders/product.ts`). The framework ships `getReference` + `getClosest` + the registry to bind loaders to types; it doesn't ship entity loaders themselves.

**Editor treatment.** `getReference("featured", "product")` tells the editor to render a picker widget keyed by the `type` string. Picker widgets per type are registered in a widget registry (see `CMS_EDITOR.md §Entity picker widgets`).

## Slot accessors — `<Children>` and `<Child>`

Composition primitives. Replaces the earlier `<Area>` sketch.

```tsx
<Children name="below-hero" allow=".product-context" />
<Child    name="primary-cta" allow=".cta" />
```

Each declares a slot in the Partial's manifest:

- `<Children>` — ordered list of blocks.
- `<Child>` — at most one block.
- `allow` — a Partial-selector expression; the slot accepts blocks whose own selector satisfies the `allow` constraint.

This is the Shopify sections + blocks pattern, expressed in the existing selector grammar. Slots are recursive: blocks inside slots can themselves declare slots, without limit. The mega-menu case from the design conversation is exactly this — the menu is a Partial with a `<Children>` slot holding menu-item blocks, each of which can itself hold a `<Children>` slot of submenu items.

At render time, each slot reads from the CMS store the list of blocks currently contributed to it, renders each as a `<Partial>` with the block's saved selector + fields. Drag-drop in the editor works via these declarations (validated against `allow`; see `CMS_EDITOR.md §Drag-drop`).

## Context-consume — `getClosest` and `provides`

`<Partial provides={…}>` attaches context values to the parent chain:

```tsx
<Partial
  parent={ROOT}
  selector="#pdp"
  provides={{ product: await fetchProduct(slug) }}
>
  <ProductDetail />
</Partial>
```

Descendants read via `getClosest<T>(key: string): T | null` — walks `PartialCtx.provides` outward and returns the first match. The `parent` token is already threaded reliably across async boundaries (that's why it's explicit rather than ambient), so `getClosest` is as reliable as the parent chain, which is the most reliable tracking mechanism in the codebase.

`getClosest` records into the context-consume section of the manifest. It does **not** scope configuration — the config axes come from whatever request state the ancestor read to produce the context value. Editor shows it as "this block inherits X from an ancestor that provides it."

## Configuration scoping — CSS cascade for CMS

The load-bearing insight of the April 2026 sessions. A Partial's configuration space is dimensioned by its request-input manifest. Storage looks like:

```jsonc
{
  "id": "p_a8f3",
  "displayName": "#product-hero",
  "configs": [
    {
      "match": { "url:pokemon:id": { "in": [1, 2, 3] } },
      "fields": { "headline": "Grass starters" },
    },
    {
      "match": { "pathname:/p/:slug": { "slug": "pikachu" } },
      "fields": { "headline": "Gotta catch 'em all" },
    },
    { "match": {}, "fields": { "headline": "Welcome" } },
  ],
}
```

Resolution at render time:

1. Read the current request's values for every dimension in this Partial's request-input manifest.
2. Find all configs whose `match` clause is satisfied by those values.
3. Return fields from the most-specific satisfying config; fall back through less-specific configs for any unset fields (cascading inheritance).

### Specificity — v1: declaration order

The order in which accessors are first read during a successful render establishes the dimension priority. More-specific = matches higher-priority dimensions. Exact match (`"slug": "pikachu"`) beats a set match (`"slug": {"in": [1,2,3]}`) within the same dimension.

This is a simple, predictable rule for v1. Refinements (CSS-count-style specificity, explicit priority declarations, per-dimension weights) can come later without changing storage format.

### Inheritance — yes

A less-specific config's field is used if the more-specific config doesn't override it. Saves authors from restating unchanged values. Matches how CSS cascade, Magento store-views, and Drupal contexts all work.

### Falls-out-for-free properties

- **A/B tests.** A block reading `getSearchParam("abtest")` has `url:abtest` in its manifest. Configs can match specific variants. Authors toggle "configure for variant A" / "variant B" in the editor. No A/B feature; it's the same config model.
- **Localization.** Locale accessor → manifest dimension → per-locale configs. Editor's locale switcher sets the preview locale.
- **Personalization.** `getCookie("user_segment")` → per-segment configs.
- **Store views / multi-tenant.** `getHeader("x-tenant")` or `getCookie("tenant")` → per-tenant configs.

None of these are features. They're the same mechanic applied to different axes. Add a new axis by reading a new accessor.

## Storage shape — recursive Partials

Every Partial-shaped node in the store has the same shape — top-level page, nested block, deeply-nested item:

```jsonc
{
  "id": "p_a8f3",
  "type": "product-hero",        // component identifier; omitted for code-declared Partials
  "displayName": "#product-hero",
  "configs": [
    { "match": {...}, "fields": {...} }
  ],
  "slots": {
    "below-hero": [
      { "id": "p_b7c1", "type": "reviews",   "configs": [...], "slots": {...} },
      { "id": "p_c3e4", "type": "rich-text", "configs": [...], "slots": {} }
    ],
    "sidebar": [ ... ]
  }
}
```

The CMS store is a forest of these trees, keyed by root `cmsId`. The runtime reads the tree for the current route + template, resolves configs against the current request, renders blocks. Deeply recursive: the menu inside a frame inside a layout inside a page, all the same shape.

**Storage medium — v1.** A single committed JSON file (`src/cms/content.json` or similar). Cheap, git-versioned, adequate for demos. Later: a real store with indices, revisions, concurrent-edit handling.

## Entity-scoped vs Partial-scoped content

Two stores, one accessor surface. Name it explicitly so the distinction doesn't drift:

| Accessor                                                      | Store                                     | Why                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `getText`, `getEnum`, `getNumber`, `getImage`, `getRichText`  | Partial store (CMS JSON/DB)               | Field value is scoped to this Partial in this context. A reviews headline on the homepage ≠ the reviews headline on a product page. |
| `getReference` + `getProduct(ref)` / `getCollection(ref)` / … | Entity backend (Magento, Shopify, custom) | Entity data is canonical across all appearances. A product's name lives on the product, not on each reviews block referencing it.   |

The Partial store is what the CMS editor owns. The entity backend is read-only from the CMS's perspective (unless the app also exposes entity management, which is separate scope). The accessor surface makes both feel uniform to the block author: call accessors; the framework + loaders route to the right place.

**Don't let the partial store drift into trying to be an entity store.** If authors want to add "our custom attributes" to products, route through the entity backend's custom-attributes feature, not the CMS JSON. The CMS stores presentation-local content; the entity store stores the entity's canonical data. Blurring this boundary rebuilds the Magento 2 mistake.

## `cmsId` — the stable id

Each Partial instance in the store needs a stable id surviving selector renames, file moves, and tree rearrangement. The framework already has `<Partial>` effective ids (from selectors), but those are intentionally mutable presentation tokens.

**Design:** a `cmsId` prop, author-set, lives on `<Partial>` alongside `selector`. The id is the storage anchor; the selector is the display/addressing token; renaming the selector is a pure UX change — content comes along automatically.

```tsx
<Partial parent={ROOT} selector="#product-hero" cmsId="p_a8f3">
  <ProductHero />
</Partial>
```

For code-declared Partials, the author writes the `cmsId` once on creation. For block instances inside slots, the editor generates the id when the block is added and stores it alongside the instance (the `id` field in the storage JSON). Blocks moved between slots retain their id; content comes with them.

**Alternatives considered:**

- **Derive from selector token** — breaks on rename. Rejected.
- **Derive from file path + component name** — breaks on file move. Rejected.
- **UUID per declaration, stored in `.cmsIds.json`** — workable but invisible in source. Possible future refinement.
- **Explicit `cmsId` prop** — visible, author-controlled, diff-friendly. **Pick.**

The constraint that used to force derivation ("we have no persistent store") is gone now that the CMS exists. Storage anchors can be explicit.

## First-render rules

- Every accessor must resolve to SOMETHING on first render — empty string, zero, false, `values[0]` for enums, empty array for slots. No throw.
- **Hoisting rule.** Accessors must be called unconditionally at the top of a component body, before any `await`. Same rule as cache-manifest and frame-scope. `HoistingViolationError` on drift.
- First render of a fresh block instance populates the field manifest; the editor uses it to generate the form.

## Block global registry — the catalog

The editor needs to know "what blocks exist" to populate the palette for a slot. Two concerns:

1. **Block catalog.** A manifest file (`src/blocks/catalog.ts`) exports the list of block types — their component reference, selector(s), `type` tag, presets if any. Dev-time: can be auto-generated by globbing `src/blocks/**/*.tsx`; committed for prod so unused blocks tree-shake.

2. **Field-manifest discovery.** To show form fields for a block BEFORE an instance exists, render each block type once at dev startup with empty context and capture its field manifest. Cache the result. Re-run on HMR. The editor reads the cached manifests to render palette previews and initial forms.

Prerender catalog build is a pure dev-time operation — no runtime cost in production. The cached manifest is effectively part of the dev-build output.

## Presets — deferred

Shopify-style "named starting configurations" per block (`default`, `compact`, `featured`) are a useful author-facing concept but not required for v1. When shipped, they're tiny static exports next to each block:

```tsx
export const presets = {
  default: { headline: "Welcome", count: 6 },
  compact: { headline: "Reviews", count: 3 },
};
```

When a block is added from the palette, the author picks a preset (or skips, for empty). The preset values populate the block's first config. No changes to the runtime or storage model.

## What this enables — checklist

- ✅ Block authors write accessor-based blocks; no schema file.
- ✅ Editor renders forms from the runtime manifest.
- ✅ Configuration scope is dimensioned by the same manifest that scopes caches.
- ✅ A/B, localization, personalization all fall out of adding the relevant accessor.
- ✅ Drag-drop between slots with selector-based validation.
- ✅ Entity references vs local content are both typed and visible to the editor.
- ✅ Ancestor context via `provides` + `getClosest` composes recursively.
- ✅ Rename-safe via `cmsId`.

## Related notes

- `AUTO_TRACKED_CACHE_KEYS.md` — the predecessor manifest design, unchanged for cache keys.
- `PARENT_CONTEXT.md` — the `parent` prop / `PartialCtx` / `capturePartialContext` that `provides` extends.
- `SELECTOR_API.md` — selector grammar reused for `allow` on slots.
- `CMS_VISION.md` — why this direction; what problem it solves.
- `CMS_EDITOR.md` — the authoring UI built on this foundation.
