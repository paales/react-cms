# Partial registry internals

The registry powers isolated per-parton re-renders (the lane pass's
`partialFromSnapshot` reconstruction) by remembering
_where_ every spec was placed on the rendered tree. It does not
remember _what_ it rendered (no JSX, no rendered output) — that
lives in `<Cache>` (see [`cache-internals.md`](./cache-internals.md)).

## Storage shape

```ts
interface ScopeStore {
  // Deduplicated snapshot store: id → variantKey → snapshot.
  partials: Map<string, Map<string, PartialSnapshot>>
  // Hint table: which variant did the most-recent render for this
  // routeKey bind to each id. LRU on the outer Map.
  hints: Map<string, Map<string, string>>
  // Content generation + the `_readSnapshotsForRoute` memo (below).
  gen: number
  routeSnapshots: Map<string, { gen: number; map: Map<string, PartialSnapshot> }>
}
```

Two layers:

1. **`partials`** — the snapshot store. Keyed by spec id and a
   _variant key_ derived from the snapshot's structural fields.
   Snapshots that share the same structural placement collapse
   onto a single variant entry, regardless of which route or
   request triggered the registration.

2. **`hints`** — a per-routeKey index. Each entry maps `(routeKey,
id) → variantKey` so an isolated lookup can resolve "which
   variant of `cart` does this request want" without scanning the
   variant store. Bounded LRU (default 10 000 routeKeys).

   The routeKey is NOT the URL pathname — it's a hash of which
   registered URLPatterns match the URL's _base_ (scheme + host +
   pathname; search and hash are stripped before matching — see
   `computeRouteKey` in `partial.tsx`). 50k product URLs that all
   match `/p/:slug` collapse to one routeKey, so they share a hint
   slot instead of evicting each other from the LRU. Spam to junk
   URLs that hit the same pattern can't displace real hot entries
   for the same reason. Search and hash are request dimensions
   _within_ a page (tracked reads, matchKeys, and fingerprints carry
   them), so a
   search-constrained pattern (`match: { search: "*q=:query" }`)
   never splits its page's bucket — a search overlay's `?q=`
   refetches keep finding the snapshots and hints the page's earlier
   renders committed. URLs whose base matches no pattern share a
   single `__no-pattern` sentinel routeKey — those requests never
   commit anyway (`notFound()` throws past the commit), so the
   sentinel is a read-side fallback.

## Variant key

```ts
function variantKeyOf(snap: PartialSnapshot): string {
  const base = hash(stableStringify([snap.parentPath, snap.parentFrameChain]))
  return snap.culled ? culledKey(base) : base
}
```

`hash()` is a 64-bit composite (16 hex chars; see `framework/src/lib/hash.ts`):
two independent 32-bit mixers (djb2-with-xor + FNV-1a) each finalised
through MurmurHash3's `fmix32` and concatenated. Pure JS keeps the
module graph portable across every runtime RSC might land on —
`node:crypto` triggers Vite's browser-externalisation warning
whenever the hash module reaches the client bundle, even indirectly.
Variant-key collision would cause an isolated re-render to
reconstruct the
wrong snapshot for a given `(route, id)` lookup, so the 64-bit
composite is a correctness requirement, not a perf choice.

The variant key captures the **structural placement axes** that
distinguish two registrations of the same id:

| Axis               | When it differs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentPath`       | Same id mounted under different ancestors (e.g. `Header` under `PageRoot` vs under `EditorShell`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `parentFrameChain` | Same id rendered inside vs outside a frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `culled`           | A cullable spec's culled render (the gate skipped the body; deps are the gate's reads) vs its in-view one — the REGISTRY-INTERNAL `~cull` suffix (`lib/cull-key.ts`; it never crosses the wire — the client has no culled cache variant, the skeleton rides inline on the pair). Per-state snapshots keep each state's dep record intact, so a culling flip's fingerprint folds the record of the state it is ENTERING (`lookupPartial(id, culled)`), not whichever state rendered last. See [render-pipeline.md](./render-pipeline.md#cull-to-park). |

Per-instance content divergence (slot blocks bound to different CMS
rows, partials called with different JSX props) folds into the
spec's effective id via `__instanceId`, not into the variant key —
each instance registers under its own id (`spec.id:HASH` for
auto-derived instances, or the CMS row id for slot blocks).

Per-user variation (cookies, search params, A/B test buckets) is
_not_ in the variant key — that divergence flows through the
spec's tracked reads, whose VALUES are never stored: the snapshot
records only the dep keys, re-read per-request inside the spec
component (store-and-reread). Two concurrent users hitting the same
route register structurally identical snapshots → idempotent
overwrite, no clobbering.

## Pending vs canonical state

A request opens a `RequestRegistry` (via `enterRequestRegistry`)
and accumulates work in three sets:

```ts
interface RequestRegistry {
  pendingWrites: Map<string, PartialSnapshot> // id → snapshot
  pendingHints: Map<string, string> // id → variantKey
  invalidations: Set<string> // id-wide invalidations
  // ...
}
```

Lookups during the request's render see pending state first, then
fall back to the route's committed hint:

1. `ctx.invalidations.has(id)` → return `undefined`.
2. `pendingWrites.get(id)` → return that snapshot.
3. `pendingHints.get(id)` → resolve to the variant in `partials`.
4. `hints.get(routeKey)?.get(id)` → resolve to the canonical variant.

Registration is double-written. `registerPartial` buffers into the
pending sets AND eagerly publishes the variant + hint entry to the
canonical store — additive only, freshness-guarded (`_seq`, below).
A CONCURRENT render must be able to see a partial before this
request's commit fires: a targeted lane (an activator-driven refetch,
a viewport flip) firing while the initial page's stream is still
flushing would otherwise hit registry-miss and fall back to a
whole-tree segment instead of its targeted lane. The atomic
prune/merge at commit still owns the FINAL hint shape.

Two fold reads rely on per-pass stability. `getRouteSnapshots()`
merges the route's committed hint with the live overlay
(invalidations delete, `pendingWrites` set) and is the general
route-snapshot view. The descendant fold instead reads
`getFoldBaseSnapshots()` — a per-pass MATERIALIZED map of the
committed hint snapshots with `invalidations` applied but **no
`pendingWrites` overlay** — memoized on the ctx (keyed by canonical
store identity + routeKey), so this pass's eager publishes never
shift it mid-fold. The overlay is omitted on purpose: React renders
top-down, so every ancestor folds before any descendant re-registers,
and an ancestor's fold never observes a descendant's this-pass
`pendingWrites` entry. Folding the overlay in would be a no-op, so the
base stays canonical-only and stable, which is what lets the fold
cache it once per pass instead of rebuilding per parton. See the
"Cold → warm fp drift" section in `render-pipeline.md`.

`commitRequestRegistry` runs on stream flush — once per ctx, via the
`committed` latch — and applies the pending sets to the canonical
store. Snapshots merge into `partials[id][variantKey]` — same
structural placement → same variant key → idempotent, subject to the
freshness guard below. The hint table is also MERGED: `pendingHints`
overlays the existing hint for the route, with `ctx.invalidations`
removing specific ids. The stream wrappers first
`Promise.allSettled` the ctx's `pendingDefers` list — `<RemoteFrame>`
registers a promise there so the remote's trailer snapshots are in
the pending sets before commit runs.

### Registration-sequence freshness guard

Every snapshot is stamped with a process-wide monotonic registration
sequence (`_seq`) by `registerPartial`, and every canonical variant
write — the eager publish inside `registerPartial`, the no-context
direct write (HMR / prerender), and the commit-time merge — keeps the
newest registration: a stored snapshot with a higher `_seq` than the
incoming one wins (`isStale`).

The guard exists because commit time is decoupled from registration
time. A long-lived connection's registry context commits when the
connection **closes** — after any number of interleaved targeted
refetches have committed fresher records for the same variants. An
unguarded overwrite would let that late commit clobber the fresher
snapshot — losing, e.g., dep keys the newer render recorded, which
then breaks fp-skip against the trailer's healed fps. Ordering by
registration sequence (not commit order) keeps the canonical record
at the newest render regardless of which connection flushes last.

Wholesale-replace (overwriting the hint with `pendingHints`) looks
appealing for the streaming-mode case — pendingHints is an
authoritative snapshot of what just rendered — but it breaks the
fp-skip cascade. When an ancestor spec fp-skips, the skip path's
`<PartialBoundary>` registers the ancestor's snapshot, but the body
never runs, so descendants never get a chance to register. Their
entries from the prior commit aren't in `pendingHints`, and replace
would wipe them. The next request reads an eroded canonical
(missing the descendants of every fp-skipped ancestor),
`computeDescendantFold` returns a partial value, the ancestor's fp
drifts away from what the trailer shipped, and `shouldSkip` starts
mis-firing further up the tree. Merging keeps the prior commit's
descendant entries alive as long as the ancestor stays on the page.

Stale entries that legitimately need removal flow through
`ctx.invalidations` via `invalidateSnapshot(id)` — an id-wide drop
of every variant and every hint pointing at it, applied at commit.

## Invalidation — two channels

Content changes and record removal are separate mechanisms:

- **Fingerprint invalidation** (the live path). Server-side
  `getServerNavigation().reload({ selector: "cart" })` bumps the
  _invalidation registry_ (`refreshSelector`) under the name
  `cart`: every placement carrying the `cart` label or id folds the
  bump's timestamp into its fp (`|inv=`), mismatches the client's
  cached fp, and re-renders fresh on the next pass. Snapshots stay —
  the registry record is structural placement, which a content
  change doesn't move. Cell writes and CMS edits ride this channel.

  The invalidation registry is compacted latest-per-key: ONE entry
  per (name, canonical-constraints) pair —
  `Map<name, Map<stableStringify(constraints), {name, constraints, ts}>>`
  — and a same-pair bump overwrites that entry's `ts` in place.
  Lossless by construction: every consumer reads through
  `queryMatchingTs` (the MAX `ts` whose name matches and whose
  constraints are a subset of the fold's constraint surface), and two
  same-pair entries match exactly the same surfaces, so the newer
  `ts` subsumes the older for every possible query. Storage is
  bounded by live (name × constraint-tuple) cardinality, never by
  bump count — a ticker bumping one partition every 100ms holds one
  entry no matter how long the server has been up. The website's
  `world.pulse` (up to 512 partitions under one selector name,
  bumping every 0.1–5s) is the motivating shape; the bench's
  `pulse/*` scenarios gate it. The bump counter (`_currentTs`)
  advances monotonically per bump, independent of what's stored.

  The query itself is KEYED, not scanned. Because the per-name map is
  keyed by `stableStringify(constraints)`, the set of keys an entry
  could be stored under and still match a given surface is
  enumerable up front: per surface key, the matching constraint
  values collapse to at most two canonical encodings (the string-loose
  form `String(v)` and, for non-string values, the type-exact
  `stableStringify(v)` — see `constraintProbeKeys`), and an entry's
  constrained keys must be a subset of the surface's, so the probe
  set is the fragment product over every subset (`"{}"`, the bare
  entry, included). `queryMatchingTs` probes those keys directly —
  per label, whichever exact strategy touches fewer entries: the
  probes or the linear `matchesConstraints` scan (also the fallback
  for surfaces past `PROBE_SUBSET_CAP` keys, where the product would
  explode). A partition-heavy name (`world.pulse`'s 512 entries) is
  therefore a handful of map hits per query, not a scan. Compiled
  surfaces are memoized per snapshot (`_compileSurfaceQuery`, WeakMap
  in `segment-relevance.ts`), shared by the fp fold, the reservation
  scan, and the wake-index registration.

  **The wake side is the same keying, inverted.** A live connection
  holds one persistent subscription in the **inverted wake index**
  (`_openWakeSubscription` et al.): each route snapshot registers its
  parton id under every `(name, constraintsKey)` address in
  `labels × constraintProbeKeys(surface)` — exactly the keys a
  matching entry could be stored under, so the probe-key equivalence
  proven for the query holds unchanged for delivery. `commitOne`
  looks up `(name, stableStringify(constraints))` and pushes the
  registered parton ids into each hit subscription's pending set —
  the segment driver's bump wake says "these ids changed", not
  "something changed, go look". A bump nothing registered touches no
  connection: parked drivers stay parked (the soak bench's idle
  µs/bump is a map miss, independent of N). Over-cap surfaces land in
  a per-connection scan set, checked per bump only against those
  entries. Each registration also carries its lane CARRIER and the
  carrier's park gates (cull-gated ancestor ids): a delivery whose
  carrier is parked records into the pending set without waking —
  the flip-in revalidation is the parked parton's catch-up — unless
  the carrier holds an assigned consequence seq (the driver must void
  it promptly). Subscriptions are diffed against the route snapshot
  map while the driver is awake (`_syncRouteWakeSubscription`,
  pointer-diff per id) and removed wholesale at connection close;
  compaction needs no change (entries and registrations share the
  keying, and a subscription outliving its entries is a lookup miss).

- **Snapshot invalidation.** `invalidateSnapshot(id)` removes the
  id's registry records entirely (inside a request: buffered into
  `ctx.invalidations`, applied at commit; outside: direct canonical
  delete). For entries whose _placement_ is gone — the next render
  covering the id is a whole-tree pass that re-registers it.

## LRU bound

The variant store is bounded by **spec topology** — finitely many
placement combinations exist for any given id. No LRU needed.

The hint table is bounded by **distinct routeKeys seen** — i.e. by
URLPattern combinations, not by URL cardinality. For a typical app
the working set is small (the number of pattern-set equivalence
classes is roughly the number of distinct page shapes), so the
`HINT_LRU_MAX = 10_000` cap is rarely approached. Eviction drops
a routeKey's hint entirely; the next targeted render on a URL that
hashes to that routeKey falls through to a whole-tree segment
(registry miss), which re-registers and rebuilds the hint.

## The `_readSnapshotsForRoute` memo

`_readSnapshotsForRoute(scope, routeKey)` — the ALS-free canonical
read every segment-driver hot path takes (wake drains, lane scoping,
park checks, warm passes, the fp-trailer flush) — is memoized per
(store, routeKey) on the store's **content generation** (`gen`,
bumped by every registration's eager publish, every commit, and
every canonical invalidation). Between mutations, repeated reads
return the SAME map instead of rebuilding a world-sized route's
thousands of hint lookups per call; any mutation invalidates every
memo entry at once (the generation check), so the map can never be
stale. The memo is a small per-store LRU
(`ROUTE_SNAPSHOT_MEMO_MAX = 32` routeKeys — the hot set is the
handful of routes with held connections). Callers treat the returned
map as immutable: all registry writes go through the API, which
bumps the generation.

## What snapshots intentionally do not capture

- **Tracked-read VALUES** — the snapshot stores dep KEYS (`deps`),
  never the values behind them; every fold re-reads the keys at the
  current request (store-and-reread).
- **JSX / rendered output** — `<Cache>` owns rendered-output
  caching, keyed independently by the spec's fingerprint + match
  params.
- **Per-request scalars** (cookies, headers, URL params) — these
  flow through tracked hooks and re-resolve per request.

The snapshot is a structural-placement + dependency-key record so
an isolated lane render can spawn a spec component at the right point
in the tree without re-running its ancestors.
