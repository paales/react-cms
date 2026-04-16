# Server-side render-output caching — spike notes (2026-04-16)

Status: **working prototype**. Green across 44/44 vitest + 17/17 playwright.

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

- **Blocks the outer render until the subtree fully resolves.**
  `readAll` consumes the entire Flight stream before caching, so on
  a cold miss the outer render can't stream anything past the
  `<Cache>` until the subtree completes. For cached-on-hit this is
  instant, but cold-miss UX loses progressive streaming within the
  cached range. Mitigation for now: keep cacheable subtrees small
  and data-bound so the cold render is the only one that blocks.
  Future: if we ever splice Flight chunks directly into the outer
  stream (with row-id remapping), streaming within Cache becomes
  possible.
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
