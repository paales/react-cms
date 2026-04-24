# CMS editor — the debug panel, expanded

**Added:** 2026-04-25
**Status:** MVE shipped 2026-04-25 (chunk 3) — tree + preview + field form + save + publish. Per-config tabs, block palette, drag-drop, entity pickers, draft isolation still deferred. Runtime underneath (chunk 1 content accessors + resolver, chunk 2a slots, chunk 2b provides/getReference, chunk 3 draft/published + catalog prerender) shipped 2026-04-25. Companion: `CMS_VISION.md` (why), `CMS_MANIFEST.md` (data model).

---

## One-liner

The editor is the existing `<PartialsDebug/>` overlay expanded with forms + drag-drop, rendering the site being edited inside a `<Partial frame="preview">` with the draft cookie set. No new runtime, no iframe, no parallel architecture. The debug panel already enumerates Partials, knows their selectors, their parent chain, and their frame scopes; the editor extends it with CMS manifest sections and an invalidation-driven save loop.

## Layout — Shopify-inspired three-pane

Following the Shopify theme editor shape, which works because it matches the mental model (structure / preview / details):

| Pane | Role | Source of truth |
|---|---|---|
| Left sidebar | **Structure tree.** Hierarchy of Partials on the current page. Expandable. Shows slot contents nested under their host Partial. Click to select. | Route-scoped registry, grouped by `parentPath`. |
| Center | **Preview.** The site being edited, rendered live inside a `<Partial frame="preview" frameUrl="/the/page">`. Navigable — the author moves between pages by navigating the frame. | Actual render, served through the normal RSC pipeline, with draft cookie set. |
| Right sidebar | **Fields.** Form for the selected Partial: content fields, references, slot contents, and "varies by" dimensions from the request-input manifest. Tabbed per configuration match. | CMS store for the selected Partial. |

No on-canvas drag-drop initially. Selection is click-on-preview (the preview frame's click handler identifies the hit Partial and highlights it in the tree). Reordering/adding/removing blocks happens in the tree sidebar.

## Preview via `<Partial frame="preview">`, not an iframe

The framework primitive already does the job:

```tsx
<Partial
  parent={ROOT}
  selector="#preview"
  frame="preview"
  frameUrl="/products/bulbasaur"
>
  <SitePreview />
</Partial>
```

- The preview's navigation is independent — authors navigate inside the frame without affecting the editor's own URL.
- The frame's session carries a `cms-draft=<id>` cookie that blocks read via `getCookie("cms-draft")`; that cookie dimensions CMS storage to the draft tree.
- No postMessage, no double rendering, no cookie-isolation workarounds. Same React tree as the editor chrome.
- DevTools stay one-level — no "switch context to the iframe."

### Container queries, not viewport media queries

The preview pane's width ≠ the browser viewport width. Any block that uses `@media (max-width: …)` will render incorrectly in the editor (it thinks it's on a desktop because the viewport is). Block authors must use CSS container queries (`@container`). Ship this as:

- A documented constraint in the block-author guide.
- A dev-time HMR warning when `@media` appears inside a block file.
- A lint rule if practical.

### Future iframe escape hatch

If a scene ever needs security or cookie isolation from the editor (embedding third-party content, cross-origin flows), add a `<Partial iframe>` primitive alongside `frame` with its own security semantics. Explicitly not a v1 concern — the frame primitive covers every current use case.

## Selecting a Partial

Click anywhere in the preview → message bubbles to the editor chrome → tree highlights the hit Partial → field sidebar loads its manifest + current configs. DOM-level hit testing: every Partial already emits a `data-partial-id` marker (via `<PartialErrorBoundary>` or the skip-placeholder); the preview's click handler walks up from the click target to find the nearest one.

Selecting a slot (clicking in the gap between blocks, or on a slot-header in the tree) — not a Partial — shows the slot's `allow` grammar and an "add block" affordance in the sidebar.

## Field sidebar — per-configuration tabs

A Partial's manifest tells the editor:

- Which content fields it reads (→ form inputs)
- Which references it reads (→ entity pickers)
- Which slots it declares (→ drop zones shown in-tree, summary in sidebar)
- Which request-input dimensions it reads (→ configuration match tabs)

If the Partial reads `getPathname("/p/:slug")` and `getSearchParam("abtest")`, the author sees tabs like:

```
[ All ] [ slug=bulbasaur ] [ slug∈{1,2,3} ] [ + Add slug override ]
  [ No variant ] [ variant=A ] [ variant=B ] [ + Add variant ]
```

Each tab corresponds to a `match` clause in storage. Switching tabs switches which config the form writes to. Inheritance from less-specific tabs is indicated in the form (greyed defaults; explicit overrides highlighted).

## Save protocol — using the existing invalidation graph

Author edits a field in the right sidebar → debounced save fires a server action → action writes to the draft store → action returns `{ invalidate: { selector: "#product-hero" } }` → existing refetch pipeline re-renders that Partial in the preview frame → author sees the change.

**Nothing new.** The entire authoring loop uses mechanics that already exist:
- Server actions for persistence.
- Server-action-return `invalidate` directive for cache invalidation.
- Selector-based refetch for surgical updates.
- Cookie-driven accessor (`getCookie("cms-draft")`) for draft vs published.
- Tracked accessor → cache key folding, so the draft/published split participates in cache keys automatically.

## Drag-drop — structure only, in the tree sidebar

Blocks are reorderable within a slot and movable between slots, subject to each slot's `allow`:

- Drag from slot A → drop in slot B. Editor validates B's `allow` against the block's selectors. If not allowed, reject with a tooltip ("slot 'sidebar' accepts `.widget`; this block is `.product-card`"). If allowed, write new ordering to store for both slots, invalidate both.
- Reorder within a slot: update the slot's ordered contents, invalidate.

**On-canvas drag-drop** (drag directly in the preview frame) is deferred. Click-to-select in the preview + reorder in the tree sidebar is simpler to implement, has fewer edge cases, and matches how Shopify works today. Revisit if authors ask.

## Block palette — adding new blocks

When the author clicks "add block" on a slot, the editor shows a palette of block types whose selectors satisfy the slot's `allow`. Palette entries come from:

- The **block catalog manifest** (`src/blocks/catalog.ts`). Static list of block types with their `type` tag, selector(s), and presets.
- **Cached field manifests** (from the dev-time prerender pass). Used for palette card previews and initial form rendering.

Filter by `allow` is client-side: `catalog.filter(b => b.selectors.some(s => satisfies(s, slot.allow)))`.

**Adding a block:** generate a `cmsId`, push `{cmsId, type, configs: [], slots: {}}` into the slot's ordered contents, apply preset if selected, invalidate the slot's host Partial. The new block renders with preset values (or empty), manifest populates, sidebar shows its form.

## Entity picker widgets

`getReference(name, "product")` in a block → editor shows a "product" picker in the field sidebar. Picker UI per type is registered in a widget registry:

```ts
registerPickerWidget("product",    ProductPickerComponent);
registerPickerWidget("collection", CollectionPickerComponent);
```

Widgets are userspace — a Magento app registers pickers that hit GraphCommerce; a Shopify app registers pickers that hit Storefront API; a headless CMS registers pickers that hit its own entity store. The framework ships the registry mechanism and a simple "paste an ID" fallback widget for any type without a registered picker.

## Draft and published — cookie-driven

Two stores (or one store with draft + published fields per entry):
- **Draft.** Written by the editor on every save. Read when `cms-draft=<id>` cookie is set.
- **Published.** Read when the cookie is absent. Updated by the "publish" action, which copies (a subset of) draft → published.

Blocks read the store via the CMS runtime. The runtime reads the cookie (via `getCookie("cms-draft")` — tracked, participates in cache keys); forks the storage lookup accordingly; the rest is identical.

Published reads can be aggressively cached (`<Partial cache>` per-Partial with a `.published` shared token for global invalidation on publish). Draft reads bypass cache since authors are iterating rapidly.

## What's deferred — roadmap, not v1

Explicit list so nobody rebuilds these expecting them to exist.

- **Inline editing via `<Text>` / `<RichText>`.** Click text in the preview → edit in place with optimistic local rendering. The plumbing exists (cookie-driven draft, targeted refetch); the UX is real work.
- **On-canvas drag-drop.** Drag blocks directly in the preview pane. More complex hit-testing; Shopify doesn't bother.
- **Publishing workflow.** Review stage, multi-author review, scheduled publishes. v1: save → publish is one button.
- **Versioning and rollback.** v1: git history (the big JSON file is committed).
- **Multi-author concurrent editing.** v1: single-author editor; concurrent edits collide.
- **Entity management** (creating products, etc.) — out of scope. Entity backends own this.
- **Modules contributing blocks into shared slots** (the M1 `layout_default` merge analog). Waits on a contribution-protocol design. See `CMS_VISION.md § What this framework has already rebuilt`.
- **Presets.** See `CMS_MANIFEST.md § Presets`.
- **`<Partial iframe>`** for security-isolated preview or embedded third-party content.

## Implementation sketch — where the code lands

| Piece | File |
|---|---|
| Editor route | `src/app/pages/editor.tsx` (new) |
| Tree sidebar | extends `src/lib/partial-debug.tsx` |
| Preview frame | `<Partial frame="preview">` inside editor route |
| Field sidebar | `src/app/components/cms-field-panel.tsx` (new) |
| CMS store (v1: big JSON file) | `src/framework/cms-store.ts` (new) |
| Draft save server action | `src/app/cms-actions.ts` (new) |
| Content accessors (`getText` etc.) | `src/framework/context.ts` (extend) |
| `<Children>` / `<Child>` primitive | `src/lib/slot.tsx` (new) |
| `provides` prop on `<Partial>` | `src/lib/partial-component.tsx` (extend) + `partial-context.ts` (extend `PartialCtx`) |
| Block catalog | `src/blocks/catalog.ts` (new) |
| Dev-time field-manifest prerender | `src/framework/cms-prerender.ts` (new) |
| Picker widget registry | `src/framework/cms-widgets.ts` (new) |
| Manifest-section split (5 kinds) | `src/framework/context.ts` (refactor `ManifestScope`) |

Nothing requires changes to the RSC pipeline, the Flight runtime, or the navigation surface. Every extension point is additive.

## Build order — suggested sequence

1. **Split `ManifestScope` into five sections.** Pure refactor; cache keys still read only `requestInputs`. Everything else empty until later steps fill them.
2. **Add content accessors.** `getText` / `getEnum` / `getNumber` / etc. Wired to the content-field section; reading from a stubbed in-memory store.
3. **Add `<Children>` / `<Child>`.** Slot declarations record into the child-slot section; at render time they read the store and render contributed blocks as `<Partial>`s.
4. **Add `provides` + `getClosest`.** Extend `PartialCtx`; thread through existing parent-token plumbing.
5. **Add `getReference` + one loader (`getProduct`).** Prove the reference flow end-to-end with PokeAPI or Magento product data.
6. **Big-JSON-file store + draft cookie.** Stub the CMS persistence; wire draft-vs-published via cookie accessor.
7. **Block catalog + prerender pass.** Dev-time manifest capture for each block type.
8. **Editor route, preview frame, tree sidebar (extend debug panel).** Selection wired; no editing yet.
9. **Field sidebar with form rendering from manifest.** Save via server action + `invalidate`. Single-config editing first.
10. **Configuration tabs for request-input dimensions.** Per-match editing with cascade.
11. **Palette + add-block.** Block-type selection constrained by `allow`.
12. **Drag-drop between slots.** Constraint validation on drop.

Each step is independently testable (the testing tiers in `TESTING_ARCHITECTURE.md` cover all of it) and each lands a visible capability. No big-bang merge.

## Related notes

- `CMS_VISION.md` — why this direction.
- `CMS_MANIFEST.md` — the data model.
- `FRAMES.md` — the frame primitive the preview uses.
- `SELECTOR_API.md` — selector grammar for `allow`.
- `PARTIAL_ARCHITECTURE.md` — the partial registry the tree sidebar reads.
- `NAVIGATE_UNIFIED.md` — the invalidation-driven save loop runs on this.
