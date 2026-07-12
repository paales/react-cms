# Convergence fuzzing — the oracle and the random-walk harness

The client merge layer is a stateful system fed by an incremental
wire: whole-tree segments, per-parton lanes, fp heals, culling flips,
mirror promotions. Its correctness claim is a single sentence — and
that sentence is a testable property:

> **The oracle.** After ANY sequence of actions reaches quiescence,
> the client's committed tree must equal a fresh COLD render of the
> same request state — same URL, same scope (cells, invalidation
> timeline), same visibility set. Incremental merge ≡ cold render.

Every mechanism in the pipeline — fp-skip, the descendant fold, the
wake index, park/flip revalidation, the layered mirror, as-of drops —
exists to make the incremental path _cheaper_ than the cold render
while producing the same tree. A hand-written spec can check one
interleaving; the space of interleavings (a write racing a navigation
racing a flip) is where the bugs live. The fuzzer walks that space
with a seeded PRNG and checks the oracle at every quiescence point.

Status: **v1 shipped** — `framework/src/test/fuzz-harness.ts` (runner,
model, oracle, shrinker), `framework/src/test/fuzz-wire.ts` (Flight
extraction), `framework/src/lib/__tests__/fuzz-fixture.tsx` (the
fixture app), `framework/src/lib/__tests__/fuzz-convergence.rsc.test.tsx`
(the CI budget + env knobs). Findings from the first long runs are at
the bottom — the v1 harness found two real framework bug classes on
its first day.

## The action alphabet

Actions are the client-side moves a real page can make on a held live
connection, generated from a seeded PRNG (mulberry32 — the seed fully
determines the sequence):

| Action     | Wire form                                                                           | Exercises                                                                            |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `navigate` | window `url` frame, intent `push`                                                   | navigation consume, lane tear, mirror survival, match-gate park/restore, as-of drops |
| `write`    | `cell.set` through a real request scope                                             | invalidation fan-out, the wake index, lane rendering, fp heals                       |
| `flip`     | `visible` frame with `changed` + wholesale set + the model's actual `cached` tokens | cull gates, park/unpark, flip-in revalidation, fp-skip confirms, deferred flips      |
| `refetch`  | window `url` frame, intent `silent`, same URL + `?__force=<label>`                  | forced lanes, fold exclusion, the covering segment                                   |
| `settle`   | drain to quiescence (below)                                                         | coalescing boundaries — actions between settles race each other and the driver       |

Actions between two settles form a BURST: they are issued without
reading the wire, so they interleave with the driver's own concurrent
rendering — that concurrency is where the missed-update class was
found. Every sequence ends with a final settle before the oracle.

## The harness (v1 — in-process rsc tier)

Built entirely on existing seams: `withLiveDrive` (the real
`driveSegmentedResponse` against a bound attach statement, with the
production fp-trailer wrap / segment splitter / lane demux) and
`handleChannelPost` for envelopes. No framework code was modified.

The harness plays the CLIENT's half of the protocol faithfully:

- page-lifetime envelope seqs; the navigation point advances at every
  window `url` statement (`navPoint = seq`, mirroring
  `_channelNavigate`'s reservation);
- the as-of commit guard: a delivery whose `asof < navPoint` is
  consumed PROCESSED, not committed, and reported in the next ack's
  `dropped` — exactly `_channelDeliveryDroppedStale`;
- contiguous-watermark acks (`delivered` = highest contiguous seq over
  committed + processed + `seqvoid`-voided), posted at threshold
  (16) and at every settle boundary;
- `visible` frames carry the model's ACTUAL holdings as `cached`
  tokens (`id:matchKey:fp`), the flip-statement eviction evidence;
- unannounced lane bodies (no `seq` entry before `muxend` — a
  cancelled/superseded render) never commit.

### The client model

A per-id record `{live, fp, matchKey, stamp}` updated by the same
commit rules the browser merge applies, at the granularity the wire
supports:

- **Whole-tree segment**: fresh emissions replace fp/matchKey; holes
  and confirms leave the cached copy standing; ids absent from the
  segment leave the tree (match-miss park) — UNLESS an ancestor is
  present as a culled pair or placeholder, in which case the
  descendant's fiber is retained inside that ancestor's content slot
  (a fresh ancestor body re-states its descendants explicitly).
- **Lane**: same rules, scoped to the lane's subtree.
- **fp heals** (`{from,to}` trailer entries): applied only when the
  held fp equals `from` — the client's `_applyFpUpdates` discipline.
  Segment heals arrive via the wire-entry hook anchored to their
  segment's `seq` entry; lane heals ride inside the lane body.
- **Culling display** follows the STATED set, never emission props:
  the pair displays `reported ?? emission`, and the controller's own
  statement always exists here (the attach seeds it), so a cullable
  id shows its skeleton iff it is outside the client's stated set.
  Ancestor culls cascade: a descendant of a culled/parked ancestor is
  not displayed — matching the cold render, where the culled
  ancestor's body never runs.

Fixture bodies embed **stamps** — `[S|<id>|<state>]` tokens that are
pure functions of tracked reads (searchParams + cell values; no
render counters) — so a cold render at the same request state
reproduces every stamp byte-for-byte. Stamps are the content-level
oracle currency.

### Wire extraction is structural, never regex-over-text

`fuzz-wire.ts` parses each Flight document's rows and walks the
element graph from row 0, following only structural positions (type +
props; never the dev-build owner/stack slots) and skipping `D` debug
rows — which duplicate raw props and would poison a text scan (the
flight-gotchas rule). It resolves row refs (`$L` / `$@` / plain),
outlined symbol types (`"$16"` → `"$Sreact.activity"`), and import
rows (to recognize `#CullPair`), and classifies: fresh PEB emissions
(`partialId`/`partialFingerprint`/`partialMatchKey`), holes vs
confirms (`data-partial-confirm`), cull pairs (`culled` prop), parked
context (`<Activity mode="hidden">` subtrees), and stamps.

### Quiescence — the driver's own signals, never timing

The one signal v1 needs that the driver does not export is "parked
with an empty pending set". The harness derives it from wire
causality with a SENTINEL parton — a cell reader whose bump (a real
`cell.set` of a unique tick) must produce a wire artifact:

1. Bump the sentinel with tick _t_; read wire events until one
   carries the sentinel's `t` stamp (its own lane, or a whole-tree
   segment whose covering render folded the bump in).
2. If ANY other event arrived in that window, repeat with _t+1_ —
   pending work (including cascades: deferred flips resolve on lane
   drains, which are themselves wakes) rides earlier or equal drains
   than a later sentinel's.
3. A window containing ONLY the sentinel event proves the wake found
   nothing else pending. Quiesced.

One deterministic wrinkle (finding #1 below): a covering whole-tree
segment can arrive WITHOUT the current tick's stamp — the navigation
consume cleared the bump from the pending set at segment drain while
the lazily-rendered segment read the sentinel's row before the bump
committed. The settle re-states the bump with a fresh tick, keyed on
the segment's own arrival (never a timer), and counts the occurrence
(`sentinelRebumps`) as the bug-class signature. A 20s watchdog exists
as pure failure detection (a hang is a finding, not a wait).

### The oracle render and the comparison

After the final settle the harness captures the session's visible set
(`_peekConnectionSession`), shuts the drive down, and cold-renders the
final URL in the same scope — fresh request, empty manifest, the
captured set presented as the measured visibility
(`_setConnectionSession`), wrapped with the production fp-trailer so
cold fps heal to warm exactly as a real response's would.

Compared per fixture id, at displayed-tree level:

| Axis                                    | Compared            | Notes                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| state (`content` / `culled` / `absent`) | ✅                  | absent covers match-miss park AND ancestor-cull cascading                                                                                                                                                                                                         |
| stamp                                   | ✅ (both content)   | the load-bearing staleness check                                                                                                                                                                                                                                  |
| matchKey                                | ✅ (both content)   |                                                                                                                                                                                                                                                                   |
| warm fp                                 | ✅ for leaf partons | wrapper partons (`foldDriftAllowed`) are exempt: ancestor fold drift after lane-only descendant updates is the documented over-fetch class, healed by the next whole-tree segment. The sentinel is also exempt (the shutdown wake bumps its label after capture). |

**What the comparison covers**: content staleness (missed updates,
phantom confirms, stale flip restores), existence errors (ghost
partons, wrongly-parked partons, cull-state divergence), variant
identity, and leaf fp bookkeeping (mirror drift that would fp-skip to
a wrong confirm later).

**What it does NOT cover (v1), honestly**: byte-identical bodies
(only stamps compare — wrapper DOM, ordering, and non-stamp content
are out); parked variants' retained content (allowed stale by
contract — the flip-in revalidation is its healer, and flip actions
exercise exactly that); client React state / hydration semantics (no
DOM here — the browser tier's job); the session-set-vs-stated-set
axis is an ORACLE INPUT (the cold render uses the session's set), so
a session corrupted in a way that exactly matches the stated set on
every flip would not be caught — state mismatches catch divergence
between them; multi-connection broadcast (one connection per
sequence — single-viewer routes bypass the slot by design); frames,
cookies, actions-with-consequence-seqs, `expires()` wheels, defer
gates, and byte-cache replay are not in the v1 alphabet/fixture.

### Shrinking

On a failure (oracle mismatch OR harness/driver failure), delta-debug
the ACTION SEQUENCE: chunk removal (halves, then smaller windows,
down to single actions), re-running every candidate in fresh
isolation (fresh scope, cleared registries, fresh cell storage) and
keeping any removal that still fails. Locally minimal, bounded at 200
re-runs. The CI assertion message carries seed + minimal sequence +
expected/actual.

### Determinism

A sequence is a pure function of its seed; a run is deterministic
given the same engine (single-threaded event loop, no real timers in
fixtures — no `expires()`, no `Date.now()` in bodies). The driver's
own concurrency (lazy Flight pulls interleaving with client awaits)
is deterministic for a fixed schedule but NOT pinned across Node
versions or framework edits — which is fine: the shrinker re-checks
every candidate against the oracle, so a repro either reproduces or
the finding shifts shape, and the seed + sequence is always
re-runnable. `_setReconcileIntervalMs` is raised for the run so the
30s whole-tree reconcile cannot heal lane bugs mid-sequence (the
oracle wants the lane path correct without the healer), and
`_setFirstAckDeadlineMs` is raised so debugger pauses can't degrade
the connection.

## Running it

```bash
# CI budget — deterministic, part of `yarn test` (rsc tier):
#   25 sequences × 20 actions, seeds 1..25. Seeds reproducing the
#   KNOWN findings below are pinned as expected failures (exact
#   signature asserted) — green today, red when a fix lands.
PARTON_WAKE_PARITY=1 yarn test:rsc fuzz-convergence

# Long local run (known finding classes tallied, only NEW classes
# fail):
PARTON_WAKE_PARITY=1 FUZZ_BUDGET=500 yarn test:rsc fuzz-convergence

# Knobs: FUZZ_BUDGET (sequences), FUZZ_LEN (actions/sequence),
#        FUZZ_SEED (first seed; sequence i uses FUZZ_SEED + i)
```

## Staging

- **v1 (this)** — in-process rsc tier: real segment driver, real
  channel apply, fake wire (in-process reader), sequential burst
  schedule. The deterministic ratchet.
- **v2 — schedule permutation.** The v1 reader consumes the wire in
  server emission order and issues actions burst-sequentially. v2
  permutes DELIVERY: hold decoded lanes/segments and commit them in
  PRNG-chosen order (bounded reordering windows), drive demand
  backpressure (small `desiredSize`, stalls), and interleave action
  issuance with partial drains — the client-side race surface
  (per-parton lane chains vs segment commits, as-of arbitration under
  reorder). Needs the model to adopt the client's per-parton
  commit-chain rules rather than wire order.
- **v3 — browser-level AI chaos sessions.** Real Chromium (the
  browser tier / e2e apps): an agent drives arbitrary UI (scroll
  storms, rapid nav, form races) against the real merge layer, with
  the DOM as the committed tree and a `?partials=`-style cold fetch
  as the oracle. Discovery layer — finds what the fixture app can't
  express; every find gets distilled into a v1/v2 seed + fixture
  extension, because the deterministic harness is the ratchet that
  keeps it fixed.

## Findings — first long runs (v1)

Runs (all with `PARTON_WAKE_PARITY=1`, zero parity trips, zero
harness failures): 500 × 20 actions (4.6s — 435 clean / 51 F1 /
14 F2), 3000 × 20 (24s — 2613 / 328 / 59), 1000 × 50 from a distinct
seed range (17s — 780 / 132 / 88). **4500 sequences, ~110k actions,
two real bug classes, zero unclassified failures.** Both classes are
pinned as expected-failure seeds in the CI test (`XFAIL` — seeds 9,
18 → F1; seed 10 → F2), so the suite stays green now and goes red
the moment a fix lands (delete the entry + this section's finding).

- **F1 — real bug: the covering-segment missed-update window.**
  `handleNavigation` (`segmented-response.ts` ~2177) — and the same
  pattern at the frame-nav uncovered fallback (~2277) and the
  scheduled reconcile (~2481) — advances the wake cursor to
  `_currentTs()` and clears the subscription's pending set AFTER the
  covering segment drains, but the vendored Flight server renders
  lazily: a write that commits while the segment streams, after its
  reader's row already rendered, is marked covered while its effect
  is in neither the segment nor any lane. The client shows the stale
  value until an unrelated later bump or the 30s reconcile. The
  wake-parity assert cannot see it — the bump is cleared, so no wake
  happens at all. Minimal repro (3 actions):
  `[navigate "/beta?q=y", write cellB=1, write cellB=2]` → the
  cell's reader displays `b=1` at quiescence while the cold render
  shows `b=2`. The sentinel-swallow diagnostic (`sentinelRebumps`)
  fires on the same window. Direction of a fix: anchor the cursor at
  the ts current BEFORE the covering render begins — the discipline
  segment 0's `lastTs` and the catch-up anchor already follow — so a
  mid-render write stays pending and the next drain lanes it
  (over-delivery at worst: if the segment did carry the late rows,
  the lane fp-skips).

- **F2 — real bug (over-fetch class): parked-variant fp retag.**
  The fp-trailer's whole-stream flush recompute ships heals for
  MATCH-MISSED snapshots, recomputed under the request state that
  parked them. Minimal repro: attach at `/alpha?q=x` (match-gated
  `fz-gated` renders, warm fp W), navigate to `/alpha` — the
  covering segment emits gated as a parked keepalive hole AND its
  trailer ships `{fz-gated: {from: W, to: W'}}` where W′ folds the
  /alpha reads (`q=null` — a state gated's own match gate forbids;
  its body never rendered there). The client's `_applyFpUpdates`
  retags its parked q=x content with the foreign-state fp W′,
  permanently (holes never restate fps). Consequences: the parked
  variant's manifest token can never match a real render again —
  every manifest-path re-match re-renders (defeating exactly the
  parked-variant fp-skip that keepalive parking exists for) — and
  client/mirror fp bookkeeping drifts. NOT a staleness bug: the
  tracking invariant means an fp collision implies byte-equal
  content, so a wrong confirm cannot occur; the cost is over-fetch
  and polluted `OVERRIDE_SET_CAP` slots. Direction of a fix: the
  flush recompute should skip snapshots whose match gate did not
  pass this request (they didn't render; there is no drift to heal).

- **Minor client-lib wart: `splitAtFpTrailer` hangs on a
  pre-classification tear.** A lane body errored before any byte
  classifies (a navigation tear racing the lane's first frame)
  rejects the trailer promise but never closes/errors `mainStream` —
  a consumer awaiting the body (the browser's lane decode included)
  hangs instead of rejecting. In the browser the leak is bounded (the
  covering segment replaces the content; the pending decode is
  abandoned), but "a torn lane's decode always settles" does not hold
  on this path. The harness works around it by racing body reads
  against the trailer's rejection.
