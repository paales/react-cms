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

Status: **v1 and v2 shipped.** v1 —
`framework/src/test/fuzz-harness.ts` (runner, model, oracle,
shrinker), `framework/src/test/fuzz-wire.ts` (Flight extraction),
`framework/src/lib/__tests__/fuzz-fixture.tsx` (the fixture app),
`framework/src/lib/__tests__/fuzz-convergence.rsc.test.tsx` (the CI
budget + env knobs). v2 — the REAL client merge layer under the walk
(§v2 below): `framework/src/test/fuzz-harness-v2.ts`,
`framework/src/lib/__tests__/fuzz-fixture-v2.tsx` (v1's shapes plus
the async-body `$@` geometry),
`framework/src/lib/__tests__/fuzz-convergence-v2.rsc.test.tsx`.
The findings ledger is at the bottom — the v1 harness found two real
framework bug classes on its first day, and fixing them exposed three
more the old classifier had lumped in. F1–F8 are FIXED (F8 was found
in the FIELD, not by the fuzzer — it lives in the layer the v1 model
deliberately does not run; v2 exists to close exactly that gap and
found five more real classes on ITS first day: F9–F12 in the merge
layer and F13 server-side (seed 77 below), all fixed.
Every seed runs as an ordinary case: the CI budgets are
fully clean and any failure there is a new finding. The post-F7 v1
long runs are ZERO findings at every budget tried (3000×20, 1000×50
from a distinct seed range, 500×50 — the last after fixing a harness
settle-terminator hole, seed 336 below). The post-F13 v2 runs:
seeds 1–500, 10000+ (×30), and 50000+ budgets all fully clean —
including the 50500–51000 window that held both seed-77 siblings.

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

Two deterministic wrinkles. First: only a sentinel LANE terminates a
settle window — a covering whole-tree segment never does, even one
carrying the current tick's stamp. A segment is a navigation/refetch
consume, and scheduled work legitimately TRAILS it: the statement's
forced lanes start only after the region reopens, and a bump landing
mid-render stays pending (the driver's coverage cursor anchors before
the render begins — the F1 fix) with its lane following the segment.
The settle re-states the bump with a fresh tick on every segment
arrival (keyed on the segment itself, never a timer) and counts the
occurrence (`sentinelRebumps`) as a diagnostic; the fresh tick's lane
is the sound terminator, because the wake that lanes it drains the one
pending set. Second: the terminator counts only once the model's
contiguous watermark COVERS its delivery seq. Lane OPENINGS can
reorder relative to delivery seqs — two adjacent wakes' pumps race
their first chunks onto the wire, so the sentinel's lane can surface
ahead of an earlier-seq lane still in the pipe — and terminating on it
would leave that delivery unconsumed (the seed-336 harness finding
below). The seq gap is the real signal: every minted seq reaches the
wire (a body's seq entry, a torn-consume, or a `seqvoid`), so the
settle drains until the gap closes. A 20s watchdog exists as pure
failure detection (a hang is a finding, not a wait).

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

**What it does NOT cover (v1), honestly**: the REAL client merge
IMPLEMENTATION — the model applies the commit RULES to per-id
records; `cacheFromStreamingChildren` / `substituteNested` /
`_commitPartonLane` never run, so a bug in the walks themselves can
never surface as an oracle mismatch (the F8 class: the wire extractor
resolves `$@` outlined promise rows structurally, so the model saw
content the real walks could not reach — and the fixture has no async
Render body, so no `$@` row even crosses the fuzz wire). Found
instances get a deterministic regression family beside the fuzzer
driving the real walks against real Flight decodes
(`async-parent-nested-heal.rsc.test.tsx`); running the real merge
layer against the wire is the v2/v3 direction. Also out: byte-identical bodies
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

## v2 — the walk drives the REAL client merge layer

v1's model applies commit RULES to per-id records; a bug in the walks
themselves can never surface there (the F8 lesson). v2 is a second,
deeper oracle beside it: every step renders the fixture through the
real server, encodes to real Flight bytes, decodes with the real
Flight client, and commits through the REAL merge functions. Harness:
`framework/src/test/fuzz-harness-v2.ts`; fixture:
`fuzz-fixture-v2.tsx` (the v1 shapes plus `fz-async-leaf` and
`fz-async-wrap`/`fz-async-inner` — async Render bodies whose children
cross the wire as outlined `$@` promise rows, pinned by the geometry
test the same way `async-parent-nested-heal.rsc.test.tsx` pins it).

**What runs for real.** Whole-tree steps (attach, navigations) run the
same walk `PartialsClient` runs in the browser —
`cacheFromStreamingChildren` → `deriveTemplate`/`setTemplate` →
frontier harvest → `pruneToLive` — with the manifest built from the
client's own `getCachedPartialIds()` and the visible set on the
request's connection session. Lane steps (writes fan out to every
live displayed parton; refetches force one; flip-ins revalidate the
flipped parton) re-render one parton from its registry snapshot
(`partialFromSnapshot` under a lane-shaped partial state,
`flushScopeId` trailer — the production lane pipeline) and commit
through the real `_commitPartonLane` / `_commitPartonLaneProgressive`
+ `_applyFpUpdates`. The fp-skip verdicts deciding who ships bytes
and who confirms are the real server verdicts against the client's
real advertised manifest. Module-level client state persists across
steps and resets per trial (`_resetClientStateForTest`,
`_resetLaneCommitStateForTest`).

**Interleaving as fuzz dimensions, causally.** Each action carries a
`DeliveryPlan`: `hold` withholds tail Flight rows at commit time (the
decoded chunks are GENUINELY pending — the settlement re-walk
machinery arms for real; a held lane commits through the progressive
root-ready contract), `order` sequences the held delivery's two
release events (fp-trailer apply vs row settlement + re-walks — both
orders reachable, the e728964 dimension), `reverse` flips the lane
commit order (rival orderings). Held deliveries stay held across
subsequent actions (`release` pops the oldest; `settle` drains all);
a NAVIGATE tears held lanes — their chunks REJECT — mirroring the
region tear (delivering a pre-nav lane's rows after the covering
segment is an interleaving the real transport cannot produce; an
earlier harness draft did, and manufactured false staleness).
Quiescence is the re-walks' own completion signal
(`_settleLaneRewalksForTest`, scoped per (parton, commit
generation)), never a timer; a watchdog is pure failure detection.

**The oracles** (after a forced settle):

1. **Convergence** — `renderTemplate(template, cache)` over the real
   client state, walked with an await-based collector (hidden
   `<Activity>` = parked, CullPair display follows the stated set),
   must equal a fresh cold render of the final URL + scope +
   visibility set: state / stamp / matchKey per parton.
2. **Advertise honesty** — (a) every advertised `id:matchKey:fp`
   token has a content slot (restorability, the structural gate);
   (b) a fresh render presented the FULL manifest
   (`getAllCachedPartialTokens`) must not confirm content the client
   cannot restore or holds stale (ghost / stale confirm — the client
   copy's stamp is compared against the cold stamp for every
   non-parked hole/confirm); (c) warm skip parity: the CONNECTION
   flavor's candidate (`_recomputeSubtreeWarmFp`) must be among the
   advertised fps for every current-content leaf that advertises
   anything — losing the warm alias is the e728964 class (full price
   on every connection nav). Discrete-nav parity (the emitted-fp
   flavor) is deliberately NOT asserted: body reads lag one render,
   so the visit after a bucket's cold record legitimately re-renders
   (the documented cold-record over-fetch).

**What stays modeled/out, honestly.** React's actual DOM commit,
hydration, Activity parking mechanics and the cull-park content pool
(v2's culled "display" is the harness's stated set, v1 semantics);
`PartialsClient`'s ~30 lines of orchestration are transcribed into
`walkWholeTree` (the walks, template ops and state modules are the
real ones — the component's React wiring is not executed; kept in
lockstep by hand); the live-connection delivery plane — envelopes,
acks, the as-of guard, the server mirror layers — stays v1's job (v2
renders are request/response with the manifest, so mirror-side
classes like F4–F7 are v1's to catch); frames, cookies, actions,
`expires()`, defer gates, byte-cache replay are in neither alphabet
yet. Regression demonstrations (run locally, not committed): blinding
`unwrapLazy`'s thenable arm (the 34e1b9a revert) fails the CI budget
and pinned seed 90001 with the exact F8 signature; removing
`cacheStore`'s identity check (the e728964 revert) fails pinned seed
90002 with the warm-parity signature. Both are ordinary clean cases
on HEAD.

**Cost + budget.** ~25–30 ms per trial at 20 actions (~1.3 ms per
action — each action is one-to-eleven real renders + Flight decode +
commit; 500×20 ≈ 13 s, 1000×20 ≈ 26 s wall). The CI budget is 25
trials × 15 actions from seed 1 (~1 s), running as part of
`yarn test:rsc` beside v1's, plus the pinned deterministic seeds
(90001/90002 — the two demonstrations; 90011/90017/90072/90305 — the
F9–F12 shrunk repros; seed 77 pinned `it.fails` as the OPEN finding).

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

# v2 — the real-merge-layer walk (CI: 25 trials × 15 actions):
yarn test:rsc fuzz-convergence-v2

# v2 long local run:
FUZZ_V2_BUDGET=500 FUZZ_V2_LEN=20 yarn test:rsc fuzz-convergence-v2

# Knobs: FUZZ_V2_BUDGET, FUZZ_V2_LEN, FUZZ_V2_SEED (same shapes)
```

## Staging

- **v1** — in-process rsc tier: real segment driver, real
  channel apply, fake wire (in-process reader), sequential burst
  schedule, MODELED client. The protocol/mirror ratchet.
- **v2 (shipped)** — the REAL client merge layer under the walk (§v2
  above): real renders → real Flight decode → the real commit walks,
  template substitution, prune, fp registration and trailer aliasing,
  with held-delivery interleaving (rows vs trailer vs re-walks) as
  seeded dimensions. The merge-layer ratchet — the two harnesses
  overlap on the oracle and split the mechanism surface.
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
(seed 5722) — both residuals the F7 family (fp-only, ~0.03–0.1% of
sequences); zero watchdogs, zero parity trips, zero harness failures.
Post-F7-fix runs (with the seed-336 settle-terminator harness fix):
3000 × 20 → **3000 clean / 0**, 1000 × 50 from the distinct seed range
→ **1000 clean / 0**, 500 × 50 from seed 1 → **500 clean / 0** — zero
findings of any class. The formerly-pinned seeds (9, 18 → F1; 10 → F2;
1381, 1016 → F6; 2153, 5722 → F7; 336 → the settle terminator) run as
ordinary cases and the CI budget (seeds 1–25) is fully clean.

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

- **F7 — FIXED: rival same-drain renders strand a mis-tagged fp
  (split out of the old F6 tally — pre-existing, fp-only).** Was
  ~0.03–0.1% of sequences; stamps converged in every observed run
  (representative shrunk repros: seed 2153 `[flip out wrap, flip out
a + in wrap, settle, flip out wrap, write b=7, flip out b + in
wrap, write b=8]`; seed 5722 — same shape). Mechanism: one drain
  can start a flip-in lane for a cullable WRAPPER and a bump lane for
  its addressable CHILD (the child's parked-era delivery unparks with
  the wrapper's flip) — two concurrent renders of the child commit
  RIVAL registrations, each lane's trailer heal computed its `from`
  off the canonical (last-registered) emission rather than its own
  body's, and the client commits the lane bodies in WIRE order, which
  can differ from registration order — so the client's last-committed
  child emission carried a fp no heal's `from` matched, stranding the
  (content-correct) copy under a stale tag: over-fetch and mirror
  bookkeeping drift, never staleness. **Fix:** "describe the render"
  one level deeper — the per-render registration capture. Each lane
  iteration's probe installs a registration map
  (`_createConnectionLiveProbe` in `runtime/context.ts`;
  `registerPartial` writes through `_renderRegistrationCapture`), and
  both consumers of a lane render's emissions read snapshots through
  it (`_activeRenderRegistrations`, `partial-registry.ts`): the
  trailer flush's scoped fold (`wrapStreamWithFpTrailer` /
  `foldUpdates`, fp-trailer.ts) computes each heal's `from` off the
  fp THIS body emitted, and the drain promote
  (`promoteSnapshotsToCachedOverride`, segmented-response.ts) claims
  — and records on the delivery, for the F6 revocation's sake —
  exactly the fps this body carried. Both rivals heal to the shared
  warm fp, so whichever body the client commits last has a matching
  heal. Whole-tree renders carry no capture (covering renders tear or
  trail open lanes — no rival exists) and keep the canonical fold;
  the broadcast publisher's body probe carries its own. NOT fixable
  by collapsing the child into the ancestor's same-drain lane: a
  direct flip-in's verdict runs against the client's stated tokens,
  which an earlier flush heal may have retagged PAST the child's
  parked-era bump (the flush recompute folds live invalidation
  timestamps — the inv-ts sibling of the F6 alias, sound for unparked
  readers only because their bump always lanes), so the ancestor can
  CONFIRM while the child's change never ships — tried, and seed 824
  turned the fp-only drift into real staleness; reverted. The child's
  own lane is the guaranteed carrier. Deterministic regression (both
  shrunk sequences, red without the fix):
  `framework/src/lib/__tests__/rival-lane-heal.rsc.test.tsx`.

- **F8 — FIXED: outlined promise children are invisible to the real
  merge walks (found in the FIELD — the website's auction-lot bug —
  not by the fuzzer; the model gap that let it survive is ledgered
  here).** An ASYNC Render body reaches its `<PartialErrorBoundary>`
  wrapper as a raw Promise (`partial.tsx` wraps
  `spec.Render(renderProps)`'s return value directly), so Flight
  ships the wrapper's children as an OUTLINED PROMISE ROW
  (`"children":"$@N"`), which the client decodes to a Flight CHUNK —
  an instrumented thenable, not a React lazy. The merge walks
  (`cacheFromStreamingChildren`, `substituteNested`,
  `harvestPartialIds`, `deriveTemplate`) only unwrapped lazies, so
  everything behind the promise was outside the merge layer's reach:
  a nested addressable child's cache entry never landed from any
  payload containing its async parent, and a parent lane that
  fp-skipped the child committed a wrapper whose `<i data-partial>`
  hole mounted through React's NATIVE thenable resolution — the
  child's own lane bytes sat in `_currentPagePartials` under the
  exactly-matching `(id, matchKey)` key while the DOM kept the hole
  indefinitely (and the payload prune's harvest, equally blind, could
  drop nested entries behind async parents). **Fix** (`unwrapLazy` +
  the lane-commit re-walk, `partial-cache.ts`): the walks read the
  decoded chunk's OWN settlement record — the Flight client's
  `status`/`value` protocol, which is also the instrumentation
  `use()` writes onto plain thenables — descending fulfilled chunks,
  forcing a `resolved_model` chunk's synchronous init through its own
  `.then()` (the same forcing a lazy's `_init` gets), classifying
  in-flight chunks `LAZY_PENDING` (which already poisons the
  `substituteNested` wrapper memo, so no stale entry survives the
  pending→fulfilled transition), and capturing pending chunks so
  `_commitPartonLane` re-walks its payload on settlement,
  generation-guarded (`_commitPartonLaneProgressive` now delegates —
  a producer body is the always-pending-at-first-walk case of the
  same commit). **Why the fuzzer missed it:** the v1 client model
  never runs the real walks — it applies commit rules to per-id
  records, and `fuzz-wire.ts` resolves `$@` rows structurally, so the
  model "saw" content the real merge layer could not reach; the
  fixture also has no async Render body, so no `$@` row ever crossed
  the fuzz wire. The gap is recorded under "What it does NOT cover" —
  and CLOSED by v2 (§v2 above), which drives the real walks against
  real Flight decodes with the `$@` geometry in its fixture; the F8
  revert demonstration (pinned seed 90001) is red within one CI
  budget. Deterministic regression (real Flight encode→decode, real
  commit walk + template substitution, red without the fix):
  `framework/src/lib/__tests__/async-parent-nested-heal.rsc.test.tsx`;
  thenable-arm unit coverage (memo poisoning, plain-thenable
  instrumentation, rejected-chunk opacity) beside the memo tests in
  `partial-cache-substitute.test.tsx`.

- **Browser-level finding — FIXED (client merge layer): the flip-in
  confirm against a stated holding whose CONTENT the client already
  evicted.** `website/validate-scroll-stress.mjs` intermittently
  failed its RE-ENTRY batteries (diagonalBack / southCruise / zigzag /
  longHaulReturn backtracks) with persistent 2×2 chunk holes inside
  stuck quad-tile placeholders — previously-visited-then-parked
  territory only. NOT F7 and NOT a server-lane bug. The instrumented
  chain (server flip/lane traces + client IO/controller/transport
  hooks, one stuck quad end-to-end): the client's re-entry flip-in
  statement carried `cached` tokens for the quad (`cached#=2` —
  `cachedTokensFor` reads `_currentPageFingerprints`), the server
  honored the claim and CONFIRMED with the zero-byte placeholder —
  but the client's CONTENT for the quad was already gone, so the
  confirm restored nothing and the skeleton stood. The deadlock was
  total and mutual: controller baseline in-view, session set holds
  the id, server mirror holds the confirmed fp — no delta anywhere
  until a lucky later flip stating `cached#=0` or the 30s reconcile.
  The regression detector (`_visibilityContentRegressed`) never
  fires: the content died PARKED, before the confirm — no
  content→skeleton transition exists to observe.

  **The actual gap — which layer lied.** Both destroyers already
  purged BOTH maps and reported upstream (`evictCulledContent` and
  the pool-cap `evictOldest` delete cache + fps together and ride
  `AckFrame.evicted`; the server revokes every credit layer). The
  tokens RESURRECTED after the purge: `PartialErrorBoundary`'s
  render-time fallback registration (`registerClientPartial` from
  `render()`) re-fires from a still-MOUNTED fiber — a parked parton
  lives inline inside an ancestor's cached wrapper, so the eviction
  deletes its slots without unmounting it, and any later re-render
  (an ancestor's restore, an offscreen prerender) re-advertised the
  fp with nothing restorable behind it. A probe build confirmed the
  writer in the field: every `[resurrect-after-eviction]` stack ran
  through `PartialErrorBoundary.render`. The server-side revocation
  cannot defend against it — the next flip statement's `cached`
  tokens REPLACE the mirror layers wholesale (`applyReportedCached`,
  the F4 discipline), so a lying client statement re-arms the credit
  the report just revoked. The client's advertised set is the
  load-bearing layer.

  **Fix — the advertise-honesty gate** (`registerClientPartial`,
  `partial-client-state.ts`): an fp registers only while the
  `(id, matchKey)` CONTENT slot holds the subtree it describes — the
  invariant "never advertise an fp for bytes you cannot restore",
  enforced structurally at the one writer of the advertised set
  (`_currentPageFingerprints` ⊆ `_currentPagePartials`, per variant).
  The commit walks store content before registering, so every honest
  registration passes; the boundary's fallback registration becomes a
  no-op exactly when the content is gone, the next flip-in states
  `cached#=0`, and the server renders fresh — heal within one flip
  RTT, with the `evicted` report (already wired) agreeing
  server-side. Deterministic regression (map-level, the mounted-PEB
  re-render, and the flip statement's `cached#=0`):
  `framework/src/lib/__tests__/advertise-honesty.test.tsx`. The
  scroll-stress CI step is now a HARD GATE (the validator excludes
  the one DESIGNED ≥400 answer — a `/__parton/channel` 404 for an
  envelope racing the auto-upgrade's park-exit close, which the
  transport self-heals by re-owning the frames).

- **Harness finding (fixed alongside F1): a covering segment is not
  a quiescence proof.** The settle protocol formerly terminated a
  window on ANY event carrying the current sentinel stamp — but a
  covering segment that absorbs the bump can have scheduled work
  TRAILING it (a refetch statement's forced lanes start only after
  the region reopens; a mid-render delivery's lane follows the
  segment), so terminating on it dropped trailing lanes from the
  model and mis-reported the server. Only a sentinel LANE terminates
  now (§Quiescence).

- **Harness finding (seed 336): the settle terminator must wait out
  the seq gap.** Surfaced by a 500 × 50 deep run as a stamp+fp
  "staleness" on fz-inner (shrunk: `[write b=1, four flips, navigate
  same-url, flip in wrap, write b=19, settle, flip out cull-a, write
b=21]`, timing-sensitive ~1-in-few runs). Driver-side tracing proved
  the server SHIPPED everything: the b=21 bump laned fz-inner as
  delivery seq 12 and the settle's sentinel as seq 13 — but the two
  pumps raced their FIRST chunks onto the wire, the sentinel's lane
  OPENED first, and the model (which consumes lanes in open order)
  terminated the settle on it with seq 12 still in the pipe. The
  model's own watermark held the evidence (wedged at 11, gap at 12);
  the real client decodes lanes concurrently and commits every
  arrival, so no framework bug exists. **Fix (harness):** the sentinel
  lane terminates a settle round only once the contiguous watermark
  covers its delivery seq; a gapped terminator keeps draining (the
  gap-filler is in flight — every minted seq reaches the wire as a
  body, a torn-consume, or a `seqvoid`), and a genuinely-lost seq
  hangs into the watchdog, surfacing as a real finding instead of a
  silent under-read. See §Quiescence.

- **Harness finding: an ANNOUNCED torn lane must consume PROCESSED.**
  The model's torn-lane path dropped the body without consuming its
  queued delivery seq; a lane that announced EARLY (a window-force
  lane's root-ready seq entry, a producer's `muxlive`) and was then
  torn by a navigation left a permanent gap that wedged the
  contiguous watermark (surfacing as a rare settle watchdog). The
  real client consumes exactly this case as PROCESSED with a drop
  report (`_laneDeliveryDroppedStale`); the model now mirrors it.

## Findings ledger (v2)

The first v2 runs (25×15 through 500×20) surfaced FOUR real
merge-layer classes — every one in the code the v1 model deliberately
does not run — plus one open server-side class. All four fixes are in
the client merge layer (`partial-client-state.ts` /
`partial-cache.ts` / `partial-client.tsx`); each has a pinned
deterministic seed in `fuzz-convergence-v2.rsc.test.tsx` and the full
node+rsc suites are untouched by them.

- **F9 — FIXED: a superseded payload's late settlement re-walk
  clobbers a newer commit's slot (staleness).** A progressive/held
  lane commit re-walks its payload when the captured chunks settle —
  guarded only by the per-parton lane GENERATION, which whole-tree
  commits never bump: a covering navigation segment could replace the
  slot with fresh content and the old lane's re-walk would re-store
  its older body right over it (shrunk repro: two held write lanes,
  then a covering navigate — the client ends showing the write-era
  body at the post-nav state). The same door exists through
  `PartialsClient`'s incomplete-walk re-render clobbering a newer
  LANE's slot. **Fix:** commit-order bookkeeping — every commit batch
  (one payload's walk + its re-walks) runs under a monotonic store
  seq, recorded per slot; `cacheStore` drops a store whose batch is
  older than the slot's occupant (the client-side sibling of the
  server's as-of drop), and a dropped store suppresses the walk's
  follow-up fp registration (a torn superseded payload's re-walk
  would otherwise RESURRECT a claim for content the slot no longer
  holds — the ghost-confirm direction). Pinned seed 90011.

- **F10 — FIXED: the cold→warm alias dies when its anchor registers
  late (over-fetch, the e728964 sibling).** `_applyFpUpdates` anchored
  an alias on the variant set holding `from` — but when the anchor
  wrapper is still behind a pending chunk (its cold fp registers only
  at the settlement re-walk), a trailer applied between the walks
  found no anchor and dropped the warm fp: the variant advertised
  cold-only forever and every connection nav re-rendered it full
  price (the warm-parity oracle's signature). **Fix:** the
  pending-alias ledger — an unanchored alias pends per (id, `from`),
  is consumed by exactly that registration, and dies when a REPLACING
  store from a newer commit batch retires its content generation
  (mint-seq scoped, so a response's own stores never eat its own
  alias, while a genuinely superseded trailer still dies). Pinned
  seed 90017.

- **F11 — FIXED: a pending-blocked frontier harvest let the prune
  blank nested variants (staleness/blanking).** `PartialsClient`'s
  prune expands `seen` by harvesting cached wrappers — and
  `harvestPartialIds` silently stops at pending chunks, so a prune
  running while an ANCESTOR's progressive lane commit was mid-stream
  dropped every nested variant hiding behind the unresolved chunk
  (inner/async-inner blanked; shrunk repro: navigate, held navigate,
  held write lanes). **Fix:** the harvest reports pendingness and a
  pending-blocked pass DEFERS the prune (over-retention, never
  blanking — the same discipline the pending-RENDER guard always had;
  the live-tree eviction exemption still refreshes). Pinned seed
  90072.

- **F12 — FIXED: a torn progressive delivery kept advertising — and
  displaying — bytes it could not complete (ghost confirm +
  shadowing).** A lane committed at root-ready whose remaining rows
  REJECT (navigation tear) held a subtree with pending-forever holes:
  its fps stayed advertised (next presentation CONFIRMS torn content
  with no delta left to heal it), the torn slot SHADOWED good inline
  content through `substituteNested` (a later ancestor confirm
  substituted the torn slot over the ancestor's own fresh copy), and
  an ancestor's advertised fp kept claiming a composition whose hole
  the eviction had unbacked. **Fix:** the settlement re-walk reads its
  own `allSettled` outcomes — on any rejection it EVICTS every variant
  the payload still owns (slot-seq ownership; content + fps + loss
  report) and de-advertises every cached wrapper whose content
  references an evicted variant through a placeholder
  (`collectPlaceholderRefs`; a slot whose own content is still
  streaming is de-advertised conservatively). Over-fetch on tears,
  never a standing blank. Pinned seed 90305.

- **F13 (seed 77) — the flush recompute retags a culled-ancestor
  descendant (staleness on flip-in; server-side, F2's sibling).
  FIXED.** `computeWarmFps` healed every route snapshot under the
  flush request — including a descendant whose ANCESTOR was culled on
  this response: the descendant's body never ran, yet its fp was
  recomputed under the new request state and the heal retagged the
  client's parked copy (held inside the culled ancestor's content)
  with a state it does not carry. The next flip-in's verdict then
  legitimately CONFIRMED the mis-tagged copy: `[flip out wrap,
  navigate cross-state, flip in wrap]` showed the pre-nav descendant
  state (~0.2% of v2 trials; seeds 77/50507/50925 all shrink to this
  shape). Fix: the culled-ancestor sibling of the F2 discipline ("a
  snapshot that did not render here gets NO warm fp") in
  `computeWarmFps` (fp-trailer.ts) — a snapshot with any culled
  ancestor on its parentPath is skipped by the heal; the culled
  instance ITSELF still heals (its skeleton render is a real render
  of the culled variant). Pinned as an ordinary case, seed 77.

- **Harness finding: delivering a pre-nav lane's rows after the
  covering segment is not a real interleaving.** An early v2 draft
  released held lane bytes across navigations; the real transport
  TEARS the region's open lanes at a window statement, so those rows
  reject client-side and never commit. The un-torn version
  manufactured "staleness" the production client cannot exhibit; the
  harness now tears held lanes on navigate (their chunks reject, the
  settlement re-walk runs against the rejections — which is exactly
  what surfaced F12 for real).
