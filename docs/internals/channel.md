# The channel — the attach + upstream envelopes

The client-states-facts half of the live connection. Two request
shapes carry the statements: the ATTACH — the heartbeat's live fire
as a POST whose body is the full client statement, answered by the
held segmented stream — and the coalesced envelopes of frames a page
POSTs to the session that stream opened. Visibility flips, delivery
ACKS, and viewport TELEMETRY are the shipped frame kinds; the grammar
is built to grow (url / cancel are designed but unshipped — the
roadmap and the full design rationale live in
[`../notes/channel-design.md`](../notes/channel-design.md)). The
downstream half — segments, lanes, markers — is
[`streaming.md`](./streaming.md); the delivery-seq / ack / applied
machinery that makes the channel EVIDENCED is §Delivery is evidenced
below.

## The attach — the connection's opening statement

Opening the channel IS a discrete request: the heartbeat's live fire
is a POST to the page's own `_.rsc` URL, marked by an explicit
request header and carrying the client statement as its JSON body
(`AttachStatement` in `framework/src/lib/channel-protocol.ts`):

```
POST /<page>_.rsc?live=1&streaming=1
x-parton-attach: 1

{ "cached": [...], "since": {"epoch","ts"} | null, "visible": [...] | null, "applied": N }
```

- `cached` — the manifest: the client's `id:matchKey:fp` tokens,
  stating WHAT it holds. UNCAPPED — the body has no request line to
  protect, so the 96-entry `CACHED_MANIFEST_CAP` and the parked-id
  priority walk apply only to the `?cached=` URL form, which survives
  unchanged for every discrete request (targeted refetches,
  navigations, preloads, action POSTs). The body manifest is
  structurally bounded by the client pool itself — at most
  `CLIENT_POOL_CAP` ids, each variant capped at `FP_CAP_PER_VARIANT`
  fps (`getAllCachedPartialTokens` in `partial-client-state.ts`).
  `PartialRoot` and the catch-up override install read the statement
  where a discrete request's read the URL param; verdicts are
  transport-identical.
- `since` — the catch-up anchor, stating WHEN the client last heard:
  the document's registry anchor, take-once. The honor checks are
  unchanged (a live subscription, the epoch names the CURRENT
  registry timeline, the route still has snapshots): honored, the
  driver skips the whole-route initial segment and opens straight
  into lanes; refused, it falls through to the full render —
  over-fetch, never stale. The anchor rides ONLY the attach body; no
  `?since=` URL form exists.
- `visible` — the viewport seed, stating what the client SEES.
  `null` is the unmeasured state (no statement); `[]` is a
  measurement. The `?visible=` URL param survives as the no-session
  fallback carrier (`readVisible`'s discrete cull-in reloads).
- `applied` — the upstream watermark, stating what the client last
  HEARD the server apply: the highest upstream envelope seq from a
  downstream `applied` marker (absent normalizes to 0 — an old
  client states no watermark). The envelope seq is PAGE-LIFETIME
  monotonic, so the new session seeds its applied gate here and the
  marker never announces below what the client already heard. The
  three timeline fields never compete: `since` bounds the DOWNSTREAM
  resync window (what the initial segment must cover), `applied`
  anchors the UPSTREAM envelope timeline, and delivery acks bound
  the mirror.

Dispatch is by explicit marker, never body shape: `parseRenderRequest`
keys an `_.rsc` POST on `x-parton-attach` (the attach — the full
segmented drive + fp-trailer path, exactly a live GET's) vs
`x-rsc-action` (an action — one commit-only segment). An action POST
whose body happens to be statement-shaped stays an action and never
opens a drive; an attach never decodes as an action; a POST claiming
both markers is ill-formed. A malformed statement answers `400`. The
statement lands on the request store (`applyAttachStatement` — the
seam the entry and the in-process live-drive harness share) before
any render runs, and unknown statement fields are IGNORED — the
statement grows by adding fields.

The attach is also the CREDENTIAL REBIND point: every attach binds
its OWN request's scope + session identity into the connection
session (`openLiveConnectionSession`), so a session cookie minted
mid-connection — which 404s envelopes for the rest of that
connection — starts working the moment the next attach presents it.

## Wire shape

One fire-and-forget POST per coalesced batch:

```
POST /__parton/channel
{ connection: string, seq: number, frames: Frame[] }
```

- `connection` — the SERVER-MINTED id of the live connection this
  envelope addresses (see §The id handshake). Never inferred, never a
  URL param.
- `seq` — PAGE-LIFETIME monotonic, minted by the client transport and
  never restarted at establishment: retransmitted reliable envelopes
  keep their original seqs across reattaches, and the downstream
  `applied` marker names one unambiguous timeline. Each envelope's
  apply advances the session's `appliedSeq` (max — arrival order IS
  seq order, since the transport serializes envelopes). Idempotence
  is PER FRAME KIND, never a whole-envelope replay gate: the session
  applies a `visible` frame's snapshot only from envelopes at or past
  the last applied seq (`>=`, so a later frame in the SAME envelope
  stands), so a stale envelope can't regress newer state; per-id flip
  statements order by seq independently (a stale envelope's flips
  still queue — statement semantics in
  [`streaming.md`](./streaming.md) §Visibility rides the connection);
  an `ack` is cumulative (the watermark only moves forward).
- `frames` — ordered within the envelope. A discriminated union on
  `kind`; UNKNOWN kinds are SKIPPED, never errors (the same
  extensibility rule the downstream marker grammar follows), while a
  malformed KNOWN kind is a protocol violation (`400`).

Frame kinds shipped:

| Kind | Carries | Server effect |
|---|---|---|
| `visible` | `{changed, visible, cached?}` — the visibility statement: flipped ids, the wholesale snapshot, the client's actual holdings for the changed ids | Applied to the connection session; flipped-IN partons lane on the EXISTING stream (never on this response) |
| `ack` | `{delivered}` — the highest CONTIGUOUSLY committed delivery seq (cumulative) | Advances the session's ack watermark, folds the covered deliveries' fps into the ACKED mirror layer, frees the unacked delivery window (the parked driver wakes), and — any ack frame at all — proves the duplex (`firstAckReceived`, the never-acked degrade's off-switch) |
| `detach` | nothing | Explicit close: the parked driver wakes, the drive loop exits, the session closes. Best-effort by nature (sent on `pagehide` via keepalive fetch); the keepalive timeout remains the backstop |
| `telemetry` | `{viewport: {w,h}, scroll: {x,y,vx,vy}, at}` — the client's scroll context: container box, position, velocity (px/s), performance-clock timestamp | Replaces the session's `telemetry` slot, latest-wins by envelope seq. NOTHING else: no invalidation, no wake, never a render — the channel carries freshness statements, and telemetry is CONTEXT, not a dependency. Consumers read the slot when awake for their own reasons (the warm pass — see §Telemetry) |

Responses carry no body: `204` applied; `400` malformed; `403`
cross-site; `404` connection gone — see §Security. Frame kinds split
into three classes: **loss-tolerant** (`visible`, `detach`, `ack` —
the protocol re-establishes their statements on its own: the next
attach's seed, the keepalive backstop, the cumulative watermark),
**lossy** (`telemetry` — newest-wins, droppable, no fallback: only
the latest statement has value), and **reliable** (the url / cancel
kinds later packages add), which ride the transport's retransmit
buffer — see §Delivery is evidenced.

Shared grammar + decoder: `framework/src/lib/channel-protocol.ts`
(import-safe on both sides).

## Telemetry — the lossy class

`telemetry` is the one shipped LOSSY kind, and its whole pipeline is
built around "context, not dependency":

- **Producing.** The app states its scroll context through
  `reportTelemetry(data)` (`framework/src/lib/telemetry.ts`, deep
  path from `"use client"` modules — the website world's scroller is
  the first producer). The module keeps at most ONE pending frame
  (newest-wins; a new report overwrites the old) and schedules NO
  flush and NO timer: the frame rides the next envelope another
  statement justifies — during any scroll that could reach parked
  content, visibility flips and acks fire constantly, so telemetry
  flows exactly when it is useful and adds zero traffic of its own.
  A failed envelope drops the frame (`deliveryFailed` re-queues
  nothing); `collect(null)` — no connection — drops it too, because
  re-presenting stale context later would state a falsehood. Never
  `reliable`: telemetry never enters the retransmit buffer.
- **Applying.** The session's `telemetry` slot
  (`ConnectionSession.telemetry`) is replaced wholesale, latest-wins
  by envelope seq, stamped with `receivedAt` (the server clock a
  projection extrapolates on). Applying one fires no wake and
  records no invalidation; the envelope's own applied-watermark
  advance follows the standard envelope rule (a wake that renders
  nothing).
- **Consuming.** The segment driver's predictive warm pass — see
  [`streaming.md`](./streaming.md) §Predictive warming at park. The
  server-side projector registration (`registerWarmProjector`) is
  the app-facing half.

**Byte-cost honesty (v1).** A beacon carries the browser's full
`Cookie` header — that IS the feature (cookie-varying state stays
browser-authoritative) — and at scroll cadence the cookies dominate
the statement. Measured against the shipped grammar: a
telemetry-only envelope body is ~200 B (the frame itself ~130 B),
the fixed request headers ~430 B, so a lean-cookie page pays
~0.8 KB per telemetry-carrying beacon — while a consent-laden
commerce cookie jar (2–4 KB of consent strings + analytics ids) puts
the same beacon at **~3.5–4.5 KB, >90 % of it cookie**. That ratio
is why telemetry never justifies an envelope alone, and why the
designated fix is the datagram class of a WebTransport-style
transport (the lossy class exists in the grammar now precisely so
datagrams can carry it later) — not header-compression hand-waving.

## Delivery is evidenced

Downstream delivery stops being assumed the moment a session opens:

- **Delivery seqs.** Every emission a live connection makes — the
  initial payload segment, every lane, the periodic reconcile
  segment — carries a per-connection monotonic delivery seq as a
  `seq` entry in the `\xFF` marker grammar
  ([`fp-trailer-marker.ts`](../../framework/src/lib/fp-trailer-marker.ts)).
  A segment's entry precedes its Flight rows (body: the decimal seq);
  a lane's is a framed entry written immediately before its `muxend`
  (body: `<parton-id>\n<seq>`, the mux frames' id-first shape) — so
  the client always holds the seq before the payload can commit.
  One-shot responses never carry seqs.
- **Commit-time recording.** The client records a seq when the
  payload COMMITS — the browser entry's lane-chain commit
  (`_laneDeliveryCommitted`) and payload-segment commit
  (`_segmentDeliveryCommitted`) — never at decode. A decoded-but-
  dropped payload (the stale-page guard, a torn decode) consumes its
  seq WITHOUT recording (`_laneDeliveryDropped`): the watermark
  stalls there and the server never counts the drop as held. Lane
  seqs queue per parton (`_channelWireEntry`); segment seqs are
  FETCH-LOCAL in the browser entry, so a concurrent discrete fetch's
  commit can never consume the live stream's seq.
- **The `ack` frame.** The transport acks the highest CONTIGUOUSLY
  committed seq (lanes commit concurrently, so out-of-order commits
  wait for their gap to fill) via an internal producer on the
  standard producer contract. The ack is a PASSENGER, never a
  driver: a watermark advance marks the producer dirty and nothing
  more — any envelope other statements justify (visibility flips,
  detach, future kinds) collects the current watermark for free.
  Exactly two advances drive a flush of their own, on the same
  rAF-coalesced path every statement rides (no timers): the
  connection's FIRST committed delivery — the prompt duplex proof
  both sides' degrade machinery times — and the unacked count
  crossing `ACK_FLUSH_THRESHOLD` (half the server's
  `UNACKED_DELIVERY_WINDOW`, one shared protocol constant), so a
  client under sustained lane traffic acks once per ~32 commits and
  the window always keeps 2× headroom. The third moment an ack
  could seem due — attach — owes nothing: delivery seqs are
  per-connection, so a fresh connection opens with zero ack debt
  (the attach manifest is the durable evidence; the `applied` field
  covers the separate upstream timeline). The cadence is a cost
  rule: every envelope carries the browser's full Cookie header
  (§Telemetry's numbers — ~3.5–4.5 KB, >90 % cookie under a
  commerce jar), and no consumer of the ack needs per-commit
  resolution — the mirror's hot layer is the OPTIMISTIC skip-set,
  and the window only needs freeing well before it fills.
- **The `applied` marker.** The mirror image of the ack: after an
  envelope applies, the driver's next wake ships the session's
  highest applied upstream seq as an `applied` entry (once per
  advance). It prunes the transport's reliable-envelope buffer — a
  beacon's `204` is acceptance, not proof a future transport
  surfaces, so the stream marker is the one pruning signal — and
  seeds the next attach statement's `applied` watermark.
- **The reliable class.** Producers declaring `reliable: true` get
  their frames buffered per envelope (keyed by the envelope's
  page-lifetime seq) until the `applied` marker covers them, and
  retransmitted — original seqs, in order, ahead of new flushes — at
  the next establishment (attach is the natural retransmit point).
  `deliveryFailed` is never called for them; the buffer owns
  redelivery. Every shipped kind is loss-tolerant, so the buffer
  holds nothing today — the machinery exists for the url / cancel
  kinds. Application idempotence across a reattach is the frame
  kind's own seq-ordered statement contract (at-least-once with a
  bounded duplicate window when the marker itself was lost — the
  session's state is disposable, so exactly-once across a dead
  session is not on offer).

## The layered mirror

The connection's cached mirror — what fp-skip verdicts consult on a
live connection — is two layers, not one:

- **OPTIMISTIC skip-set** (the request's cached-override maps,
  unchanged cadence): promoted at EMIT time by both promote families
  (`promoteSnapshotsToCachedOverride` at segment end and lane drain,
  `promoteFpUpdatesToCachedOverride` for trailer heals). This is the
  hot layer: a same-parton re-lane within one RTT — long before any
  ack could arrive — still fp-skips off it.
- **ACKED watermark** (`ConnectionSession.ackedFps`): when the
  client's cumulative ack covers a delivery seq, the `(id, fp)` pairs
  that emission carried (captured in the same walk that promoted
  them — `pendingDeliveries`, bounded by the unacked window) fold
  into the acked layer: client-PROVEN holdings. Verdicts consult
  optimistic-first and fall back here on a miss
  (`PartialRequestState.ackedFingerprints`, wired by `PartialRoot`
  and the lane driver alike), so an fp the optimistic per-id cap
  evicted still skips if the client proved it. Both layers cap per id
  at `OVERRIDE_SET_CAP`.

Two rules keep the layers truthful:

- **Reattach seeds from the attach manifest ∪ nothing else.** The
  acked layer resets with the connection (a fresh session starts
  empty) — the manifest IS the durable evidence; a dead session's
  acks prove nothing about what the client holds NOW.
- **Flip-statement cached tokens remain the eviction evidence.** Acks
  report what the client GAINED, never what it evicted, so a
  `visible` frame's stated holdings REPLACE the id's entry in BOTH
  layers (`applyReportedCached`) — an acked-then-evicted fp must
  never confirm a phantom copy. Burst-race semantics are untouched.

## Backpressure — the two-signal gate

Lane OPENING gates on two signals:

- **Bytes** — the response stream's `desiredSize` pull-gate (shipped
  with the driver hardening): enqueues park while the consumer's
  queue is full, propagating the stall into the Flight stream.
- **The unacked delivery window** (`UNACKED_DELIVERY_WINDOW`, 64 —
  rationale at the constant): `deliverySeq - ackedDeliverySeq` past
  the window means the client stopped committing what the kernel
  already swallowed — the one state the byte gate can't see (a
  frozen proxy buffer, a torn downstream). The driver stops opening
  lanes; touched ids coalesce into a dirty set and render their
  LATEST state when an ack frees the window. Coalescing intermediate
  states is correct — cells carry state, not events, so one render
  of the latest value supersedes every skipped intermediate; nothing
  is dropped. Window-gated wakes are not useful activity: the
  keepalive keeps counting down, so a client that never frees the
  window can't hold the connection.

## The never-acked degrade

A connection whose client commits deliveries but can never say so
must not be held behind a window that can never free — the review
finding this kills: a blocked `/__parton/*` POST path (ad-blocker,
corporate proxy) would otherwise freeze liveness. Both sides degrade
on their own real signal:

- **Server** — the first delivery-seq'd emission's settle starts the
  client's ack obligation (`firstDeliverySettledAt`); if no ack frame
  EVER arrives within `FIRST_ACK_DEADLINE_MS` (5s — a deadline
  because a fully blocked upstream emits NO signal, and an ack-less
  envelope is ambiguous: the ack piggybacks on the rAF-coalesced
  flush, so any single envelope can legitimately predate the commit
  it would have acked; the anchor at delivered-settle measures
  exactly the obligation window, never connection age), the session
  notes `degradedReason: "never-acked"` and the drive loop exits —
  the driver stops holding, closing after settle. Any ack frame at
  all (`firstAckReceived`) disarms the deadline for good: an acking
  client is never degraded.
- **Client** — an envelope carrying the connection's FIRST ack that
  fails to deliver proves the duplex broken from the client's side.
  `ChannelClient` marks the PAGE degraded (sticky —
  `_channelIsDegraded`); the heartbeat stops firing lanes-first live
  attaches and each interval tick becomes a one-shot DISCRETE reload
  (GET-shaped, capped `?cached=`, the measured viewport as
  `?visible=` — the degraded-mode pin). Liveness becomes periodic
  polling at the heartbeat's cadence: degraded, never frozen. A
  later ack's failure after a delivered first ack is a transient —
  normal fallback, no degrade.

## The whole-tree reconcile

An indefinitely-lived lanes connection (steady relevant wakes keep
extending the keepalive) would silently lose the correctness backstop
the reopen cycle provides idle connections — a relevance
false-negative (a dependency the label/constraint surface doesn't
capture) would never heal. The driver makes it explicit: past
`RECONCILE_INTERVAL_MS` (30s, anchored at the last full segment —
connection open, an honored catch-up anchor, or the previous
reconcile), the next wake at quiesce (no open lanes; the `next`
delimiter would tear them) with room in the delivery window emits a
whole-tree payload segment ON the stream — `next`, the segment (its
own delivery seq, fp-skip pruning it to placeholders when nothing was
missed), `settled`, then `next` + `lanes` to reopen the region — and
advances the wake cursor past everything the segment covered.
Evaluated at wakes, no standing timer: an idle connection never
reaches the cadence (the keepalive closes it first, and its reopen's
first segment is whole-tree anyway). The reconcile is
server-scheduled, not client-evidenced activity, so it does not
extend the keepalive.

## The endpoint runs in a request scope

`createRscHandler` dispatches `POST /__parton/channel` before app
routing — but INSIDE `runWithRequestAsync`. No render runs; the point
is the scope: the test scope resolves through the ALS
(`getScope()`), cookies parse through the same context every render
uses, and the response is the ONE place a channel interaction can
mint Set-Cookie (the held stream's headers are long gone by the time
a frame arrives — the entry appends the scope's accumulated cookies
to this response). Endpoint body: `handleChannelPost` in
`framework/src/lib/connection-session.ts`.

## Security

Three checks gate every envelope, in order:

1. **Same-origin provenance** (`403`). A present `Sec-Fetch-Site`
   must testify `same-origin` (or `none`); a present `Origin` must
   equal the request's own. The JSON content-type is not a defense —
   cross-site pages can POST JSON with credentials. Requests carrying
   neither header (non-browser clients, the in-process harness) pass:
   the cookie binding below is the credential check; this check only
   stops cross-site pages from riding a victim's cookies.
2. **Scope binding** (`404`). The session records the attach's scope;
   the envelope's resolved scope must match. Isolation is the
   globally-unique connection id — the scope check is an ASSERT,
   never a lookup key, so a scope can never be used to reach another
   scope's session. (e2e workers stamp `x-test-scope` on the whole
   browser context, so beacons carry the same scope the attach did.)
3. **Cookie binding** (`404`). The session records the attach's
   session identity (`getSessionId() ?? ""`); every envelope must
   present the same one — beacons carry cookies anyway. Anonymous
   pages bind the empty identity and keep working. A session cookie
   minted mid-connection fails the check until the next attach
   rebinds (§The attach); the transport's 404 fallback covers the
   gap.

Binding mismatches answer `404` — byte-identical to "connection
gone" — so a hostile beacon can't distinguish wrong-creds from gone.

## The id handshake

The connection id is SERVER-minted: the segment driver creates it at
session open (a client-chosen id would invite fixation and leak the
addressable token into access logs) and ships it downstream ONCE per
connection as a `conn` entry in the `\xFF` marker grammar
([`fp-trailer-marker.ts`](../../framework/src/lib/fp-trailer-marker.ts)):

- full path — ahead of the first segment's Flight rows (entries
  interleave; the body keeps flowing);
- catch-up path (an honored attach anchor) — immediately after the
  `lanes` marker, as the region's first framed entry.

Receiving the entry IS establishment: the driver only mints ids for
sessions it has opened, so the client can address the session the
moment the handshake arrives — while the first whole-tree render is
still draining. The splitter surfaces entries progressively
(`splitSegments`' `onEntry`) precisely so this handshake doesn't wait
for the segment's trailer map to resolve at settle; the browser entry
feeds every wire entry to `_channelWireEntry`
(`channel-client.ts`), which establishes on `conn`. The id never
appears in the DOM — `data-parton-live` is presence-only — and never
in a URL.

## ChannelClient — the transport

`framework/src/lib/channel-client.ts` owns everything between a
producer's statement and the envelope on the wire:

- **Producers.** A producer registers once
  (`registerChannelProducer`) and is consulted per flush:
  `collect(connection)` contributes at most one frame; `collect(null)`
  (no connection established) is the cue to deliver via the
  producer's own discrete fallback. `deliveryFailed(frame)` hands a
  frame back when its envelope didn't land — the transport has
  already cleared the published id, so the re-owned statements (and
  everything after them, until the heartbeat re-establishes) ride the
  fallback. A producer declaring `reliable: true` opts its frames
  into the retransmit buffer instead — `deliveryFailed` is never
  called for them (§Delivery is evidenced). A LOSSY producer
  (`telemetry.ts`) uses the same contract with drop semantics at
  every choice point (§Telemetry). The visibility controller
  (`visibility.tsx`) is the first external producer; the transport's
  own ack producer rides the same contract.
- **Coalescing + serialization.** Flushes coalesce per animation
  frame and serialize — one envelope in flight; a flush requested
  mid-flight re-fires when it lands. Retransmits go first at a fresh
  establishment, through the same serialization.
- **Lifecycle.** Establishment (from the wire handshake) resets the
  per-connection DELIVERY tracking (seq queues, the commit watermark,
  the first-ack flag), sets `data-parton-live`, and notifies
  establishment listeners (the visibility controller arms its
  full-set first-measurement sync there). The ENVELOPE seq is
  page-lifetime and never resets. The heartbeat calls
  `_channelConnectionClosed()` when its fire settles.
- **Detach.** `pagehide` sends a final `detach` frame via keepalive
  fetch and clears the id (a bfcache restore re-establishes via the
  next heartbeat fire).
- **Degrade.** `_channelIsDegraded()` is the page-lifetime flag the
  heartbeat consults (§The never-acked degrade);
  `_channelAppliedWatermark()` is the heard upstream watermark the
  next attach statement presents.

## Testing

- rsc tier: `channel-endpoint.rsc.test.tsx` (decode, HTTP mapping,
  origin/scope/cookie checks, unknown-kind skip, in-envelope frame
  ordering, the mint handshake, detach ending a held drive),
  `connection-visibility.rsc.test.tsx` (visibility statement
  semantics through the envelope, against a real drive),
  `channel-acks.rsc.test.tsx` (delivery-seq emission ordering across
  segments + lanes, the ack watermark + acked-layer fold, the
  `applied` marker + duplicate-envelope convergence, the attach
  `applied` seed, window-exceeded coalescing, the window vs the lazy
  cadence — threshold-cadence steady state never gates, a silent
  client fills the window and one cumulative ack frees it — the
  never-acked degrade + the acking client that never degrades, the reconcile
  cadence, mirror layering: flip statements superseding the acked
  layer and the acked-fallback verdict),
  `live-catchup.rsc.test.tsx` (the attach statement: anchor catch-up,
  attach-only anchor, body-manifest/URL-manifest verdict equivalence,
  the uncapped body manifest), `attach-rebind.rsc.test.tsx` (the
  mid-connection-login → reattach → beacons-work-again flow),
  `channel-warm.rsc.test.tsx` (the session telemetry slot:
  latest-wins, no wake, no render; the warm pass: byte silence, the
  warm-vs-cold flip latency, the per-park cap, the window skip).
- node tier: `channel-client.test.ts` (coalescing, page-lifetime seq,
  serialization, the fallback signal, pagehide detach),
  `channel-client-acks.test.ts` (contiguous commit watermark, the
  passenger policy + its two driving flushes — first ack, threshold
  crossing — dropped-lane attribution, the reliable buffer's
  prune/retransmit assembly, the first-ack degrade mark),
  `channel-telemetry.test.ts` (the lossy producer: newest-wins, no
  self-scheduled traffic, drop on fail, never buffered; the strict
  decoder), `attach-dispatch.test.ts` (statement decoder grammar
  incl. `applied`; attach/action marker dispatch),
  `refetch-attach.test.ts` (the manifest cap split by transport).
- The live-drive harness (`framework/src/test/live-drive.tsx`) reads
  the minted id off its own wire (`DriveHandle.connectionId`), logs
  every wire entry (`DriveHandle.entries` — how tests observe `seq` /
  `applied`), and drives attaches through the entry's own statement
  seam (`LiveDriveInit.attach`). Its reader never acks: tests
  exercising held connections past `FIRST_ACK_DEADLINE_MS` either ack
  explicitly or widen the deadline (`_setFirstAckDeadlineMs`), as the
  soak bench does.
