# Server-side render-output caching — design notes

**Added:** 2026-04-16 (initial spike)
**Updated:** 2026-04-18 (post unified-path refactor — see `LESSONS_FROM_REFACTOR.md`)
**Files:** `src/lib/cache.tsx`

Status: **in use**. Shipped in the Magento demo wrapping `<ProductGrid>`
inside `<Partial id="products">`. See `e2e/cache-demo.spec.ts` and
`e2e/magento-cache-hit-renders-body.spec.ts` for regression coverage.

## The question

Could we cache the *rendered output* of a partial's subtree on the
server, keyed by declared input dependencies, and serve cached
bytes on subsequent requests instead of re-executing the component?
The existing client-side template/cache merge (`partial-client.tsx`)
already assembles cached partials into a response, but it's done on
the browser after the server re-renders fresh. We wanted the server
itself to skip the work.

Prior research (see `STREAMING_DEBUG_NOTES.md` history + a prior
spike conversation) landed on "possible but needs Flight-buffer
machinery we don't have." **That was wrong** — the machinery is
already exported by `@vitejs/plugin-rsc`.

## The unlock

`@vitejs/plugin-rsc/rsc` exports **both** sides of the Flight pipeline:

```ts
import {
  renderToReadableStream,      // encode: ReactNode → Flight bytes
  createFromReadableStream,    // decode: Flight bytes → ReactNode
} from "@vitejs/plugin-rsc/rsc";
```

Internally (`node_modules/@vitejs/plugin-rsc/dist/react/rsc.js`) these
are `ReactServer.renderToReadableStream` and
`ReactClient.createFromReadableStream`, the latter wired up with the
plugin's serverConsumerManifest and moduleMap. That means an RSC
server component can render a child subtree to Flight, buffer those
bytes, and later round-trip them back into a React element tree —
all within the RSC environment, in-process.

Earlier research had claimed "no server-side `createFromReadableStream`
in the RSC environment." That was reading the vendored
`react-server-dom-webpack-server.edge.development.js` and missing
that plugin-rsc composes it with the client-edge decoder in its
`react/rsc.js` wrapper. Chasing the actual plugin surface instead of
raw react-server-dom would have caught this earlier.

## The component

`src/lib/cache.tsx` exports `<Cache dep ttl staleWhileRevalidate bypass>`:

```tsx
<Partial id="products">
  <Cache id="products-list" dep={{ q, locale }} ttl={60} staleWhileRevalidate={300}>
    <ProductList q={q} locale={locale} />
  </Cache>
</Partial>
```

Flow:

1. Compute `key = "<id>:<djb2(stableStringify(dep))>"`.
2. **Fresh hit** (`now < expiresAt`): read bytes, decode via
   `createFromReadableStream`, return the tree.
3. **Stale hit** (`expiresAt < now < staleUntil`): same as above,
   *plus* fire-and-forget a background re-render that replaces the
   stored bytes with fresh ones when it completes. A per-key
   `refreshing` set dedupes concurrent SWR refreshes.
4. **Miss**: render children via `renderToReadableStream`, buffer
   all chunks with `readAll`, store, decode the buffer back into a
   tree, return. A per-key `inFlight` promise dedupes concurrent
   misses so only one render runs.

Store: in-memory `Map<key, {bytes, expiresAt, staleUntil}>`. LRU via
Map insertion order (re-insert on touch, evict oldest when size
exceeds 10 000). No persistence. Cleared on Vite HMR in dev
(`vite:beforeUpdate` / `vite:beforeFullReload`) to avoid stale
module-id references in cached bytes.

## What was validated in the spike

- **Cache hits are fast.** Cold miss: ~520ms (includes a deliberate
  500ms delay). Warm hit: ~15ms. 30× speedup.
- **Cache key by `dep` works.** Same dep → hit. Different dep →
  miss, independent entry.
- **Cached subtree skips its component body.** Counter incremented
  inside the slow server component stays stable across all hits of
  the same dep (`data-render-count` test).
- **Partial refetch respects the cache.** `?partials=slow` on a
  cache hit → 10ms. Underlying server component body does not run.
- **Client components survive the round-trip.** A `"use client"`
  `<ClickCounter>` nested inside a cached subtree serializes to
  Flight as a module reference, decodes back as a client-ref
  element, and hydrates normally on the client. Clicks update
  state. Same behavior on cache hits as on first-render.
- **Other partials stay fresh.** The demo's `<Clock>` (not
  Cache-wrapped) emits a new server timestamp on every request
  while the Cache-wrapped partial serves stored content.
- **Composes with `<Partial fallback={…}>`.** Cache lives inside the
  Partial; the Partial's Suspense boundary still wraps as normal.

## What it can't do (yet / limits)
- **No tag-based invalidation.** Per user decision — not in this
  spike. Only TTL + LRU + HMR-reset + SWR. A tag layer would add a
  reverse map `Map<tag, Set<cacheKey>>` and a `revalidateTag()`
  function; slotted in where `partial-cache.ts` already invalidates
  for the existing data-layer cache.
- **In-memory, per-process.** Dies on restart. Appropriate for a
  research framework; a Redis backend would need a `CacheStore`
  interface + build-version prefix for cross-deploy invalidation.
- **No per-request dedupe with React.cache().** If two Cache entries
  end up hitting the same downstream data fetch, each subtree
  renders it independently. Not a regression vs. no Cache, but
  doesn't stack with React's per-request memoization unless the
  user layers both.
- **Module-id staleness on deploy.** Cached Flight bytes encode
  client-component module ids. In dev we flush on HMR; in
  production we don't have a build-version prefix yet. A deploy
  that changes a client component's id would point cached bytes at
  a non-existent module. Two fixes when it matters: prefix every
  key with `process.env.BUILD_ID` (or equivalent), or clear on
  startup.
- **No stampede protection across processes.** In-flight dedupe is
  per-process. Under load across multiple server instances, a cold
  key can be computed concurrently by each. Acceptable for now.

## Where the design choices fell

**`id` prop is required** alongside `dep`. Same reason `<Partial>`
requires an id: the walker needs a stable identifier per cache
boundary. Two different Caches with the same `dep` at different
locations in the tree would otherwise collide.

**`dep` is a plain object**, not a callback. Discussed at length in
the design conversation — callbacks are invisible to any static
walker (the Partial walker's rule), and `dep` returns a plain value
anyway, so there's no JSX for a callback to hide. Inline props are
simpler.

**`ttl` is seconds, `Infinity` (undefined) means no expiry.** Matches
HTTP `Cache-Control: max-age` semantics. `staleWhileRevalidate` is
additional seconds after `ttl`; mirrors the same HTTP directive.
Both can be set together: `ttl=60, swr=300` means fresh for 60s,
served stale + async-refreshed for 240 more seconds, then miss.

**Client components** don't need special handling. They serialize as
module references inside the Flight bytes; decoding reassembles the
reference tree; outer render re-serializes; client hydrates
normally. The manifest is shared across all renders in one process.

## Files

- `src/lib/cache.tsx` — the `<Cache>` component + store + SWR +
  HMR invalidation. ~180 lines.
- `src/app/pages/cache-demo.tsx` — demo page at `/cache-demo`
  with two partials: a Cache-wrapped slow component and a bare
  clock partial.
- `src/app/components/cache-controls.tsx` — client buttons for
  refetch / flavor toggle.
- `src/app/components/click-counter.tsx` — client component inside
  the cached subtree, proves hydration.
- `e2e/cache-demo.spec.ts` — 6 tests: hit/miss, partial-refetch,
  non-cached partial stays fresh, cold-vs-warm timing, hydration on
  cold, hydration after cache hit.

## Open questions for the next session

1. **Streaming within a cached subtree on cold miss.** Worth it? The
   row-id remap is non-trivial; the workaround ("keep cached
   subtrees small") works for most realistic cases. Revisit if a
   real use-case shows up.
2. **Tag invalidation.** Easy to add. Likely wants to unify with
   existing `<Partial tags>` — same tag can both activate a
   partial and invalidate its cache.
3. **Integration into existing pages.** The pokemon page's
   `<HeroPartial>` / `<SpeciesPartial>` are good candidates — they
   fetch graphql-cached data but still re-render on every refetch.
   Wrapping them in `<Cache dep={{pokemonId}}>` would make
   pokemon-id-keyed refetches instant.
4. **Production build-version prefix.** When we first deploy this
   beyond dev, we need a key prefix that changes per build to
   invalidate cached module ids.
5. **Does `renderToReadableStream(children)` actually stream, or
   does it eagerly resolve everything?** The `readAll` consumes the
   whole stream before returning bytes. If renderToReadableStream
   started flushing partial chunks as inner work completed, we'd be
   capturing those progressively. Worth looking at the actual
   behavior to confirm.

---

## Follow-up (2026-04-16) · `<Cache>` + `<Partial>` composition

### The problem

Wrapping a `<Partial>` inside a `<Cache>` naïvely freezes the
partial's content inside the cached Flight bytes — subsequent
refetches of the partial served the stale bytes until the Cache
entry expired. The whole point of a `<Partial>` (live, refreshable
slice) conflicts with the whole point of `<Cache>` (stable
snapshot).

### The fix: strip-on-store + reinject-on-return

Before serializing children to bytes, walk the tree and replace
every partial-bearing subtree with a placeholder (`<i hidden
data-partial key={id}/>` — same shape `<Partial>` emits when it
decides to skip). Store *that* template. On output, walk the decoded
tree and swap placeholders back to the **live** partial elements
from the current render.

Recognition rules for a partial-bearing subtree (in
`stripPartials`):
1. Element is a `<PartialBoundary>` (the self-wrap emitted by
   `<Partial>` — see `DYNAMIC_PARTIAL_REGISTRY.md`).
2. Element is an existing `<i data-partial>` placeholder (cache-mode
   refetch templates already have these).
3. Element has a `partialId` prop matching a known id in the
   route-scoped registry (the partial wrapper emitted by
   `<Partial>` — a keyed `<Suspense>` or `<PartialErrorBoundary>`).

The cache key folds in the **sorted list of partial ids** inside
the subtree (`hashDep([dep, ids])`). Adding or removing a partial
inside a cached region invalidates the entry automatically.

### The lazy-ref snag (must-read)

On a cache hit, `createFromReadableStream(bytesToStream(bytes))`
returns the root before the nested chunks are fully parsed. Those
unresolved lazy refs leaked into the outer Flight stream and
silently truncated downstream walkers on SSR, producing
**empty-body HTML** on the second `/magento` GET. Fix: after
decode, `await resolveLazies(decoded)` walks every chunk-lazy to
completion before returning from `<Cache>`. Both cold-miss and
warm-hit paths now hand back an equivalent, fully-materialized
tree. See `STREAMING_DEBUG_NOTES.md · 2026-04-16 · Lazy-ref
truncation` for the full trace.

The client-side `substituteNested` had the same blind spot for
dynamic partials nested inside a cached static-partial subtree.
Same `unwrapLazy` treatment applied there.

### Dynamic partials survive through `<Cache>`

Cache's strip only finds what's reachable through the static
`children` chain. A Partial produced inside an opaque function
component (e.g. `ProductList.map(p => <Partial id={"price-" +
p.sku}/>)`) isn't visible at strip time. **That's fine**: the
dynamic partial renders once, gets baked into the cached bytes,
and the client's `substituteNested` — walking the cached `products`
subtree on refetch — finds the keyed `<Suspense>` there and swaps
in the fresh content from the partial cache. No extra server work.

### API addition: `bypass={true}`

Skips the cache for a single render. Useful during development
when you want to observe the component's fresh output without
nuking the whole cache. Present in the type signature; cache-demo
doesn't exercise it directly but `MagentoPage` uses it during
iteration.

---

## Follow-up (2026-04-19) · streaming within cached subtree on cold miss

### The problem

Cold-cache loads of `/magento` stalled the whole page for ~1s
before any content — including `LivePriceFallback` Suspense fallbacks
inside `ProductGrid` — painted. Warm hits worked fine: decode-on-hit
returns a tree whose live holes re-run per request, so inner Suspense
fallbacks stream naturally.

Root cause: on miss, `<Cache>` called `renderToReadableStream`, then
`readAll` to buffer every byte before decoding. `readAll` only resolves
when the stream closes, which means every inner Suspense chunk has
already completed. By the time Cache returned, its subtree was fully
resolved — the outer render never saw a pending boundary to suspend on.

### The fix: `stream.tee()` split

`renderMissAndStore` now tees the inner Flight stream:

1. **User branch** — decoded immediately with `createFromReadableStream`.
   Inner Suspense boundaries stay as lazy refs; the outer Flight
   serializer re-emits them as lazy chunks. Client paints fallbacks
   until each chunk streams in. The render side-effects (Partial
   self-registration) still happen inline because the inner render
   proceeds whether or not someone buffers its output.
2. **Storage branch** — buffered with `readAll` in a background task,
   decoded, `resolveLazies`'d, stripped of dynamic Partial wrappers,
   re-encoded as hole-only bytes, and stored. The current response
   returns without waiting on this; subsequent hits see the stored
   entry as soon as the task completes.

Regression coverage: `e2e/cache-miss-streaming-fallback.spec.ts`
asserts the fallback paints >400ms before the content resolves, on
both cold and warm loads.

### Limits that carry over

- `reinject` (static-partial re-injection) walks the decoded tree but
  does not descend into lazy chunks. A `<Partial>` placed inside an
  async component's children — where the rendered placeholder ends up
  inside a Suspense chunk — would not be reinjected on a streaming
  miss. None of the current demos exercise that shape; add a dedicated
  test if it ships.
- The background storage task runs one extra re-encode (hole-only
  bytes) per miss. Acceptable: misses are once per key, and hit-path
  decode is tiny after that.
