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

1. `pendingInvalidations.has(id)` → return `undefined`.
2. `pendingWrites.get(id)` → return that snapshot.
3. `pendingHints.get(id)` → resolve to the variant in `partials`.
4. `hints.get(route)?.get(id)` → resolve to the canonical variant.

The canonical store is **immutable within a request** — writes
buffer into the pending sets and only land at commit. Two reads lean
on that. `getRouteSnapshots()` merges the route's committed hint with
the live overlay (invalidations delete, `pendingWrites` set) and is
the general route-snapshot view. The descendant fold instead reads
`getFoldBaseSnapshots()` — the committed hint snapshots with
`invalidations` applied but **no `pendingWrites` overlay** — and
memoizes it for the whole pass (keyed on the canonical store identity
+ routeKey). The overlay is omitted on purpose: React renders
top-down, so every ancestor folds before any descendant re-registers,
and an ancestor's fold never observes a descendant's this-pass
`pendingWrites` entry. Folding the overlay in would be a no-op, so the
base stays canonical-only and stable, which is what lets the fold
cache it once per pass instead of rebuilding per parton. See the
"Cold → warm fp drift" section in `render-pipeline.md`.

`commitRequestRegistry` runs on stream flush and atomically applies
the pending sets to the canonical store. Snapshots merge into
`partials[id][variantKey]` unconditionally — same structural
placement → same variant key → idempotent. The hint table is also
MERGED: `pendingHints` overlays the existing hint for the route,
with `ctx.invalidations` removing specific ids.

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
`ctx.invalidations`: server-side `getServerNavigation().reload({selector})`
calls bump the invalidation registry, and on commit the dispatcher
converts each bumped name into an id-wide invalidation
(`invalidateSnapshot(id)` clears every variant of the id and every
hint pointing at it). CMS edits flow through the same `reload()`
path.

## Invalidation

`invalidateSnapshot(id)` clears every variant of that id from the
variant store and every hint pointing at it. Server-side
`getServerNavigation().reload({ selector: "cart" })` bumps the
invalidation registry under the name `cart`; the meaning is "this
content has changed for every placement of any partial carrying
the `cart` label or id."

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
