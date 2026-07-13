# The bridge seam — cross-process bumps over one store

Landing note for increment 3's bridge half of
[`remote-frame-arc.md`](./remote-frame-arc.md): the
`setInvalidationBridge` seam, designed once for its two callers — the
same-trust broker bus (processes of one app over one shared store,
landed here) and the cross-trust capability-authorized channel attach
(remoteCell, later; nothing in the seam's shape precludes it — the
batch is origin + selector strings, exactly what a server-to-server
attach would re-emit into its own registry). Mechanism reference:
[`../internals/registry-internals.md`](../internals/registry-internals.md)
§ The bridge seam. Shared spine with research→PoC workstream 2 (the
SQLite adapter carries the values; this seam carries the doorbells).

## The consistency contract, embodied

1. **The store is the truth.** A batch is `{origin, selectors}` —
   selector grammar strings, no values, no timestamps. The bus
   scenario's broker spy asserts the wire shape byte-for-byte.
2. **Publish-after-commit is the only ordering.** The registry hands
   the bridge one batch per synchronous commit section, strictly after
   `commitOne` — which itself runs after the storage flush (`atomic()`
   flushes its overlay before the transaction commits). Receivers
   treat every batch as an idempotent doorbell: re-read, fp-compare;
   duplicates and reordering cost a wasted re-render, never wrongness.
3. **Timelines are process-local.** An inbound bump commits with a
   fresh local ts through the ordinary `commitOne` — wake index,
   deadline wheel, park gating unchanged. No ts travels, and inbound
   never re-stamps the row: the writer's stamp stays authoritative
   (details + the unbacked-entry consequence in registry-internals).
4. **One `atomic()` = one store commit + one bump batch.** Contention
   is per-key last-writer-wins; `cell.update(fn)` over the SQLite CAS
   is the compose escape — now proven cross-process (below).

## Design decisions worth remembering

- **The inbound entry is deliberately unbacked.** Symmetry argument:
  whether the receiver re-stamps or not, exactly one process's entry
  matches the row's ts. Not stamping keeps "the writer owns the row"
  (value and ts move together, one writer per commit), avoids a DB
  write per doorbell per receiver, and costs only evict-exemption for
  doorbell-minted entries — bounded by live key cardinality like every
  entry.
- **Loopback is two guards, not one.** The origin id suppresses
  transport echo of one's own batches; the registry-side
  `applyingInbound` flag suppresses re-publish of applied batches —
  without it two processes would ping-pong forwarded bumps under NEW
  origins. Both explicit; no heuristics.
- **The transport is deployment code.** The harness's is ~60 lines of
  JSON-lines TCP with a 1s reconnect loop; its loss window (batches
  dropped while disconnected) degrades the peer to query-time restore
  / next-doorbell freshness — over-fetch, never stale. A production
  bus swaps the transport, not the seam.
- **Scope-agnostic on purpose.** Every committed selector travels
  (test-scope traffic included); a receiver whose store doesn't share
  the writer's rows re-renders against its own state — the no-op
  outcome the fp compare absorbs.

## As-built

- `framework/src/runtime/invalidation-bridge.ts` — the public seam:
  `setInvalidationBridge` / `deliverInvalidationBumps` /
  `invalidationBridgeOrigin`, wire-shape types. Barrel-exported next
  to `setCellStorage` (the two halves of the multi-process contract).
- `framework/src/runtime/invalidation-registry.ts` — the tap:
  `commitOne` collects (skips row-stamp + collection when applying
  inbound), `flushBridgeTap` drains once per commit section,
  `_applyInboundInvalidations` is the inbound commit loop.
- `experiments/multi-process/` — the two-process harness: sticky
  proxy + supervisor + byte stats + bump broker (`harness.mjs`), the
  minimal counter app over `SqliteCellStorage` (`app/`), three
  scenarios. The proxy preserves the client-facing Host header —
  the live-attach endpoint's Origin check 403s a Host-rewriting proxy
  (a finding worth keeping for the deployment reference page).
- Unit contract:
  `framework/src/runtime/__tests__/invalidation-bridge.rsc.test.ts`
  (publish-after-commit observable through an independent store
  handle, one-batch-per-atomic, rollback publishes nothing, loopback
  both guards, inbound idempotence, writer-stamp preservation,
  type-tagged selector round-trip).

## Landing package — gate numbers (2026-07-13)

- **Bus (prototype G, modernized):** a `cell.update` on process A
  reaches a live viewer attached to process B through doorbell →
  registry commit → wake index → lane, both directions; every relayed
  broker line is exactly `{origin, selectors: ["cell:mp.counter"]}` —
  zero values on the wire.
- **Contention (prototype D, inverted):** 100 concurrent updates
  interleaved across two real processes over one SQLite store land
  exactly 100 — zero lost updates, 100 distinct committed values (the
  CAS retry composes). The prototype demonstrated the opposite over
  cells.json; research→PoC workstream 2's cross-process claim closes.
- **Failover measurement (prototype E, extended — workstream 3's
  measure-before-design input).** SIGTERM the pinned process
  mid-session, writes continuing at 4/s through the survivor:
  - **Committed writes survive**: the doomed process's last committed
    value was readable through the survivor's handle immediately
    (synchronous-commit WAL — no debounce window to lose).
  - **Auto-recovery, no reload**: the viewer re-attached by itself —
    1 attach POST after the kill, 0 document reloads; recovery in
    **~2.1s**, longest DOM update gap **~1.9s** (kill → proxy failover
    + re-pin → cold attach → doorbell resumes).
  - **No visible tear on committed state**: the counter DOM never
    regressed across the kill (samples at 10Hz); it went quiet for the
    gap, then converged.
  - **Wire cost**: held-stream lifetime bytes either side of the kill,
    same cadence and ~same window — initial attach 12,311B/3.1s vs
    re-attach 12,620B/3.4s. On this deliberately tiny app the
    whole-tree catch-up ≈ a lane's steady state, so the numbers mostly
    say "no pathological amplification"; what the measurement pins is
    the STRUCTURE of the loss: per-process registry, fps, sessions and
    ephemeral cells die with the process; the client re-warms in one
    attach; values ride the store. (Per-parton fp-skip portability
    across the failover — which the JSON-era prototype observed
    partially — needs a many-parton page to be worth measuring;
    unmeasured here.)
  - **What the resume contract must add** (not designed here): the
    in-flight window — an action POST or channel frame racing the kill
    has no replay guarantee beyond the proxy's buffered-body retry,
    and the ~2s gap is proxy-failover-shaped, not drain-shaped; a
    deliberate drain (stop attaches, settle lanes, signal reattach)
    should beat it.

Suites at landing: `yarn typecheck` green; rsc tier 77 files / 453
tests green (bridge suite included); node tier green; the harness
suite 4/4.

## Drain results (2026-07-13) — the deliberate half, measured

Deploy-and-drain landed (research→PoC workstream 3 —
[`deploy-and-drain.md`](./deploy-and-drain.md), mechanism in
[`../internals/channel.md`](../internals/channel.md)
§ Deploy-and-drain), designed around exactly what the failover
measurement above said is lost. Side-by-side on the same harness,
same 4 writes/s cadence (`scenarios/drain.spec.ts`; the failover
scenario moved to SIGKILL so the ungraceful crash-class baseline
stays measured — SIGTERM is now the graceful path):

- **The visible gap**: drain (SIGTERM) recovery **473ms**, longest
  DOM update gap **313ms** — vs the ungraceful baseline's ~2.1s /
  ~1.9s. The win is structural: the `drain` wire frame makes the
  client reattach the moment its wound-down stream settles, while the
  old process is STILL UP — one attach POST, one proxy-absorbed drain
  refusal (503 + `x-parton-drain`, retried against the survivor), no
  proxy connect-failure detection in the path at all. Zero document
  reloads, zero DOM regression, both worlds.
- **The in-flight window CLOSES**: a write the doomed process had
  SEEN but not committed at SIGTERM (a 300ms-delayed update) commits
  AND its response flushes before the exit — the entry's request
  gauge holds quiescence until response bodies fully stream out. The
  ungraceful path never had this (only the proxy's buffered-body
  replay).
- **Full-price re-render, bounded and confirmed**: the drained
  re-attach's held stream cost 14,368B/3.7s vs the initial attach's
  11,455B/3.2s — the cold process's whole-tree render, ≈ one initial
  attach per viewer per deploy. Fp portability across processes is
  confirmed ABSENT (fps fold per-process invalidation timestamps), so
  the manifest misses and the cold-record posture over-fetches, never
  stale; values ride the store, unchanged.
- **Sessions**: per the store config — the in-memory default dies
  with the process (frames reset to initial URLs on the survivor); a
  shared `SqliteSessionStore` carries them. The drain surfaces the
  split rather than papering over it.
