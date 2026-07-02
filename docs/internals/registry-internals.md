# Partial registry internals

The registry powers cache-mode partial refetches by remembering
*where* every spec was placed on the rendered tree. It does not
remember *what* it rendered (no JSX, no rendered output) — that
lives in `<Cache>` (see [`cache-internals.md`](./cache-internals.md)).

## Storage shape

```ts
interface ScopeStore {
  // Deduplicated snapshot store: id → variantKey → snapshot.
  partials: Map<string, Map<string, PartialSnapshot>>
  // Hint table: which variant did the most-recent render for this
  // routeKey bind to each id. LRU on the outer Map.
  hints: Map<string, Map<string, string>>
}
```

Two layers:

1. **`partials`** — the snapshot store. Keyed by spec id and a
   *variant key* derived from the snapshot's structural fields.
   Snapshots that share the same structural placement collapse
   onto a single variant entry, regardless of which route or
   request triggered the registration.

2. **`hints`** — a per-routeKey index. Each entry maps `(routeKey,
   id) → variantKey` so cache-mode lookup can resolve "which
   variant of `cart` does this request want" without scanning the
   variant store. Bounded LRU (default 10 000 routeKeys).

   The routeKey is NOT the URL pathname — it's a hash of which
   registered URLPatterns match the URL's *base* (scheme + host +
   pathname; search and hash are stripped before matching — see
   `computeRouteKey` in `partial.tsx`). 50k product URLs that all
   match `/p/:slug` collapse to one routeKey, so they share a hint
   slot instead of evicting each other from the LRU. Spam to junk
   URLs that hit the same pattern can't displace real hot entries
   for the same reason. Search and hash are request dimensions
   *within* a page (tracked reads, matchKeys, and fingerprints carry
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
  return hash(stableStringify([
    snap.parentPath,
    snap.parentFrameChain,
  ]))
}
```

`hash()` is a 64-bit composite (16 hex chars; see `framework/src/lib/hash.ts`):
two independent 32-bit mixers (djb2-with-xor + FNV-1a) each finalised
through MurmurHash3's `fmix32` and concatenated. Pure JS keeps the
module graph portable across every runtime RSC might land on —
`node:crypto` triggers Vite's browser-externalisation warning
whenever the hash module reaches the client bundle, even indirectly.
Variant-key collision would cause cache-mode to reconstruct the
wrong snapshot for a given `(route, id)` lookup, so the 64-bit
composite is a correctness requirement, not a perf choice.

The variant key captures the **structural placement axes** that
distinguish two registrations of the same id:

| Axis | When it differs |
|---|---|
| `parentPath` | Same id mounted under different ancestors (e.g. `Header` under `PageRoot` vs under `EditorShell`) |
| `parentFrameChain` | Same id rendered inside vs outside a frame |

Per-instance content divergence (slot blocks bound to different CMS
rows, partials called with different JSX props) folds into the
spec's effective id via `__instanceId`, not into the variant key —
each instance registers under its own id (`spec.id:HASH` for
auto-derived instances, or the CMS row id for slot blocks).

Per-user variation (cookies, search params, A/B test buckets) is
*not* in the variant key — that divergence flows through the
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
  pendingWrites: Map<string, PartialSnapshot>  // id → snapshot
  pendingHints: Map<string, string>            // id → variantKey
  invalidations: Set<string>                   // id-wide invalidations
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
A CONCURRENT request must be able to see a partial before this
request's commit fires: an activator-driven refetch that lands while
the initial page's RSC stream is still flushing would otherwise hit
registry-miss and get a full streaming-mode response instead of its
targeted partial. The atomic prune/merge at commit still owns the
FINAL hint shape.

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
  *invalidation registry* (`refreshSelector`) under the name
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
  `pulse/*` scenarios gate it. The bump counter (`_currentTs` /
  `_waitForNextBump`) advances monotonically per bump, independent
  of what's stored.
- **Snapshot invalidation.** `invalidateSnapshot(id)` removes the
  id's registry records entirely (inside a request: buffered into
  `ctx.invalidations`, applied at commit; outside: direct canonical
  delete). For entries whose *placement* is gone — the next refetch
  for the id falls through to a streaming-mode re-render that
  re-registers it.

## LRU bound

The variant store is bounded by **spec topology** — finitely many
placement combinations exist for any given id. No LRU needed.

The hint table is bounded by **distinct routeKeys seen** — i.e. by
URLPattern combinations, not by URL cardinality. For a typical app
the working set is small (the number of pattern-set equivalence
classes is roughly the number of distinct page shapes), so the
`HINT_LRU_MAX = 10_000` cap is rarely approached. Eviction drops
a routeKey's hint entirely; the next refetch on a URL that hashes
to that routeKey falls through to streaming-mode (registry miss),
which re-registers and rebuilds the hint.

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
cache-mode refetches can spawn a spec component at the right point
in the tree without re-running its ancestors.
