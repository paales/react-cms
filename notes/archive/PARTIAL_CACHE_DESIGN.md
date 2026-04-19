# `<Partial cache>` — folding `<Cache>` into `<Partial>`

**Status:** design, not yet implemented. **`cache` value semantics superseded by `AUTO_TRACKED_CACHE_KEYS.md`** — the fold still lands, but `cache` carries Cache-Control directives (`{maxAge, staleWhileRevalidate, extra, bypass}`) rather than an opaque dep object, and the key derives from tracked accessor reads instead of author-declared deps.
**Adds:** `cache` prop on `<Partial>`.
**Removes:** standalone `<Cache>` component.
**Related:** `SERVER_CACHE_NOTES.md` (current `<Cache>` implementation — will move to archive once this lands), `AUTO_TRACKED_CACHE_KEYS.md` (what `cache` means in the final form), `LESSONS_2026-04-19.md` §3 (the compose problem this fixes).

---

## Why this exists

Today's composition is two boundaries stacked:

```tsx
<Partial id="products">
  <Cache id="products" dep={{ search }} ttl={60}>
    <ProductGrid search={search} />
  </Cache>
</Partial>
```

Two invariants pull against each other:

- `<Partial>` wants its content re-evaluated per request so snapshots
  reflect the current URL bindings (`refreshRegistry`).
- `<Cache>` wants its subtree *frozen* behind a key so rendering can
  be skipped.

Three concrete problems fall out:

1. **`__inputs` can't drill through `<Cache>`.** Overrides arrive via
   `cloneElement(content, overrides)` which only sets props on the
   outermost element. When `<Cache>` is the outer element, overrides
   land on it as dead props; the inner component never sees them.
2. **Cache key and Partial props diverge.** Authors have to declare
   the same values twice — once as Partial props (for the client to
   fingerprint) and once as `dep` on Cache (for the server to key
   the stored bytes). Drift between them produces subtle "same shape,
   different cache key" bugs.
3. **Dynamic partials inside a cached region need strip-on-store.**
   The current `<Cache>` walks its input JSX before rendering,
   identifies statically-visible Partials, replaces each with a
   placeholder, and re-injects live elements after decode. Needed,
   but the walk doesn't see Partials produced inside `.map()` —
   those get baked into the cached bytes and stay frozen until the
   cache entry expires.

The fold addresses all three by making a single boundary responsible
for both "this is a refreshable section" and "this is a cache
boundary."

## The end state, in one paragraph

`<Partial id="…" cache={…}>` replaces `<Cache>` + `<Partial>` when
you want both. The Partial body computes `cache` eagerly against the
current request's props and URL context, hashes the result to a key,
and on hit decodes stored Flight bytes and returns them. On miss it
renders content normally, buffers the result, stores, returns. The
boundary owns both roles: it knows what identifies this section
(the Partial id plus a structural fingerprint of its content) and
what identifies this *snapshot* of the section (the cache object).
Any `<Partial>` nested inside a cached parent is an independent hole
— its own cache semantics apply; dormant/stream/fingerprint-skip
decisions are taken at *that* Partial's body, not the ancestor's.
Inheritance is a convenience: if a child omits `cache`, it inherits
the parent's cache policy, but it can always opt out.

## Surface

```tsx
<Partial
  id="products"
  cache={{ search }}          // what to key the cached bytes on
  ttl={60}
  staleWhileRevalidate={300}
  tags={["products"]}
>
  <ProductGrid search={search} />
</Partial>
```

| Prop | Meaning |
|---|---|
| `cache` | Object whose stable-stringified hash becomes the cache key (alongside the Partial id + structural fingerprint). Absent → no caching. `false` (explicit) → opt out even if inherited. |
| `ttl` | Seconds until the entry expires. Undefined = never (LRU only). |
| `staleWhileRevalidate` | Additional seconds after `ttl` during which the stored entry is served stale while a background refresh runs. |
| `tags` | Unchanged. Already used for `?tags=` invalidation and for invalidating the Partial itself. |

`id` is already the cache-boundary key: `<Cache>`'s `id` prop goes
away because `<Partial id>` serves both roles. One identifier, one
concept.

## Inheritance

A common pattern: "the whole products list is cached, but each
item's live-price inside it isn't."

```tsx
<Partial id="products" cache={{ search }}>
  <ProductGrid search={search} />    // async, returns per-product cards
</Partial>

// Inside a card rendered by ProductGrid:
<Partial id={`price-${sku}`} tags={["price"]}>
  <LivePrice sku={sku} basePrice={price}/>
</Partial>
```

Rule: `cache` does not inherit. A child Partial without `cache`
renders live, even when its ancestor is cached. The ancestor's
cached bytes contain a placeholder for the child (same
strip-on-store pattern as today); on decode the live child element
is spliced in. The child is a *hole* through the parent's cache.

This preserves the core requirement the user called out: "cached
parent Partial, streaming non-cached child partial." Authors opt
children into caching by adding `cache={…}` to each child Partial
— which may have its own dep, its own ttl, etc.

A later extension, if warranted by real code: `cacheInherit` as an
explicit prop that tells a child to use its parent's cache tuple
(`dep + ttl + swr`). Not adding this now — the explicit form is
already one line, and inheritance-by-default has the compose
problem (surprise caching on a section that looks live).

## Flow, one pass

Server-side body of `<Partial>`:

1. **Read state** (`requirePartialState()`), compute structural
   fingerprint of content as today.
2. **Skip decisions** as today (cache-mode-not-requested,
   fingerprint-match, defer-dormant).
3. **`cache` present AND id should render:**
   a. Compute `cacheKey = ${id}:${djb2(stableStringify([cache, fp]))}`.
   b. Lookup in the module-level store.
   c. Fresh hit → decode bytes, return decoded tree (with partial
      placeholders re-injected as live elements, same as today).
   d. Stale hit → serve stale, kick off background refresh.
   e. Miss → render content to Flight, buffer, store, decode-back,
      return.
4. **`cache` absent** → render content normally (today's path).

Steps 3a–3e are the current `<Cache>` internals lifted into the
Partial body. `stripPartials` stays as-is (finds statically-visible
Partials inside the content, replaces with placeholders before
serializing). `reinject` stays. `resolveLazies` stays.

Dynamic Partials inside the cached content behave exactly like they
do today: baked into bytes on first miss, served from bytes on
hits, refreshed on their own refetch via `substituteNested`.

## The `<Cache>` component goes away

Grep'd for callers; only two: `src/app/pages/magento/product-list.tsx`
and `src/app/pages/cache-demo.tsx` and the pokemon search stages.
Each transforms cleanly:

```tsx
// before
<Partial id="products">
  <Cache id="products" dep={{ search }} ttl={12}>
    <ProductGrid search={search}/>
  </Cache>
</Partial>

// after
<Partial id="products" cache={{ search }} ttl={12}>
  <ProductGrid search={search}/>
</Partial>
```

```tsx
// before
<Partial id="stage-2" fallback={<…/>}>
  <Cache id="SearchStage2" dep={{ searchQuery }}>
    <SearchStage2 query={searchQuery}/>
  </Cache>
</Partial>

// after
<Partial id="stage-2" cache={{ searchQuery }} fallback={<…/>}>
  <SearchStage2 query={searchQuery}/>
</Partial>
```

`src/lib/cache.tsx` becomes `src/lib/partial-cache-store.ts` (store
+ LRU + SWR + HMR) with the component removed. `PartialBoundary` in
`partial-component.tsx` calls into the store directly; no separate
component boundary.

`stripPartials` / `reinject` / `resolveLazies` / `unwrapLazy` stay
where they are — still needed to compose dynamic partials with
cached regions.

## Semantics the fold actually improves

1. **`__inputs` reaches the content.** The Partial body applies
   `applyInputs(children, override)` *before* the cache key is
   computed. The override now participates in the key because the
   structural fingerprint includes applied props. Bonus: a refetch
   that overrides props naturally misses the cache (different
   props → different fp → different key) — which is the desired
   behavior in most cases. Authors who want the override to reuse
   cache entries can thread the override prop into `cache` too.
2. **One identifier.** `id` is the boundary; no duplicate `id` on a
   separate `<Cache>`.
3. **`cache` reads naturally from the same props the content uses.**
   The author writes the dependencies once. Drift between Partial
   props and cache dep becomes impossible.
4. **Registry integration.** Because the cache decision lives
   inside the Partial body, `refreshRegistry`'s per-request JSX
   re-seed still covers the current bindings — the cache key
   re-computes with current closures, the content re-evaluates
   with current closures, everything stays consistent.

## Migration checklist

Mechanical:

- [ ] Add `cache?: unknown`, `ttl?: number`, `staleWhileRevalidate?: number` to `PartialProps`.
- [ ] Move store + SWR + HMR pieces from `cache.tsx` → `partial-cache-store.ts`.
- [ ] Inline the cache-hit/miss flow into the Partial body (after skip decisions, before final wrap).
- [ ] Update `stripPartials` to recognize the new owner (still a `PartialBoundary` in the decoded tree; may not need any change).
- [ ] Rewrite the three call sites (magento product-list, cache-demo, pokemon search).
- [ ] Delete `src/lib/cache.tsx` (or leave as a thin re-export shim pointing at the new location for one release, then remove).

Tests:

- [ ] `e2e/cache-demo.spec.ts` stays, pages use `<Partial cache>` instead of `<Cache>`.
- [ ] `e2e/magento-cache-hit-renders-body.spec.ts` stays.
- [ ] Add a test for the compose case: `<Partial cache>` containing a non-cached child `<Partial>` — child refetches correctly.
- [ ] Add a test for `cache` + `__inputs`: override changes → miss → fresh render.

## What doesn't change

- The route-scoped registry and `refreshRegistry` / `clearRoute`.
- Client-side template derivation and persistence.
- Fingerprint-skip logic.
- `defer` / activators.
- Tag-based invalidation (`?tags=`).
- The in-memory, per-process store model.

## Open questions

- **`cache={false}` explicitly opting out.** Needed only if we ever
  add inheritance. Today the absence of `cache` already means "no
  caching."
- **Whether to strip `stripPartials` to only walk one level.** Today
  it walks deeply, which is probably unnecessary since dynamic
  children register via `PartialBoundary` anyway. Possible
  simplification, not required for the fold.
- **Cache-mode refetch hitting a `cache`-enabled Partial.** The
  content is already in the registry snapshot. On refetch, the
  Partial body runs, hits its own cache (fresh or stale), returns.
  Cache-mode still short-circuits ancestor execution; per-partial
  server-output caching sits inside the partial itself. Works
  cleanly.
- **Circular `cache` dep.** The `cache` value is treated opaquely by
  `stableStringify`. Circular refs → infinite loop. Same guard as
  `<Cache>` today (we rely on authors not doing this); could add a
  `seen` set if we ever hit it.
