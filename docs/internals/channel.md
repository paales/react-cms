# The channel — the attach + upstream envelopes

The client-states-facts half of the live connection — and the whole
interactive transport: after first paint, everything a page says to
the server rides one of two POSTs. The ATTACH — `POST /__parton/live`,
whose body is the full client statement, answered by the held
segmented stream — and the coalesced envelopes of frames a page POSTs
to the session that stream opened. Visibility flips, delivery ACKS,
viewport TELEMETRY, URL moves (window and frame scoped), CANCEL
statements, WARM intents, and COOKIE deltas are the shipped frame
kinds — the kind
table is complete; the design rationale lives in
[`../archive/channel-design.md`](../archive/channel-design.md). The only
GETs are documents (SSR — the CDN-cacheable artifact) and
embed-flagged page fetches (server-to-server — see
[`page-embed.md`](./page-embed.md)); action POSTs stay the one discrete
`_.rsc` request. The downstream half — segments, lanes, markers — is
[`streaming.md`](./streaming.md); the delivery-seq / ack / applied
machinery that makes the channel EVIDENCED is §Delivery is evidenced
below; window navigation and id-forced refetches riding the stream is
§Navigation rides the channel; frame navigation, producer lanes, and
action consequence seqs are §Frames ride the channel and §Action
consequence seqs.

## The attach — the connection's opening statement

Opening the channel is a POST to its own endpoint — the dedicated
path IS the dispatch signal — carrying the full client statement as
its JSON body (`AttachStatement` in
`framework/src/lib/channel-protocol.ts`):

```
POST /__parton/live

{ "url": "/page?q=a", "cached": [...], "since": {"epoch","ts"} | null,
  "visible": [...] | null, "applied": N, "frames": [...]?,
  "handoverFrom": "conn-id"? }
```

- `url` — the client's window URL statement. The server builds the
  connection's request state from it (same-origin-validated, like a
  `url` frame's target): route key, match gates, and tracked reads
  all evaluate the stated URL. Page URLs never carry transport params
  for the attach. A one-shot `?__force=` overlay may ride its query —
  an id-forced refetch that fired pre-establishment — which the entry
  strips from request state; the driver lanes the named targets
  EXPLICIT the moment the region opens (the refetch contract — a
  whole-tree render cannot force a target whose ancestor fp-skips).
- `cached` — the manifest: the client's `id:matchKey:fp` tokens,
  stating WHAT it holds. UNCAPPED — the body has no header budget to
  protect; the 96-entry `CACHED_MANIFEST_CAP` and the parked-id
  priority walk apply only to the `x-parton-cached` header form, which survives
  solely on UNATTACHED / degraded ACTION POSTs (a discrete request with
  a header budget to protect, and no connection mirror to consult —
  an attached POST sends none, § Action consequence seqs). The body
  manifest is structurally bounded by the
  client pool itself — at most `CLIENT_POOL_CAP` ids, each variant
  capped at `FP_CAP_PER_VARIANT` fps (`getAllCachedPartialTokens` in
  `partial-client-state.ts`). `PartialRoot` and the catch-up override
  install read the statement; verdicts are carrier-identical with the
  action leg's URL form.
- `since` — the catch-up anchor, stating WHEN the client last heard:
  the document's registry anchor, take-once for the boot attach.
  Honored when the epoch names the CURRENT registry timeline, the
  route still has snapshots, and the statement carries no frame intent
  (a `frames` entry needs the full render as its covering pass): the
  driver skips the whole-route initial segment and opens straight into
  lanes; refused, it falls through to the full render — over-fetch,
  never stale. Two later presenters reuse a RETAINED copy of the
  anchor (`_documentCatchupAnchor`): the transport upgrade's probe
  (its throwaway session then opens parked — near-zero server work)
  and the handover's replacing attach (its manifest is complete at
  fire time, so a whole-tree segment would only re-ship held bytes —
  and re-ship DEFER partons as fallbacks, remounting activation
  triggers the client already fired).
- `visible` — the viewport seed, stating what the client SEES.
  `null` is the unmeasured state (no statement); `[]` is a
  measurement. The seed and the session's `visible` frames are the
  ONLY carriers — no URL form exists.
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
- `frames` — ATTACH-WITH-INTENT: frame-scoped `url` statements that
  fired before the connection existed, riding the attach they
  triggered. Window intent needs no entry — the statement's `url` IS
  the window statement (the attach subsumes the URL timeline). The
  entries apply at the statement bind, inside the attach's own
  request scope — the session-frame-URL writes land where the
  client's cookie resolves and a freshly-minted session cookie rides
  the attach response's headers — so the whole-tree first render
  already reads them: the segment IS the covering render the client's
  re-anchored records resolve against.
- `handoverFrom` — the transport handover's continuity link: the
  connection this attach REPLACES. The new session inherits its
  ephemeral cell storage through the handover locker (deposited at the
  old session's park-exit close, claimed one-shot under the SAME
  scope + session-identity binding, TTL-bounded), so connection-scoped
  state — deferred cells, streaming logs — survives the pipe swap: the
  handover is the same logical connection continuing on a new
  transport.

A malformed statement (or a cross-origin `url` / frame target)
answers `400`; cross-site provenance answers `403` (the same
`isSameOriginPost` check envelopes pass). The statement lands on the
request store (`bindAttachStatement` — the seam the entry and the
in-process live-drive harness share) before any render runs, and its
presence IS the live-subscription signal: the segment driver opens a
connection session iff a statement is bound. Unknown statement fields
are IGNORED — the statement grows by adding fields. The one other
`_.rsc` request kind is the action POST (`x-rsc-action`, one
commit-only segment); an action whose body happens to be
statement-shaped stays an action and never opens a drive.

The attach is also the CREDENTIAL REBIND point: every attach binds
its OWN request's scope + session identity into the connection
session (`openLiveConnectionSession`), so a session cookie minted
mid-connection — which 404s envelopes for the rest of that
connection — starts working the moment the next attach presents it.
It is the transport's one cookie-less entry: an anonymous page's
first frame intent mints the session id on the attach response
itself.

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

| Kind        | Carries                                                                                                                                                                                                                                                                                                                                                | Server effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visible`   | `{changed, visible, cached?}` — the visibility statement: flipped ids, the wholesale snapshot, the client's actual holdings for the changed ids                                                                                                                                                                                                        | Applied to the connection session; flipped-IN partons lane on the EXISTING stream (never on this response)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ack`       | `{delivered, dropped?, evicted?}` — the highest CONTIGUOUSLY committed delivery seq (cumulative), the seqs within the newly-acked range the client received but did NOT hold (its as-of guard dropped them), and the parton IDS whose committed content the client has since DESTROYED (pool-cap / cull-park eviction, page prune, a clobbered pair)   | Advances the session's ack watermark, folds each covered delivery's fps into the ACKED mirror layer — UNLESS its seq is `dropped`, which REVOKES the delivery's `(id, fp)` claims from every layer (optimistic, acked, still-pending records) AND queues each dropped id for a FORCED heal lane (`pendingDropHeals` — fp-skip yields, fresh bytes within one delivery; §the four rules) — frees the unacked delivery window (the parked driver wakes), and — any ack frame at all — proves the duplex (`firstAckReceived`, the never-acked degrade's off-switch). `evicted` ids lose EVERY credit layer (acked, optimistic, pending-record tokens) AFTER the fold, watermark advance or not — the loss statement that keeps later renders from confirming ghosts (§the four rules) |
| `detach`    | `{atPark?}`                                                                                                                                                                                                                                                                                                                                            | Explicit close: the parked driver wakes, the drive loop exits, the session closes. Best-effort by nature (sent on `pagehide` via keepalive fetch); the keepalive timeout remains the backstop. `atPark` softens it to the transport handover's GRACEFUL wind-down: the loop exits at its next FULL PARK — nothing latched, no open lanes — so everything in flight is served first (open lanes drain and commit, latched statements get their covering renders) and the close tears nothing on either side                                                                                                                                                                                                                                                                         |
| `telemetry` | `{viewport: {w,h}, scroll: {x,y,vx,vy}, at}` — the client's scroll context: container box, position, velocity (px/s), performance-clock timestamp                                                                                                                                                                                                      | Replaces the session's `telemetry` slot, latest-wins by envelope seq. NOTHING else: no invalidation, no wake, never a render — the channel carries freshness statements, and telemetry is CONTEXT, not a dependency. Consumers read the slot when awake for their own reasons (the warm pass — see §Telemetry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `url`       | `{url, intent, frame?}` — a URL statement for a scope the client owns: absent `frame`, the WINDOW URL (a `?__force=` overlay names a refetch's forced targets); present, the named FRAME's URL (the frame path's segments). `intent` is the history semantic (`push`/`replace`/`silent` — descriptive: the client's history work is done by send time) | Same-origin-validated (`400` the envelope on a cross-origin target — a violation, nothing applies). WINDOW scope: LATCHED on the session (newest seq wins; a seq at or below the consumed navigation is a stale restatement, a no-op — retransmit idempotence); the driver consumes it navigation-FIRST at wait entry and answers with a whole-tree payload segment, then forced-target lanes — §Navigation rides the channel. FRAME scope: the session frame URL is written AT THE ENDPOINT (the same store `?__frame=` writes through — and the one channel response that can mint the session cookie; an anonymous binding rebinds in place); the render latches per frame key and the driver lanes the frame's targets on the open region — §Frames ride the channel           |
| `cancel`    | `{scope}` — supersede the scope's in-flight renders: the frame's top-level name                                                                                                                                                                                                                                                                        | Aborts the scope's open lane renders synchronously at apply (the driver's `cancelListeners` arm — the same reach into a suspended render the window supersede's nav-latch arm has). A cancelled body closes with a `muxend` and NO delivery announcement, so the client's decode settles, the content never commits, and the id can reopen for the covering statement's lane. Per-scope seq gate: a replayed cancel at or below its scope's applied seq is a no-op — it can never abort a newer statement's render                                                                                                                                                                                                                                                                 |
| `warm`      | `{url}` — a stated preload target (`useNavigation().preload` on hover)                                                                                                                                                                                                                                                                                 | Same-origin-validated like `url` (the target becomes a render's request state). Replaces the session's warm slot (newest-wins by seq) and wakes the driver; the park point consumes it with ONE byte-silent whole-tree render of the target — bounded, window-respecting, never keepalive activity — so the navigation statement that follows renders against warm caches. Nothing reaches the wire for it                                                                                                                                                                                                                                                                                                                                                                         |
| `cookie`    | `{name, value}` — a client cookie change (`value: null` = delete), the wire form of `document.cookie`                                                                                                                                                                                                                                                  | Applied to the connection's mutable cookie OVERLAY (name → value, `null` tombstone), which `parseCookies` layers under the per-request `setCookie` writes and over the raw header — so held-stream `cookie()` reads reflect the change without a reattach. Queues the name for the driver, which lanes EXACTLY the snapshots whose tracked `cookie:<name>` deps name it (their fp folds the overlay through `parseCookies`); a changed value re-renders, an unchanged one fp-skips. MATCH GATES bypass the overlay (`parseRawCookies` reads the raw header) — a delta re-renders `cookie()` bodies, never a parked variant's existence gate. Per-connection (this client's jar), so it wakes only its own session via the flip-wake arm — never a process-global `refreshSelector` |

Responses carry no body: `204` applied; `400` malformed; `403`
cross-site; `404` connection gone — see §Security. Frame kinds split
into three classes: **loss-tolerant** (`visible`, `detach`, `ack` —
the protocol re-establishes their statements on its own: the next
attach's seed, the keepalive backstop, the cumulative watermark),
**lossy** (`telemetry`, `warm` — newest-wins, droppable, no fallback:
only the latest statement has value, and a preload is advisory), and
**reliable** (`url`, `cancel`, `cookie`), which ride the transport's
retransmit buffer — see §Delivery is evidenced. `cookie` retires at the
next attach rather than retransmitting: the attach's own `Cookie` header
restates the jar, so a replayed delta is redundant (the url/cancel-frame
retire rule — §Delivery is evidenced).

Shared grammar + decoder: `framework/src/lib/channel-protocol.ts`
(import-safe on both sides).

## Telemetry — the lossy class

`telemetry` is the archetypal LOSSY kind (the `warm` intent is its
sibling — same class, same drop-at-every-failure-point contract), and
its whole pipeline is built around "context, not dependency":

- **Producing.** The app states its scroll context through
  `reportTelemetry(data)` (`framework/src/lib/telemetry.ts`, exported
  from the `@parton/framework/client` barrel — the website world's
  scroller is the first producer). The module keeps at most ONE pending frame
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
  rides the channel. Action responses never carry seqs. Broadcast
  lanes change none of this: a viewer-independent body may render once
  and its bytes fan to every subscriber
  ([`streaming.md`](./streaming.md) §How a live update lands), but
  every delivery seq, mux frame, mirror promote, delivery record, and
  fp-skip verdict is minted per connection around the shared bytes —
  the broadcast slot replaces only the render+encode.
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
  window into a forced reconnect) AND is reported to the server
  (`_reportAsOfDrop` → the next ack's `dropped` set), which evicts its
  mirror promotions (§The layered mirror). Lane seqs queue
  per parton (`_channelWireEntry`); segment seqs are FETCH-LOCAL in
  the browser entry, consumed only within their own stream's loop.
- **The `ack` frame.** The transport acks the highest CONTIGUOUSLY
  committed seq (lanes commit concurrently, so out-of-order commits
  wait for their gap to fill) via an internal producer on the
  standard producer contract. The ack is a PASSENGER, never a
  driver: a watermark advance marks the producer dirty and nothing
  more — any envelope other statements justify (visibility flips,
  detach, future kinds) collects the current watermark for free.
  Exactly three moments drive a flush of their own, on the same
  rAF-coalesced path every statement rides (no timers): EVERY
  ESTABLISHMENT — the establishment ack, one cumulative ack of the
  watermark as applied on the fresh connection (`delivered: 0` on a
  catch-up boot that has committed nothing yet), which is both the
  attach-confirm and the prompt duplex proof whose delivery OUTCOME
  settles degrade state at boot (see §The never-acked degrade); the
  connection's FIRST committed delivery; and the unacked count
  crossing `ACK_FLUSH_THRESHOLD` (half the server's
  `UNACKED_DELIVERY_WINDOW`, one shared protocol constant), so a
  client under sustained lane traffic acks once per ~32 commits and
  the window always keeps 2× headroom. The establishment ack advances
  no watermark on a catch-up boot yet still fires: it is the one
  statement a lean boot always has to make, so the duplex is proven
  (or found blocked) at establishment rather than waiting on the first
  real upstream need. The server applies it unconditionally
  (`firstAckReceived` before the watermark-advance gate — a
  `delivered: 0` ack stands the never-acked deadline down without
  moving the marker); delivery seqs remain per-connection, so the
  attach manifest stays the durable evidence and the `applied` field
  still covers the separate upstream timeline. The cadence is a cost
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
  next ATTACH rather than retransmit: the statement's `url` restates
  the window URL, uncovered frame fires restate as the statement's
  `frames` intent, and the attach's own session write is
  authoritative (a replayed frame url could regress it)
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
  ack could arrive — still fp-skips off it. On a lane drain the trailer
  heal folds AFTER the subtree promote: the warm `to` fp joins the SLOT
  the promote just established for its cold `from` (evicted as a unit
  when a sibling variant overwrites the slot), and a heal whose `from`
  no slot holds is DROPPED — the exact discipline of the client's
  `_applyFpUpdates`. Folding a heal before its slot exists would strand
  the warm fp slotless, un-evictable — a return-toggle (a nested frame's
  A→B→A) would then fp-skip against that phantom and show stale content.
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

Four rules keep the layers truthful:

- **Held vs dropped is CLIENT-reported, never server-inferred — and a
  drop always heals.** Every newly-acked delivery folds into the acked
  layer UNLESS the ack names its seq in `dropped` (`AckFrame.dropped`)
  — a delivery the client RECEIVED but did not HOLD, because its as-of
  guard (`_channelDeliveryCommittable`) found it rendered as-of a
  navigation point the client had already left. A dropped seq's
  `(id, fp)` claims are REVOKED from every layer
  (`revokeDroppedDelivery` in `connection-session.ts`: the optimistic
  override the driver's renders read, the acked layer, and derivative
  claims inside still-pending delivery records — a later emission that
  fp-skip-CONFIRMED the dropped content re-claimed the pair, and the
  client committing that confirm committed a zero-byte placeholder,
  never the content) and never fold. Revocation alone cannot converge
  the client, though: the covering render that phantom-confirmed the
  dropped content fired synchronously at the consume — before the
  report could arrive — and its own drain promote re-claims the fp
  AFTER the purge (its delivery record does not yet exist when the
  report lands). So every dropped id ALSO queues for a FORCED heal
  lane (`pendingDropHeals`, drained at the driver's next wake): fp-skip
  and the defer gate yield, fresh bytes ship within one delivery, and
  the wrongly-confirmed copy never waits on an unrelated bump or the
  reconcile (fuzz finding F6 —
  [`./convergence-fuzzing.md`](./convergence-fuzzing.md);
  regression `drop-report-heal.rsc.test.tsx`). Parked or
  route-departed ids skip the heal — their revoked credit makes the
  flip-in revalidation / return navigation re-render them anyway. Only
  the client knows which arrivals its live navigation superseded, so it
  says so; the server does not guess from `asOf < navSeq` (that gate
  could not tell "committed then navigated — HELD, parked" from
  "navigated then received-and-dropped"). Torn/dying-stream drops are
  NOT reported — they self-heal on the reattach's whole-tree render.

- **Reattach seeds from the attach manifest ∪ nothing else.** The
  acked layer resets with the connection (a fresh session starts
  empty) — the manifest IS the durable evidence; a dead session's
  acks prove nothing about what the client holds NOW.
- **Flip-statement cached tokens remain the eviction evidence.** Acks
  report what the client GAINED, never what it evicted, so a
  `visible` frame's stated holdings REPLACE the id's entry in BOTH
  layers (`applyReportedCached`) — an acked-then-evicted fp must
  never confirm a phantom copy. Burst-race semantics are untouched.
  The statement's truthfulness is the CLIENT's obligation: because it
  replaces the layers wholesale, it would re-arm any credit an
  `evicted` report just revoked — which is why the advertised set is
  gated at its writer (`registerClientPartial` registers only while
  the content slot is restorable; see
  [render-pipeline.md](./render-pipeline.md) §Bounding the client
  cache).
- **Loss is reportable** (`AckFrame.evicted`). A client-side
  destruction of COMMITTED content — the pool-cap eviction, the
  cull-park LRU eviction, the payload prune, a displayed cull pair
  regressed to its skeleton by a stale commit — is stated as parton
  ids on the next ack frame (the destruction site writes the report
  through `_setContentLossListener` / `_reportContentEvicted`;
  nothing infers loss). The server revokes EVERY credit it holds for
  the id — the acked layer, the optimistic override, and the id's
  tokens inside still-pending delivery records — applied AFTER the
  same frame's `delivered` fold and regardless of whether the
  watermark advanced, so pre-destruction commits never re-credit
  while post-statement commits re-credit through their own later
  acks. An evicted id still in the session's VISIBLE set re-queues as
  a pending in-flip — the client is looking at content it just
  declared lost (its flip's confirmation can race the report by one
  RTT), so the driver's next drain lanes it fresh instead of leaving
  the skeleton to the reconcile's cadence. This is what makes the
  whole "client forgot" class self-healing: the next lane or
  reconcile re-ships instead of confirming a ghost. Revocation costs
  at most an over-fetch, never staleness. Cadence follows the ack's
  passenger policy: an OFF-SCREEN loss (pool cap, cull-park LRU,
  page prune) rides the next driven envelope — a scroll's eviction
  drain must not become one POST per wave — while a DISPLAYED loss
  (the pair regression) drives its own flush, because the user is
  looking at the regressed skeleton and the revocation + in-view
  re-lane must land within one RTT.

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
corporate proxy) would otherwise freeze liveness. But the connection
is "just" HTTP: a torn one RE-ESTABLISHES, it never permanently
degrades. Both sides act on their own real signal, and the client
side is BOUNDED and RECOVERABLE:

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
- **Client** — a SINGLE transient failure re-establishes, never
  degrades (`channel-client.ts`). Two blocked-path signatures each
  accrue a consecutive-failure counter, reset on their own success:
  a FIRST-ACK failure (the envelope carrying the connection's first
  ack fails to deliver — a blocked `/__parton/channel`; reset on a
  delivered ack). Because the establishment ack fires unconditionally
  (§The `ack` frame), this signature now surfaces AT ESTABLISHMENT: a
  catch-up boot that commits nothing still sends its establishment
  ack, so a blocked upstream is discovered at boot rather than staying
  dark until the first real upstream statement. Alongside it, an
  ESTABLISHMENT failure that STRANDED a real
  interaction (an attach settled without ever establishing while a
  nav/refetch record rode it — a blocked `/__parton/live`; reset on
  establishment). An idle-heartbeat non-establishment is a benign
  transient (the interval retries) — never counted, so a saturated
  server can't false-trip the fallback; our own supersede is never a
  failure. On a failure UNDER the bound the client re-attaches with
  backoff (immediate, then exponential) — pending records LATCH and
  ride the next attach, never flushed to a document navigation on a
  single stumble. Only a RUN past `CHANNEL_FAILURE_LIMIT` (3) of
  EITHER counter falls to DOCUMENT-NAV MODE (`_channelIsDegraded`):
  the navigate listener stops intercepting — links, traverses and
  form posts are document loads (SSR renders; a plain website) — and
  pending interaction records complete as ONE document navigation
  carrying their target state (`__frame`/`__frameUrl` document params
  for frame moves). Even that stays RECOVERABLE: the heartbeat keeps
  firing (its interval is the recovery probe), and a later successful
  attach / delivered ack clears the mode and restores channel
  navigation. A later ack's failure after a delivered first ack is a
  transient — no degrade.

## Navigation rides the channel

WINDOW navigations and batched id-forced refetches are `url` frames —
statements of the client's URL — and their responses arrive on the
held stream in stream order.

**The routing table, as shipped:**

| Interaction                                                               | Attached + healthy                                                                                                                                                                                                                        | Pre-establishment                                                               | Degraded                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Window navigation (`nav.navigate`, intercepted)                           | `url` frame, intent `push`/`replace` (a traverse states `replace`)                                                                                                                                                                        | latches; rides the attach it triggers (the statement's `url`)                   | not intercepted — browser-native document load                        |
| Silent window URL sync (`silent: true`, server-push application)          | `url` frame, intent `silent` + `sync: true`, fire-and-forget — the LIGHTWEIGHT class (see §The sync class below)                                                                                                                          | nothing (the next attach's `url` restates it)                                   | client-local URL work only (still intercepted — no server leg exists) |
| Batched id-forced refetch (`enqueueRefetch` — framework-internal)         | `url` frame, intent `silent`, page URL + `?__force=<ids>`                                                                                                                                                                                 | latches; the overlay rides the attach `url` and the targets lane at region open | resolves as a no-op (document loads are the page's renders)           |
| Frame navigation (`useNavigation(frame).navigate/reload`, frame traverse) | frame-scoped `url` frame (+ a `cancel` co-rider when it supersedes an unsettled fire for the same frame) — §Frames ride the channel                                                                                                       | latches; rides the attach's `frames` intent                                     | document navigation carrying `__frame`/`__frameUrl` document params   |
| Culling flips                                                             | `visible` frames                                                                                                                                                                                                                          | PEND until establishment (the attach seed + first segment carry the truth)      | none (no transport)                                                   |
| Preload (`useNavigation().preload`)                                       | `warm` frame                                                                                                                                                                                                                              | dropped (advisory)                                                              | Speculation Rules document prefetch                                   |
| Action POSTs, cold start                                                  | discrete by design (the action carries `x-parton-conn` when attached — §Action consequence seqs — and then NO `x-parton-cached`, the server reads the connection mirror; the capped header manifest survives only on the unattached POST) | same                                                                            | same (native form posts included)                                     |

The pieces:

- **The claim.** The navigate-event listener claims the stream
  synchronously during the event dispatch (`_channelClaimWindowNav`);
  the heartbeat's abort check defers one microtask and consumes the
  claim — a claimed navigation KEEPS the held connection (the nav
  segment arrives on it), an unclaimed one (a pre-establishment
  interaction racing an in-flight attach on the old URL) aborts it,
  and the settle's arbitration re-attaches with the statement folded
  in.
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
  ids never force the SEGMENT render (a whole-tree render cannot
  force a target whose ancestor fp-skips or replays a byte cache —
  the ancestor's fold doesn't move on a force, so its placeholder
  would cut the target out). After the region reopens, the driver
  resolves each id against the new route's snapshots
  (`resolveForcedIds` — a target with no snapshot on this route is
  dropped, as a real route change legitimately loses it) and lanes
  each target EXPLICIT (`forcedLaneIds`
  → the lane state's `explicitIds`): fp-skip and the defer gate both
  yield, the refetch contract on the lane path — the attach
  statement's own `?__force=` overlay lanes through the same seam at
  region open. The overlay is one-shot — it
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
- **Bytes on the wire forfeit the right to truncate.** The supersede
  gate (`supersededBy` in `emitNavSegment`) reads ONE fact: has this
  segment already enqueued Flight bytes (`emittedStreamingBytes`,
  written at the enqueue itself)? A payload segment's Flight document
  is delivered COMPLETE — that is what the `settled` marker means — and
  once the first bytes are out, the client may already have committed
  them root-ready (a streaming nav, the default for a window
  navigation, commits at root: its Suspense fallbacks show and its
  boundaries resolve as the body streams). Cancelling the render then
  closes that committed document with its refs still pending, rejecting
  them (`"Connection closed."`) and tearing the just-revealed partons
  into their per-partial error cards. Whether the client committed is
  the CLIENT's fact — it commits at root-ready, before any newer
  statement exists — so the server never asks and never infers it from
  the statement's URL; it honors what it already wrote. EMITTED ⇒ the
  stream DRAINS (its boundaries commit progressively) and the newest
  statement consumes right after — the `pendingNav` latch collapsed
  everything in between, and a same-URL refetch's `?__force=` targets
  ride the reopened region's lanes (fp-skipped whole-tree segment +
  forced lanes, a cheap covering pass since the drained nav already
  registered every snapshot). NOTHING EMITTED ⇒ supersede freely: an
  atomic nav buffers its Flight bytes to the atomic swap, so it has no
  committed shell to tear, and a streaming nav suspended on a slow
  loader has produced no bytes yet — the case the nav-latch arm exists
  to preempt, and where the supersede's latency win lives.
- **The sync class — URL-only statements apply lightly.** A
  `record: false` fire (a scroller's bookmark mirror, the silent URL
  sync) ships `sync: true` on its url frame and is treated as a
  DECLARATION of content-equivalence on both sides. Client: it does
  NOT advance the navigation point — deliveries rendered as-of the
  previous URL stay committable (advancing per mirror as-of-dropped
  every in-flight covering segment and lane, starving pending records
  into minutes-stuck traverse transitions and discarding whole decoded
  trees per mirror — the measured traverse-storm livelock), and it
  never downgrades a pending RECORDED frame (the sync's URL folds in,
  the recorded intent and its owed coverage stand; the server latch
  merges the same way). A separate `lastUrlStatementSeq` advances on
  EVERY statement — the server-push client-wins gate reads that
  timeline (`_serverUrlPushApplies`; discrete action responses capture
  it at issue). Server: a latched sync statement applies to request
  state without tearing lanes or emitting a whole-tree segment — no
  region churn for a bookmark mirror — and never supersedes a
  rendering navigation segment (that render IS current coverage).
  Full-path exceptions, in which the sync statement's URL rides the
  ordinary consume as the covering statement: a route change, a
  `__force` overlay, or owed coverage (`pendingNavCoverage`, set when
  a non-sync frame latches, cleared when its covering segment lands).
  Match-gated partons whose existence turns on a silently-mirrored
  param follow at the next real navigation or reconcile — the
  documented silent contract (the degraded column above never
  refetched them either).
- **Dropped covering segments still settle their fires.** A payload
  segment the client as-of-drops (or that arrives torn under a
  supersede) resolves the records at or below its as-of
  (`_channelNavSegmentSettled` at the drop consume): those fires were
  superseded by the statement that moved the navigation point, and
  the newest statement's own segment follows. Without this, a fire
  whose covering segment lost the race starved its `finished`
  forever — `navigation.transition` stuck for minutes under rapid
  back/forward, the WS upgrade's quiesce gate blocked with it.
- **The as-of guard — pageUrlKey generalized into the protocol.**
  The client's commit arbitration for seq'd deliveries: commit iff
  the delivery's as-of ≥ the navigation point
  (`_channelDeliveryCommittable`). A document navigation unloads the
  page, so no cross-page staleness class exists beyond the as-of:
  stream order plus the as-of correlation are the whole commit
  arbitration.
- **The mirror SURVIVES navigation.** A navigation consume does NOT
  prune the mirror: the client keeps its pre-navigation partons
  (parked, hidden Activity), so the covering segment fp-skips them and
  a return nav ships placeholders with no intervening ack — the mirror
  retention IS what makes fp-skip fire across navigation. A phantom is
  removed only when the client explicitly reports the delivery
  DROPPED (`ack.dropped`, above — which also queues the dropped ids
  for a forced heal lane, since the covering segment's confirm beat
  the report by construction): the server can't infer a drop from
  `asOf < navSeq` (that gate can't distinguish held-then-navigated from
  navigated-then-dropped), so it doesn't try. Consume moves the request
  state and reopens lanes; it never touches the mirror.
- **A forced statement's targets don't fold into their ancestors.**
  A `?__force=` statement re-lanes only its named targets;
  everything else fp-skips. On the whole-tree segment that means an
  ANCESTOR of a forced target must be able to skip even though a
  descendant it carries changed — so the descendant fold EXCLUDES the
  forced targets (and their subtrees) for that segment render
  (`_setFoldExclusionIds`, `excludedByForce`): the force is the
  child-invalid path, the fold is parent-valid safety. Scoped to
  targets STRICTLY BELOW the ancestor (a force at/above an id leaves
  its own subtree folded) and cleared after the nav.
- **Milestones ride the covering segment.** A channel-routed fire's
  `streaming` resolves when a payload segment whose as-of covers its
  navigation point COMMITS; `finished` when that segment SETTLES
  (its trailers resolve). The commit mode follows the NEWEST covered
  navigation (`_channelNavPrefersTransition`): if the newest statement
  at or below the segment's as-of asked for the atomic swap
  (`streaming: false`) the segment is a transition commit; a streaming
  statement (the default for a route-changing window navigation)
  leaves the live stream's raw commit in place. An IN-PLACE window
  navigation (the `FrameworkInPlaceInfo` brand — a scroller's window
  statement) states `streaming: false`: it replaces the surface the
  user is looking at, where a raw commit re-suspends mounted content
  behind fallbacks. Consulting the NEWEST — not "any
  covered fire" — is load-bearing: a superseded atomic force
  (an on-mount `defer` refetch whose page was navigated away from
  before its own segment ran) must NOT drag the next window navigation
  into a withholding transition — the later navigation's own wish,
  registered at its newer point, wins. The read is the PERSISTED
  per-point wish map (the same store the lane path reads — the wish
  must outlive the record): the browser's supersede abort settles a
  record the moment ANY newer navigation starts — including a silent
  URL-only mirror write during an in-flight in-place move — while the
  statement's segment is still streaming, and that segment must still
  commit with the mode its statement asked for. The map resets per
  connection; with no covered navigation the
  live stream's default raw commit stands. A
  forced target's fresh bytes can trail `finished` by one lane — the
  lane path is the framework's own freshness delivery, moments
  later. A window-force lane whose caller asked for STREAMING commits
  progressively (root-ready, fallbacks flashing) like a producer lane
  rather than buffering to an atomic swap: the lane announces its seq
  EARLY so the client holds it at root-ready, and
  `_channelNavPrefersStreaming` (kept per navigation point for the
  connection's lifetime, since a forced lane commits after the covering
  segment retires the nav record) drives the progressive commit.
- **The attach subsumes the URL timeline.** The statement's `url` IS
  the client's URL statement: an attach fire retires the navigation
  point (both sides reopen as-of 0), folds the pending window
  statement into the statement's `url` (its one-shot `?__force=`
  overlay included), drops buffered url frames from the retransmit
  buffer, and re-anchors every pending record at navigation point 0 —
  the attach's first covering segment (or a catch-up boot's
  lanes-open moment) resolves their milestones through the ordinary
  as-of path. A connection loss with pending records pulls the kept
  stream down and re-attaches immediately (`_requestAttachNow`); the
  statements ride that attach.
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

A frame navigate/reload/traverse is a FRAME-scoped `url` frame
(`_dispatchFrameRefetch` routes — `_channelFrameNavigate` in
`channel-client.ts`). The pieces:

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
  first, then label fan-out) and lanes them EXPLICIT on the
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
- **`cancel` is the supersede.** A statement superseding an UNSETTLED
  fire for the same frame ships `{kind:"cancel", scope: frame[0]}` in
  the SAME envelope, ahead of its url frame — the in-order pass gives
  cancel-then-url. The apply aborts the scope's open lane renders
  synchronously (id, label, or `framePath[0]` match); the cancelled
  body closes with a `muxend` and NO delivery announcement, so the
  client's decode settles without committing (an unannounced lane
  body on a seq-carrying stream never commits — it is by construction
  a superseded render) and the id reopens for the covering lane.
- **The heartbeat keeps the stream.** The silent-info `frame` branch
  and pure frame traverses CLAIM the held stream when attached — the
  statement's response arrives ON it.
- **Pre-establishment and degraded.** No connection at dispatch → the
  statement latches and rides the attach it triggers as the
  statement's `frames` intent (attach-with-intent — the bind's
  session write happens inside the attach's own request scope, so the
  whole-tree first render is the covering render). Frame url + cancel
  frames are reliable class but RETIRE at the attach subsume instead
  of retransmitting: the attach's own session write is
  server-authoritative, and a replayed frame url could regress it.
  DEGRADED, the frame move is a document navigation carrying
  `__frame`/`__frameUrl` document params — the SSR render writes them
  into the session (`PartialRoot`) and renders the frame state: the
  plain website's version of the drawer link (the same params the CMS
  preview iframe uses).

## Cookies ride the channel

A client cookie change (`navigate(url, {cookies})`) does NOT tear the
held connection. `applyClientCookies` writes `document.cookie` and
`_channelCookieChange` states each change as a `cookie` frame on the
OPEN connection (`channel-client.ts`). The change reaches the server two
ways — this frame on the live connection AND the raw `Cookie` header on
the next attach — so a lost frame self-heals at the next reattach, which
is why the reliable-class cookie frame RETIRES at the attach subsume
rather than retransmitting (`_channelNavSubsumedByAttach`).

- **The mutable session cookie overlay.** The connection session holds
  a cookie DELTA (`ConnectionSession.cookies` — name → value, `null` a
  tombstone) over the attach's open-time `Cookie` header. `parseCookies`
  layers it between the raw header and the per-request `setCookie`
  writes, so every held-stream `cookie()` read — the tracked hook,
  `evalDepKeys`' fold, and the cell-partition scope — reflects the
  change without a reattach. The held stream's request object is pinned
  at open time; the overlay is what lets its renders speak for the
  client's CURRENT jar.
- **Re-lane by tracked dep, per connection.** A `cookie` frame queues
  the changed name (`pendingCookieChanges`) and wakes the driver via the
  same flip-wake arm visibility uses. The driver lanes EXACTLY the
  snapshots whose tracked-read `deps` include `cookie:<name>`
  (`_routeMatchingCookieIds`) — their fp folds the overlay through
  `parseCookies`, so a changed value re-renders and an unchanged one
  fp-skips to the confirmation placeholder. Parked partons don't lane
  (their catch-up is the flip-in revalidation, whose fp folds the change
  too), exactly as on a bump wake. Cookie deps are TRACKED READS, not
  labels, and a cookie change is per-CONNECTION (this client's jar), so
  it never rides the process-global `refreshSelector` path — that would
  spuriously wake every peer connection.
- **Match gates keep the raw jar.** Gates read `parseRawCookies` (the
  raw header), deliberately bypassing the overlay — "who you were when
  you asked". So a cookie delta re-renders `cookie()` BODIES, never a
  parked variant's EXISTENCE gate; a cookie change that would flip a
  match gate materializes at the next attach's whole-tree render, not
  mid-connection.
- **Server → client.** A server cookie write on the channel/held path
  (the session-mint `Set-Cookie` on the endpoint `204` / attach /
  document response) stays a header write: the minted session cookie
  must reach the client SYNCHRONOUSLY for the next envelope's binding
  (§Security) — a downstream frame is async and would 404 the binding
  in the gap. App-cookie downstream framing is designed but has no
  in-tree writer yet.

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
producer lane — so chunks reveal progressively on the held stream. A
pre-establishment open rides attach-with-intent: the attach's
whole-tree render carries the overlay, and the chunks lane on the
connection it opened.

## Stream-defer stubs — the flush boundary

A lane's `muxend` waits for its LAST Flight row, so a body whose
nested descendant streams slowly (a per-card live price behind
Suspense) holds its own shell hostage — the measured ~1s
materialization wait the flush-boundary arc removed. The resolution
is structural, not a commit-mode: **the body closes at its shell**
because slow members never enter it.

- **The stub emission.** A parton with `defer: "stream"` rendered
  inside a DRIVER-OWNED body (a lane iteration, a covering
  nav/reconcile segment — marked by the ambient `laneStubCapture`
  the driver installs: on the lane probe store like the registration
  capture, via `_runWithLaneStubCapture` around segment renders)
  takes the defer branch with a distinct dormant: a
  `<PendingSlot partonId matchKey>` client gate wrapping the inert
  `<i data-partial data-partial-pending>` marker. The boundary
  REGISTERS as on every emission path — `lookupPartial` resolves it
  for the follow-up, the wake index covers it, the descendant fold
  sees its prior record. The enclosing body reaches
  `pendingChunks === 0` at its shell; trailer, delivery seq,
  `muxend`, drain promote, and heals all keep their full-drain
  semantics — every committed body stays COMPLETE, which is what
  keeps covering renders' fp-skips honest and the no-blink invariant
  intact. Renders with no driver (documents, SSR, discrete
  refetches) render stream-deferred partons DEEP.
- **The follow-up lane.** The render records each stubbed id into
  the capture; the driver spawns them at drain (lane path) or on the
  reopened region (segment paths) as FORCED lanes — fp-skip and the
  defer gate yield, and a navigation tear re-lanes them as
  unfulfilled forces instead of silently dropping promised content.
  An already-open lane coalesces to dirty.
- **The client gate.** `<PendingSlot>` suspends on
  `slotFillPromise(id)` while the id's cache slot is EMPTY, and
  renders its children once filled (by then the substitution has
  replaced the marker with the cached content). The gate lives in
  the WIRE FORM — not in the substitution — because a lane body's
  rows can settle between the commit walk's classification and
  React's reconcile (the raw-reveal TOCTOU): React then unwraps the
  row natively, no substitution pass runs, and a bare marker would
  commit the boundary REVEALED with visually-empty content that
  React's transition semantics never un-reveal. The harvest walk
  never stores a stub wrapper (`isStubWrapper`) — the slot stays
  genuinely empty until the real body lands, and no fp registers for
  content the client doesn't hold.
- **fp timing.** The stubbed parton's own fp finalizes with ITS
  body's trailer, on its own lane; the ancestor's fold reads the
  prior-commit record as always. The known lag — a lane's flush heal
  never heals ancestors — stands: the ancestor's advertised fp sits
  one drift behind until a whole-tree segment (over-fetch, never
  stale).

The browse demo's `LivePricePartial` declares `defer: "stream"`;
measured effect: scroll-up rematerialization went from ~1.35s
skeleton hold (shell gated on the price sleep) to ~10ms, with prices
streaming in on their own lanes ~1s behind. Broadcast slot bodies
render DEEP (the publish path installs no capture) — a shared body
must stay viewer-independent and replayable.

## Action consequence seqs

Actions stay discrete POSTs (the pinned decision), but with a channel
attached the response body carries NO render — only the delivery seqs
its invalidation consequences will ride. The held stream is the sole
consequence carrier: the transaction-commit wake re-renders each
reserved parton on the open stream, so an in-body whole-tree `<Root/>`
would double-deliver the exact same consequences. When the reservation
is non-empty the entry sets `suppressRoot` (the same null-root path the
deferred-only tally takes — [`streaming.md`](./streaming.md) § "Deferred
(stream-only) writes"), and the body is just `returnValue` + `formState`

- any url-trailer. The client's optimistic overlay holds until its
  committed watermark covers the reserved seqs, never clearing at the
  returnValue alone (under window coalescing the consequence lane can
  trail the response by the whole backpressure window, which is exactly
  when a returnValue-cleared overlay flashes the stale server value).
  UNATTACHED, a binding mismatch, or a write with no matching route
  snapshots reserves nothing (`_reserveActionConsequences` collapses an
  empty match set to `null`, never `[]`) — the in-body `<Root/>` renders
  as the only carrier, unchanged:

* **The client names its connection** (`x-parton-conn` on the action
  POST — an explicit statement, never inferred), when attached and
  non-degraded. On such a POST the client sends NO `x-parton-cached` manifest:
  the server already knows this connection's holdings (its session
  mirror), which the action adopts. The capped header manifest survives
  only on the UNATTACHED / degraded POST, where there is no mirror.
* **The action adopts the connection's state**
  (`_adoptConnectionForAction`, before the action body runs). Two
  things follow the connection so the action and its held stream agree:
  its **ephemeral cell storage** — so the action's `.set`/`.invalidate`
  land in the SAME storage the driver's consequence lanes read (without
  this the writes hit a throwaway per-action storage and the lanes
  re-render the pre-mutation values the driver still holds) — and a
  snapshot of its **cached mirror** + acked layer, so an action that
  DOES render its own root fp-skips against what the server delivered
  (the `x-parton-cached` replacement above). The mirror snapshot decouples the
  action's read-only fp checks from the driver's concurrent mutation of
  the live one.
* **The server reserves INSIDE the action's transaction**
  (`_reserveActionConsequences`, called by the entry between the
  action body and the commit): the pending selectors match the
  connection's route snapshots (`_routeMatchingSelectorIds`, parked
  partons excluded), and each target gets a delivery seq assigned
  (`assignedLaneSeqs`). A match with no `emittedFp` cannot
  carry a lane: it has no client slot to swap, so it ESCALATES to its
  nearest fp-bearing ancestor (`laneCarrierFor` in `segment-relevance`,
  shared with the live lane-open path so the reserve and the driver
  agree on carriers), whose one render re-renders the subtree that
  contains it — exactly as a whole-tree segment does off the lane path.
  Because the commit's flush is what wakes the drivers, the reservation
  is strictly ordered before any driver could mint the same lanes'
  seqs — no race window exists. Re-reserving an id with an unconsumed
  assignment reuses it: one render of the latest state covers both
  writes. Binding checks mirror the envelope's (scope + session
  identity); a mismatched header reserves nothing.
* **The pump consumes at iteration start;** every skip path VOIDS the
  assignment (`voidSeqs` → the `seqvoid` entry: parked flips, a gone
  snapshot, window-freed-then-parked ids, a navigation tear — which
  voids everything). The client counts voided seqs PROCESSED, so the
  contiguous watermark can always pass a reservation — a silent gap
  would wedge the unacked window and hold the gate forever.
* **An ANNOUNCED seq whose body cannot complete is voided too.** A
  lane that already wrote its delivery announcement (an
  early-announced streaming force, a `muxlive` producer) and is then
  torn by a navigation or cancelled mid-body adds its ANNOUNCED seq
  to `voidSeqs` on the torn exit. Without the void, the client's
  torn-decode consume stalls the watermark at that seq permanently —
  the unacked window fills and every later flip/bump lane coalesces
  into `windowDirty` forever (the measured skeletons-at-rest wedge
  after a traverse storm). The client's `seqvoid` handler counts the
  seq processed AND marks any still-queued lane delivery `voided`, so
  a settled-but-truncated body (a cancelled lane closed with its
  `muxend`) is dropped instead of committed as torn content
  (`channel-sync-statements.rsc.test.tsx`).
* **The response header** (`x-parton-consequences: s1,s2`) registers
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

A long-lived lanes connection — an active one steady relevant wakes
keep alive indefinitely, or an idle one the minutes-long keepalive
backstop holds open — needs the correctness backstop that a
close+reopen would otherwise provide: a relevance false-negative (a
dependency the label/constraint surface doesn't capture) would never
heal on lanes alone. The driver makes it explicit: past
`RECONCILE_INTERVAL_MS` (30s, anchored at the last full segment —
connection open, an honored catch-up anchor, or the previous
reconcile), the next wake at quiesce (no open lanes; the `next`
delimiter would tear them) with room in the delivery window emits a
whole-tree payload segment ON the stream — `next`, the segment (its
own delivery seq, fp-skip pruning it to placeholders when nothing was
missed), `settled`, then `next` + `lanes` to reopen the region — and
advances the wake cursor past everything the segment covered (the
wake subscription's pending set clears and re-syncs with it — the
delivered-but-undrained ids were covered too).
Evaluated at wakes, no standing timer: a connection needs a wake to
reach the cadence, so a totally silent one is closed by the keepalive
first (its eventual reopen's first segment is whole-tree anyway) — but
any connection with even trickling wake traffic, idle or active, now
reconciles every 30s rather than waiting on a reopen. The reconcile is
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

## Deploy-and-drain

A deploy replaces the process, and the architecture holds one long
connection per viewer to it — so SIGTERM is a first-class protocol
moment, not an error path. `beginDrain()`
(`framework/src/runtime/drain.ts`; barrel-exported next to the
invalidation bridge) runs the graceful half; `createRscHandler` wires
`SIGTERM → beginDrain → exit` automatically (`drain: false` opts out,
`drain: {deadlineMs}` tunes the bound — default
`DEFAULT_DRAIN_DEADLINE_MS`, 5s). The lifecycle:

- **Stop accepting attaches — explicitly.** While draining, a NEW
  attach answers `503` + `x-parton-drain: 1` (`DRAIN_REFUSAL_HEADER`
  in `channel-protocol.ts`); the full-duplex drivers write the `drain`
  wire entry and close the socket with no session opened. The HEADER is
  the statement — a bare 503 is never read as drain. A drain-aware
  proxy retries the buffered attach POST against a surviving backend
  (the multi-process harness's does); the client transport marks the
  failure `NavigationError.drainRefusal` and the close arbitration
  retries on a short fixed cadence (`DRAIN_RETRY_MS`, 500ms) WITHOUT
  counting toward the degrade bound — the path is not broken, the
  process is leaving. Everything else keeps serving for the whole
  window: envelopes, action POSTs, document GETs — in-flight writes
  land.
- **Signal + settle every held connection.** `beginDrain` marks every
  open session (`_drainAllConnectionSessions`) and wakes its driver;
  the driver's next wake writes the `drain` wire entry ONCE (a
  zero-body entry in the `\xFF` marker grammar — `TAG_DRAIN`; the
  producer writes the signal, a closed socket alone never means drain)
  and converts the drive to the SAME full-park wind-down the transport
  handover's `atPark` detach uses: open lanes drain and commit,
  latched statements get their covering renders, the stream closes
  CLEANLY. Client-side, the `drain` entry arms the handover's one-shot
  reattach-on-close: the stream's settle re-fires the attach
  IMMEDIATELY — no heartbeat-interval wait — with the fire-time
  manifest (complete, since the wound-down stream served everything
  first) and `since: null` (the new process's registry is a new
  timeline; the anchor would be refused). Action POSTs hold through
  the close→establish gap on the handover machinery
  (`_channelHandoverSettled`). Through the deployment's sticky proxy
  the reattach lands on a surviving process BEFORE the old one exits —
  that ordering is what deletes the ungraceful failover's ~1.9s
  visible gap (measured: ~0.3s, `docs/archive/deploy-and-drain.md`).
- **Quiescence, then the deadline.** The drain resolves when the
  process is quiescent — zero open sessions AND zero in-flight
  requests. Requests are gauged by the entry (`_drainRequestStarted` /
  `_drainRequestSettled` around the handler, held until the response
  BODY fully streams out), so a write the process has SEEN commits and
  its response flushes before the exit. The `deadlineMs` bound is the
  module's one explicit time signal — it IS the contract (a deploy
  must complete): at the deadline every remaining session is
  force-closed (`detached` + `drainForced`; the drive's exit path
  aborts EVERY open lane's render read, not just producers' — a
  wedged loader must not hold the exiting process) and the drop is
  REPORTED (a process-level `console.warn` naming the connections,
  plus each driver's per-connection lane detail) — never silent. A
  force-closed lane's body ends on the cancel path (muxend, no
  delivery announcement), so the client's decode settles without
  committing; the reattach's whole-tree render is the heal.
- **Exit.** After quiescence (or the deadline) and a best-effort cell
  storage `flush()` (the dev JSON store's debounce window must not
  ride into the kill; the SQLite adapter's commits are already
  synchronous), the SIGTERM wiring hands the signal to whatever it
  displaced. `installDrainOnSigterm` takes SIGTERM over at install —
  Vite's dev/preview handler destroys every open socket and exits
  within the same tick, which would tear the drain frame off the wire
  — and re-invokes the displaced listeners after the drain (they close
  the http server and exit), or exits itself when there were none.
  SIGINT (Ctrl-C) is untouched.

What drain does NOT do: migrate state. Values live in the shared cell
store and survive by construction; the client re-warms in one attach
whose whole-tree render is the bounded full-price cost (per-process
registry/fps are not fp-portable across processes — invalidation
timestamps fold into the fp on a per-process timeline, so the
manifest's fps miss and the cold-record posture over-fetches, never
stale). SESSIONS (frame URLs) follow the configured `SessionStore`:
on the default in-memory store they die with the process — the new
process renders every frame at its initial URL — while a shared
`setSessionStore(new SqliteSessionStore(...))` carries them across
the deploy. Drain surfaces that split honestly instead of hiding it;
the session cookie itself always survives (it lives in the browser).

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
  own ack producer rides the same contract. Producers split their
  state into DRIVERS and PASSENGERS: only statements with urgency
  request a flush (a real viewport flip, the controller's
  once-per-establishment full-set sync, the ack's first-commit and
  threshold advances), while everything else (measurement-only
  reports, ordinary watermark advances, telemetry) marks the
  producer dirty and rides whatever envelope the next driver
  justifies — `collect` is consulted on every flush, so a passenger
  needs no transport-level registration. The cost rule behind the
  split: every envelope carries the browser's full Cookie header
  (§Telemetry's numbers), so a statement without urgency must never
  be the reason an envelope exists.
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
- **Bounded re-establishment.** A single failure re-attaches with
  backoff; only a run past `CHANNEL_FAILURE_LIMIT` of either the
  first-ack or the interaction-stranding establishment counter falls
  to DOCUMENT-NAV MODE (`_channelIsDegraded()` — the navigate
  listener's stand-down cue), and a proven-working connection clears
  it (§The never-acked degrade). `_channelAppliedWatermark()` is the
  heard upstream watermark the next attach statement presents.

## The transport seam — one pipe, two roles

The byte/message plumbing under the channel is pluggable behind one
interface (`framework/src/lib/channel-transport.ts`), so the channel
SEMANTICS above — frames, delivery seqs, acks, the connection-session
mirror — stay transport-agnostic while only the pipe swaps:

```
interface ChannelTransport {
  open(statement, signal?): Promise<{ body: ReadableStream<Uint8Array> }>  // downstream
  send(envelope): Promise<boolean>                                          // upstream
  close(): void
}
```

- **downstream** — `open` hands back a byte stream of the same
  `\xFF`-marker wire the splitter (`splitSegments`) already parses. The
  browser entry (`consumeLiveStream`) reads it and never names a
  transport.
- **upstream** — `send` delivers one coalesced envelope; the boolean is
  the whole contract ("the server will see it"). Reliability lives
  ABOVE the seam (the retransmit buffer + the downstream `applied`
  marker — §Delivery is evidenced), so a transport that can't answer
  per-message returns `true`.
- **close** — release whatever the transport holds.

The default is the **fetch transport**: `open` = `POST /__parton/live`
held open for the downstream; `send` = `POST /__parton/channel`
fire-and-forget (`keepalive: true`), `204` → `true`; `close` a no-op
(each attach is its own fetch, torn cooperatively via the splitter's
signal, and every envelope is a discrete request). A full-duplex
transport folds both roles onto ONE connection behind the same
interface — an OPAQUE TUNNEL carrying the SAME marker bytes, no
reframing — so nothing above this module changes.
`getChannelTransport()` / `setChannelTransport()` select it; fetch is
the BOOT transport, and an unforced page auto-upgrades from it to
WebSocket where the socket works (§The default — boot fetch, upgrade to
WebSocket).

### The default — boot fetch, upgrade to WebSocket

Fetch is the boot transport — instant, universal, no handshake to wait
on — and the channel PROMOTES itself to the WebSocket transport in the
background where the socket works. The socket.io-shaped default, but
built on the framework's own re-attach machinery, not an in-place socket
swap: client state (the cache, fingerprints, cull state,
delivery/envelope timelines) is transport-independent module state, so
"upgrade to WS" is a graceful close of the fetch connection followed by
an ORDINARY attach on the WS transport (`armTransportUpgrade`, browser
entry). The handover is NO-GAP and NO-TEAR — nothing mid-render is torn
on either side, no statement class is lost, and the replacing
connection can never roll the page back. The steps:

1. **Boot on fetch.** `selectChannelTransport()` keeps fetch unless a
   `?transport=` force pins one; first content rides the fetch attach.
2. **Capability gate, quiesce, then background probe.** The upgrade
   arms ONLY on an app whose server ADVERTISED it serves the socket:
   `partonChannelServer` (the Vite plugin registering the `/__parton/ws`
   handler) sets `PARTON_WS_AVAILABLE` in the render process,
   `renderHTML` reflects it into every document's bootstrap as
   `self.__partonWsAvailable`, and `armTransportUpgrade` stands down
   unless that flag is present. No plugin → no flag → no probe: an
   unadvertised page opens ZERO sockets and logs no error. This is the
   no-heuristic rule — the server that serves the socket advertises it;
   the client never probes an unadvertised endpoint (a blind probe would
   open a doomed socket the host leaves hanging, close 1006, twice).

   Once advertised AND the fetch connection establishes (first content
   already delivered — the upgrade costs the user nothing), the attempt
   first QUIESCES: `_channelIdle()` resolves only when no navigation /
   refetch record is in flight (the record machinery's own settle
   milestones — never a timer), so the swap never lands under a
   mid-stream covering render; a page that never idles simply keeps
   fetch. Then a BACKGROUND probe opens a speculative WS attach on a
   throwaway socket (`probeWebSocketTransport`). It confirms iff the
   server-minted `conn` handshake arrives over the socket — the SAME
   establishment signal the live path reads (`splitSegments`'
   `TAG_CONNECTION_ID`), not a bare `onopen` (which only proves the TCP
   upgrade, never that the server drove the socket). The probe presents
   the manifest AND the retained document anchor, so an anchor-honoring
   server opens the probe's session straight into a parked lanes region
   — `conn` arrives with near-zero server work, and closing the probe
   socket tears no render.

3. **Confirmed → graceful wind-down, then the replacing attach.**
   `_channelBeginTransportHandover()` states the fetch connection's
   `atPark` detach: the server winds the held stream down at its next
   FULL PARK — nothing latched, no open lanes — so everything in flight
   is served first (open lanes drain and commit, latched statements get
   their covering renders) and the stream closes CLEANLY, with nothing
   to tear. The connection id stays PUBLISHED for the whole wind-down:
   statements and actions keep riding the fetch connection until the
   moment it actually closes. That close consumes the one-shot reattach
   flag and re-fires the heartbeat; the fire installs the WebSocket
   transport (the one-shot flip in the attach transport) and is an
   ORDINARY attach — its statement folds pending intent and presents
   the manifest AT FIRE TIME, strictly after every one of the old
   stream's commits landed (a fire's `finished` awaits its lane
   chains), so the new connection's first render can never roll the
   page back behind content the old connection delivered. The statement
   presents the retained anchor (`since`) — the new connection opens
   straight into lanes, no whole-tree replay — and names the closed
   connection (`handoverFrom`), inheriting its ephemeral cell storage
   through the handover locker. The only unpublished window is the
   close→establish gap (milliseconds); statements latch through it on
   the ordinary pre-establishment machinery, and action POSTs hold for
   `_channelHandoverSettled()` so their connection affinity — the
   `x-parton-conn` binding routing cell writes into the connection's
   storage — is never silently dropped to unattached semantics. An
   envelope that raced the close and failed against the dead connection
   is recognized as stale (its connection is no longer the current one)
   and neither tears the new stream nor counts toward the degrade
   bound. From there every attach, lane, and envelope rides WS.
4. **Failed → stay on fetch.** An ADVERTISED endpoint that still fails
   to confirm (the WS handshake errors before `onopen`, or `conn` never
   arrives within the timeout — a proxy stripping the upgrade, a
   transient) closes the probe socket and stays on fetch, transparently
   — the fetch connection was never touched. A bounded, backed-off
   re-probe (up to `MAX_UPGRADE_PROBES`) covers a transient stumble,
   then it gives up for the page lifetime — never hammering a blocked
   endpoint. A socket that confirms and later stops establishing falls
   back through the fire path itself: an attach that settles without
   ever seeing `conn` on an UNFORCED WebSocket transport reverts the
   transport to fetch before the close arbitration re-attaches
   (`consumeLiveStream`'s settle guard) — so a mid-handover socket
   death lands back on the universal transport with no dead gap. The
   wind-down has a liveness backstop (`HANDOVER_DRAIN_TIMEOUT_MS`): a
   connection that never parks (an unbounded producer, a wedged loader)
   is aborted after the bound so the handover completes.

A `?transport=` force (`fetch`/`ws`/`webtransport`) is the user's
explicit choice and STANDS THE UPGRADE DOWN: `isTransportForced()` is
the gate. So `?transport=fetch` pins fetch (no probe) and `?transport=ws`
boots straight on WS (no probe needed).

### The WebSocket transport (opt-in)

`WebSocketTransport` (`channel-transport.ts`) is the full-duplex pipe —
ONE socket to `/__parton/ws` for both roles. `open` upgrades the socket,
sends the `AttachStatement` as the first (text) message, and returns a
`ReadableStream` fed by `ws.onmessage` — the server tunnels
`driveSegmentedResponse`'s bytes down as BINARY frames, which
`splitSegments` parses exactly as over fetch. `send` =
`ws.send(JSON.stringify(envelope))` → `true` (reliability is above the
seam, so no per-message `204`). `close` = `ws.close`. The signal is the
caller's cooperative abort: post-establishment it drives `splitSegments`
(which cancels the stream at a segment boundary → the stream's `cancel`
closes the socket), so an abort never tears a mid-segment body — the
same discipline the fetch transport keeps by not wiring the signal to
`fetch`.

**Server (`channel-server.ts` + the RSC entry).** The socket lives
OUTSIDE `createRscHandler`'s Request→Response surface, so the server
wiring is a FOURTH hook. `createChannelServer({ Root })` (the socket-side
twin of `createRscHandler`, also exposed as `handleChannelSocket` off
its return) drives one upgraded socket: `driveChannelSocket` reads the
attach off the first message, binds it, and runs `driveSegmentedResponse`
UNCHANGED against a controller whose `enqueue` is `ws.send` and whose
`demand` reads the socket's `bufferedAmount` + send-flush (`onDrain`) —
no timers. When the drive ends (keepalive elapse, detach, the
handover's park-exit) the driver CLOSES the socket, exactly as the
fetch wrapper closes its response stream — the client's downstream body
ends instead of holding a silent socket for a wound-down stream. Each later message decodes to an envelope and applies through
the SAME `applyEnvelopeToSession` switch the fetch endpoint uses, in a
request scope carrying the upgrade's cookies (so a frame-url's session
write lands where the client's cookie resolves). `_resolveBoundSession`
is the shared binding check both transports run: the envelope must name a
session under the current request's scope + session identity. The socket
is inherently bound (one connection per socket), so the origin check
lives at the handshake, not per-message.

Dev only: an HMR edit to the rsc graph DETACHES every open session —
held drives render the module graph captured at their attach, so an
edit orphans them; the client's `rsc:update` handler arms an immediate
reattach, which imports the entry fresh. Both drives pin their graph's
code version into the attach scope (the `codeVersion` parameter) so
their fps name the graph that renders. Mechanism + gate:
[`render-pipeline.md`](./render-pipeline.md) § Dev HMR.

**Dev/preview wiring** is the framework Vite plugin `partonChannelServer`
(`framework/src/vite/channel-server.ts`): it hooks the Node http server's
`upgrade` event, accepts the `/__parton/ws` handshake (leaving Vite's HMR
upgrade alone), adapts each `ws` socket to a `ChannelSocket`, and drives
it through the app's `handleChannelSocket` — reached via the runnable
`rsc` environment in dev, the built RSC bundle in preview. It is ADDITIVE:
it only serves the extra endpoint, so an app that adds it is unchanged on
the default fetch path. It also ADVERTISES the endpoint: registering the
upgrade handler sets `PARTON_WS_AVAILABLE` in the render process (shared
across the dev module-runner environments and the preview process — a
module global is not, hence `process.env`), which `renderHTML` reflects
into every document's bootstrap as `self.__partonWsAvailable`. That flag
is the auto-upgrade's capability gate (§The default, step 2): absent it,
the client never probes, so a plugin-less app opens no socket.

Usage — add it to the app's `plugins` (the
website does, `website/vite.config.ts`):

```ts
import { partonChannelServer } from "@parton/framework/vite/channel-server.ts"
// plugins: [ partonChannelServer(), rsc(), react(), … ]
```

The app's RSC entry must default-export `createRscHandler({ Root })` (it
exposes `handleChannelSocket`); the plugin resolves the entry from the
`rsc` environment's `build.rollupOptions.input` (canonically `index`).
Then load any page with `?transport=ws` — the whole channel (attach,
lanes, navigation segments, every upstream envelope) rides the one socket
and NOTHING POSTs to `/__parton/live` or `/__parton/channel`.

**Selection.** With `partonChannelServer` serving `/__parton/ws`, the
WebSocket transport is the DEFAULT reached via the auto-upgrade (§The
default — boot fetch, upgrade to WebSocket): an unforced page boots fetch
and promotes itself. `?transport=ws` (or `window.__partonTransport ===
"ws"`) FORCES it at boot instead — the whole channel rides the socket
from the first attach, skipping the fetch-first dance
(`selectChannelTransport()`, run once at `bootBrowser`). An app WITHOUT
the plugin never advertises `/__parton/ws`, so the auto-upgrade never
probes (it opens no socket) and the page stays fetch — the default suite
is unaffected.

**Verification.** Four surfaces — the tunnel, the handover's channel
state, the forced-WS live glue, and the auto-upgrade:

- `channel-ws.rsc.test.tsx` proves the TUNNEL end to end over a REAL
  socket (the client transport + `driveChannelSocket`: attach, first
  segment, an expiry lane, and an upstream envelope whose seq surfaces on
  the `applied` marker) — but with a hand-built `ws` server, not the Vite
  glue — PLUS the `atPark` detach (the stream keeps serving, then closes
  CLEANLY at the next full park — iteration completes without error) and
  `probeWebSocketTransport` in isolation: it confirms (`true`) when the
  server drives the socket and mints `conn`, and declines (`false`) when
  the socket opens but is never driven, or the endpoint is absent (the
  WS-unavailable → stay-on-fetch guarantee, in miniature).
- `channel-handover-client.test.ts` pins the handover's channel-state
  half: the `atPark` detach with the id kept published, the close's
  one-shot re-fire + `handoverFrom` consumption, the detach-failure
  fallback to the abort, close-racing statements latching and gating
  stale deliveries, the action gate (`_channelHandoverSettled`)
  releasing at establishment, and the quiesce gate (`_channelIdle`).
- `website/validate-ws.mjs` proves the Vite PLUGIN's dev/preview upgrade
  glue in a running server (`yarn build:website && node
website/validate-ws.mjs`, and `--dev` for the dev server): it drives
  Chromium at `/?transport=ws` (FORCED) and asserts the socket establishes
  (the `conn` handshake sets `data-parton-live`), the attach +
  scroll-driven lanes stream down as BINARY frames, the scroll's
  visibility flips ride UP the same socket (and the server acts on them —
  the flipped-in chunk streams down), pulses stay live, ZERO POST hits
  either fetch endpoint, and — in dev — Vite's own HMR still round-trips
  over its untouched socket.
- `website/validate-upgrade.mjs` proves the AUTO-UPGRADE end to end
  (`node website/validate-upgrade.mjs`, `--dev` too): it drives Chromium
  at `/` with NO `?transport=` param and asserts the FIRST content rides
  fetch (a `POST /__parton/live` before any socket opens), then the
  connection UPGRADES within a short window (a `/__parton/ws` socket, WS
  attach binary frames, `data-parton-live` still set) with the NO-TEAR
  handover contract — the held fetch attach closes CLEANLY
  (`requestfinished`, the park-exit wind-down; never `requestfailed`)
  and only AFTER the socket opened — and streaming + culling stay
  intact ACROSS the switch (scroll streams the new chunk in over the
  socket, flips ride up it, pulses advance) with ZERO further
  fetch-endpoint POSTs and no tear/duplication. The FETCH world stays
  gated by `validate-world.mjs` (`?transport=fetch`, forced — its budgets
  are fetch-transport contracts).
- `website/validate-no-ws.mjs` proves the CAPABILITY GATE — the inverse
  of the auto-upgrade (`yarn build && node website/validate-no-ws.mjs`).
  Every in-repo app ships the plugin, so the unadvertised page is
  produced by SUPPRESSING the advertisement client-side (an init script
  swallows the bootstrap's `self.__partonWsAvailable = 1` write —
  exactly the state a plugin-less server leaves the page in). It drives
  the e2e-testing preview at `/` and asserts the fetch channel
  establishes and stays held (`data-parton-live`, a `POST
/__parton/live`) while ZERO `/__parton/ws` sockets ever open and no
  WebSocket console error fires — with the served bootstrap asserted to
  CARRY the flag as the control (the client gate is what stood down).

One teardown note: a hard socket close during an in-flight render
cancels that render's Flight stream. Every driver-initiated cancel
carries an explicit `RenderCancelledError` reason
(`DRIVER_CANCEL_REASON` in `segmented-response.ts`) — React folds a
stream-cancel reason into the render-error channel, and
`reportServerRenderError` (`runtime/errors.ts`) classifies the marker
as expected lifecycle, so a client disconnect tears down silently
instead of logging an abort stack. Identical on the fetch path (a torn
`/__parton/live` hold winds down the same lanes), not a
WebSocket-specific behavior. The server stays healthy across the churn.

### The WebTransport transport (opt-in)

`WebTransportTransport` (`channel-transport.ts`) is the HTTP/3 full-duplex
pipe — ONE bidirectional QUIC stream to `/__parton/wt` for both roles.
`open` constructs `new WebTransport(url)` (always `https:` — QUIC mandates
TLS), awaits `wt.ready`, opens a bidi stream (`createBidirectionalStream()`),
writes the `AttachStatement` as the first upstream line, and returns a
`ReadableStream` fed by the stream's readable half — the server tunnels
`driveSegmentedResponse`'s bytes down it as the SAME `\xFF`-marker wire,
which `splitSegments` parses exactly as over fetch. `send` writes the JSON
envelope to the stream's writable half → `true` (reliability is above the
seam, so no per-message ack). `close` = `wt.close`. The signal is the
caller's cooperative abort, the same discipline as fetch/WS: post-establishment
it drives `splitSegments`, whose stream `cancel` closes the session — never
wired to the live pipe.

**The one framing difference — upstream only.** A QUIC stream is raw bytes
with no message boundaries, so the UPSTREAM half carries newline-delimited
JSON: the attach and each envelope are `\n`-terminated (safe — `JSON.stringify`
never emits a literal newline). This is the message boundary the WebSocket
gives for free; the WS transport needs no delimiter. The DOWNSTREAM half is
byte-identical to fetch/WS — the marker wire is unframed, still an OPAQUE
TUNNEL, so nothing above the transport changes.

**Server (`channel-server.ts` + the RSC entry).** `driveChannelWebTransport`
is the WebTransport twin of `driveChannelSocket`: it takes the bidi stream's
two halves (`ChannelDuplexStream` = `{ readable, writable }`, structurally
`WebTransportBidirectionalStream`), reads the attach off the first upstream
line, binds it, and runs `driveSegmentedResponse` UNCHANGED against a
controller whose `enqueue` writes the writable half and whose `demand` reads
the writable's NATIVE backpressure — `writer.desiredSize` (queue headroom)
and `writer.ready` (a queued write flushed), no `bufferedAmount` indirection,
no timers. Each later upstream line decodes to an envelope and applies
through the SAME `applyEnvelopeToSession` switch (the shared
`_resolveBoundSession` binding check runs first) — no duplicated apply
logic, exactly as the WS driver. `createWebTransportServer({ Root })` (the
RSC entry) is the WebTransport twin of `createChannelServer`: its
`handleSession(session, request)` accepts the client's first incoming bidi
stream off the QUIC session and drives it with the SAME `<Root/>` render
closure (`channelRenderOnce`, shared with the WS server).

**Infra requirement (no Vite plugin).** WebTransport needs an HTTP/3 (QUIC)
listener, which Vite dev/preview (Node HTTP/1.1) does not provide and Node
has no stable server for. So there is NO framework Vite plugin for it — the
WebTransport server is a STANDALONE hook. To serve it: stand up a QUIC/HTTP3
server (e.g. `@fails-components/webtransport`'s `Http3Server`, or deploy
behind an HTTP/3 edge that terminates WebTransport), and for each session on
`/__parton/wt` build a `Request` from the connect (its `Cookie` header
supplies the scope + session binding, its URL the origin) and call
`createWebTransportServer({ Root }).handleSession(session, request)` — where
`session` exposes `incomingBidirectionalStreams` (a readable of bidi
streams, each with `.readable`/`.writable`). Keep it OFF the default path;
the client opts in with `?transport=webtransport`.

**Selection.** `selectChannelTransport()` installs the WebTransport transport
only on an explicit opt-in (`?transport=webtransport` or
`window.__partonTransport === "webtransport"`) with a `WebTransport` global
present. Absent the opt-in the default fetch transport stands.

**Verification.** The tunnel is proven end to end over a FAKE duplex (a pair
of `TransformStream`s standing in for the bidi stream, a stubbed
`WebTransport` global) by `channel-webtransport.rsc.test.tsx`: attach as the
first newline-framed line, the whole-tree segment + an expiry lane tunneled
down as opaque marker bytes, and an upstream envelope applied through the
shared switch, its seq surfacing on the `applied` marker. The seam guarantee
is what lets a fake duplex exercise the tunnel byte-for-byte —
`driveSegmentedResponse` and the client splitter never name a transport, so
only the QUIC socket underneath is mocked. NOT gate-verified end to end over
a real HTTP/3 connection — that needs the standalone QUIC server above,
which the CI environment cannot host.

## Testing

- rsc tier: `channel-endpoint.rsc.test.tsx` (decode — incl. the
  `cookie` frame set/delete grammar, HTTP mapping,
  origin/scope/cookie-binding checks, unknown-kind skip, in-envelope
  frame ordering, the mint handshake, detach ending a held drive),
  `channel-cookies.rsc.test.tsx` (the `cookie` frame end to end: the
  endpoint applies it to the session overlay and queues the re-lane; a
  held-stream `cookie()` reader re-lanes with the fresh value while a
  non-reader never re-renders; a delete re-lanes to the absent value;
  match gates keep the raw jar), `connection-visibility.rsc.test.tsx`
  (visibility statement
  semantics through the envelope, against a real drive — incl. the
  pure sync statement, `changed: []`, aligning the set without
  laning),
  `channel-acks.rsc.test.tsx` (delivery-seq emission ordering across
  segments + lanes, the ack watermark + acked-layer fold, the
  `applied` marker + duplicate-envelope convergence, the attach
  `applied` seed, window-exceeded coalescing, the window vs the lazy
  cadence — threshold-cadence steady state never gates, a silent
  client fills the window and one cumulative ack frees it — the
  never-acked degrade + the acking client that never degrades, the reconcile
  cadence, mirror layering: flip statements superseding the acked
  layer and the acked-fallback verdict),
  `ack-evicted.rsc.test.tsx` (the `evicted` loss statement: both
  mirror layers + pending-record purge, non-advancing-ack apply,
  strict decode, and the in-view re-lane — the eviction envelope
  alone re-ships fresh bytes), `drop-report-heal.rsc.test.tsx` (the
  `dropped` statement's F6 race: a drop report arriving after the
  covering render's phantom confirm → full revocation + one FORCED
  heal lane, no phantom in the acked layer; and the pinned-visibility
  flush — an out-flip landing mid-lane never retags the in-state
  body), `content-loss-report.test.ts` +
  `cull-pair-regression.test.tsx` (the client side: destruction
  sites reporting as passengers, the pair's regression detector
  driving, the baseline reset re-arming the flip),
  `drain.rsc.test.tsx` (deploy-and-drain server half: the `drain`
  entry announced once + the clean full-park close, an in-flight lane
  settling before the close, the explicit 503 + `x-parton-drain`
  refusal and the WS driver's drain-entry refusal, the deadline
  force-closing a wedged lane with the loss reported, and the fan-out
  race — a session opened mid-drain self-marks at open),
  `live-catchup.rsc.test.tsx` (the attach statement: anchor catch-up,
  attach-only anchor, body-manifest/URL-manifest verdict equivalence,
  the uncapped body manifest), `attach-rebind.rsc.test.tsx` (the
  mid-connection-login → reattach → beacons-work-again flow),
  `channel-warm.rsc.test.tsx` (the session telemetry slot:
  latest-wins, no wake, no render; the warm pass: byte silence, the
  warm-vs-cold flip latency, the per-park cap, the window skip, and
  warm registrations never claiming client holdings),
  `channel-navigation.rsc.test.tsx` (url frame → whole-tree
  navigation segment with fp-skip against the mirror + the as-of on
  its `seq` entry, `__force` targets laning explicit after the
  reopen, same-origin validation + strict decode, navigation-first
  wake priority, the mid-render supersede — exactly one settled
  navigation segment — the mirror surviving navigation (held partons
  fold on the covering ack; a `dropped` delivery is evicted), the
  descendant fold excluding a nav's forced targets,
  stale-restatement idempotence),
  `channel-ws.rsc.test.tsx` (the WebSocket transport end to end over a
  REAL socket — the client `WebSocketTransport` + the server
  `driveChannelSocket`: the attach as the first text message, the
  whole-tree segment + an expiry lane tunneled down as opaque binary
  marker bytes, and an upstream envelope applied through the shared
  switch, its seq surfacing on the `applied` marker),
  `channel-webtransport.rsc.test.tsx` (the WebTransport transport over a
  FAKE duplex — the client `WebTransportTransport` + the server
  `driveChannelWebTransport`: the attach as the first newline-framed
  line, the whole-tree segment + an expiry lane tunneled down the
  readable half as opaque marker bytes, and an upstream envelope applied
  through the shared switch, its seq surfacing on the `applied` marker;
  no QUIC server, so a `TransformStream` pair + a stubbed `WebTransport`
  global stand in — the seam guarantees the tunnel is byte-identical).
- node tier: `channel-client.test.ts` (coalescing, page-lifetime seq,
  serialization, the fallback signal, pagehide detach, the cookie
  producer — a client cookie change states `cookie` frames on the open
  connection instead of tearing, and is a no-op with no connection),
  `visibility-passenger.test.ts` (the controller's statement cadence:
  measurement-only state never drives, rides driven flushes as the
  full-set report; flips and the establishment sync drive; the
  no-session fallback consumes measurement syncs without a reload),
  `channel-client-acks.test.ts` (contiguous commit watermark, the
  passenger policy + its two driving flushes — first ack, threshold
  crossing — dropped-lane attribution incl. the processed as-of
  drop and its `dropped` report on the next ack (once the watermark
  covers it), the reliable buffer's prune/retransmit assembly, the
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
  decoder), `drain-client.test.ts` (the `drain` wire entry arming the
  one-shot reattach-on-close; drain-refused closes retrying on the
  fixed cadence, never counting toward the degrade bound),
  `attach-dispatch.test.ts` (statement decoder grammar
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
  whole-tree as-of coverage, attach-with-intent latching + the
  subsume's frames fold and buffer retire),
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
