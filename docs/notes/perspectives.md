# Perspectives

The unifying primitive is `ReactCms.partial(Render, options)`: a define-step constructor that returns a placeable React component for an addressable RSC subtree. Each partial has its own fingerprint, cache key, refetch path, and frame scope. `ReactCms.block` (slot-placeable, CMS-driven) and `<Frame>` (URL scope opener) are specialisations on top of the same engine. See [`reference/partial.md`](./reference/partial.md).

Polysemic by design: the framework is intentionally explainable through Varnish, iframes, Livewire, RSC, and commerce rendering because each lens reveals a different constraint. The "Like" items below are doors into the same room; the "Not" items keep the room's shape sharp. Each item carries a leading **label** so they can be referred to without quoting the whole line.

1. **Varnish/ESI**: Like Varnish/ESI hole-punching, but in-process: the server emits ONE Flight response with 3-byte placeholders where each partial's fingerprint matches the client's claim. The client paints those slots from its local partial cache, the rest streams fresh.
2. **Fingerprint-based skip**: Like cache-keying every region by its actual dependencies: each partial hashes `(spec id, vary result, descendant fold, CMS contribution, call-site props)` into a fingerprint. The client sends its fp set on every refetch; the server skips body execution when its current fp matches.
3. **Define-step constructor**: Like `React.memo`, but at module scope and request-shaped: `partial(Render, options)` runs once at import time and returns a placeable component whose request dependencies live in one sync `vary` callback. Page composition is a JSX tree of those components.
4. **`use cache` for UI**: Like `use cache`, but the cache entry is addressable: the client can ask the server to re-stream just that region by selector (`reload({selector: "#cart"})`) and a server action can invalidate it by name, not just memoize render output keyed on args.
5. **Server-side iframes**: Like iframes, but server-side and in-React: a `<Frame>` opens a URL scope inside one DOM, one React tree, one auth context, and one design system. Descendants resolve URLs against the frame's URL, not the window's.
6. **URL-as-state**: Like URLs as the recursive state coordinate: page URL, frame URL, and nested-frame URL each scope a different region, and a partial's render is reproducible from those URLs alone. Frame URLs are session-cookie-backed (survive reload, shared across same-session tabs, not cross-device shareable).
7. **Routed zones**: Like a page made of independently routed zones: frames, drawers, and overlays can move through their own URL space while the page stays put. Browser back/forward operates on the window axis; per-frame back stacks are separate.
8. **htmx/Turbo**: Like htmx/Turbo fragments, but the fragment is a React Server Component subtree with fingerprints and selector identity, not raw HTML.
9. **Livewire**: Like Livewire-style server actions for RSC fragments: a server action returns `{invalidate: {selector: "#cart"}}` and the framework refetches every partial matching that selector on the next render.
10. **UI invalidation**: Like query invalidation but the targets are rendered regions, not data: server actions, CMS edits, and session writes all flow through the same selector-based dispatch.
11. **Activity-aware nav**: Like React Activity applied to navigation: each partial wraps its body in `<Activity mode="visible">` while active and emits `<Activity mode="hidden">` siblings for every cached variant. Cross-route navigation flips Activity modes; `useState`, `useRef`, and DOM state survive across nav.
12. **Server islands**: Like server-rendered islands, but the islands are server-owned, cacheable, composable, and refetchable by selector. Not isolated client apps.
13. **Headless commerce**: Like headless commerce without pushing commerce state into the browser: price, cart, inventory, and personalization stay server-owned. Client components dispatch server actions; the affected partials re-render server-side.
14. **Executable blocks**: Like a CMS block model generalized to every region: render, cache, data dependencies, preview, and invalidation live together on the same primitive, whether or not the region is CMS-bound.
15. **Cascading CMS configs**: Like a CMS where each block instance resolves its fields through a per-cmsId cascade of `{match, fields}` configs (per-pathname, per-cookie, per-header), with longer-match wins. The editor reads which fields exist by introspecting each block's `schema` callback at render time, not from static schema files.
16. **Draft + published**: Like a CMS draft layer over committed content: `cms/data/content.json` is the published baseline, `cms/data/draft.json` is per-author staging, and a `cms-draft=1` cookie flips read order. A `publishCmsDraft` action merges draft into committed.
17. **In-process Flight tests**: Like running the production renderer in a Vitest test: the RSC harness round-trips Flight encode → decode in one Node process, so assertions can target the exact tree the client would render. The same harness backs unit tests, in-tree refetch tests, and registry-state tests.

## What It Is Not

1. **Route-level SSR**: Not just route-level SSR: the route is one input among many. Frames, drawers, CMS slots, and per-spec cache TTLs each create their own render and invalidation boundaries.
2. **`use cache` directive**: Not just `use cache`: caching is one behavior of an addressable region. Selector-targeted refetch and selector-targeted invalidation are the other two.
3. **Client islands**: Not a client island system: the island is still server-rendered, server-invalidated, and part of the same RSC graph. Client components hydrate inside it but don't own its data.
4. **State manager**: Not a state manager: it classifies where state belongs (page URL, frame URL, session, CMS, cache, Activity, server action), then uses each as a separate tool.
5. **SPA data layer**: Not a generic SPA data-fetching layer: it does not move commerce state into client queries and ask the browser to rebuild server semantics.
6. **Microfrontend framework**: Not a microfrontend framework: ownership boundaries can exist inside one app without independent deployment, separate bundles, or postMessage protocols. Distributed-runtime support is filed, not built.
7. **Realtime push**: Not a websocket-first realtime system: the base model is request/response RSC. Streaming chat works inside one Flight response; cross-session push is filed, not built.
