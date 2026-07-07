# The channel — the attach + upstream envelopes

The client-states-facts half of the live connection. Two request
shapes carry the statements: the ATTACH — the heartbeat's live fire
as a POST whose body is the full client statement, answered by the
held segmented stream — and the coalesced envelopes of frames a page
POSTs to the session that stream opened. Visibility flips, delivery
ACKS, viewport TELEMETRY, URL moves (window and frame scoped), and
CANCEL statements are the shipped frame kinds — the kind table is
complete; the design rationale and roadmap live in
[`../notes/channel-design.md`](../notes/channel-design.md). The
downstream half — segments, lanes, markers — is
[`streaming.md`](./streaming.md); the delivery-seq / ack / applied
machinery that makes the channel EVIDENCED is §Delivery is evidenced
below; window navigation and selector refetches riding the stream is
§Navigation rides the channel; frame navigation, producer lanes, and
action consequence seqs are §Frames ride the channel and §Action
consequence seqs.

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
| `url` | `{url, intent, frame?}` — a URL statement for a scope the client owns: absent `frame`, the WINDOW URL (a `?__force=` overlay names a refetch's forced targets); present, the named FRAME's URL (the frame path's segments). `intent` is the history semantic (`push`/`replace`/`silent` — descriptive: the client's history work is done by send time) | Same-origin-validated (`400` the envelope on a cross-origin target — a violation, nothing applies). WINDOW scope: LATCHED on the session (newest seq wins; a seq at or below the consumed navigation is a stale restatement, a no-op — retransmit idempotence); the driver consumes it navigation-FIRST at wait entry and answers with a whole-tree payload segment, then forced-target lanes — §Navigation rides the channel. FRAME scope: the session frame URL is written AT THE ENDPOINT (the same store `?__frame=` writes through — and the one channel response that can mint the session cookie; an anonymous binding rebinds in place); the render latches per frame key and the driver lanes the frame's targets on the open region — §Frames ride the channel |
| `cancel` | `{scope}` — supersede the scope's in-flight renders: the frame's top-level name (the discrete twin's `?partials=<frame[0]>` narrowing) | Aborts the scope's open lane renders synchronously at apply (the driver's `cancelListeners` arm — the same reach into a suspended render the window supersede's nav-latch arm has). A cancelled body closes with a `muxend` and NO delivery announcement, so the client's decode settles, the content never commits, and the id can reopen for the covering statement's lane. Per-scope seq gate: a replayed cancel at or below its scope's applied seq is a no-op — it can never abort a newer statement's render |

Responses carry no body: `204` applied; `400` malformed; `403`
cross-site; `404` connection gone — see §Security. Frame kinds split
into three classes: **loss-tolerant** (`visible`, `detach`, `ack` —
the protocol re-establishes their statements on its own: the next
attach's seed, the keepalive backstop, the cumulative watermark),
**lossy** (`telemetry` — newest-wins, droppable, no fallback: only
the latest statement has value), and **reliable** (`url`, `cancel`),
which ride the transport's retransmit buffer — see §Delivery is
evidenced.

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

- **Delivery seqs + the as-of.** Every emission a live connection
  makes — the initial payload segment, every lane, the periodic
  reconcile segment, every navigation segment — carries a
  per-connection monotonic delivery seq PLUS the navigation point it
  was rendered as-of, as a `seq` entry in the `\xFF` marker grammar
  ([`fp-trailer-marker.ts`](../../framework/src/lib/fp-trailer-marker.ts)).
  A segment's entry precedes its Flight rows (body: `<seq> <asof>`,
  both decimal); a lane's is a framed entry written immediately
  before its `muxend` (body: `<parton-id>\n<seq> <asof>`, the mux
  frames' id-first shape) — so the client always holds seq AND as-of
  before the commit-or-drop decision. The as-of is the envelope seq
  of the last `url` frame the connection's request state reflects
  (`0` = the attach's own request, pre-navigation) — see §Navigation
  rides the channel. One-shot responses never carry seqs.
- **Commit-time recording, three consume flavors.** The client
  records a seq when the payload COMMITS — the browser entry's
  lane-chain commit (`_laneDeliveryCommitted`) and payload-segment
  commit (`_segmentDeliveryCommitted`) — never at decode. A payload
  dropped on a DYING stream (the pageUrlKey twin guard, a torn
  decode) consumes its seq WITHOUT recording
  (`_laneDeliveryDropped`): the watermark stalls there and the
  server never counts the drop as held. A payload dropped by the
  AS-OF guard on a stream that LIVES ON (it predates the client's
  navigation point) consumes its seq as PROCESSED
  (`_laneDeliveryDroppedStale` / `_segmentDeliveryDroppedStale` —
  the watermark advances, so a raced navigation can never wedge the
  window into a forced reconnect); the server's fold gate (below)
  keeps the processed drop out of the acked mirror. Lane seqs queue
  per parton (`_channelWireEntry`); segment seqs are FETCH-LOCAL in
  the browser entry, so a concurrent discrete fetch's commit can
  never consume the live stream's seq.
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
  the next establishment. `deliveryFailed` is never called for them;
  the buffer owns redelivery. The window url producer and the
  frame-navigation producer (url + cancel pairs) are the
  reliable-class sources — though their buffered frames retire at the
  next ATTACH rather than retransmit: the attach's own request line
  restates the window URL, and the attach's whole-tree render reads
  the SESSION frame URLs (a replayed frame url could regress a
  discrete frame nav made in the gap, so uncovered frame fires
  re-fire discrete instead)
  (`_channelNavSubsumedByAttach` — §Navigation rides the channel,
  §Frames ride the channel). Application idempotence across a
  reattach is the frame kind's own seq-ordered statement contract (a
  `url` frame at or below its scope's consumed navigation seq applies
  as a no-op; a `cancel` at or below its scope's applied seq
  likewise; at-least-once with a bounded duplicate window when the
  marker itself was lost — the session's state is disposable, so
  exactly-once across a dead session is not on offer).

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

## Navigation rides the channel

On an attached, non-degraded page, WINDOW navigations and batched
selector refetches are `url` frames — statements of the client's URL
— and their responses arrive on the held stream in stream order.

**The routing table, as shipped:**

| Interaction | Attached + healthy | Pre-attach / degraded / otherwise |
|---|---|---|
| Window navigation (`nav.navigate`, intercepted) | `url` frame, intent `push`/`replace` (a traverse states `replace`) | discrete `_.rsc` GET |
| Silent window URL sync (`silent: true`, server-push application) | `url` frame, intent `silent`, fire-and-forget | nothing (the URL is client-local; pre-W5a the heartbeat's reopen re-synced the connection) |
| Batched selector refetch (`reload({selector})`, `navigate({selector})`) | `url` frame, intent `silent`, page URL + `?__force=<labels>` | discrete GET with `?partials=` + capped `?cached=` |
| Frame navigation (`useNavigation(frame).navigate/reload`, frame traverse) | frame-scoped `url` frame (+ a `cancel` co-rider when it supersedes an unsettled fire for the same frame) — §Frames ride the channel | discrete GET with `?__frame=&__frameUrl=&partials=<frame[0]>` (the long-poll form; deferred-abort supersede lives on here) |
| Traverse combining a window move WITH frame diffs (`__frame` pairs), culling flips, batches with ephemeral `params`, `live` fires | — (one combined request / no-session work) | discrete GET |
| Heartbeat attach, action POSTs, preload/warm, cold start | — | discrete by design (the channel's own legs; an attached page's action POST carries `x-parton-conn` — §Action consequence seqs) |

The pieces:

- **The claim.** The navigate-event listener decides the route
  synchronously during the event dispatch and CLAIMS the stream
  (`_channelClaimWindowNav`); the heartbeat's abort check defers one
  microtask and consumes the claim — a claimed navigation KEEPS the
  held connection (the nav segment arrives on it), an unclaimed one
  aborts-and-reopens as before. A claimed navigation that turns out
  unroutable at fire time (the connection died in between) releases
  the kept stream (`_channelAbortLiveStream`) and goes discrete.
- **The navigation point.** `_channelNavigate` reserves the
  statement's envelope seq at CLICK time (`envelopeSeq + 1` —
  flushes serialize, so the reservation is exact): from that instant
  every delivery rendered as-of an older navigation is droppable.
  One pending frame, newest-wins pre-flush; the covering segment
  resolves every superseded fire's milestones too (its content IS
  the newest URL's render).
- **Consumption, navigation-first.** The frame latches on the
  session (`pendingNav`, newest seq wins) and wakes the driver; the
  wait-entry latch ranks navigation ABOVE pending flips — old-route
  flips then resolve against the new routeKey and defer (no snapshot
  on the new route), which is harmless. The driver tears open lanes
  (their content is the route the client left; the client's region
  exit rejects only their un-committed decodes), applies the URL to
  the connection's request state through the same `setRequest` seam
  server-side navigation uses, and answers with `next` → a
  whole-tree payload segment (delivery seq + as-of) → `settled` →
  `next` + `lanes`. fp-skip against the mirror applies as on any
  segment — a navigation to a mostly-mirrored route ships
  placeholders.
- **Forced targets ride lanes.** A refetch statement's `?__force=`
  labels never force the SEGMENT render (a whole-tree render cannot
  force a target whose ancestor fp-skips or replays a byte cache —
  the ancestor's fold doesn't move on a force, so its placeholder
  would cut the target out). After the region reopens, the driver
  resolves the labels against the new route's snapshots (id first,
  then label fan-out — the same resolution a discrete `?partials=`
  takes) and lanes each target EXPLICIT (`forcedLaneIds` → the lane
  state's `explicitIds`): fp-skip and the defer gate both yield, the
  refetch contract on the lane path. The overlay is one-shot — it
  never persists into the connection's request state.
- **Mid-render supersede.** A NEWER url frame latching while a
  navigation segment renders makes that render moot: the emitter
  races its reads against a nav-latch arm on the session's wake set,
  cancels the Flight reader (aborting the render), and the caller
  consumes the newer statement — exactly one settled navigation
  segment lands. The truncated segment is closed by the next `next`
  delimiter; the client drains it without committing (its as-of
  predates the navigation point by construction) and consumes its
  delivery PROCESSED. This internal seam — "a newer statement aborts
  the in-flight navigation render" — is what the explicit cancel
  frame kind will address directly.
- **The as-of guard — pageUrlKey generalized into the protocol.**
  The client's commit arbitration for seq'd deliveries: commit iff
  the delivery's as-of ≥ the navigation point
  (`_channelDeliveryCommittable`) AND the current page identity
  equals the connection's last-stated URL (a DISCRETE navigation
  moving the page out from under a still-open stream is a dying
  stream — its commits stall-drop as before). Un-seq'd responses
  (every discrete GET) keep the twins: the pageUrlKey stale-commit
  guard and the per-selector monotonic issue-seq claim
  (`refetch-ordering.ts`). One guard seam in the browser entry,
  reached two ways — the channel path mints no issue seqs and
  captures no pageUrlKey; stream order plus the as-of subsume both.
- **The mirror stays honest across navigations.** At consume, the
  driver prunes every unacked delivery record rendered before the
  new navigation point and removes their optimistic promotions
  (`pruneDeliveriesBeforeNav`) — the client as-of-drops those
  deliveries, so their fps must not confirm phantom holdings.
  Genuinely-committed-but-unacked pre-nav deliveries are pruned too:
  conservative, an over-fetch, never stale (the prompt first-commit
  ack keeps the common case covered — an acked delivery's fps sit in
  the ACKED layer and survive). The ack fold gate is the same
  comparison at apply time: a covered record whose as-of predates
  the latest LATCHED navigation frees the window without folding
  (`statedNavSeq` advances at envelope apply, ahead of the driver's
  consume, and url frames latch before the same envelope's in-order
  pass so a co-riding ack sees them).
- **Milestones ride the covering segment.** A channel-routed fire's
  `streaming` resolves when a payload segment whose as-of covers its
  navigation point COMMITS; `finished` when that segment SETTLES
  (its trailers resolve). The commit mode follows the covered
  callers: any covering fire that asked for the atomic swap
  (`streaming: false`) makes the segment a transition commit; with
  no covering fire the live stream's default raw commit stands. A
  forced target's fresh bytes can trail `finished` by one lane — the
  lane path is the framework's own freshness delivery, moments
  later.
- **The attach subsumes the URL timeline.** The attach's request
  line IS the client's URL statement: an attach fire retires the
  navigation point (both sides reopen as-of 0), drops buffered url
  frames from the retransmit buffer, and re-owns any records a
  closing connection left behind. A connection loss with pending
  navigation records falls back to ONE discrete fire for the latest
  statement's URL (the `?__force=` overlay rewritten to the discrete
  `?partials=` twin), chaining every record's milestones — and pulls
  the kept stream down so the next tick reopens on the current URL.
- **Two URL writers — client-wins-at-higher-envelope-seq.** A
  server-initiated url push (`getServerNavigation().navigate` → a
  `url` trailer) is a SUGGESTION the client applies only when it has
  not navigated past the state the push was rendered as-of: the
  applier gates on `push.asOf ≥ navPoint` (`_serverUrlPushApplies`),
  where the as-of is the delivery's wire as-of on the live stream
  and the issue-time navigation point for a discrete response (an
  action POST, a preload) — the client-local as-of of a request the
  client issued itself. The client's statement about its own URL is
  authoritative; applying an accepted push re-states it as a silent
  url frame (the silent-nav path), which is how the held
  connection's request state converges after an action-side push.

## Frames ride the channel

A frame navigate/reload/traverse on an attached, non-degraded page is
a FRAME-scoped `url` frame (`_dispatchFrameRefetch` routes —
`_channelFrameNavigate` in `channel-client.ts`); the frame long-poll's
dedicated connection is gone on this path. The pieces:

- **Two halves, split by where the state lives.** The session frame
  URL is cookie-backed SHARED state, so the ENDPOINT writes it — the
  same `setSessionFrameUrl` store `?__frame=` writes through, inside
  the envelope's own request scope where the client's cookie resolves
  and a freshly-minted session cookie can ride the `204` (an anonymous
  binding REBINDS in place to the identity it just handed that same
  client, and the driver re-presents the bound identity on the held
  request so its renders can read the store). The RENDER latches per
  frame key (`pendingFrameNavs`, newest seq per key; a seq at or below
  the key's consumed seq is a stale restatement — and a stale
  restatement skips the session write too, so a replay can never
  regress a newer frame URL).
- **The driver lanes, never tears.** Frame content is a subtree, so
  the consume (`handleFrameNavs` — after a pending window navigation,
  before flips) resolves the frame's targets by its TOP-LEVEL name (id
  first, then label fan-out — the discrete twin's
  `?partials=<frame[0]>` narrowing) and lanes them EXPLICIT on the
  OPEN region: window partons' lanes are untouched. Each covering
  lane's delivery announcement carries the statement's seq as a
  ` nav=<seq>` token — the client's milestone correlation
  (`streaming` at the covering lane's commit, `finished` at its
  settle). Zero resolved targets (the frame never rendered on this
  route) fall back to one whole-tree segment via the reconcile
  machinery — its as-of covers the statement, because frame consumes
  advance `consumedNavSeq` too (the as-of names the last consumed url
  statement of EITHER scope; the window drop guard is unaffected —
  the client's navigation point only moves on window statements).
- **`cancel` retires the deferred-abort supersede.** A statement
  superseding an UNSETTLED fire for the same frame ships
  `{kind:"cancel", scope: frame[0]}` in the SAME envelope, ahead of
  its url frame — the in-order pass gives cancel-then-url. The apply
  aborts the scope's open lane renders synchronously (id, label, or
  `framePath[0]` match); the cancelled body closes with a `muxend`
  and NO delivery announcement, so the client's decode settles
  without committing (an unannounced lane body on a seq-carrying
  stream never commits — it is by construction a superseded render)
  and the id reopens for the covering lane. The client's
  deferred-abort machinery (`partial-client-state.ts`'s in-flight
  queue) lives on only for the discrete GET path.
- **The heartbeat keeps the stream.** The silent-info `frame` branch
  and pure frame traverses CLAIM the held stream when attached — the
  statement's response arrives ON it. A claim whose fire ends up
  discrete is harmless: frame URLs are session state, so the kept
  stream's next render reads what the discrete request wrote.
- **Fallbacks.** No connection at dispatch → the discrete `__frame`
  GET, unchanged. A failed envelope, the stream closing under pending
  fires, or an attach subsume → ONE discrete `__frame` re-fire per
  frame key for the latest statement (milestones chained). Frame url
  + cancel frames are reliable class but RETIRE at the attach subsume
  instead of retransmitting: the attach's whole-tree render reads the
  session (server-authoritative), and a replayed frame url could
  regress a discrete frame nav made while the connection was down.

## Producer lanes

A lane render that calls `markConnectionLive()` — a body that streams
until a producer await resolves, the chat's `ChunkSlot` — is a
PRODUCER lane. Attribution is per lane: each lane iteration renders
inside a prototype-chained store probe (`_createConnectionLiveProbe`)
whose own `connectionLive` field catches the mark, because concurrent
lane renders share one request scope and the store-level flag cannot
say whose render marked. On the flip:

- **The announcement moves early.** The pump writes a `muxlive` frame
  (`<id>\n<seq> <asof>[ nav=<n>]` — the lane delivery-seq body in the
  mux frames' id-first shape) the moment it observes the mark, INSTEAD
  of the drain-time `seq` entry: the client must hold seq + as-of
  before the body closes, because the body only closes (`muxend`) at
  producer resolve. Delivery recording server-side still happens at
  drain, with the early-minted seq (`_recordDelivery`'s raced-ack path
  folds if the client's progressive commit already acked it).
- **The client commits progressively.** `handleLane` races the
  trailer against the producer announcement; a live-flagged delivery
  commits at ROOT-READY through `_commitPartonLaneProgressive` — a
  lazy-aware walk that caches what has resolved and RE-WALKS the same
  payload as its pending Flight chunks land (the one-shot walk stops
  at the first pending row and would cache nothing), guarded by a
  per-parton commit generation so a superseding commit stops an older
  body's late re-walks. The fp trailer applies at the body's close.
- **Tears stay isolated.** A clean region exit (a `next` delimiter,
  the source closing between frames) CLOSES an open producer body
  instead of erroring it — its progressively-committed tree keeps its
  Suspense fallback until the covering render replaces it, rather
  than rejecting pending rows into an error boundary. A genuinely
  torn stream (mid-frame end, invalid marker) still rejects it — and
  only it. The drive-loop exit aborts producer reads: an unbounded
  producer await must not hold the wind-down.

The chat is the shape this exists for: the open-pill's frame
statement lanes the overlay as a producer lane (initial content
commits at root, the "streaming…" fallback holds the producer's
place), and each chunk's bump lanes the message parton — itself a
producer lane — so chunks reveal progressively on the held stream,
exactly as the discrete long-poll's per-segment commits did.

## Action consequence seqs

Actions stay discrete POSTs (the pinned decision), but with a channel
attached the response carries the delivery seqs its invalidation
consequences will ride — and the client's optimistic overlay holds
until its committed watermark covers them, never clearing at the
returnValue alone (under window coalescing the consequence lane can
trail the response by the whole backpressure window, which is exactly
when a returnValue-cleared overlay flashes the stale server value):

- **The client names its connection** (`x-parton-conn` on the action
  POST — an explicit statement, never inferred), when attached and
  non-degraded.
- **The server reserves INSIDE the action's transaction**
  (`_reserveActionConsequences`, called by the entry between the
  action body and the commit): the pending selectors match the
  connection's route snapshots (`_routeMatchingSelectorIds`, parked
  partons excluded), and each target id gets a delivery seq assigned
  (`assignedLaneSeqs`). Because the commit's flush is what wakes the
  drivers, the reservation is strictly ordered before any driver
  could mint the same lanes' seqs — no race window exists.
  Re-reserving an id with an unconsumed assignment reuses it: one
  render of the latest state covers both writes. Binding checks
  mirror the envelope's (scope + session identity); a mismatched
  header reserves nothing.
- **The pump consumes at iteration start;** every skip path VOIDS the
  assignment (`voidSeqs` → the `seqvoid` entry: parked flips, a gone
  snapshot, window-freed-then-parked ids, a navigation tear — which
  voids everything). The client counts voided seqs PROCESSED, so the
  contiguous watermark can always pass a reservation — a silent gap
  would wedge the unacked window and hold the gate forever.
- **The response header** (`x-parton-consequences: s1,s2`) registers
  a gate (`_registerActionConsequences`) before the action's returned
  promise resolves; the cell overlay's clear point awaits
  `_awaitActionConsequences()` after the write POST lands — the `.set`
  promise and the write queue's flow are untouched, only
  `latestSentByCell` holds. The inverse race (consequence commits
  before the POST resolves) registers no gate — the watermark already
  covers it. Gates release when the connection ends (dead seqs must
  never freeze an overlay; the reattach's whole-tree render is the
  catch-up). Without a channel: no header, no gate — unchanged
  behavior.

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

The reconcile is also `<RemoteFrame>`'s freshness path on a held
connection: remote invalidation never wakes the host driver (the
remote is another process — no bump lands in the host's registry),
so a remote's changes reach an attached client at the reconcile
cadence, when the whole-tree pass re-fetches the remote endpoint. No
remote lanes exist, by decision: the remote's latency belongs on the
scheduled pass, not on per-wake lane traffic. Two consequences,
documented rather than engineered around: a navigation segment whose
tree contains a `<RemoteFrame>` settles only after the remote's
trailer (`deferCommitUntil`), so third-party origin latency lands on
the segment's settle — and on the supersede window (a newer url frame
can abort the wait); and a remote DEPLOY shifts the remote's fps
wholesale outside the host's epoch checks, so an attached client
shows the old remote content for at most one reconcile interval —
bounded staleness that self-corrects at the next whole-tree pass.
See [`../reference/remote-frame.md`](../reference/remote-frame.md).

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
  warm-vs-cold flip latency, the per-park cap, the window skip),
  `channel-navigation.rsc.test.tsx` (url frame → whole-tree
  navigation segment with fp-skip against the mirror + the as-of on
  its `seq` entry, `__force` targets laning explicit after the
  reopen, same-origin validation + strict decode, navigation-first
  wake priority, the mid-render supersede — exactly one settled
  navigation segment — the nav-consume prune + the ack fold gate,
  stale-restatement idempotence).
- node tier: `channel-client.test.ts` (coalescing, page-lifetime seq,
  serialization, the fallback signal, pagehide detach),
  `channel-client-acks.test.ts` (contiguous commit watermark, the
  passenger policy + its two driving flushes — first ack, threshold
  crossing — dropped-lane attribution incl. the processed as-of
  drop, the reliable buffer's prune/retransmit assembly, the
  first-ack degrade mark),
  `channel-navigation-client.test.ts` (the navigation point's
  statement-time reservation, newest-wins statements + covering
  resolution, the url producer's reliable buffering/retransmit and
  the attach subsume, the as-of guard + the server url-push gate in
  both directions, milestone wiring + commit modes, the
  connection-loss discrete fallback, the refetch dispatcher's
  channel-vs-discrete routing with the surviving issue-seq claim),
  `channel-telemetry.test.ts` (the lossy producer: newest-wins, no
  self-scheduled traffic, drop on fail, never buffered; the strict
  decoder), `attach-dispatch.test.ts` (statement decoder grammar
  incl. `applied`; attach/action marker dispatch),
  `refetch-attach.test.ts` (the manifest cap split by transport).
- rsc tier additions for the frame/cancel/producer/consequence
  packages: `channel-frame-navigation.rsc.test.tsx` (a frame url frame
  moves the session frame URL at the endpoint and lanes the frame's
  targets on the open region with the `nav=` correlation — window
  partons untouched; retransmit idempotence per frame key; a
  cancel-then-url envelope aborting a stalled frame render with
  exactly one settled covering lane and replay-safe cancel seqs; the
  `muxlive` early announcement while the producer await still stalls
  the body, muxend at resolve, no drain-time seq entry; the
  consequence reservation assigning the covering lane's seq inside
  the action's transaction with reuse on re-reservation; a window
  navigation voiding a torn reservation — the `seqvoid` entry).
- node tier additions: `channel-frame-client.test.ts` (the frame
  statement's wire shape, cancel co-rider pairing + in-envelope
  ordering, per-frame milestone correlation off `nav=` flags and
  whole-tree as-of coverage, the discrete `__frame` fallback on
  connection loss and the attach-subsume retire),
  `channel-actions-client.test.ts` (consequence gates in both
  orderings, `seqvoid` releasing a skipped reservation's gate,
  release-all at connection close), and the producer cases in
  `lanes-split.test.ts` (clean region exits CLOSE `muxlive`-flagged
  bodies while normal siblings still error; a real tear rejects a
  producer body — and only it).
- The live-drive harness (`framework/src/test/live-drive.tsx`) reads
  the minted id off its own wire (`DriveHandle.connectionId`), logs
  every wire entry (`DriveHandle.entries` — how tests observe `seq` /
  `applied`), and drives attaches through the entry's own statement
  seam (`LiveDriveInit.attach`). Its reader never acks: tests
  exercising held connections past `FIRST_ACK_DEADLINE_MS` either ack
  explicitly or widen the deadline (`_setFirstAckDeadlineMs`), as the
  soak bench does.
