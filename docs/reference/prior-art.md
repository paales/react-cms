# Prior art

The pattern — pages composed of independently-rendered, addressable,
cacheable subtrees with targeted invalidation — is well-known
outside the React ecosystem. This doc names the systems the design
borrows from and the systems the React ecosystem mostly didn't
build.

The framework's claim is not novelty. It's that **RSC finally makes
this tractable in JavaScript**.

## Server-rendered composition platforms

The shape comes from systems that took "the page is composed of
named regions filled by independently-fetching, independently-
caching modules" seriously, decades ago.

**Magento 1.** `layout.xml` composed pages from named blocks;
modules contributed blocks via mergeable handle files
(`layout_default`, `catalog_product_view`). Each block had its own
`_construct` (data-loading) and `_toHtml` (render); Varnish + ESI
hole-punched the dynamic regions out of an otherwise-cacheable HTML
shell. Block-level cache keys, action-dispatched region refreshes,
contribution-point composition. The `<Partial>` primitive maps 1:1
onto the M1 block; `cache` maps onto Varnish ESI; selector
invalidation maps onto cache-tag invalidation.

**Drupal.** Render arrays + regions + blocks + contexts are still
the most architecturally complete extension model in web history.
Anything goes anywhere; cache contexts (per-user, per-locale,
per-URL) drive both invalidation and key derivation. The
manifest-as-cache-key idea in `cache.md` is the same insight as
Drupal's cache contexts, rephrased.

**WordPress, TYPO3, Sitecore, AEM.** Same shape, varying complexity.
Page = template + regions; modules contribute blocks; per-block
caching with named invalidation tags.

What this framework borrows: the unit of composition is the
_block_; the unit of caching is the same _block_; the unit of
invalidation is the same _block_. One mental model, three reuses.

What this framework doesn't have yet: a contribution mechanism that
lets module A insert a block into module B's slot without module B
importing module A. Drupal-style contribution-by-discovery is a
follow-up flagged in `notes/IDEAS.md` (the M1 `layout_default` merge
analog).

## Edge fragment composition

A separate lineage: render the shell once, hole-punch the dynamic
parts at the edge, fill them in independently.

**Varnish + ESI.** The `<Cache>` strip-on-store + reinject-on-return
pattern in `framework/src/lib/cache.tsx` is ESI hole-punching done in-process
instead of at the edge. The bytes are stored with placeholders;
live partials reinject on the way out.

**Zalando Mosaic, Finn.no Podium, OpenTable OpenComponents.** Each
solves "compose a page from fragments coming from different origins,
each with its own lifecycle, cache, and deploy cadence." The
deployment-unit angle in `notes/IDEAS.md` (a Partial that lives in
a different process) is structurally the same problem.

**Hotwire Turbo Frames.** Probably the closest to the runtime shape
of `<Partial frame>`. Each frame is a mini-browser: its own URL, its
own navigation, its own back stack. Frames navigate independently;
a click inside a frame stays inside that frame. The differences:

- Turbo Frames are HTML custom elements. `<Partial frame>` is a
  pure RSC construct — the frame boundary is a scope-cell mutation,
  not a DOM element.
- Turbo Frames have one URL axis (the frame's own); browser
  back/forward operates across frame URLs uniformly. `<Partial
frame>` has two axes — browser history (page URLs) and per-entry
  `__frameHistory` (frame URLs scoped to each browser entry) — so
  drawer-shape frames don't pollute browser back.
- Turbo doesn't have a built-in invalidation graph. `<Partial>` does
  (selector tokens, server-action `invalidate`).

## JS frameworks that gestured at this

Most React-ecosystem frameworks have parts of the shape. None
finish it.

**Gatsby.** Source plugins worked well; theme shadowing was
override-not-contribution. Build-time-everything killed the business
before the contribution model matured.

**Astro.** Component islands + integrations are partial. Slots are
JSX-scoped (build-time), not runtime named-extension-points; the
framework's own integration API is the closest thing to a
contribution model in the ecosystem. Could land at a similar place
eventually.

**Nuxt layers.** A layer is "another Nuxt project that merges into
yours by convention." Probably the closest thing to a contribution
model anywhere in JS. Vue-only.

**Piral.** Explicit pilet-into-slot micro-frontend model. The shape
is right; the deployment surface is enterprise-only and the
ecosystem stayed niche.

**Remix / Next App Router / Redwood / Blitz.** Outlet-based
composition. Layouts wrap pages, pages render route segments, no
named extension points the way Drupal or M1 had. The "outlet" is
a single child slot per layout, structurally one position; you
can't have a layout declare three named regions and let a different
module fill each.

**Hotwire / Stimulus.** Not React. Closest _behaviorally_ to what
this framework does (Turbo Frames + Turbo Streams as the
invalidation channel). Missing the in-process render pipeline (its
fragments cross HTTP boundaries) and the strongly-typed manifest.

**Inertia.** Lazy partials and partial reloads via `only` /
`except` props on the Inertia visit object. This framework's
selector-targeted refetch is structurally the same idea, applied to
RSC subtrees rather than serialized server props. Inertia's
`reload`-with-progress events are a flat-out better DX than what
ships here today; flagged for follow-up.

## Liquid and the Shopify theme editor

Worth its own section because the editor in `docs/cms.md` borrows
the layout (tree / preview / fields) directly.

**Shopify Liquid.** Synchronous, intentionally limited template
engine. Data loading is array-access on a fixed root scope; you
can't write a query, the template language compiles to a known
graph and the data layer fills it. The whole "graph traversable
from the root" stance buys two things:

- You can't break it. No waterfall, no dependent data loading, no
  N+1 by accident.
- Rendering is fast enough that a light cache is sufficient.

The cost is that every dynamic data dependency has to be expressible
in the predefined graph. Asynchronous custom queries aren't
possible; client-side hydration is a separate world. This framework
takes the opposite position — async server components are
first-class, manifest tracking handles the cache key surface, and
the data layer is hand-written GraphQL rather than a constrained
query graph. The structural promise (no waterfalls because the
framework can see the dependency graph) is gone, replaced by a
softer one (you write `await`, you own the latency).

**Shopify theme editor.** Three-pane layout (sections panel /
preview / fields), drag-drop inside named sections, configuration
schema per section type, draft / published split. The editor in
`cms/src/editor/` borrows the layout and the draft semantics. It
doesn't borrow:

- Schema files. Accessor reads ARE the schema; the catalog
  prerender captures the field manifest at render time.
- The sections-and-blocks two-tier hierarchy. Block slots are
  recursive; arbitrary depth, same primitive at every level.
- The template-language constraints. Blocks are server components;
  full async, full data-loading, full type inference.

## What's distinct in this framework

Not novel; the combination is uncommon.

1. **The Partial primitive does one of every job.** Render unit,
   cache unit, invalidation unit, fingerprint unit, CMS storage
   unit, frame unit. One JSX wrapper opens scopes for all of them.
   Most prior systems split these (M1: blocks for render, ESI for
   cache, layout-xml for composition; Drupal: render arrays for
   render, cache contexts for cache, configuration entities for
   storage).

2. **Runtime discovery, not static analysis.** No build-time
   manifest of available blocks; no schema files; no codegen.
   `ReactCms.partial(...)` self-registers in the catalog at
   module-init when it declares `tags: [".x"]`; the prerender
   introspects each spec by invoking its `vary` once with a stub
   request. Adding a new block type is one component file + one
   `ReactCms.partial(...)` call — the editor's palette picks it up
   on the next HMR.

3. **The cache key is what `vary` returns.** Every per-spec
   dependency on the request, route, or CMS lives in a single sync
   `vary` callback whose return value IS the cache-key surface.
   Drupal had this conceptually (cache contexts); this framework
   makes the read pattern the literal source of the key, evaluated
   at the spec's body, no manifest cell or hoisting rule needed.

4. **One client navigation surface.** `useNavigation()` is a typed
   superset of `window.navigation`. Page nav, frame nav, and
   targeted refetch are all `navigate(url, options)` with
   different option fields. No second client API to learn.

5. **State lives in URLs.** No client→server prop-override channel.
   Page URL for shareable, frame URL for subtree-scoped. The
   combination of tracked accessors + URL-driven state means a
   Partial's render is reproducible from its URL alone — refresh
   the page, get the same scene back.

## What's missing

- **Contribution mechanism.** Modules contributing blocks into
  shared slots without the slot owner importing them. The M1
  `layout_default` merge analog. Filed in `notes/IDEAS.md`.

- **Static export.** The manifest could drive a build-step that
  prerenders routes and shells out only the dynamic Partials.
  Astro-shape "islands of dynamism in a static shell." Aligned
  with the project name; not built.

- **Distributed runtime.** Each Partial in a different process /
  worker / CDN edge. The strip-and-reinject mechanics already
  support this structurally — the outer cached bytes can come from
  anywhere. Filed; not built.

- **Cache invalidation by manifest value.** "Invalidate every
  cache entry that read `cookie:user_id=42`." Falls out nearly for
  free from the tracked-accessor manifest; not wired.

## Why React doesn't have this

Four structural reasons, in order of impact:

1. **Library, not platform.** React's founding stance was that the
   extension primitive is `import`. Everything else is convention.
   Deliberate; it's the reason ecosystem composition never got
   standardized at the framework layer.

2. **The bundler era.** Serving JS meant compiling it; plugin-
   contributed blocks had to be in the bundle at build time;
   "plugin architecture" became "code-splitting strategy," solved
   incompletely. PHP had no bundle. RSC restores runtime module
   resolution server-side.

3. **Vertical-integration bets.** Next, Gatsby, Remix all chose to
   be the whole thing. Rational for the vendor; hostile to
   ecosystem formation. You don't need extension points if you plan
   to ship every feature yourself.

4. **No economic engine for plugins.** Magento, Drupal, and
   WordPress grew on agencies that made money building extensions.
   React's economic gravity was product companies; product
   companies build vertical apps, not plugins. The plugin economy
   never formed, so the architecture for it never had to.

Cultural tell: React devs fork-and-switch; Magento devs
observe-and-override. The instinct follows the technology.
