# Leases — demand-driven production, pause/restore, and the road to multiplayer

The framework's founding move is _the read is the dependency_ (reads
record what to invalidate). The inverted wake index
([`wake-index.md`](./wake-index.md)) added _the read is the
subscription_ (a bump delivers to exactly its dependents). This note
designs the third rung: **the read is the lease** — nothing on the
server produces (ticks, polls, simulates, holds hot state) unless
someone holds a lease on it, and everything paused is restorable from
the durable tier. Together the three rungs give the scaling shape a
"wayyy larger" world needs:

- **wire** is O(viewport) — shipped (culling + fp-skip),
- **hot** is O(watched) — this note,
- **durable** is O(mutations) — sparse worlds: state nobody ever
  touched doesn't exist anywhere (derive from a seed on first watch);
  only mutations earn a storage row.

## Derivation before production

Most "live" state is a function of (persisted state, time). The
world's pulse is the exemplar: its value is `now - started` — the
retired ticker _wrote_ it every 0.1–5s (1,700 writes/s at dense
geometry, watched or not), representing the passage of time by brute
force. Time-shaped state is **derived at render, never ticked**:

- the body reads the persisted anchor (a cell row written once) and
  the tracked clock (`time()`),
- it declares its own cadence with `expires()` / `staleUntil()`,
- the segment driver's expiry arm re-lanes it on that boundary —
  and the expiry arm already skips parked partons, so cadence runs
  for exactly the watched set.

This needs NO new primitive. A rendered body only exists while
watched (match/cull gate), and wake hints already express
"re-produce me on this schedule" — that composition IS the lease for
anything derivable. Zero clients ⇒ zero timers, zero writes, zero
registry traffic. A returning watcher renders the caught-up value by
construction.

**Design rule:** reach for a producer only when the state genuinely
cannot be derived (external feeds, simulations with their own
dynamics). Ticking is the last resort, and it runs only under lease.

## The lease primitive (deferred — designed, not shipped)

For the non-derivable case, the wake index already maintains
refcounts per `(name, constraintsKey)`; the transitions are the
lifecycle signal: first subscriber → resume, last subscriber →
pause. The natural surface is cell-level —

```ts
localCell({ id, shape, producer: { start(partition), stop(partition) } })
```

— with `start`/`stop` fired off the index's 0→1 / 1→0 edges
(debounced across scroll churn), and `start` receiving the persisted
row to resume from. **Not shipped yet**: the world's pulse converted
to derivation (L1, landed), which removed the only in-tree ticker —
no caller, no primitive (the API-surface-discipline rule). The first
real external-feed or simulation caller promotes this section to an
implementation.

## Pause, eviction, restore

Pause = flush to the durable tier + stop producers + drop hot state.
Server-side eviction of paused items is then safe _by construction_ —
hot state is a cache over storage, and cache shrink is not loss. Two
contracts make it airtight:

- **The invalidation timestamp rides the stored row.** Evicting a
  registry entry must not lose "when did this last change", or a
  returning watcher's fp fold could match stale cache. Persist the
  version/ts with the cell value and restore is lossless. (Until
  then, eviction must force a cold re-record — the framework's
  standing bias: over-fetch, never stale.)
- **The loss rule** (learned from the client pool-cap livelock): any
  cap on state another layer credits ships its loss report on day
  one. Server-side the durable tier is authoritative so most
  "eviction" is exempt; the rule bites only where a layer holds
  _credits_ (acked mirrors, overrides) against evicted state.

Registry entries, route snapshot buckets, and hot cell copies all
become evictable under these contracts; they re-warm at first render
— the runtime-discovery principle doing double duty as the restore
path. The unbounded pools named in the pool audit (registry
cardinality, cell partitions, keepalive variants) get their caps
_after_ these contracts exist, not before.

## Multiplayer staging

1. **Read side — broadcast (W3 of the wake index).** A lane whose dep
   record is viewer-independent renders once; the index is the
   subscriber list; extra viewers cost bytes, not renders. The dep
   record is the safety proof (it knows which lanes are
   personalization-free).
2. **Write side.** Cells are already server-authoritative with
   `atomic()`; concurrent mutations serialize at the cell and fan out
   through the index. Missing: conflict semantics beyond
   last-write-wins — a reducer form (`cell.update(fn)`) so intent
   composes. Design ground: [`replicated-state.md`](./replicated-state.md).
3. **Presence** is high-frequency cells partitioned by region, with
   match/cull as interest management — the streaming end of the
   dynamic range, no new machinery.
4. **Multi-process.** Leases and hot state stay per-process; the
   deferred fan-out bus ships only selector bumps; durable storage is
   the shared truth. Shard the world by region (not users by session)
   and most bumps never cross the bus. Sticky sessions remain the
   accepted constraint.

First slice when we get here: two browsers watching one region over
broadcast lanes — the W3 demo.

## Landing packages

- **L1 — pulse by derivation. Landed 2026-07-12.** The world's pulse
  is derived (write-once anchor cell + `time()` + a pure
  coords×grid-slot beat jitter declared via `expires()`, all three
  geometries); the tickers are deleted. Two contained framework
  pieces rode along: the byte cache clamps an entry's fresh/stale
  windows to the body's declared boundary (a derived body's cache
  key never moves — no write ever bumps it — so without the clamp
  `maxAge` would replay stale derived bytes past the very boundary
  fp-skip already honors), and the expiry arm coalesces deadlines
  onto a 25ms absolute grid so independent cadences share wakes.
  Results (same machine, same day, ticker→derived): zero-client CPU
  0.0% flat at both geometries; 1440p cornerIdle 7.8→3.6%,
  afterClose 12.1→0.9%; 4K/chunk=128 baseline 76→50%, afterClose
  35→0%. All validators green — pulses ride expiry lanes; a
  re-culled-in chunk shows the caught-up value by construction.

  **Density finding (the live test — reported, not fixed):** at
  4K/chunk=128 (~540 concurrent visible cadences over an ~8K-snapshot
  route bucket) cornerIdle saturates a core in BOTH worlds (ticker
  ~103%, derived 57–106% across runs, non-converging) — the wake
  path, not the lanes, is the bottleneck. The expiry arm is a
  PULL-model scan: every wake re-derives the earliest boundary by
  walking ALL route snapshots and re-classifying thousands of
  parked, forever-past-due snapshots (`computeNextExpiresAtDelay` +
  `isParkedOnConnection` ≈ 14% of the corner profile); every lane
  settle/drain runs O(route-bucket) subtree filters (`foldUpdates` /
  `promoteSnapshotsToCachedOverride` ≈ 19% — a full-bucket
  `parentPath.includes` walk to find a ~3-snapshot subtree); each
  commit invalidates the route-map memo, rebuilt on the next read
  (≈ 9%). Deadline coalescing recovered outright hot-cycling
  (102%→57% on its first measurement) but the scan shape stands.

- **L1 follow-up — a deadline index. Landed 2026-07-12 as
  [`delivery-plane.md`](./delivery-plane.md) D1.** The expiry arm got
  what bumps got: a per-connection deadline wheel maintained at
  snapshot commit (park-aware — a parked parton's past-due boundary
  fires once into the shared pending set and costs nothing until its
  flip-in), plus the parent→children index that takes subtree-scoped
  folds and promotes off the O(route bucket) walk. Gate numbers live
  in the D1 entry. That scheduler is the timing half of the lease
  primitive above.

- **L2 — ts rides the row.** Persist version/ts with cell values;
  make hot registry entries and cell copies evictable + restorable.
- **L3 — broadcast** (the wake index's W3) and the reducer-form cell
  write. Separate notes when scheduled.
