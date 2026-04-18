## Borrowed-from-Inertia candidates (2026-04-16)

### Lazy partials (`<Partial lazy>`)

Server-side counterpart to `<WhenVisible>`. On initial render the partial's content does not execute — only the fallback is streamed. An explicit `usePartial(id).refetch()` (from a button, WhenVisible, hover-prefetch, websocket, whatever) triggers the first real render. Rationale: `<WhenVisible>` is one specific _activation_ strategy; `lazy` is the _deferral_ decision, orthogonal to who triggers it. Inspired by Inertia's `Inertia::lazy()`. See chat 2026-04-16.

### Refetch-trigger pattern (not a new primitive)

Document `<WhenVisible>` as one instance of a broader pattern: any client condition → `usePartial(id).refetch()`. Likely a `useRefetchTrigger(id, signal)` hook or just a convention. Other canonical instances: poll (`setInterval`), hover-prefetch, websocket message, `visibilitychange`. No framework code needed — just a coherent story + a couple of examples in the docs.

### Prefetch links

`<PartialPrefetch id="trivia" on="hover">` or `<Link prefetch>` for full-page nav. Fires a refetch on hover/mousedown intent, populates `_cache` so the real click/scroll-activation is instant. Short TTL (~30s) so stale hovered data doesn't sit around. Pairs naturally with `lazy` and `<WhenVisible>`.

### Rich refetch event hooks + per-partial progress

`usePartial` returns `isPending` today. Inertia emits `start / progress / success / error / finish` on every visit. Adding callback options to the refetch call (`refetch(props, { onSuccess, onError, onProgress })`) or an event emitter keyed per-partial would let apps build NProgress-style top bars, per-partial progress affordances, and analytics without forking the framework.

Deliberately skipped (Inertia has these, we don't need them): Deferred Props (Suspense is better), useForm (RSC actions cover it), stacked modals (too specific), full Visit API surface.

---

## State-preserving refetches (2026-04-16)

Today's partial-refetch dichotomy in `partial.tsx`:

- **Fresh mount** (default, `<Suspense key={id#version}>`) → React unmounts/remounts → progressive streaming of nested Suspense boundaries works, **client state inside is destroyed**.
- **Revalidate** (opt-in `?revalidate=1`, bare `<Suspense key={id}>`) → reconcile in place → **client state preserved**, no progressive streaming (startTransition waits for whole subtree).

Live-search is the canonical casualty: every keystroke that refetches risks nuking input focus, selection, scroll, IME state. Cart-badge works in revalidate mode because it has no inner Suspense boundaries to stream.

The `revalidate` flag exists _purely_ because of how React reconciled pending Suspense subtrees in the React version this was built against. If that changed in React 19 stable, the whole distinction might collapse.

Things to investigate, in order:

1. **Re-test streaming-on-update in React 19 stable.** Bare-key refetch + multiple nested async Suspense boundaries. Do chunks flush progressively without the remount? If yes → delete the `revalidate` branch, default to bare key, problem solved.
2. **If (1) fails**, decouple render identity (what Suspense's `key` controls) from state identity (what client components care about). Candidate: a `<PartialState scope="search-form">` boundary — tiny client component that caches its children's state via context/ref, survives parent Suspense remounts. Non-trivial to make work with arbitrary client hooks inside, but tractable for known state holders.
3. **`<Activity/>` is _not_ the fix.** Activity keeps a subtree mounted-but-paused; it doesn't let a _new_ render _inherit_ the paused tree's state. Useful for tab-style preservation, not for "server content updated, client state stays."
4. **Ship the instance-identity debugger.** `useRef(() => randomColor())` rendered as a small corner dot in dev builds. Dot color changes → component remounted. Turns "did my component just remount" from a guessing game into a glance. Lives alongside the PartialDebugPanel status dots.

Chat context: 2026-04-16 — user flagged that the current fresh-mount / revalidate split is load-bearing only because of streaming, and may be removable.

---

## Fingerprint-skip v2 (2026-04-17)

Navigations now use the fingerprint-compare already embedded in the
`?cached=id:fp,…` protocol: server renders the skipped partials as
`<i data-partial hidden key={id}/>` placeholders, client fills from
its `_cache`. Empirical win on `/pokemon/1 → /pokemon/1?search=url`:
~75 KB → ~34 KB (~55% smaller). Regression test in
`e2e/fingerprint-skip.spec.ts`.

Follow-ups worth considering:

1. **Widen the match.** Today the fingerprint is purely structural
   (component name + scalar props + recursion). Two refetches of
   `<Partial id="cart">` from different carts hash the same because
   they carry no discriminating prop. In practice that's fine because
   carts render via `getRequest()` context, not props — but it means
   the server still has to execute the partial to know the output
   differs. A **content fingerprint** (hash of the decoded Flight
   bytes) would let two matching _renders_ share cached bytes, but
   costs a render to compute. Probably not worth it unless we see
   "server re-rendering identical output repeatedly" in practice.

2. **Prune stale `_cache` entries.** `cache.clear()` used to run on
   every streaming render to evict stale entries. That's gone (it
   was clobbering the new skipped partials). Entries accumulate
   across navigations. For the demo app it's fine; a real CMS with
   many routes needs a drop-if-not-in-template pass. Keep entries
   only for ids present in the current `template`.

3. **Per-partial opt-out.** An author may want a partial that
   _always_ re-renders on nav regardless of fingerprint match
   (e.g., a server-time readout). Would need a prop on `<Partial>`
   like `alwaysFresh` (or its inverse `cacheOnNav`) plus a filter
   in the skip loop. Not needed yet, but predictable ask.

---

## Cache component bakes in dynamic Partials (2026-04-17)

`<Cache><ProductGrid/></Cache>` — the children passed to Cache is
the **unrendered** `<ProductGrid/>` element. `stripPartials` walks
that input tree, can't see through an opaque function component,
finds no Partials, strips nothing. Then `renderToReadableStream`
renders ProductGrid, producing `<Partial id="price-${sku}">` inside
each card with `<LivePrice/>` baked in. Those bytes are what get
cached. On hit, the baked-in prices are served verbatim, so
individual `tags=["price"]` refetches work (they go through the
registry, not the cache) but the cache entry itself holds stale
prices until its TTL expires.

### Proposed fix

Render first, strip the rendered tree, re-encode:

```ts
// On cache miss:
const rawBytes = await renderAndBuffer(children);
const decoded = await createFromReadableStream(bytesToStream(rawBytes));
const resolved = await resolveLazies(decoded);
const { stripped, partials, ids } = stripPartials(resolved);
const bytes = await renderAndBuffer(stripped);
store.set(key, { bytes, partialIds: [...partials.keys()], ... });
return reinject(resolved, partials);
```

On hit:

```ts
const decoded = await createFromReadableStream(bytesToStream(entry.bytes));
const resolved = await resolveLazies(decoded);
// Rebuild the partials map from registry, so reinject has something
// to splice in (the cached bytes are pure placeholders).
const partials = new Map<string, ReactElement>();
for (const id of entry.partialIds) {
  const snap = lookupPartial(route, id);
  if (!snap) continue;
  partials.set(id, <PartialBoundary id={id} {...snap}>{snap.content}</PartialBoundary>);
}
return reinject(resolved, partials);
```

Cost: double render on miss (render + strip + re-encode). Benefit:
cached bytes only hold scaffolding; every hit still executes fresh
per-partial content. This matches the documented design goal in
`cache.tsx` top comment ("Cache captures the stable scaffolding,
partials stay live").

### Open questions

1. If the cache hit occurs for a request where the registry has been
   cleared (HMR, new process), `lookupPartial` returns nothing and
   the hit degrades to the current behavior — cached bytes with no
   live partials, placeholder `<i>` elements in the rendered output.
   Could fall back to rendering fresh, but that defeats the cache.
   Best bet: do a full render on the first request per process/HMR
   so the registry populates, cache the stripped version on that
   render, serve hits thereafter.
2. Double-render on miss doubles first-load latency. Might not
   matter if miss rate is low; if it does, we'd need a zero-copy
   way to "strip the tree while streaming" — more complex.

Chat context: 2026-04-17 — user noticed LivePrice was frozen inside
cached ProductGrid and asked if Cache was supposed to keep child
Partials live. Existing behavior documented honestly; fix deferred
to a future session because the proper solution is non-trivial.
