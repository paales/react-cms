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
(the CI budget + env knobs). The findings ledger is at the bottom —
the v1 harness found two real framework bug classes on its first day,
and fixing them exposed three more the old classifier had lumped in.
F1–F6 are FIXED; F7 (the rival-lane fp bookkeeping drift, split out of
the old F6 tally) is OPEN — fp-only, stamps converge in every observed
run. Every seed runs as an ordinary case: the CI budget is fully clean
and any failure there is a new finding.

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

One deterministic wrinkle: only a sentinel LANE terminates a settle
window — a covering whole-tree segment never does, even one carrying
the current tick's stamp. A segment is a navigation/refetch consume,
and scheduled work legitimately TRAILS it: the statement's forced
lanes start only after the region reopens, and a bump landing
mid-render stays pending (the driver's coverage cursor anchors before
the render begins — the F1 fix) with its lane following the segment.
The settle re-states the bump with a fresh tick on every segment
arrival (keyed on the segment itself, never a timer) and counts the
occurrence (`sentinelRebumps`) as a diagnostic; the fresh tick's lane
is the sound terminator, because the wake that lanes it drains the one
pending set and every earlier-announced lane serializes ahead of it.
A 20s watchdog exists as pure failure detection (a hang is a finding,
not a wait).

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
#   25 sequences × 20 actions, seeds 1..25. Every sequence must
#   converge — zero mismatches of any class is the gate; any failure
#   shrinks to a locally-minimal repro in the assertion message.
PARTON_WAKE_PARITY=1 yarn test:rsc fuzz-convergence

# Long local run — same gate, bigger budget:
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

## Findings ledger (v1)

First long runs (all with `PARTON_WAKE_PARITY=1`, zero parity trips,
zero harness failures): 500 × 20 actions (4.6s — 435 clean / 51 F1 /
14 F2), 3000 × 20 (24s — 2613 / 328 / 59), 1000 × 50 from a distinct
seed range (17s — 780 / 132 / 88). The old stamp-based classifier
lumped every staleness shape into "F1"; fixing the cursor revealed
that tally spanned FIVE distinct roots (F1, F4, F5, the parity-oracle
hold, and F6). Post-F1 runs: 3000 × 20 → 2980 clean / 20 findings,
1000 × 50 → 993 clean / 7 — the "F6" tally, which the F6 fix in turn
split into TWO roots. Post-F6-fix runs: 3000 × 20 → **2999 clean / 1**
(seed 2153), 1000 × 50 from a distinct seed range → **999 clean / 1**
(seed 5722) — both residuals the one OPEN family (F7, fp-only,
~0.03–0.1% of sequences); zero watchdogs, zero parity trips, zero
harness failures. The formerly-pinned seeds (9, 18 → F1; 10 → F2;
1381, 1016 → F6) run as ordinary cases and the CI budget (seeds 1–25)
is fully clean.

- **F1 — FIXED: the covering-segment missed-update window
  (staleness).** `handleNavigation` (`segmented-response.ts`) — and
  the same pattern at the frame-nav uncovered fallback and the
  scheduled reconcile — advanced the wake cursor to `_currentTs()`
  and cleared the subscription's whole pending set AFTER the covering
  segment drained, but the vendored Flight server renders lazily: a
  write that committed while the segment streamed, after its reader's
  row already rendered, was marked covered while its effect was in
  neither the segment nor any lane (stale until an unrelated bump or
  the 30s reconcile; invisible to the wake-parity assert — the bump
  was cleared, so no wake happened at all). Minimal repro:
  `[navigate "/beta?q=y", write cellB=1, write cellB=2]` → reader
  showed `b=1`, cold render `b=2`. **Fix:** all three covering-render
  sites anchor coverage BEFORE the render begins — `since` advances
  to the pre-render `coverTs` and only the deliveries pending at that
  point are cleared; a mid-render delivery stays pending and lanes on
  the reopened region, fp-skipping to a zero-byte confirm when the
  segment did carry the late rows (over-delivery, never stale). The
  same discipline segment 0's `lastTs` and the catch-up anchor always
  followed — see `docs/internals/streaming.md` §the cursor
  discipline. Deterministic regression (both halves — the window
  delivers; the double delivery fp-skips):
  `framework/src/lib/__tests__/covering-cursor.rsc.test.tsx`.

- **F2 — FIXED: parked-variant fp retag (over-fetch class).** The
  fp-trailer's flush recompute shipped heals for MATCH-MISSED
  snapshots, recomputed under the request state that parked them
  (attach at `/alpha?q=x`, navigate `/alpha` → the trailer shipped
  `{fz-gated: {from: W, to: W'}}` with W′ folding `q=null` — a state
  gated's own gate forbids; its body never rendered there), retagging
  the client's parked variant with a never-rendered state's fp —
  permanently defeating its manifest fp-skip (not staleness: the
  tracking invariant keeps wrong confirms impossible; the cost was
  over-fetch + polluted `OVERRIDE_SET_CAP` slots). **Fix:**
  `computeWarmFps` (`fp-trailer.ts`) evaluates each snapshot's match
  gate under the flush request; a gate-failed snapshot gets NO warm
  fp (nothing rendered — there is no drift to heal) and contributes
  the live fold's `nomatch` form to its ancestors (mirroring
  `descendantContribution`, so ancestor folds recompute to what the
  next live render actually emits).

- **F3 — FIXED: `splitAtFpTrailer` hung on a pre-classification
  tear.** A lane body that errored before any byte classified (a
  navigation tear racing the lane's first frame) rejected the trailer
  promise but never closed/errored `mainStream` — a consumer awaiting
  the body (the browser's lane decode included) hung instead of
  rejecting. **Fix:** the pre-classification error path errors the
  body controller too (`fp-trailer-split.ts`), so "a torn decode
  always settles" holds on every path; the trailer promise
  self-observes its rejection so body-only consumers don't produce
  unhandled-rejection reports. Regression tests in
  `framework/src/lib/__tests__/lanes-split.test.ts`; the harness's
  torn-race workaround is gone (a bare body read is safe).

- **F4 — FIXED: acked-slot desync on a stated flip (staleness, found
  by the post-F1 runs).** The old stamp-based long-run classifier had
  bundled this class into the F1 tally; fixing F1 exposed it. Minimal
  repro (seed 245):
  `[flip out fz-cull-b, flip in (stated cached tokens), navigate
"/beta?q=y", settle, navigate "/alpha?q=x"]` → cull-b confirmed at
  q=x while the client's slot holds q=y. Two cooperating facts:
  `applyReportedCached` (the flip statement's mirror replace,
  `segmented-response.ts`) replaced `ackedFps` but NOT the acked SLOT
  index (`ackedSlots`) — desyncing the layers its own doc says it
  replaces wholesale — and cold fps COLLIDE across route buckets (a
  first-in-bucket render's dep-less cold fp is byte-identical across
  request states), so the later /beta delivery's ack fold saw its fp
  already in the stale slot, skipped the slot eviction, and stranded
  the flip's stated q=x warm fp in `ackedFps`, where the return
  navigation's verdict confirmed it against a client slot that now
  holds q=y. **Fix:** `applyReportedCached` replaces the acked slot
  index alongside `ackedFps`, so the next delivery's fold evicts the
  stated fps exactly as the client's slot overwrite did.

- **F5 — FIXED: the whole-route promote claims match-missed
  snapshots (staleness via a superseded navigation).** Minimal repro
  (seed 1030): `[navigate "/alpha?q=y", navigate "/alpha", settle,
navigate "/alpha?q=y"]` → `fz-gated` confirmed at the ATTACH state
  (q=x) on the return. The superseded first navigation's ABORTED
  render registered gated's q=y-form `emittedFp` (bytes that never
  reached the client — the client consumed the empty superseded
  segment as a processed drop), and the /alpha covering segment's
  whole-route `promoteSnapshotsToCachedOverride` walk then claimed
  that fp as a client holding even though gated MATCH-MISSED /alpha
  (it emitted only a parked keepalive hole). The return navigation's
  candidate hit the over-claimed fp and fp-skipped to a phantom
  confirm. **Fix:** the promote applies the F2 discipline — a
  snapshot whose match gate fails the current request didn't render
  here, so nothing about it is claimed (its real fps entered the
  mirror when it actually shipped); framed snapshots keep promoting
  (their gate reads the frame URL — the conservative direction).

- **Parity-oracle hold (exposed by the F1 cursor discipline).** With
  `since` anchored before a covering render, the wake-parity assert's
  bump-side re-derivation includes bumps the covering segment
  legitimately consumed for then-PARKED ids; when such an id's
  cull-gated ancestor flips back in within the same drain window, its
  catch-up rides the ancestor's flip lane — never a lane of its own —
  and the assert (whose `covered` holds applied only to the expiry
  side) threw a false violation (surfacing as the watchdog class,
  seeds 127/855: the in-process drive's controller was never errored
  on a drive-loop throw, so the wire just went silent — `live-drive`
  now surfaces drive rejections as stream errors, matching
  production). **Fix:** `_assertWakeParity` applies the `covered`
  holds to both sides, and the drain's `covered` adds the
  ancestor-lane hold (an open or this-wake-touched ancestor's lane
  re-renders the id inside its subtree). No staleness existed in any
  ordering — the delivery path was correct; the oracle was
  over-strict.

- **F6 — FIXED: the optimistic mirror outruns the client's drop
  reports (the e7dd068 residue).** Was ~0.6% of sequences at the CI
  action mix; two members, one discipline (representative shrunk
  repros: seed 1016
  `[write a=1, write b=2, flip out b+a, flip in b, write b=3,
refetch fz-shared]` — stamp; seed 1381
  `[flip out cull-b, write b=1, refetch fz-inner, flip in
cull-b+out cull-a, flip out cull-b, flip in cull-b]` — fp-only).

  The AS-OF DROP member: a lane that drains onto the wire is promoted
  into the optimistic mirror at drain; when the client's as-of guard
  then drops it (a navigation/refetch statement advanced its
  navigation point while the lane was in flight), the drop report —
  even flushed promptly — cannot beat the covering segment that
  renders synchronously AT the consume, so that render's fp-skip
  verdict confirms the dropped delivery's phantom — and the covering
  segment's own drain promote re-claims the fp AFTER any revocation
  the report could run (its delivery record does not even exist when
  the report arrives), so no purge alone can stop the re-claim from
  folding into the acked layer on the covering ack. **Fix**
  (`applyAckFrame` / `revokeDroppedDelivery` in
  `connection-session.ts`; the `pendingDropHeals` drain in
  `segmented-response.ts`): a `dropped` seq's tokens are revoked from
  every layer — optimistic, acked, and still-pending delivery
  records' derivative claims — AND every dropped id re-queues for a
  FORCED heal lane (fp-skip and the defer gate yield, the refetch
  contract), so fresh bytes ship within one delivery no matter what
  claims the covering render re-established. The prevention
  alternative (the covering segment's verdict excluding
  unacked-older-as-of promotions) was weighed and rejected: it taxes
  the COMMON path — committed-then-navigated deliveries, up to a full
  lazy-ack window of them per navigation, would re-ship on every
  channel navigation — to prevent a rare race, and it re-derives
  "dropped" from `asOf < navSeq`, exactly the inference the e7dd068
  design rejected. The heal keeps the common path untouched and pays
  one forced lane per actually-dropped delivery.

  The FLUSH-ALIAS member: the trailer flush recompute
  (`computeWarmFps`) re-reads the connection's LIVE visible set, so a
  `visible` statement landing between a row's render and the stream's
  flush retagged the emitted fp with a state the row does not carry —
  and an out-flip ships no covering lane, so the aliased heal stood as
  the connection's last word, permanently mis-tagging the client's
  holding. **Fix**: every lane iteration and every covering segment
  render (navigation, reconcile) runs under a PINNED visibility
  moment captured at render start (`_createConnectionLiveProbe`'s
  pin / `_runWithPinnedVisible` in `runtime/context.ts`), and the
  drain promote's parked check reads the same pin — render, verdict,
  flush recompute, and promote all describe ONE set; the statement
  that landed mid-render gets its own resolution (an in-flip lanes; a
  wake on the open lane re-captures at the dirty re-render). The
  initial whole-tree segment is NOT pinned (PartialRoot installs the
  cached override during that render — a nested store would strand
  the install; the v1 harness cannot race segment 0, and the boot
  exposure is bounded by the flip resolution + reconcile).

  Deterministic regression (both members, red without the fixes):
  `framework/src/lib/__tests__/drop-report-heal.rsc.test.tsx`.

- **F7 — OPEN: rival same-drain renders strand a mis-tagged fp
  (split out of the old F6 tally — pre-existing, fp-only).**
  ~0.03–0.1% of sequences; stamps converge in every observed run
  (representative shrunk repros: seed 2153 `[flip out wrap, flip out
a + in wrap, settle, flip out wrap, write b=7, flip out b + in
wrap, write b=8]`; seed 5722 — same shape). Mechanism: one drain
  can start a flip-in lane for a cullable WRAPPER and a bump lane for
  its addressable CHILD (the child's parked-era delivery unparks with
  the wrapper's flip) — two concurrent renders of the child commit
  RIVAL registrations, each lane's trailer heal computes its `from`
  off the canonical (last-registered) emission rather than its own
  body's, and the client commits the lane bodies in WIRE order, which
  can differ from registration order — so the client's last-committed
  child emission carries a fp no heal's `from` matches, stranding the
  (content-correct) copy under a stale tag: over-fetch and mirror
  bookkeeping drift, never staleness. Direction: "describe the
  render" one level deeper — the lane's flush heals and drain promote
  should walk the RENDER'S OWN registrations (the commit handle's
  pending set), not the canonical merge; alternatively the client's
  heal application could go slot-based instead of fp-equality (the
  client merge layer's side). NOT fixable by collapsing the child
  into the ancestor's same-drain lane: a direct flip-in's verdict
  runs against the client's stated tokens, which an earlier flush
  heal may have retagged PAST the child's parked-era bump (the flush
  recompute folds live invalidation timestamps — the inv-ts sibling
  of the F6 alias, sound for unparked readers only because their
  bump always lanes), so the ancestor can CONFIRM while the child's
  change never ships — tried, and seed 824 turned the fp-only drift
  into real staleness; reverted. The child's own lane is the
  guaranteed carrier.

- **Browser-level observation (unshrunk, root unconfirmed):**
  `website/validate-scroll-stress.mjs` intermittently (~1 in 6 runs
  post-F6-fix; also red at the pre-fix HEAD) fails its RE-ENTRY
  batteries (diagonalBack / southCruise / longHaulReturn) with
  persistent 2×2 chunk holes inside quad-tile blocks — previously-
  visited-then-parked territory only; forward exploration always
  converges. The F6 fix does not heal it, and the world sends no
  `url` frames, so the as-of race cannot be its root; the quad-tile
  parent / chunk-child shape matches F7's wrapper/child geometry
  (a quad flip-in confirming past its children's parked-era state),
  but that is a hypothesis — needs a v1 fixture extension or a
  shrink of its own.

- **Harness finding (fixed alongside F1): a covering segment is not
  a quiescence proof.** The settle protocol formerly terminated a
  window on ANY event carrying the current sentinel stamp — but a
  covering segment that absorbs the bump can have scheduled work
  TRAILING it (a refetch statement's forced lanes start only after
  the region reopens; a mid-render delivery's lane follows the
  segment), so terminating on it dropped trailing lanes from the
  model and mis-reported the server. Only a sentinel LANE terminates
  now (§Quiescence).

- **Harness finding: an ANNOUNCED torn lane must consume PROCESSED.**
  The model's torn-lane path dropped the body without consuming its
  queued delivery seq; a lane that announced EARLY (a window-force
  lane's root-ready seq entry, a producer's `muxlive`) and was then
  torn by a navigation left a permanent gap that wedged the
  contiguous watermark (surfacing as a rare settle watchdog). The
  real client consumes exactly this case as PROCESSED with a drop
  report (`_laneDeliveryDroppedStale`); the model now mirrors it.
