# Prior art

The pattern — pages composed of independently-rendered, addressable,
cacheable subtrees with targeted invalidation — is well-known
outside the React ecosystem. This doc names the systems the design
borrows from and the systems the React ecosystem mostly didn't
build.

The framework's claim is not novelty. It's that **RSC finally makes
this tractable in JavaScript** — and that a single primitive with
this lineage can hold the dynamic range a commerce stack needs end
to end, instead of splitting into a server-rendered catalog and a
separate client app at the checkout boundary (Liquid + Hydrogen,
Luma/Hyvä + a React checkout). See
[`../notes/perspectives.md`](../notes/perspectives.md) § The thesis.

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
contribution-point composition. The parton primitive maps 1:1
onto the M1 block; `cache` maps onto Varnish ESI; selector
invalidation maps onto cache-tag invalidation.

**Drupal.** Render arrays + regions + blocks + contexts are still
the most architecturally complete extension model in web history.
Anything goes anywhere; cache contexts (per-user, per-locale,
per-URL) drive both invalidation and key derivation. The
read-set-as-cache-key idea in `partial.md` is the same insight as
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
same problem `<RemoteFrame>` ([remote-frame.md](./remote-frame.md))
solves at the Flight wire level.

**Hotwire Turbo Frames.** Probably the closest to the runtime shape
of `<Frame>`. Each frame is a mini-browser: its own URL, its
own navigation, its own back stack. Frames navigate independently;
a click inside a frame stays inside that frame. The differences:

- Turbo Frames are HTML custom elements. `<Frame>` is a pure RSC
  construct — the frame boundary is a server-context extension,
  not a DOM element.
- Turbo Frames have one URL axis (the frame's own); browser
  back/forward operates across frame URLs uniformly. `<Frame>` has
  two axes — browser history (page URLs) and per-entry
  `__frameHistory` (frame URLs scoped to each browser entry) — so
  drawer-shape frames don't pollute browser back.
- Turbo doesn't have a built-in invalidation graph. Partons do
  (selector tokens + `getServerNavigation().reload({selector})` from
  server actions or any server-side task).

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

Worth its own section because the editor in [`cms.md`](./cms.md)
borrows the layout (tree / preview / fields) directly.

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
framework can see the dependency graph) is traded for a softer one
(you write `await`, you own the latency).

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

## Incremental computation and content-addressed builds

A separate lineage from the composition platforms — same dependency-graph
shape, different domain. Each system here computes incrementally over a
DAG of work whose nodes declare their inputs and short-circuit when an
input hasn't moved.

**Bazel / Nix / Buck / Make.** Content-addressed build graphs. Each
action declares its inputs; the action's hash is `H(inputs ∪ tool ∪
args)`; downstream actions re-derive only when an upstream hash moves.
`framework/src/lib/partial.tsx::computeDescendantFold` is structurally
a merkle-DAG: an ancestor's fingerprint folds every transitive
descendant's contribution. Bazel's remote action cache maps onto
`<Cache>`. The difference in mechanism: Bazel auto-tracks inputs via
filesystem sandboxing; `parton` auto-tracks via its server-hooks — the
hooks are the only door to the request, so the read is the record, no
sandbox overhead. The author's remaining contract is the tracking
invariant: don't condition reads on untracked nondeterminism.

**Salsa (rust-analyzer's query engine).** The closest theoretical cousin
in any modern production codebase. Queries are memoized; each query
records what other queries it called; a revision counter tracks input
mutations; re-derive walks the dependency graph and short-circuits when
no transitive input moved. 1:1 mapping: spec ≡ query, tracked reads ≡
inputs, fingerprint ≡ value hash, `descendantFold` ≡
`maybe_changed_after` walking dependents. Salsa auto-tracks via
macro-generated proxy types; this framework auto-tracks via
server-hooks recording onto the render's live dep set. Same shape.

**Self-adjusting computation (Umut Acar, CMU).** The PhD lineage behind
Salsa. Acar's thesis: computations that automatically update when their
inputs change, via a *trace* recorded during first evaluation;
re-derivation walks the trace and only re-runs nodes whose dependencies
dirtied. The snapshot map + `descendantContribution` is a hand-written,
per-request, JS-friendly version of this. The theoretical foundation
for a reader who wants the underlying CS.

**Differential dataflow (Frank McSherry) / Materialize.** Incremental
view maintenance over collections that change over time; results update
with provably correct asymptotic complexity. The framework's per-spec
re-evaluation is "manual, coarser, per-request differential dataflow."
McSherry's cost model — what does it cost to update a result when input
deltas arrive — is the cost model `parton` is implicitly optimizing for.

## Creative tools and node-graph evaluation

The DCC (digital content creation) lineage. These systems built
dependency tracking + dirty propagation + per-node caching at scale,
with 25+ years of production hardening.

**Houdini (SideFX).** Every node in a SOP/COP network has explicit
inputs and outputs; the cook engine tracks dirty propagation; each node
caches its output keyed by parameters + input cook signatures.
Houdini's Take / Wedge system runs the same network under multiple
parameter sets and caches each — that's `matchKey`-variant identity
exactly. The HDA (Houdini Digital Asset) packaging maps onto `block`:
define-step parameter schema + render body + reusability.

**Maya — Dependency Graph (DG).** Same family. Maya's evaluation graph
is the canonical example of dirty propagation in DCC. Nodes have
attributes; attributes have connections; dirty flags propagate;
evaluation is lazy and cached. `setAttr` / `connectAttr` is structurally
"set a tracked input + auto-invalidate downstream specs."

**Fusion 360 / Inventor / SolidWorks (parametric CAD).** Feature-based
modeling: a part is a *history tree* of features (extrude, fillet,
hole); changing an upstream parameter re-evaluates downstream features.
The feature tree is the render tree; parameters are tracked inputs; the
rebuild operation is fp-driven re-render. CAD has dealt for 30 years
with "ancestor cached, descendant stale" — their answer (parametric
history with full dirty propagation) is what `descendantFold`
approximates.

**After Effects, Nuke, Blender (geometry nodes).** Same family.
Compositions of nodes with cached outputs and dirty propagation. Names
to drop when discussing the lineage with someone from VFX/animation.

## Game engines and cross-process replication

The lineage `<RemoteFrame>` lives in.

**Unreal Engine — Actor replication.** Every `AActor` has a
server-authoritative copy and zero or more client replicas. Replicated
properties (`UPROPERTY(Replicated)`) auto-sync server→client; RPCs are
explicitly annotated by authority (`Server` / `Client` / `NetMulticast`).
`<RemoteFrame>` is the same-direction analog: remote (authoritative)
renders its subtree; host embeds it; `capability` is the explicit
host→remote channel. UE's `bOnlyRelevantToOwner` + relevance distance
maps onto "what does the slot owner forward to the remote." 25 years
of hardening on questions still open in `docs/notes/remote-frame-design.md`
(signed properties, lag compensation, anti-cheat) — UE is the reading
list for adversarial-input scenarios.

**Unity — Addressables.** Content-addressed asset loading: any asset
can be referenced by stable address; resolution can be local, CDN, or
remote bundle; the same C# code works regardless of where bytes
physically live. `Addressables.LoadAssetAsync<GameObject>("Enemy_Skeleton")`
doesn't care whether the prefab is in the build or behind a CDN.
`<RemoteFrame>` is the same idea applied to *rendered subtrees* —
host writes `<MagentoPaymentSummary />`, doesn't care that resolution
involves a cross-origin fetch + Flight decode + namespace rewrite.
Both auto-derive their resolver from the address's registered location.

**Godot — scene tree + NodePath.** Nodes are addressable by
`/root/UI/HUD/HealthBar`-style paths; `get_node(path)` finds them;
scenes are reusable subtrees with override semantics. `parent.path` is
structurally a NodePath. Godot scenes ≈ blocks: reusable, instantiable,
with overridable parameters.

## Native UI frameworks with auto-tracked reads

The same family: runtimes where the body's reads are the dependency
surface and the framework skips work when no read value moved —
`parton`'s server-hooks are this bet applied to the request.

**Apple SwiftUI.** Pure-function-of-state views; `@State` /
`@Observable` track property-level reads; body re-runs when read
properties change. SwiftUI's view diff is structurally fp-skip — view
body returns the same shape, framework reconciles, no actual remount.
`NavigationStack` + `NavigationPath` is the frame-chain equivalent:
independent navigation axis with its own back/forward, scoped to a
region.

**Android Jetpack Compose.** Same family; `@Composable` functions ≡
`Render`; `remember` / `derivedStateOf` ≡ memoized derived-input
analogues. Compose's "skippable functions" optimization *is* fp-skip —
the compiler checks input equality and skips re-composition.
Auto-tracked via compiler-rewritten code.

**Cocoa Bindings + KVO (Objective-C, AppKit, 2003).** The forgotten
ancestor. `NSObjectController` + `bind:toObject:withKeyPath:options:`
declared the dependency surface up front; KVO emitted change
notifications; bindings auto-updated UI. "Observed key path =
invalidation surface" is precisely "tracked read = cache key surface."
Apple effectively deprecated bindings in practice because the
observation wiring was invisible at the call site — too magic to
debug. The 20-year lesson is folded in as legibility: tracking is
automatic, but a dependency exists only where a hook call
(`cookie("cart_id")`) is visible in the body, and the recorded keys
ride the snapshot where they can be inspected.

## Adjacent server + collaborative systems

**Phoenix LiveView (Elixir).** The closest non-React server-render
cousin. `assigns` is the dependency surface; templates re-render on
assign change; the wire protocol patches the DOM at marked positions.
Nested `LiveComponent` ≡ spec; `phx-update="ignore"` ≡
`keepalive: false`. Both hold a connection in steady state now — the
channel (attach + held stream + upstream envelopes) is parton's
primary transport — so the differentiator is no longer transport
shape. Three contrasts hold:

1. **State authority.** LiveView's assigns ARE the application
   state: authoritative, in-process, one copy. A process death is a
   user-visible event papered over by remount-and-refetch. Parton's
   connection session is a disposable, EVIDENCED mirror —
   authoritative state lives in cells (storage-backed) and in the
   client's own cache; the session holds only re-presentable
   statements (the visible set, acked holdings, telemetry) and their
   proofs. Kill the process: the client reattaches anywhere,
   re-presents its manifest, and the acked layer rebuilds from zero.
   Nothing on the connection is ever the only copy.

2. **Degradation.** The channel carries freshness, never semantics:
   every upstream frame is a statement equally presentable on a
   discrete request, attach IS the discrete path, and a channel that
   cannot prove its duplex drops the page to GET-shaped polling (the
   never-acked degrade — shipped as mechanism, not aspiration). A
   LiveView page without its socket is a dead form: the events, the
   state, and the render loop all live on the other end of it.

3. **The wire/cache model.** LiveView has no client-cache concept —
   every diff computes against server-known DOM state; no byte-cache,
   no skip, no CDN story. Parton's client holds a real cache the
   server only ever CONFIRMS (fp mirror, fp-skip placeholders, acked
   holdings), the server holds a byte-cache it can warm ahead of the
   viewport, and cold start is a CDN-cacheable GET — the static end
   of the dynamic range has first-class existence. The channel is one
   transport under that model, not the model.

What LiveView keeps: a genuinely smaller programming model — one
process, one state, one loop. Parton pays for the fp/mirror machinery
precisely so the connection stays disposable and the static end stays
real.

**Erlang + OTP.** Every spec addressable by selector ↔ every actor
addressable by `pid`. Selector-targeted refetch ↔ message-pass to a
specific actor. `<Frame>` as scope opener ↔ `gen_server` with private
state. `<RemoteFrame>` is structurally distributed Erlang: different
node, different process, same addressing scheme via namespacing.

**Figma — plugin sandbox.** Plugins run in a separate JS Realm with no
DOM access; communication with the host editor is via `postMessage`
over a structured-clone bridge; capabilities are scoped by what the
host explicitly exposes via `figma.*`. Exactly the RemoteFrame trust
model: capability is the only channel, host decides what to forward.
Figma uses Realm isolation in-process; this framework uses cross-origin
fetch as the isolation boundary. Both arrive at the same security stance.

**Linear — local-first sync engine.** Client maintains a local store
of strongly-typed models; reads are entirely local; writes are
optimistic + reconciled with the server. Closer to client-first
reactivity (Solid, MobX) than to this framework's server-first model.
But entity addressing is the same — every Issue / Project has a stable
id; mutations name the id; cross-references are by id. Linear's typed
Model class gives them auto-tracked reads (a view reading `issue.assignee`
auto-subscribes); this framework's server-hooks are the same bet
server-side — the read subscribes.

**Notion.** Block-based document; every block is `{id, type, props,
children}` — literally `cms/data/content.json`'s shape. Notion's
"synced blocks" (one block referenced from many places) ≡ selector
fan-out. Notion's database views with filter/sort ≡ CMS configs with
match clauses.

## What's distinct in this framework

Not novel; the combination is uncommon.

1. **The parton primitive does one of every job.** Render unit,
   cache unit, invalidation unit, fingerprint unit, CMS storage
   unit, frame unit. One JSX wrapper opens scopes for all of them.
   Most prior systems split these (M1: blocks for render, ESI for
   cache, layout-xml for composition; Drupal: render arrays for
   render, cache contexts for cache, configuration entities for
   storage).

2. **Runtime discovery, not static analysis.** No build-time
   manifest of available blocks; no schema files; no codegen.
   `parton(...)` self-registers in the catalog at
   module-init; the prerender introspects each block by invoking
   its `schema` once with a tracking CMS surface. Adding a new
   block type is one component file + one `parton(...)` call — the
   editor's palette picks it up on the next HMR.

3. **The cache key is what the body reads.** Every per-spec
   dependency on the request, route, or CMS is a tracked read
   recorded during the render; the recorded read set IS the
   cache-key surface. Drupal had this conceptually (cache
   contexts); this framework makes the read pattern the literal
   source of the key, evaluated at the spec's body, no manifest
   cell or hoisting rule needed.

4. **One client navigation surface.** `useNavigation()` is a typed
   superset of `window.navigation`. Page nav, frame nav, and
   targeted refetch are all `navigate(url, options)` with
   different option fields. No second client API to learn.

5. **Shareable state lives in URLs.** No client→server prop-override
   channel. Page URL for shareable, frame URL for subtree-scoped;
   server-owned state that doesn't fit a URL lives in cells. Tracked
   accessors + URL-driven state make a parton's render reproducible
   from its URL plus server state — refresh the page, get the same
   scene back.

## What's missing

- **Contribution mechanism.** Modules contributing blocks into
  shared slots without the slot owner importing them. The M1
  `layout_default` merge analog. Filed in `notes/IDEAS.md`.

- **Static export.** The manifest could drive a build-step that
  prerenders routes and shells out only the dynamic Partials.
  Astro-shape "islands of dynamism in a static shell." Aligned
  with the project name; not built.

- **Worker / CDN-edge placement.** `<RemoteFrame>` covers the
  different-process case; running individual partons in workers or
  at the CDN edge is the remaining step. The strip-and-reinject
  mechanics already support it structurally — the outer cached
  bytes can come from anywhere. Filed; not built.

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
