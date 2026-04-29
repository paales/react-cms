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
  // Per-route hint: which variant did the most-recent render for
  // this route bind to each id. LRU on the outer Map.
  hints: Map<string, Map<string, string>>
}
```

Two layers:

1. **`partials`** — the snapshot store. Keyed by spec id and a
   *variant key* derived from the snapshot's structural fields.
   Snapshots that share the same structural placement collapse
   onto a single variant entry, regardless of which route or
   request triggered the registration.

2. **`hints`** — a per-route index. Each entry maps `(route, id) →
   variantKey` so cache-mode lookup can resolve "which variant of
   `cart` does the request for `/checkout` want" without scanning
   the variant store. Bounded LRU (default 10 000 routes).

## Variant key

```ts
function variantKeyOf(snap: PartialSnapshot): string {
  return djb2(stableStringify([
    snap.parentPath,
    snap.parentFrameChain,
    snap.frameUrl ?? null,
    snap.cmsId ?? null,
  ]))
}
```

The variant key captures the **structural placement axes** that
distinguish two registrations of the same id:

| Axis | When it differs |
|---|---|
| `parentPath` | Same id mounted under different ancestors (e.g. `Header` under `PageRoot` vs under `EditorShell`) |
| `parentFrameChain` | Same id rendered inside vs outside a frame |
| `frameUrl` | Frame-opening spec with a different initial URL |
| `cmsId` | Slot-block instance with a different effective cmsId override (also folded into the spec's effective id, but kept here defensively) |

Per-user variation (cookies, search params, A/B test buckets) is
*not* in the variant key — that divergence flows through the
spec's `vary` callback, which is recomputed per-request inside
the spec component. Two concurrent users hitting the same route
register byte-identical snapshots → idempotent overwrite, no
clobbering.

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

`commitRequestRegistry` runs on stream flush and atomically
applies the pending sets to the canonical store. Two modes:

- **Streaming**: replace the route's hint wholesale with
  `pendingHints`. Removes hints for ids no longer present on the
  page.
- **Cache**: patch the existing hint with `pendingHints` and any
  invalidations. Untouched ids keep their hint pointers.

In both modes, snapshots merge into `partials[id][variantKey]`
unconditionally — same structural placement → same variant key →
idempotent.

## Invalidation

`invalidateSnapshot(id)` clears every variant of that id from the
variant store and every hint pointing at it. Server actions
request invalidation by id (`return { invalidate: { selector:
"#cart" } }`); the meaning is "this content has changed for every
placement of this partial."

## LRU bound

The variant store is bounded by **spec topology** — finitely many
placement combinations exist for any given id. No LRU needed.

The hint table is bounded by **distinct routes seen** — uncapped
in principle, so it's LRU'd at `HINT_LRU_MAX = 10_000` routes per
scope. Eviction drops a route's hint entirely; the next refetch
on that route falls through to streaming-mode (registry miss),
which re-registers and rebuilds the hint.

## What snapshots intentionally do not capture

- **`varyResult`** — vary is per-request, recomputed by the spec
  component on every render. No snapshot consumer reads it.
- **JSX / rendered output** — `<Cache>` owns rendered-output
  caching, keyed independently by the spec's `varyResult`.
- **Per-request scalars** (cookies, headers, URL params) — these
  flow through `vary`.

The snapshot is purely a structural-placement record so cache-mode
refetches can spawn a spec component at the right point in the
tree without re-running its ancestors.
