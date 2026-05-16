# Cache internals

`<Cache>` is an internal wrapper applied when a spec sets `cache`
in its options. It sits between the spec's body and the rendered
output; authors don't render it directly.

## Auto-detect: streaming vs dynamic-refresh

Cached subtrees compose with inner partons OR stream — pick one,
and the cache picks automatically. The storage branch always
decodes the just-rendered tree and walks it for dynamic-wrapper
elements (PartialBoundary instances the framework emitted around
inner partons). The walk's result drives the path:

- **No dynamic wrappers found** → **streaming-preservation path**.
  Store the raw user-branch bytes verbatim. They retain Flight's
  natural Suspense pacing. On hit, the bytes feed the decoder
  through `flight-rewrite.ts`'s passthrough rewriter; inner
  Suspense boundaries stay lazy and resolve as bytes arrive. The
  outer Flight encoder sees them as suspended subtrees and streams
  them to the client incrementally.

- **Dynamic wrappers present** → **dynamic-refresh path**. Strip
  + re-encode like before. Each wrapper becomes a placeholder in
  the stored bytes; on hit, `reinjectDynamic` substitutes a fresh
  `<Component>` JSX call at each placeholder so the inner parton
  re-renders per request. Trade-off accepted: re-encoding flattens
  Suspense structure inside the cached region. Regions with inner
  partons typically have no internal streaming worth preserving
  (e.g. a product grid resolved from one async query; pricing
  inside is the dynamic bit kept live).

The streaming-preservation path was introduced together with
`<RemoteFrame>` (both consumers of `flight-rewrite.ts`); the
`/cache-streaming-demo` page validates it end-to-end.

## Strip + reinject (dynamic-refresh path)

When the auto-detect picks the dynamic-refresh path, two side-
tables back the strip + reinject machinery:

1. **Strip on store.** Walk the resolved tree; replace every
   `PartialBoundary` (and any element whose `key` resolves to a
   registered partial id) with a `<i hidden data-partial>`
   placeholder. Store the placeholder-bearing tree as Flight bytes
   via `renderAndBuffer`.
2. **Reinject on hit.** Decode the cached bytes back to a tree;
   walk it and replace placeholders with the current live
   `PartialBoundary` elements (static) or fresh `<Component>` JSX
   (dynamic). Inner partials render through their normal pipeline.

Two side-tables back this:

- **`store: CacheStore`** — bytes per cache key (default in-memory
  LRU, swappable for Redis / KV).
- **`snapshotIndex: Map<key, Map<id, snapshot>>`** — for each cache
  entry, the dynamic-partial snapshots registered during that
  render. On hit, those snapshots are re-registered into the
  current request's registry so `PartialRoot`'s cache-mode reads
  find them. Empty map on the streaming-preservation path (signal
  to the hit path to skip the resolveLazies walk).

## Cache key derivation

```ts
key = baseKey + ":" + hash(stableStringify([varyResult, options.vary]))
baseKey = `${spec.id}:${structuralFp}:${hash(innerPartialIds.sorted)}`
```

`hash()` is a 64-bit composite — two independent 32-bit mixers
(djb2-with-xor + FNV-1a) each run through MurmurHash3's `fmix32` and
concatenated to 16 hex chars (`framework/src/lib/hash.ts`).
`stableStringify` (`framework/src/lib/stable-stringify.ts`) canonicalizes the
hash input — distinct sentinels for `undefined` / `NaN` / `±Infinity`
/ `BigInt`, ms-encoded `Date`, sorted-content `Set` / `Map`, and
`<circular>` for self-referential structures so a malformed
`vary` result fails loudly instead of recursing forever.

`innerPartialIds` lives in `baseKey` so adding/removing an inner
partial inside the cached subtree invalidates the cache
automatically (the placeholder set the cached bytes hold no longer
matches the tree being rendered).

## Stale-while-revalidate

```ts
{ maxAge: 60, staleWhileRevalidate: 30 }
```

`Entry` carries `expiresAt` (now + maxAge*1000) and `staleUntil`
(expiresAt + swr*1000). On hit:

- `expiresAt > now` — fresh hit. Serve.
- `staleUntil > now` — stale-but-servable. Serve, kick off async
  refresh. The refresh runs in `refreshing: Set<string>` to dedupe
  thundering herds.
- Past both — miss.

## Miss path

`renderMissAndStore` tees the Flight stream of the stripped subtree:

1. **User branch** — decoded immediately, returned to the outer
   render. Inner Suspense boundaries stay lazy so the client paints
   fallbacks while async work resolves.
2. **Storage branch** — buffered, decoded, walked for dynamic
   wrappers. Branches on snapshot-map size:
   - Empty (no inner partons) → store the raw user-branch bytes
     verbatim. Streaming preserved on hit.
   - Non-empty → strip + re-encode via `renderAndBuffer`. Inner
     partons re-render fresh on hit.
   Runs in the background; doesn't block the user-facing latency.

Cold-miss dedupe lives in `inFlightMiss: Map<baseKey, Promise>` —
multiple concurrent requests for the same cold key share one
in-flight render.

## Slow-source diagnostic

`CacheOptions.slowSource: { perChunkMs, chunkBytes? }` (dev-only)
emits stored bytes through the hit-path decoder in fixed-size
chunks separated by a delay. Drove the validation work for the
streaming-preservation path: with raw bytes stored, slow replay
correctly staggers each inner Suspense reveal as its bytes arrive.
The same mechanism stands in for the latency profile a future
`<RemoteFrame>` fetches from a remote endpoint.

## Per-scope state

The cache, snapshot index, refresh set, and in-flight-miss map all
live under `ScopeState` keyed by `getScope()`. Production: every
request → `"default"` → one bucket. Dev: Playwright workers stamp
per-worker `x-test-scope` headers so parallel runs don't contend.

## HMR + clear

`vite:beforeUpdate` and `vite:beforeFullReload` fire `_clearCache()`
to drop every scope. Test-only `/__test/clear-caches` endpoint
forwards a per-request scope token (or `?all=1` for everything).
