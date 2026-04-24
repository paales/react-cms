# CMS vision — where this framework is going

**Added:** 2026-04-25
**Status:** direction landed; **chunk 1 shipped 2026-04-25** (content accessors + resolver + `cmsId` + demo page — see §First milestone below). Editor + composition primitives still design-sketch. Companion docs: `CMS_MANIFEST.md` (technical data model), `CMS_EDITOR.md` (authoring UX).

---

## One paragraph

The primitives this project has built — `<Partial>` + `<Partial cache>` + tracked accessors + frames + selector-based invalidation + client-owned template — are structurally the same primitives Magento 1 had with blocks, `layout.xml`, block-level ESI, and action-dispatched region refreshes. That alignment isn't an accident; it's what happens when you take "pages composed of independently re-renderable, addressable, cacheable, targeted-refetchable regions" seriously on RSC. With those primitives in hand, the next honest step is to make them author-editable — expose the Partial as a CMS unit without adding a second subsystem. This doc captures the why and frames the two companion docs that describe how.

## Origin — lessons from headless-commerce history

Context captured from the design sessions in April 2026. The author has spent ~a decade building headless storefronts — GraphCommerce (Magento 2) author, deep time in Magento 1 Luma, Varnish + ESI hole-punching, the Knockout-era mess. The pattern across those systems:

- **Magento 1 was the golden age.** Not elegant, but coherent: thin controller sets up context; `layout.xml` composes blocks (mergeable from multiple modules via `layout_default`, `catalog_product_view`, etc.); each block owns its data + cache-key + render; Varnish caches the page with ESI holes for dynamic regions. The architecture scaled to enormous modules and a large agency ecosystem because the seams were clear.
- **Magento 2** ambition outran execution: UI components on Knockout + a RequireJS data loader never shipped production mode, every M2 project was slow forever, the "improvement" fractured the coherent-render story. The project was functionally a failure before it released.
- **GraphCommerce on Next.js** (getStaticProps + useQuery + MUI): two worlds with split responsibilities (server = static, client = session), custom AJAX endpoints to bridge them, and genuine complexity marrying a personalized partly-static product list with session-specific pricing. The stack was "the latest and greatest" and still couldn't close the seam.
- **Shopify** owns end-to-end (Liquid + theme editor + hosting), which lets them deliver great authoring UX — but the ecosystem is second-class ("apps"), Liquid isn't extensible, and the theme-editor/framework boundary is hard-coded inside the platform. Moving to Remix + headless fragmented the theme story.

The durable lesson: **frontend and backend are not two separate concerns connected by an API; they are one rendering pipeline with different latencies.** M1 got this right by accident; modern JS frameworks have been trying to re-split it by choice. RSC makes undoing that split tractable, and the Partial architecture is what it looks like when you actually do.

## What this framework has already rebuilt

Intentionally or not, the primitives below are 1:1 successors of M1 architectural pieces:

| Magento 1                                        | This codebase                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| Block class (`_construct` + `_toHtml`)           | `<Partial>` body (data + render)                    |
| Block name                                       | `selector` (`#foo` / `.foo`)                        |
| Varnish + ESI TTL                                | `cache={{maxAge, staleWhileRevalidate}}`            |
| Hole-punching for dynamic regions                | `<Partial cache>` strip+reinject (`cache.tsx`)      |
| Cache tags                                       | `.shared` token invalidation                        |
| Action dispatcher refreshing regions             | Server action `return { invalidate: { selector } }` |
| Thin controller + layout handle                  | `Root` + `pickRoute` + `PartialRoot`                |
| `layout_default` / `catalog_product_view` merges | **— missing —**                                     |
| Named area (`<reference name="sidebar">`)        | **— missing —**                                     |

The first eight rows are already shipped. The last two — composition from multiple sources + named extension points — are what made M1 a platform rather than an application, and they're the single biggest architectural gap. Filed under future work; not required to ship the CMS core.

## What RSC actually changed

Why this is worth trying now and not five years ago:

1. **Runtime composition is cheap again.** A Partial contributed by a module the page author never imported can be rendered because RSC resolves modules at request time server-side. Bundle pre-resolution isn't required. M1's layout merge was cheap for the same reason PHP had no bundle.
2. **Block-level caching + hole-punching is a transport concern.** `<Partial cache>` is ESI without an edge server. Authors don't plumb cache invalidation; selectors do it.
3. **Server components erase the "data layer vs render layer" split.** A Partial owns its fetching. A contributed block owns its fetching. No "integrate with my Apollo cache" negotiation.
4. **Actions + invalidation graph** mean a mutation can invalidate regions without the page author wiring it up. Async-native observer pattern.

Previous JS framework attempts got one or two of these. RSC is the first substrate where you can have all four.

## Prior art — brief

Server-rendered composition platforms (Drupal, Magento, WordPress, TYPO3, Sitecore, AEM) solved this 10-20 years ago. Drupal's render-arrays + regions + blocks + contexts is probably the most architecturally complete extension system in web history.

Fragment/hole-punching at the edge (Zalando Mosaic, Finn.no Podium, OpenTable OpenComponents, ESI/Varnish, Hotwire Turbo Frames) nailed the transport layer.

IDE-pattern extension (Eclipse, VS Code, Emacs) is the canonical formal statement of the contribution-point pattern.

JS attempts got partial shape but never crossed the chasm:

- **Gatsby** — source plugins worked, theme shadowing is override-not-contribution, build-time-everything killed the business before the ecosystem landed.
- **Nuxt layers** — probably the closest in JS (a layer is another Nuxt project that merges into yours by convention). Vue-only.
- **Astro integrations** — build-time plugin API, slots are JSX-scoped. Might get to named extension points eventually.
- **Piral** — explicit pilet-into-slot micro-frontend model. Enterprise-only, niche.
- **Remix / Next / Redwood / Blitz** — outlet-based composition, no named extension points, no contribution model.
- **Hotwire / Turbo** — structurally nearest to what this codebase does; missing the invalidation graph.

The executive summary: **the pattern is well-known; nobody has it in the React ecosystem; RSC is the thing that unblocks it.**

## Why React doesn't have this — four structural reasons

1. **React's founding stance: library, not platform.** The extension primitive is `import`. Everything else is convention. Deliberate, load-bearing, and the reason ecosystem composition never got standardized.
2. **The bundler era (2014-2022).** Serving JS meant compiling it. Plugin-contributed blocks had to be in the bundle at build time; "plugin architecture" became "code-splitting strategy," solved incompletely. PHP had no bundle.
3. **Vertical-integration bets.** Next, Gatsby, Remix all chose "be the whole thing." Rational for the vendor, hostile to ecosystem formation — you don't need extension points if you plan to ship every feature yourself.
4. **No economic engine for plugins.** Magento/Drupal/WordPress grew on thousands of agencies who made money building extensions. React's economic engine was product companies; product companies build vertical apps, not plugins; the revenue gravity was never there.

The cultural tell: React devs fork-and-switch, Magento devs observe-and-override. The instinct follows the technology.

## The direction we're taking

Three candidate paths surfaced in the design sessions:

- **(A) Framework-as-library** — narrow to a clean primitive (`<Partial>`, `useNavigation`, the accessor surface), ship as an npm package; let apps compose on top. Most realistic adoption path.
- **(B) Framework-as-distributed-runtime** — lean into remote Partials / deployment-unit split; a page is a coordinated fetch across N origins. Most architecturally novel claim. The strip+reinject mechanics in `cache.tsx` already support this structurally.
- **(C) Framework-as-CMS** — honor the repo name. Partials + accessor-tracked manifest + selector invalidation already give 70% of a CMS runtime. Layer draft/preview/editable-regions on top. Under-served niche; fits the primitive better than anyone else's.

We're picking **(C)** as the first real milestone. B and C share infrastructure (per-Partial boundaries with independent lifecycles) so B isn't foreclosed; A falls out as the publishable form of whatever we converge on. Practically: build the CMS-native layer, prove the primitive, then extract.

## The core technical insight

This is the thing that made the design fall into place in the 2026-04-24/25 sessions: **the manifest that already drives cache keys also drives CMS configuration.**

A Partial's cache key is derived from the tracked accessors it reads (`getCookie`, `getSearchParam`, `getPathname`). Those same accessor reads define the **dimensions of the configuration space** for that Partial. A menu that reads no request state has one global configuration. A product hero that reads `getPathname("/p/:slug")` has per-slug configurable fields. An A/B-tested block that reads `getSearchParam("abtest")` has per-variant configurations. Localization, personalization, store-view inheritance — all fall out of reading the relevant accessor.

Add content accessors (`getText`, `getEnum`, `getReference`) into the same manifest. First render populates the field list; the editor reads it to generate forms; storage keys off the accessor values. **No schema file needed.** Full details in `CMS_MANIFEST.md`.

This isn't a CMS bolted onto the framework. It's what you get when you expose the manifest the framework has been building toward from the start.

## First milestone — what "done" looks like

The framework is complete-enough-to-ship-demos when a dev can:

1. Write a page template with fixed `<Partial>`s and `<Children>` slots for editable areas.
2. Author CMS-editable blocks using accessor-tracked fields (`getText`, `getEnum`, `getReference`) — no schema file.
3. Open an editor route that shows the page in a preview `<Partial frame>`, a tree sidebar (Partial hierarchy), and a field sidebar (tracked-field forms).
4. Edit a field → save → the corresponding Partial refetches through the existing invalidation graph → preview updates.
5. Drag a block between `<Children>` slots, constrained by each slot's `allow` selector.
6. Toggle draft-vs-published via a cookie; the preview and production views diverge accordingly.
7. Scope a field by URL dimension (e.g. "this headline for slug ∈ [bulbasaur, ivysaur]") via manifest-derived specificity.

Nothing requires a new runtime — every mechanic reuses an existing primitive. The work (fully enumerated in `CMS_EDITOR.md §Implementation sketch`) is: extend the manifest with field/slot/reference sections; add content accessors + `<Children>`/`<Child>` + `provides`; build a block catalog; build the editor route on top of the existing debug panel.

### Chunk 2a — shipped 2026-04-25

Composition primitives + block registry. Items 1 (partly) and 5 (partly) from the list above.

- `src/framework/cms-runtime.ts` — block registry (`registerBlock` / `getBlockSpec` / `listBlockTypes` + `_clearBlockRegistry`), `BlockSpec` type, flat-index-backed `lookupCmsNode` so slot descendants resolve by `cmsId` the same way root nodes do.
- `src/lib/slot.tsx` — `<Children>` and `<Child>` slot primitives. Record the slot into the CMS scope's `childSlots` for future-editor introspection; look up each entry's type in the block registry; render as `<Partial cmsId={entry.id}>` wrapped in a keyed `<Fragment>` so the array key doesn't composite with Flight's inner Suspense key.
- `cmsFingerprintContribution` now recurses through `node.slots` — a host Partial whose own config is stable but whose slot children's configs vary per request gets a distinct fp so fp-skip doesn't serve stale slot bytes on nav.
- `src/app/blocks/{hero,rich-text,catalog}.tsx` — example block components + catalog. `HeroBlock` reads `headline` / `subhead` / `tone` via accessors; `RichTextBlock` reads `body`. Catalog wires the type tags.
- `src/app/root.tsx` imports the catalog for its side effect so the registry is populated before the first render.
- `src/cms/content.json` extended with `cms-demo-composed` — three heterogeneous entries in its `body` slot including a nested per-slug config on the third entry (demonstrates recursive cascade).
- Demo page extended with the composed section at `/cms-demo` and `/cms-demo/:slug`.
- Tests: 5 block-registry unit tests, 5 `<Children>` RSC tests (render order, nested cascade, per-entry `partialId` markers, unknown-type fallback, scope-gated), 3 Playwright specs covering composed rendering + per-slug cascade + client-side nav between slugs.

Known issue (pre-dates chunk 2a, observable on chunk 1 specs too): SSR of the `/cms-demo` page truncates the static slug-nav mid-render, producing a hydration warning on the client. The client re-renders the subtree correctly; tests pass. Tracking as follow-up; likely related to Flight chunk boundaries around the CMS-aware Partials that sit before/after the nav. Not a chunk-2a regression.

What chunk 2a does NOT yet include:

- `provides` / `getClosest` — no ancestor context inheritance (chunk 2b).
- `getReference` + entity loaders — no product pickers (chunk 2b).
- Block preset support — palette still empty.
- Dev-time prerender of block field manifests for the palette.
- The editor itself.

### Chunk 1 — shipped 2026-04-25

Items 2 and 7 from the list above, plus the underlying runtime:

- `src/framework/cms-runtime.ts` — mtime-cached JSON store loader, `resolveCmsNode` / `resolveCmsScope` cascade resolver, `cmsFingerprintContribution` for fp folding, shared `MatchClause` / `CmsConfig` / `CmsNode` types. Dep-free by construction (takes `Request` as an explicit arg), unit-testable in isolation.
- `src/framework/context.ts` — React.cache-backed `cmsScopeCell`, `_setCurrentCmsScope` / `getCurrentCmsScope`, and content-field accessors: `getText` / `getRichText` / `getNumber` / `getBoolean` / `getEnum` / `getImage`. Each accessor records the field into the CMS scope's `contentFields` map (future-editor introspection) and resolves lazily via the shared scope memo.
- `src/lib/partial-component.tsx` — new `cmsId` prop on `<Partial>`, cell mutation at the top of the body, fp folding via `cmsFingerprintContribution` so fingerprint-skip and `<Partial cache>` baseKeys both invalidate correctly on config-match changes.
- `src/lib/partial-registry.ts` — `PartialSnapshot.cmsId` so cache-mode refetches reconstruct the same CMS scope from snapshots.
- `src/cms/content.json` — v1 store committed at the top level; two demo entries exercising cascade (`cms-demo-hero` global config, `cms-demo-greeting` with `{in: [...]}` and exact-slug matches against `pathname:/cms-demo/:slug`).
- `src/app/pages/cms-demo.tsx` + routes `/cms-demo` + `/cms-demo/:slug` + nav link.
- Tests: 13 resolver unit tests in `src/framework/__tests__/cms-runtime.test.ts`; 6 in-process RSC tests in `src/lib/__tests__/cms-accessors.rsc.test.tsx`; 6 Playwright specs in `e2e/cms-demo.spec.ts` (including cascade resolution across client-side nav).

What chunk 1 does NOT yet include (deferred to subsequent chunks):

- `<Children>` / `<Child>` slot primitives — composition stays on code-declared children for now.
- `provides` / `getClosest` — no ancestor context inheritance.
- `getReference` + entity loaders — no product pickers.
- The editor — authoring is "hand-edit `content.json` and reload."
- Draft / published split — the cookie-driven fork is designed but not wired; today every read hits the committed file.
- Block catalog / prerender — no palette.

## Principles — the non-negotiables

These fall out of what the framework has proven load-bearing. Don't violate them when building the CMS layer.

1. **Runtime discovery over static analysis.** No schemas, no codegen, no build-time manifests for the CMS. Accessor calls ARE the schema; the manifest populates at render time; the editor reads it.
2. **One primitive, one mental model.** The Partial is the render unit AND the cache unit AND the configuration unit AND the editor unit. Never add a parallel mechanic; piggyback an existing primitive.
3. **Hoisting discipline.** Accessor reads must be unconditional at the top of a component body. Same rule for cache keys, frame scope, and CMS fields. One rule applied everywhere.
4. **Contributions, not overrides.** If modules ever contribute blocks into shared slots (the `layout_default` merge analog), model it as ordered contributions into declared slots, not as mutations of others' trees. Avoid the Deface trap.
5. **Code defines the grammar; data fills it.** Devs write the template + area declarations + block implementations (versioned, reviewed, typechecked). Authors edit CMS data that fills the grammar. **The editor never writes `.tsx` files.**
6. **Don't invent a third iteration primitive.** Curated lists = `<Children>` slots with a single allowed type. Data-driven lists = a block that fetches and maps over `.map + provides`. Both exist in the architecture already.
7. **No iframe for the editor.** The preview is a `<Partial frame="preview">`, not an iframe. Blocks must use container queries, not viewport media queries, since the preview pane's width ≠ viewport width. If cross-origin / security isolation is ever needed, add a separate `<Partial iframe>` primitive — don't make the editor depend on it.

## Related

- `CMS_MANIFEST.md` — accessor families, manifest sections, configuration scoping, storage shape.
- `CMS_EDITOR.md` — authoring UX, preview frame, tree + fields sidebars, drag-drop, palette.
- `PARTIAL_ARCHITECTURE.md` — the north-star doc for the current framework.
- `AUTO_TRACKED_CACHE_KEYS.md` — the manifest's predecessor design (cache-key-only).
