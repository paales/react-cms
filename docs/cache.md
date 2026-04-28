# Caching

`<Partial cache={…}>` opts a Partial into server-side render-output
caching. The cache stores Flight bytes; on a hit the Partial decodes
the bytes, re-injects any live nested Partials, and returns the
result. Cache keys derive automatically from the request inputs the
Partial body reads through tracked accessors, plus any scalar values
on `cache.vary`.

```tsx
<Partial selector="#products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>
```

Presence of `cache` opts in. Drop the prop to render fresh every
request.

## `CacheOptions`

```ts
interface CacheOptions {
  maxAge?: number; // seconds
  staleWhileRevalidate?: number; // seconds
  vary?: Readonly<Record<string, VaryScalar>>;
  bypass?: boolean;
}

type VaryScalar = string | number | boolean | null | undefined;
```

| Field                  | Meaning                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAge`               | Fresh window, mirrors HTTP `Cache-Control: max-age=N`.                                                                                                                                                                                                                                                        |
| `staleWhileRevalidate` | Window after `maxAge` where the entry is served stale and a background refresh runs. Mirrors the HTTP directive.                                                                                                                                                                                              |
| `vary`                 | Scalar values that identify _which snapshot of the content this is_. For inputs the tracker can't see — typically route params resolved before render. Scalar-only by TS so `{vary: {product: productObj}}` is a type error and authors have to extract the identifying field (`{vary: {sku: product.sku}}`). |
| `bypass`               | Skip caching for this render only. Dev/preview escape hatch.                                                                                                                                                                                                                                                  |

`maxAge` and `staleWhileRevalidate` don't participate in the cache
key — they're entry metadata. Changing them doesn't invalidate
existing entries; it just changes how long they stay fresh.

## Tracked accessors

The cache key surface is the **access manifest** — the set of
`(kind, name)` pairs the Partial body and its descendants record
when they call:

| Accessor               | Manifest key                 | Returns                          |
| ---------------------- | ---------------------------- | -------------------------------- |
| `getCookie(name)`      | `cookie:<name>`              | `string \| undefined`            |
| `getHeader(name)`      | `header:<name>` (lowercased) | `string \| null`                 |
| `getSearchParam(name)` | `url:<name>`                 | `string \| null`                 |
| `getPathname(pattern)` | `pathname:<pattern>`         | `Record<string, string> \| null` |

Each accessor performs the underlying read AND records the manifest
key. The runtime resolves the manifest against the current request
on every cache lookup — same set of keys, fresh values, hashed into
the cache key.

`getRequest()` exists for framework-internal code (the routing
primitive in `framework/router.ts`) but does **not** participate in
tracking. Calling `getRequest().headers.get("x-foo")` inside a
cached Partial silently bypasses the cache key. Read through
`getHeader` instead, or extract the value in the parent and pass
through `vary`.

### `getPathname(pattern)`

```tsx
async function ProductHero() {
  const params = getPathname("/p/:slug");
  if (!params) return null;
  const product = await fetchProduct(params.slug);
  return <Hero product={product} />;
}
```

Matches the current pathname against a `:name`-segment pattern;
returns the extracted params or `null`.

The **pattern** is what lives in the manifest, not the matched
values. Two requests on different products produce different cache
entries (the resolved values differ) but share one snapshot in the
route-scoped registry (the pattern is invariant). On a
high-cardinality route like `/p/:slug` × 50k products this is the
difference between a workable cache and a runaway memory leak —
prefer `getPathname` over closure-capturing `slug` from the
ancestor's render.

The pattern argument is required. Without one, the cache would key
on the full URL — every distinct path would be its own entry,
guaranteeing thrash on any high-cardinality route. Requiring a
pattern makes the scaling intent explicit at the call site.

## The hoisting rule

Tracked accessors must be called **at the synchronous top of the
component body, before any `await`**. The same set of keys must be
read on every render of the Partial. Reading a key the previous
render didn't read throws `HoistingViolationError` synchronously,
naming the Partial id, the new key, and the previously-read keys.

```tsx
// ✓ Hoisted — works
async function FieldPanel() {
  const config = getSearchParam("config");
  const select = getSearchParam("select");
  await fetchSomething();
  return (
    <div>
      {config} / {select}
    </div>
  );
}

// ✗ Conditional — throws on first render that takes the false branch
async function FieldPanel() {
  if (user.loggedIn) {
    const id = getCookie("cart_id");
  }
}

// ✗ Post-await — attributes to whatever sibling Partial set the cell last
async function FieldPanel() {
  await fetchSomething();
  const config = getSearchParam("config");
}
```

### Two failure modes the error names

The `HoistingViolationError` message names both possible causes
because cell-drift attributions can be misleading — the named
Partial may not be the one actually doing the read:

1. **Conditional read** — accessor inside an `if` / loop / early
   return. Move the call to the top of the body.

2. **Cell drift** — accessor called after an `await` in a _different_
   Partial. By then the per-request manifest cell has been
   overwritten by whatever Partial body ran most recently. The read
   gets attributed to the wrong Partial; if the attribution
   _changes_ across renders, this Partial's manifest grows and
   throws.

   Fix: find the actual Partial doing the post-await read and hoist
   it. The framework can only attribute reads correctly when they
   happen at the synchronous top.

### Self-recovery

When `HoistingViolationError` fires, the framework drops the
offending Partial's snapshot from both the current and previous-render
registries. The next render starts with `stored = null` — no
comparison to fail against. Browser refresh recovers; HMR or server
restart not required. The dev still has to fix the underlying read.

## Cache key derivation

```
key = <effectiveId>:<structuralFp>:<innerIdsHash>:<hash([resolvedManifest, vary])>
```

- **`effectiveId`** — the Partial's id (single `#`-token,
  sorted-join of multiple `#`-tokens, or `__anon:<sorted-classes>`).
- **`structuralFp`** — structural fingerprint of the Partial's
  children, plus own frame URL, CMS contribution, manifest. Excludes
  ambient frame URL (that one is for the client skip handshake, not
  the cache key — the cache key needs to be stable across render
  modes).
- **`innerIdsHash`** — djb2 of every nested Partial id inside the
  cached subtree. Adding or removing a nested Partial invalidates
  the entry automatically.
- **`resolvedManifest`** — the values the tracked manifest resolves
  to against the current request. Sorted by key for stable hashing.
- **`vary`** — author-supplied scalars, stable-stringified.

## Storage tiers

State lives in three places. The cache prop interacts with all
three.

| Tier                                                | Where                                                | Keyed by                                               | Cross-request?                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **`<Partial cache>` bytes**                         | `src/lib/cache.tsx` — `MemoryCacheStore` (per-scope) | `<effectiveId>:<fp>:<idsHash>:<hashOfManifestAndVary>` | **Yes, global.** No route in the key. The same `#cart` on `/shop` and `/checkout` shares an entry if its inputs hash the same. |
| **Route-scoped registry**                           | `src/lib/partial-registry.ts`                        | `(scope, pathname, effectiveId)`                       | Yes, partitioned by pathname. Holds snapshots for cache-mode refetches.                                                        |
| **Client `_cache` + `_fingerprints` + `_template`** | `src/lib/partial-client.tsx`                         | id (cache, fingerprints) / route (template)            | No — per browser tab. Pruned on every full streaming render to live ids only.                                                  |

What counts as "the route" differs per tier:

- **Server registry**: `new URL(request.url).pathname`. Search params
  don't partition.
- **Server `<Cache>`**: no route at all. The cache is global by
  design — manifest values key the difference between snapshots.
- **Client `_template`**: `pathname + search`. `?q=a` and `?q=b`
  derive distinct templates.

## SWR

```tsx
<Partial selector="#products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>
```

- `now < expiresAt` — fresh hit, return the cached bytes.
- `expiresAt ≤ now < staleUntil` — stale hit; return the cached
  bytes AND kick off a background refresh that re-renders the body
  with the current request, re-encodes, stores under the same key
  with a new `expiresAt`.
- `now ≥ staleUntil` — miss. Render fresh, return the live tree,
  store the bytes for next time.

The in-flight refresh is gated by a `refreshing: Set<string>` flag.
A benign race (two concurrent requests both miss the flag, both
kick off refreshes) costs extra refresh work in a millisecond
window; correctness is preserved (cache _reads_ return the stale
bytes either way). See [`docs-dev/server-isolation.md`](../docs-dev/server-isolation.md);
don't "fix" with a mutex.

## Composition with dynamic Partials

A `<Cache>` subtree can contain `<Partial>`s that need to stay
live (refetchable, invalidatable). They're handled by **strip on
store, reinject on return** in `cache.tsx`:

1. Before encoding bytes, every `<PartialBoundary>` inside the
   subtree is replaced with a placeholder `<i hidden data-partial
data-partial-id={id}>`. The bytes go to disk without baked-in
   Partial content.
2. On a hit, the bytes decode to a tree with placeholders. The
   reinject pass swaps each placeholder back for a fresh
   `<Partial>` element, reconstructed from the route registry's
   snapshot. The Partial body re-runs against the current request;
   client navigation, `cache` prop on the inner Partial, and
   server-action invalidation all still apply.

Inner Partial ids are folded into the cache base key
(`innerIdsHash`), so adding or removing a nested Partial inside a
cached region invalidates the cache automatically.

## Cold-miss dedupe

Two concurrent requests for the same cold key share one render. The
first caller starts the render and stores its in-flight promise on
`ScopeState.inFlightMiss`; subsequent callers within the same scope
(during the render) await the same promise. After the storage
branch completes, the promise resolves and the entry lands in the
store for the next request to hit normally.

## Sharp edges

- **`<Cache>` inside a frame doesn't see the frame scope.** The
  inner `renderToReadableStream` opens a fresh React internal
  context; the `React.cache`-backed frame cell doesn't propagate.
  Tracked accessors inside the cached body resolve against the page
  request, not the frame's. Workaround: the parent reads the
  accessor and passes a scalar prop:

  ```tsx
  function StageHost() {
    const q = getSearchParam("q");
    return (
      <Partial selector="#stage" cache={{ maxAge: 60 }}>
        <Stage query={q ?? ""} /> {/* prop participates in fp */}
      </Partial>
    );
  }
  ```

  The scalar prop folds into the structural fingerprint, so cache
  keys vary correctly across `q` values.

- **Manifest membership must be stable across renders.** A render
  that reads strictly fewer keys than the stored manifest is a soft
  failure — logged, the existing entry is preserved (overwriting
  would change the cache shape and thrash). A render that reads a
  new key throws synchronously. Two clean fixes for genuine
  conditional needs:
  1. Always read both keys, branch on the values. The accessor is
     cheap.
  2. Split the Partial. Two Partials with stable, disjoint key
     surfaces compose better than one Partial with a dynamic surface.

- **`getRequest()` doesn't track.** Reading from the raw `Request`
  inside a cached Partial silently bypasses the cache key. The
  framework warns about this in dev. Always read through
  `getCookie` / `getHeader` / `getSearchParam` / `getPathname` —
  or pre-resolve the value in the parent and pass through `vary`.

- **High-cardinality routes need `getPathname(pattern)`.** A
  `<Partial cache>` on `/p/:slug` with a closure-captured `sku`
  prop produces one snapshot per SKU in the registry. 50k products
  × N Partials per page is gigabytes of heap. `getPathname("/p/:slug")`
  inside the body keys the snapshot on the _pattern_, so one
  registry entry serves the family — the cache key still varies
  per slug because the resolved manifest values differ.

- **Anonymous Partials and cache stability.** A `cache`-bearing
  Partial without a `#`-token keys on `__anon:<sorted-classes>`.
  Renaming a class silently changes the cache key. Prefer
  `#`-tokens on cache-bearing Partials.

- **`bypass: true` is dev-only by convention.** Nothing prevents
  shipping it to prod, but it disables both write and read for that
  render.
