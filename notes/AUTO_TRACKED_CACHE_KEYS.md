# Auto-tracked cache keys + Cache-Control surface

**Status:** implemented (2026-04-19).
**Files:** `src/framework/context.ts` (tracked accessors + `ManifestScope` + `HoistingViolationError`), `src/lib/cache-options.ts` (`CacheOptions` type), `src/lib/cache.tsx` (manifest store + key derivation + sync hoisting check), `src/lib/partial-component.tsx` (`PartialProps.cache` shape).
**Tests:** `src/framework/__tests__/tracked-accessors.test.ts` (manifest + hoisting unit tests), `e2e/cache-auto-tracking.spec.ts` (auto-tracked keys via the cache-demo page).
**Predecessors (now archived):** `archive/SERVER_CACHE_NOTES.md` (original `<Cache dep>` mechanics), `archive/PARTIAL_CACHE_DESIGN.md` (the fold proposal — superseded by this).

---

## What changes

Two things, taken together:

1. **`cache` carries Cache-Control directives, not deps.** The cache key is no longer a hash of an author-supplied object; it's derived automatically from the request state the Partial body actually reads.
2. **The accessor surface (`getCookie`, `getHeader`, `getSearchParam`, …) is tracked.** During render, every accessor call pushes `(kind, name)` into a per-Partial *access manifest*. That manifest is the cache key surface.

```tsx
// Before (PARTIAL_CACHE_DESIGN proposal):
<Partial id="products" cache={{ search }} ttl={60} staleWhileRevalidate={300}>
  <ProductGrid />
</Partial>

// After:
<Partial id="products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>

// where ProductGrid reads request state through tracked accessors:
async function ProductGrid() {
  const search = getSearchParam("q");        // recorded: url:q
  const locale = getCookie("locale");        // recorded: cookie:locale
  // ...
}
```

The author no longer restates dependencies the runtime can already see. The cache object becomes purely about freshness and cache control.

## The `cache` prop, fully specified

`cache` is an object with HTTP `Cache-Control`-style fields. Presence of the prop opts the Partial into caching; the value carries the directives.

| Field | Type | Meaning |
|---|---|---|
| `maxAge` | `number` (seconds) | Fresh window. Equivalent to `Cache-Control: max-age=N`. |
| `staleWhileRevalidate` | `number` (seconds) | Additional window after `maxAge` during which the stored entry is served stale and a background refresh runs. Same semantics as the HTTP directive. |
| `vary` | `Readonly<Record<string, string \| number \| boolean \| null \| undefined>>` (optional) | Additional scalar values that identify this snapshot. Canonical case: a dynamic route param like `sku` on a product page — resolved before render, can't be seen by the tracker, but is what makes one product's cached bytes different from another's. Scalar-only by TS: `vary: { product: productObj }` is a type error, forcing the author to pick the identifying field (`{ product: product.id }`). Named after HTTP `Vary`; the bend is that HTTP vary names headers while ours carries already-resolved values. |
| `bypass` | `boolean` (optional) | Skip caching for this render only. Survives from today's `<Cache>` for dev/preview. |

Absent `cache` → no caching, render normally.

`tags` stays where it is on `<Partial>` (it's about invalidation channels, not key derivation).

## The accessor surface

A small, closed set of typed accessor functions, each of which:

1. Reads from the AsyncLocalStorage-held request store (already exists in `context.ts`).
2. Pushes `(kind, name) → value` into the per-render *access manifest* held in a separate ALS slot.

Initial set:

| Accessor | Manifest key |
|---|---|
| `getCookie(name)` | `cookie:${name}` |
| `getHeader(name)` | `header:${name.toLowerCase()}` |
| `getSearchParam(name)` | `url:${name}` |
| `getPathname()` | `url:_pathname` |

`getRequest()` itself stays available as the unstructured escape hatch but does **not** participate in tracking — its return value is the whole `Request` object and the runtime can't tell what the caller will pluck off it. Calling `getRequest().headers.get("x-foo")` and not also calling `getHeader("x-foo")` is the same class of bug as forgetting an `vary` key under today's manual model. We'll surface it as a dev-mode warning ("you read from `getRequest()` inside a cached Partial; the result is not in the cache key — use `getHeader`/etc. or move it into `cache.vary`").

Module-level scope (`process.env.NODE_ENV`, in-memory caches) is by definition stable across requests; not in scope for tracking.

## Hoisting rule (the conditional access problem)

The manifest is a **set**, not a sequence — order doesn't matter, but membership must be stable across renders of the same Partial. If one render reads `cookie:cart_id` and `header:auth`, the next must read the same set.

Why: the cache key derives from the manifest's *contents*. If a request lands on a render branch that only reads `cookie:cart_id`, the key is computed from one cookie. The next request lands on the other branch and reads `cookie:cart_id` + `url:promo` — different key, miss, repopulate, evict the previous entry. The cache thrashes silently. The whole optimisation degrades to "compute every time."

**The rule, framed like React hooks:** request accessors must be called unconditionally, at the top of the Partial body, before any branching. Same shape as `useState` / `useEffect`. The reason differs (we track membership, not position) but the discipline matches: the runtime needs a stable contract about what state this render reads.

### Runtime detection

Two checks, fired at different points in the render:

1. **Added-key violation (synchronous throw).** When an accessor is called and the key isn't in the stored manifest, `trackAccess` throws `HoistingViolationError` immediately — the user gets a hard failure on the first request that hits the bad branch. This is the common case (a new conditional branch reads a key the original render didn't).

   ```
   HoistingViolationError: Partial "products" read "url:promo" on this render,
   but its previous renders didn't read it. Request accessors (getCookie /
   getHeader / getSearchParam / getPathname) must be called unconditionally
   at the top of the component body, like React hooks. Move the read above
   any conditional branching, or — if the input genuinely shouldn't
   participate in the cache key — pass it through cache.vary instead.
   (previous keys: [cookie:cart_id, header:auth])
   ```

2. **Missing-key check (post-render, soft fail).** After the storage branch finishes reading the render output, we compare the produced manifest to the stored one again. The "added" case has already thrown by then, so the only remaining mismatch is "stored had X, current didn't touch X" — a branch that reads strictly less. We log + preserve the existing entry rather than overwrite. Hard-throwing here would require waiting for the full render before sending the response, which would defeat cold-miss streaming.

Both checks run in dev *and* prod — silent thrash is worse than a hard failure (added) or stale serve (missing).

### Static lint rule

Detection at runtime catches every case but only after one bad request lands. A companion ESLint rule (forked from `react-hooks/rules-of-hooks`) flags conditional accessor calls at write time:

```ts
// ✗ flagged
async function Cart() {
  if (user.loggedIn) {
    const id = getCookie("cart_id"); // accessor inside conditional
  }
}

// ✓ fine
async function Cart() {
  const id = getCookie("cart_id");
  if (user.loggedIn) { /* use id */ }
}
```

Same rule as hooks: no conditionals, no loops, no early returns above the accessor calls. Order doesn't matter for us, but keeping the rule identical to `rules-of-hooks` lets us reuse the AST walker and lets authors apply one mental model.

### When you genuinely need conditional reads

You don't. If the Partial sometimes reads cookie A and sometimes cookie B, the cache key surface is unstable by definition. Two clean fixes:

1. **Always read both, branch on the values.** The accessor is cheap; reading something you don't use costs you nothing but membership in the manifest.
2. **Split the Partial.** Two Partials with stable, disjoint key surfaces compose better than one Partial with a dynamic surface. The parent passes data down or branches between two children.

The error message should suggest both.

## Flows

### First render (cold)

1. Partial body starts. ALS opens an empty access manifest.
2. Body runs to completion. Every accessor call pushed into the manifest.
3. Manifest is captured, frozen, and stored under `(id, fingerprint)`.
4. Cache key computed: `id + fingerprint + djb2(stableStringify(manifestValues + cache.vary))`.
5. Render output buffered to Flight, stored under the cache key.

Two stores:

```
manifestStore:  Map<id+fp, AccessManifest>          // process-local (live React refs OK; in fact none here, but keeps it co-located with snapshotIndex)
entryStore:     CacheStore<id+fp+valueHash, Entry>  // the existing async-by-contract surface from cache.tsx
```

Both can be in-memory in the prototype; the entry store is already async-by-contract for swapping in Redis later. The manifest store can be in-memory only — it's a small structural fact (a Set of strings), recoverable from one render if lost.

### Subsequent render (warm)

1. Look up `(id, fingerprint)` in `manifestStore`.
2. **Manifest hit:** resolve each accessor key against the current request → values map. Hash → cache key. Look up in `entryStore`.
   - **Fresh hit** → decode bytes, reinject live partials (existing logic), return.
   - **Stale hit** → serve stale, kick off SWR refresh.
   - **Miss** → render. Verify the produced manifest matches the stored one. Store new entry.
3. **Manifest miss** (process restart, new fingerprint, never-rendered): treat as cold. Render, capture manifest, store both.

### SWR refresh

Background task re-runs the Partial body, captures a fresh manifest, verifies it matches the stored one (mismatch = same hoisting error, surfaced via console + telemetry rather than thrown), re-encodes bytes, stores under the new key derived from current values.

### Conditional access detected

Added-key case: throws synchronously inside `trackAccess` (the first read of an unrecognized key). The user sees a 500; logs carry the `HoistingViolationError` message identifying the partial id and the offending key. The cache entry and stored manifest are untouched.

Missing-key case: caught by the post-render comparison in the storage branch. Logged as `[cache] manifest mismatch on miss for "id" — preserving old entry.` and skipped. The user-facing response already streamed; the next request reads the unchanged stored manifest.

## Defer interaction

`defer` controls *when* the body runs (dormant → activated). The cache key still represents *what request state the body depends on when it runs*. Two cases:

1. **Defer is dormant** (first render of a deferred Partial): the body doesn't run. No manifest produced this request. No cache lookup. Fallback emits.
2. **Activator fires a refetch:** the refetch goes through the ordinary cache path. If the manifest is already known (from any prior render of this Partial in this process), the runtime can compute the key *without* running the body and serve from cache. If the manifest is unknown, the refetch is a cold render that establishes it.

This means a deferred + cached Partial can serve a warm cache hit on its very first activation if a previous request already populated the manifest. That's the desired behaviour.

## Cache key, end to end

```
key = `${id}:${fp}:${djb2(stableStringify([
  resolveManifest(manifest, request),   // current values for tracked accessors
  cache.vary,                           // author-supplied vary entropy
]))}`
```

- `id` — Partial id, scoped per-route.
- `fp` — structural fingerprint (today's logic, unchanged).
- `manifestValues` — `{cookie:cart_id: "abc", url:q: "pikachu"}`. Sorted by key in the stable-stringify pass.
- `cache.vary` — opaque, hashed by the same stable stringifier. Authors only reach for this when they have an input the tracker can't see.

Cache-Control directives (`maxAge`, `staleWhileRevalidate`) do **not** participate in the key — they're entry metadata, not identity. Changing `maxAge` doesn't invalidate; it just changes how long the existing entry is fresh for.

## What the author writes

Common case — Partial reads request state directly:

```tsx
<Partial id="products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>

async function ProductGrid() {
  const q = getSearchParam("q");
  const locale = getCookie("locale");
  return <ul>{...}</ul>;
}
```

Cache key derives from `q` + `locale` automatically. Author wrote the directives once; never duplicates the dep list.

With a route-param input the tracker can't see:

```tsx
// On /product/[sku]
function ProductPage({ sku }: { sku: string }) {
  return (
    <Partial id="product" cache={{ maxAge: 300, vary: { sku } }}>
      <ProductDetails sku={sku} />
    </Partial>
  );
}
```

`sku` arrived as a prop from the route, not from a cookie/header/url-param. The auto-tracker can't see it. `vary` makes it explicit and folds it into the key. TypeScript keeps `vary` values scalar: `vary: { product }` errors unless `product` is a primitive; authors have to extract `{ sku: product.sku }` to say "key by this field."

There is no `getVary()` accessor. Vary values are Partial configuration, resolved in the author's scope when they write the prop — the same scope they use to thread the value to children. An accessor would add an ambient-state API where a prop already works and make components less portable.

## Surface comparison

| Concern | Today | After fold (`PARTIAL_CACHE_DESIGN`) | After this proposal |
|---|---|---|---|
| Opt into caching | `<Cache>` wrapper | `cache={…}` prop with deps | `cache={…}` prop with directives |
| Declare deps | `dep` prop | `cache` value | (auto-tracked, `cache.vary` for the rest) |
| Freshness | `ttl`, `staleWhileRevalidate` props | same | `cache.maxAge`, `cache.staleWhileRevalidate` |
| Skip cache | `bypass` prop | `bypass` prop | `cache.bypass` |

Three top-level cache-related props collapse to one nested object. That object reads like an HTTP `Cache-Control` header, which is a familiar mental model.

## What landed

- [x] Tracked accessors in `src/framework/context.ts`: `getCookie`, `getHeader`, `getSearchParam`, `getPathname`. Each pushes `kind:name` into the ALS-held `ManifestScope`.
- [x] `<Cache>` opens a fresh `ManifestScope` per call. Nested Partials get their own scope (ALS scopes stack naturally).
- [x] `manifestStore: Map<id+fp+ids-hash, Set<string>>` (process-local, in `cache.tsx`).
- [x] Key derivation: `${id}:${fp}:${djb2(ids.join(","))}:${djb2(stableStringify([manifestValues, vary]))}`.
- [x] `PartialProps.cache: CacheOptions | undefined` where `CacheOptions = {maxAge?, staleWhileRevalidate?, vary?, bypass?}`. Top-level `ttl` and `staleWhileRevalidate` props removed.
- [x] `HoistingViolationError`: synchronous throw inside `trackAccess` on added keys; post-render log+preserve on missing keys.
- [x] Three call sites migrated (`cache-demo`, `magento/product-list`, `pokemon` search stages). `cache-demo`'s `SlowContent` uses `getSearchParam` to demo auto-tracking.
- [ ] Lint rule (deferred — runtime check covers correctness; lint is ergonomics).

Tests:

- [x] Manifest population for cookie / header / url / pathname (`tracked-accessors.test.ts`).
- [x] Nested scopes attribute reads correctly (`tracked-accessors.test.ts`).
- [x] Hoisting violation throws with partialId + key + previous keys + suggested fix (`tracked-accessors.test.ts`).
- [x] First render with `stored: null` doesn't throw (`tracked-accessors.test.ts`).
- [x] Different URL params produce different cache entries (`cache-auto-tracking.spec.ts`).
- [x] Same URL param twice is a cache hit (`cache-auto-tracking.spec.ts`).
- [x] Cold-miss streaming still works through the manifest scope (existing `cache-miss-streaming-fallback.spec.ts` passes — confirms ALS propagation through `stream.tee()`).

## Open questions

- **`getRequest()` warning vs error.** Today it's the only way to read arbitrary request state. Promoting accessor surface to "the only tracked path" + warning on `getRequest` inside cached Partials seems right. Hard error feels too aggressive while the accessor surface is still small.
- **Manifest persistence.** Today's snapshotIndex is process-local; the manifest store has the same property. If we add a distributed entry store later, we either (a) ship manifests alongside entries (small, easy) or (b) accept first-render miss per process (acceptable, see the `existingSnapshots` check in `cache.tsx`).
- **What counts as the Partial's "body" for ALS scope.** Currently `Partial({...})` is sync and the user's content is rendered as children inside `<Cache>`. The manifest needs to span the user's component execution, not just the `Partial` function call. The cleanest scope is around the *content* render — open at the top of the cache miss path, close after content resolves. On a cache hit, no manifest open (we already have one stored).
- **Nested Partials and manifest scope.** A Partial inside another Partial gets its own manifest (its own id). The outer Partial's manifest does **not** include accessor calls made inside the inner Partial. Mechanically: the inner Partial opens its own ALS scope that shadows the outer one for the duration of its body. Need to validate this lines up with how AsyncLocalStorage nests in practice (it does — `als.run` creates a new context, returns to the outer on exit).
- **Server actions.** A server action that reads request state and returns `invalidate: { tags: [...] }` doesn't need a manifest — actions don't participate in caching directly. But if a future API ever caches action responses, the same model applies.
