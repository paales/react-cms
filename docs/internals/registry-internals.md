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
  // Content generation + the `_readSnapshotsForRoute` memo (below);
  // each memo entry also carries the route's parent→children index.
  gen: number
  routeSnapshots: Map<
    string,
    { gen: number; map: Map<string, PartialSnapshot>; descendants: Map<string, Set<string>> }
  >
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
| `parentPath`       | Same id mounted under different ancestors. Reachable only by CALLER-SUPPLIED `__instanceId` ids (slot wiring — e.g. one CMS row's block registered under `PageRoot` on one route and under `EditorShell` on another; per-route hints point each route at its variant), which skip the placement fold. An id minted from the spec folds the parent path into the effective id itself (see "Effective-id identity" below), so its placements never share an id.                                                                                         |
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

## Effective-id identity

The id every registration (and wire wrapper, client cache slot,
fp-trailer entry) keys on is minted per placement by the identity
ladder in `createSpecComponent` (partial.tsx). Its stem is the spec's
catalog id — the Render function's NAME, kebab-cased with one trailing
`Render` / `Page` / `Block` / `Partial` / `Component` suffix stripped
(`PokemonHeroRender` → `"pokemon-hero"`; `displayName` wins over
`name`, which is how a factory minting one spec per variant names each
product explicitly). An anonymous Render throws at construct time —
the auto-derived id IS the spec's stable identity, and there is
nothing stable to derive it from (`autoSpecId`). The ladder:

1. **`__instanceId`** — verbatim (slot wiring; snapshot replay passes
   the stored, already-folded id back through it, which is what keeps
   the fold idempotent across streaming render and targeted refetch);
2. **props-hash** — `spec.id:hash(extraProps)` when the call site
   passes JSX props;
3. **placement fold** — an id minted from the spec composes a trailing
   `~hash(stableStringify([parent.path, parent.frameChain]))` on top of
   legs 2/4 whenever either axis is non-empty (`applyPlacementFold`).
   Two placements of one spec under different parents — or inside
   different `<Frame>`s — mint distinct ids — one instance per
   placement, instead of two positions fighting over one
   `(id, matchKey)` slot (hydration mismatch, route-hint flips,
   churning trailer heals; for frame divergence, one placement's
   cached content confirmed against the other's, since the frame folds
   into the fp but not the matchKey). Root-level unframed placements
   stay bare, so page chrome keeps ONE id across routes and its
   cross-route fp-skip credit; a spec under different parents on
   different routes pays one over-fetch per distinct parent chain
   instead (over-fetch, never stale — pinned by
   `cross-route-chrome-substitution.test.tsx`). The `~` grammar is
   framework-reserved (the embed namespace claims it; app ids must not
   use it), so `stripPlacementFold` — the matchKey ancestor walk's
   strip — is a protocol signal, not a guess. Labels are never folded:
   they stay class-level fan-out targets. The one placement axis
   deliberately NOT folded is sibling position: two same-props
   siblings under the same parent and frame chain still share an id —
   index-based identity would churn ids on every reorder, a worse
   trade; give such siblings distinguishing props.
4. **the bare spec id** — root-level singleton.

Leg 1 ids skip the fold: a caller-supplied `__instanceId` is
caller-managed identity, and snapshot replay hands the stored —
already-folded — id straight back through it, which is what keeps the
fold idempotent across streaming render and targeted refetch.

The effective id is what the wire, the registry, and the client cache
key on. It is NOT what a Render sees: the wrapper forwards
`__instanceId` on to the Render UNDECORATED — the caller-managed key
with the embed-namespace prefix and the placement-fold suffix stripped
(`stripPlacementFold(stripEmbedNamespace(...))`, both parsing the
reserved `~` grammar). A Render's per-instance work is
placement-independent — a `block()` reads the same CMS row wherever it
is placed (`__instanceId ?? spec.id` is its content key, see
[`../reference/cms.md`](../reference/cms.md)) — so the key must resolve
identically on both sides of the fp-skip handshake. The two paths hand
the prop in decorated differently: a streaming render mints the
decorations after deriving the key, while replay hands its stored,
fully decorated id back through leg 1. Undecorating reconciles them.
Labels follow the same rule for the same reason: a block's
`cms:<contentKey>` dep + tag stay bare, so an editor write's
`refreshSelector("cms:<key>")` keeps reaching every placement of the
row it edited.

Catalog ids themselves are collision-gated one level up:
`registerSpec` (spec-catalog.ts) throws when a second DISTINCT spec
claims a live id in the same code generation, naming both definition
sites. The generation (`currentCodeVersion()`, lib/code-version.ts) is
what admits HMR: `vite:beforeUpdate` bumps it BEFORE the edited module
re-evaluates, so a re-registration carries a newer generation and
replaces silently. Prod's generation never moves — a duplicate id
fails at module init, at deploy time. `componentById` (partial.tsx)
writes in lockstep, after the claim succeeds.

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

- **Fingerprint invalidation** (the live path). `refreshSelector(name)`
  bumps the _invalidation registry_ under `name` — a server function's
  `refreshSelector("cart")`, or the `cell:<id>?<partition>` selector a
  cell write fans out. Every snapshot whose `labels` carry the name
  (subject to the constraint subset match below) folds the bump's
  timestamp into its fp (`|inv=`), mismatches the client's cached fp,
  and re-renders fresh on the next pass. Snapshots stay — the registry
  record is structural placement, which a content change doesn't move.
  Cell writes and CMS edits ride this channel.

  A snapshot's `labels` are exactly its invalidation SUBSCRIPTIONS,
  and the parton's own reads are what write them: `cell:<id>` per cell
  it resolved (a prop-borne one, a schema one, or an in-body
  `cell.resolve()` — the last recorded as a dep and folded into labels
  at boundary registration), plus the bare name of every `tag()` it
  read. Nothing is declared — the read IS the subscription, so a
  culled parton, which resolves no cells, carries no `cell:` label and
  stays dark to cell invalidation until it flips back in. Constraints
  ride beside the labels in the snapshot's effective constraint
  surface (match params + bound-cell args), which is what makes a
  partition-scoped bump (`cell:<id>?sid=7`, a constrained
  `tag("price?sku=ABC")`) reach only the placements whose surface
  holds the pair, while the bare name fans out to every reader.

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
  entry no matter how long the server has been up. The motivating
  shape was the website's world pulse in its retired ticker form
  (hundreds of partitions under one selector name, bumping every
  0.1–5s; the pulse is DERIVED now — anchor + `expires()` cadence,
  no bumps — see `docs/notes/leases.md`); the bench's `pulse/*`
  scenarios gate it. The bump counter (`_currentTs`)
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
  explode). A partition-heavy name (hundreds of entries under one
  selector) is therefore a handful of map hits per query, not a
  scan. Compiled
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
  pointer-diff per id) and removed wholesale at connection close.
  The same diff maintains the connection's **deadline wheel** — the
  time twin of the index: each snapshot's declared `expires()`
  boundary slots onto the 25ms grid, and one head-slot timer fires
  due ids into the same pending set through the same park gating
  (see [`streaming.md`](./streaming.md) §How a live update lands).
  Compaction needs no change (entries and registrations share the
  keying, and a subscription outliving its entries is a lookup miss).

- **Snapshot invalidation.** `invalidateSnapshot(id)` removes the
  id's registry records entirely (inside a request: buffered into
  `ctx.invalidations`, applied at commit; outside: direct canonical
  delete). For entries whose _placement_ is gone — the next render
  covering the id is a whole-tree pass that re-registers it.

### Persistence / eviction / restore (cell entries)

`cell:` entries are the one entry class with a durable twin: **the
invalidation ts rides the stored cell row** (leases.md L2). Every
committed bump stamps its `ts` onto the backing row (`commitOne` →
the ts bridge `cell-write.ts` registers via
`_setInvalidationTsBridge`; storage side: `CellStorage.stampTs`, see
[`cell-internals.md`](./cell-internals.md#the-invalidation-ts-rides-the-row)),
so `row ts ≡ entry ts` holds by construction. That makes a hot entry
a **cache over storage** — evictable and restorable, lossless:

- **Restore is query-time, before the ts read.** In
  `_queryCompiledMatchingTs`, a `cell:` label's probe keys that lack a
  live entry are checked against storage
  (`hasAny` → per-key `readTs`) and re-seeded from the row's persisted
  ts (`seedRestoredEntry` — no bump delivery, no re-stamp) _before_
  the query reads. The seam sits inside the one read every consumer
  takes — the fp fold on the **fp-skip path included**, whose body
  never runs — so no fold can ever observe ts=0 for state with a
  persisted history (the stale-match hazard that made eviction
  forbidden). The bridge address translation is exact: the entry key
  `stableStringify(constraints)` hashes to the row's partition key,
  because a write's selector encoding round-trips its partition args
  losslessly under `stableStringify`.
- **Over-cap surfaces fold the evicted floor.** A surface past
  `PROBE_SUBSET_CAP` can't enumerate candidate keys, so its queries
  fold `max(result, evictedFloorByName[name])` — the max ts ever
  evicted under the name, maintained at evict time. Never below a
  lost entry's ts → over-fetch, never stale (those rare watchers
  refetch once per sweep that touches their cell).
- **Eviction is verified, never assumed.** `_evictInvalidationEntry`
  refuses unless the entry is `cell:`-named AND
  `bridge.readTs(name, key) === entry.ts` — a ts-unknown row (legacy
  file, loader seed, adapter without `stampTs`), a lagging row, or no
  row at all is _unbacked_ and exempt (the loss rule: eviction of
  unrestorable state is forbidden). Wake-index subscriptions are a
  separate structure and are untouched; a later bump re-creates the
  entry via `commitOne` and delivers normally.
- **The bounded-cardinality sweep** (`maybeSweepEntries`, run from
  `commitOne` only — never from a restore, so a query's own seeds
  can't be swept mid-read) triggers past `DEFAULT_ENTRY_CAP = 65_536`
  live entries (the pool audit's pulse-scale ceiling; override via
  `_setInvalidationEntryCap`) and evicts verified-backed entries in
  insertion order down to cap − ⅛cap. No recency bookkeeping —
  restore makes any eviction order lossless. A mostly-unbacked
  population over the cap backs off and retries after growth instead
  of rescanning per bump.
- **Restart is the same mechanism.** A fresh process restores entries
  from rows on first query — fp folds are byte-identical to the
  never-restarted process (`cell-ts-persistence.rsc.test.ts` proves
  it). When the persistent storage singleton comes live, its `maxTs()`
  seats the counter (`_raiseInvalidationTsFloor`) so restored
  timestamps sit below every cursor a live connection can anchor
  (they must read as PAST events — never surface in a catch-up
  window or the parity oracle's since-scan) and every new bump
  supersedes them. Non-cell entries (tag bumps) remain
  process-memory only: gone on restart, cold re-record — over-fetch,
  never stale.

## The bridge seam (cross-process bumps)

`invalidation-bridge.ts` is the single seam through which committed
bumps cross a process boundary — the same-trust broker bus (N
processes of one app over one shared store) today, the cross-trust
remoteCell channel attach later; designed once for both. The framework
exposes the seam; the transport (a TCP broker, a Redis channel, a
server-to-server attach) stays with the deployment.

```ts
setInvalidationBridge({ publish(batch) }) // outbound — install per process
deliverInvalidationBumps(batch)           // inbound — the transport calls this
invalidationBridgeOrigin()                // this process's origin id
// batch: { origin: string, selectors: string[] }  — the selector grammar,
// nothing else. The bus is a doorbell, never a payload.
```

- **Outbound — publish-after-commit, batched per commit section.**
  `commitOne` collects each locally committed selector; the registry
  hands the collection to the bridge as ONE batch at the end of each
  synchronous commit section (a solo `refreshSelector`, a transaction
  flush — so an `atomic()` is exactly one batch — or a driver tick's
  `_flushPendingInvalidations`). `commitOne` runs strictly after the
  value writes landed (the write pipeline commits storage first; the
  `atomic()` overlay flushes before its transaction commits), so every
  batch a receiver sees is already re-readable from the shared store.
  A throwing transport never takes the local commit down (the tap is
  try/caught); a rolled-back transaction publishes nothing.

- **Inbound — the same path as a local commit.** A delivered batch
  commits through `commitOne` itself: entries compact per
  (name, constraints) pair, the wake index delivers the touched parton
  ids, the deadline wheel and park gating apply unchanged — a bridge
  bump is indistinguishable downstream from a local one. Bumps are
  at-least-once and unordered by contract; applying a duplicate or
  late batch advances the entry ts again, which triggers a re-read +
  fp compare — wasted re-render at worst, never wrongness.

- **The ts posture: the wire carries no timestamps, and inbound never
  stamps.** Registry timelines are process-local (the epoch declares
  them non-comparable), so an inbound bump mints a fresh LOCAL ts —
  neither a wire ts nor the row's persisted ts could be a valid local
  timestamp, and non-cell selectors have no row at all. The row's
  `ts` column keeps the WRITER's stamp untouched: re-stamping with a
  foreign-timeline value would break the writer's evict verification
  (`readTs === entry.ts`) and inject the receiver's timeline into
  every peer's restore path. Consequences: a doorbell-minted entry is
  unbacked (evict-exempt, bounded like all entries by live key
  cardinality), and restore-from-row remains the query-time freshness
  path for selectors no doorbell has materialized locally — with the
  floor-raise backstop absorbing foreign row timestamps. The only
  stale window is a LOST doorbell against a live local entry, which is
  exactly what the transport's at-least-once contract excludes; a
  reconnect window degrades the peer to over-fetch on its next
  doorbell or restore, never to wrongness.

- **Loopback — two explicit guards, no heuristics.** Every process
  mints an origin id; `deliverInvalidationBumps` drops batches
  carrying its own (transports may echo to all subscribers freely).
  And inbound applies are never re-collected for publish
  (`applyingInbound`), so two bridged processes can't ping-pong a
  forwarded bump even though a forward would carry a new origin.

The harness (`experiments/multi-process/`) runs the seam end-to-end
over two real processes + one SQLite store; the seam's unit contract
lives in `runtime/__tests__/invalidation-bridge.rsc.test.ts`. Design
and measurements: [`../archive/bridge-seam.md`](../archive/bridge-seam.md).

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

### The parent→children index

Each memo entry also carries the route's **descendants index**
(`_readRouteDescendants(scope, routeKey)`): ancestor id → every id
whose snapshot's `parentPath` names it — the inverse of the
child→ancestors relation the snapshots carry, transitive by
construction (`parentPath` is the full root-first chain). Subtree
consumers read the actual subtree instead of filtering the whole
route bucket by `parentPath.includes` per call — the two callers are
the lane drain's client-mirror promote
(`promoteSnapshotsToCachedOverride(withinId)`) and the per-lane
fp-trailer fold (`foldUpdates` in `fp-trailer.ts`), which at world
density paid O(route bucket) per lane settle/drain (~19% of the busy
profile) for a ~3-snapshot subtree.

The index is maintained INCREMENTALLY across memo rebuilds: the
rebuild walk (already O(route) for the map itself) pointer-compares
each id's snapshot against the previous memo's; only ids whose object
changed re-check their `parentPath` content, and only genuine
placement moves unlink/relink — a re-render in place costs one short
array compare. Drops are detected exactly (a carried-id count, never
a size compare — a same-size add+drop commit still re-walks). Unlike
the snapshots map, the index object is UPDATED IN PLACE at rebuild,
so consumers must read it fresh per synchronous section and never
hold it across awaits. An LRU-evicted memo entry rebuilds the index
cold on the next read.

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
