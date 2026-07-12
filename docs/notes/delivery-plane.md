# The delivery plane — deadlines and broadcast as one layer

Follow-on to [`wake-index.md`](./wake-index.md) (bumps are delivered,
not derived) and [`leases.md`](./leases.md) (L1's finding: the expiry
arm is still a pull-model scan). The consolidation claim: a live
connection's driver should drain **one pending set**, and everything
that wakes it is a _delivery_ from an indexed source — never a scan.
Two sources exist today, one delivered and one derived; this note
designs the missing delivery and the fan-out that the same structure
enables.

| Event source            | Today                      | Target                             |
| ----------------------- | -------------------------- | ---------------------------------- |
| Bumps (writes)          | delivered — wake index     | shipped                            |
| Deadlines (`expires()`) | delivered — deadline wheel | shipped (D1)                       |
| Flips / cookies         | session-scoped wakes       | unchanged (already per-connection) |
| Fan-out (N viewers)     | N independent renders      | **D2: broadcast lanes**            |

## D1 — the deadline wheel · ✅ Landed 2026-07-12

Shipped as designed (details as-built:
[`../internals/streaming.md`](../internals/streaming.md) §How a live
update lands — the expiry arm;
[`../internals/registry-internals.md`](../internals/registry-internals.md)
§The parent→children index). The wheel lives on the route wake
subscription (`segment-relevance.ts`), maintained by the same
pointer-diff sync that registers index entries and closed wholesale
with it; slot firings deliver through the bump path's park gating
(`_deliverToWakeSubscription`) into the one pending set, and the
drain is literally the bump drain — the `expiry` wake kind,
`computeNextExpiresAtDelay`, and the park re-classification walk are
deleted. The parent→children index rides the `_readSnapshotsForRoute`
memo (`_readRouteDescendants`), diffed incrementally per rebuild;
`foldUpdates` and `promoteSnapshotsToCachedOverride` consume it. The
wake-parity oracle now derives the due-boundary set too — coverage
(never under-deliver; extras park/dedup) spans both sources.

**Gate results (same machine, one day):**

- 4K `?chunk=128` cornerIdle **left saturation**: 57–106%
  non-converging → 58.3 / 68.5% across two runs, browser-side
  saturated (~500%) while the server holds headroom; baseline
  (origin view) 50% → **19.5 / 19.9%**; afterClose 0%. Profile
  attribution of the residual busy time: the two scan terms are gone
  (wheel firing 0.2%, subtree filters absent) — what remains is real
  lane production + Flight encode (~31%), the route-map memo rebuild
  (~22% of busy — the known ~9%-of-total class D1 scoped out), and
  the subscription pointer-diff sync (~11%).
- 1440p holds: baseline 3.0 / cornerIdle 2.3 / afterClose 0.1%;
  zero-client floor 0.0%.
- `bench:server --only=soak` gates ok — B/wake ≈ 0 (−40…93 B, gc
  noise), idle 3–4 µs/bump at N≥1000, zero idle renders, zero early
  closes; `--only=pulse` rows equal (p50 ~21/15 ms, 43–50 ticks/s).
- `PARTON_WAKE_PARITY=1 yarn test` fully green (oracle armed across
  both sources); `yarn test:e2e` 185 passed; validate-world / -ws /
  -upgrade ALL GREEN (pulses-advance rides the wheel; eastBurst stop
  clean).

Original design note (kept for the rationale):

**The problem, measured** (L1 gate data, 4K `?chunk=128`, ~540
cadences over an ~8K-snapshot route bucket): `computeNextExpiresAtDelay`
plus park-classification re-walk all snapshots and re-classify
thousands of parked, forever-past-due boundaries per wake (~14% of
busy time); every lane settle/drain pays O(route-bucket) subtree
filters in `foldUpdates` / `promoteSnapshotsToCachedOverride`
(`parentPath.includes` over the whole bucket, ~19%); each commit
invalidates the route-map memo (~9%). Corner saturates in both the
ticker and derivation worlds — the scan shape, not the producer, is
the wall.

**Design.** Per-connection timer wheel, slotted on the existing 25ms
coalescing grid (`EXPIRY_COALESCE_MS`):

- **Maintained at snapshot commit.** When the driver commits a
  render, each snapshot's declared boundary inserts `(slot → id)`
  into the connection's wheel; a re-render moves the id to its new
  slot; drops remove it. No global scan ever recomputes "the next
  deadline" — the wheel's head IS the next deadline, and the wake arm
  is one timer to the head slot.
- **Park-aware by construction** (the wake-index lesson: parking
  gates only the WAKE). A parked id's boundary stays in the wheel but
  its slot firing only records into the pending set — no wake. The
  flip-in that unparks it drains pending, catching the id up in the
  same lane pass. Forever-past-due parked boundaries cost exactly
  nothing: fired once into pending, deduped thereafter.
- **One pending set.** Slot firings push ids into the SAME
  per-connection pending set bump deliveries use; the drain path is
  shared and already proven (escalation, park-checks, coalescing).
  `waitForSegmentWake` keeps exactly three arms: pending-set latch,
  keepalive, degrade.
- **Release discipline**: the wheel dies with the connection
  (session close removes it wholesale); soak B/wake ≈ 0 is the
  regression gate, as ever.

**The parent→children index** rides with D1: route buckets keep
`parentPath` (child → ancestors); settle/drain needs the inverse
(ancestor → descendants) to scope `foldUpdates` /
`promoteSnapshotsToCachedOverride` to the actual subtree instead of
filtering the whole bucket. Maintained at snapshot registration
(same commit hook as the wheel), invalidated by the same diffs.

**Gates**: 4K `?chunk=128` cornerIdle leaves saturation (both scan
terms disappear; target well under a core with headroom attributable
to real lane renders); 1440p and zero-client floors hold; soak/pulse
benches hold; wake-parity oracle green (deliveries must still cover
the retired scan's lane sets — the oracle already encodes coverage,
extend it to expiry-sourced deliveries); validators + e2e.

## D2 — broadcast lanes (multiplayer's read side)

**Prerequisite · ✅ landed 2026-07-12: the `shared` bench category.**
The soak bench prices N connections × N _distinct_ worlds; the
"N viewers, ONE world" number now exists as
`yarn bench:server --only=shared` (bench/README.md §shared): N live
connections in ONE scope bucket on one route (8 live + 2 static
leaves, 1 wrapper), M cells bumped per tick, every bump relevant to
all N. Gated exactly — a tick renders N×M bodies (each bumped leaf
lanes once PER connection), every connection's own wire settles every
wake round, irrelevant bumps render nothing.

**The baseline broadcast must beat** (dev Flight, node v24, from the
committed `bench/results/server-warm-tick.json`):

| N × M   | renders/tick | cpu/tick | wall p50 | bytes/tick |
| ------- | ------------ | -------- | -------- | ---------- |
| 10 × 1  | 10           | 2.2 ms   | 1.8 ms   | 53 KiB     |
| 100 × 1 | 100          | 11.9 ms  | 9.1 ms   | 320 KiB    |
| 500 × 1 | 500          | 87.1 ms  | 59.3 ms  | 1.85 MiB   |
| 10 × 4  | 40           | 7.0 ms   | 6.3 ms   | 188 KiB    |
| 100 × 4 | 400          | 55.0 ms  | 38.5 ms  | 1.4 MiB    |
| 500 × 4 | 2000         | 399.0 ms | 248.3 ms | 7.3 MiB    |

Renders/tick is exactly N×M (the gate pins it); CPU follows roughly
linearly at ~120–200 µs/lane, drifting SUPER-linear at the top cell
(µs/lane 137.6 at 100×4 → 199.5 at 500×4 — allocation/GC pressure at
2000 lanes and 7 MiB per tick). At 500 viewers a 4-cell tick costs a
quarter-second of wall clock per wake round today. Broadcast's win
condition: renders/tick → M (independent of N), leaving per-viewer
marginal cost ≈ framing + bytes.

**Design sketch** (to be firmed against the baseline):

- **Eligibility is the dep record.** A lane is broadcastable iff its
  snapshot's recorded reads contain no per-viewer axis (no
  `session()`, no `cookie()`, no per-connection cell partition). The
  read set already exists per render; eligibility is a derived flag
  on the snapshot, recomputed when deps change. No declaration, no
  heuristic — the read is the proof.
- **Render once, personalize framing.** The first driver to drain an
  eligible id renders and encodes once, publishing the Flight bytes
  into a per-`(id, matchKey, fp)` slot with a generation tied to the
  invalidation ts. Other connections holding the same id pending
  consume the slot instead of rendering — but framing stays
  per-connection (delivery seqs, mux frames, fp-trailer entries wrap
  the shared body). A connection whose cached-override says the
  client already holds the fp still fp-skips as today — broadcast
  only replaces the RENDER, never the per-connection skip decision.
- **Subscriber list is the wake index** — the same
  `(name, constraintsKey)` entry that delivered the bump/deadline
  enumerates the connections to offer the slot to. No second
  registry.
- **Slot lifecycle**: generation-checked (a newer bump invalidates
  the slot), TTL'd to one drain window, dropped on last-subscriber
  exit. Slots hold encoded bytes only — never React state — so
  eviction is always safe (a consumer that misses re-renders; the
  framework bias: over-fetch, never stale).

**Gates**: the `shared` bench scenario shows per-viewer marginal
cost ≈ bytes (renders/tick independent of N for eligible lanes,
against the baseline table above); single-viewer paths byte-identical
(the oracle + validators); a two-browser world demo (the leases
note's multiplayer first slice) as the e2e proof.

## Sequencing

D1 landed first — self-contained, its gate was already red (the
saturated dense corner), and its commit hook (the subscription sync
at snapshot registration) is where D2's eligibility flag and
subscriber enumeration also live. D2 follows on the settled hook
with its bench scenario in hand.
