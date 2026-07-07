# The channel — one protocol for everything after first paint

Captured 2026-07-06. Status: design pinned in conversation, landing in
staged work packages (see § Landing sequence — W1 is on its branch;
the shipped surface is documented as current state in
[docs/internals/channel.md](../internals/channel.md)). Generalizes the
visibility-report pattern ([[connection-session]],
[[channel-protocol]]) into the framework's primary transport.

## The bet

Today the client talks to the server over five shapes: navigation GETs,
batched `?partials=` refetch GETs, action POSTs, visibility beacon
POSTs, and the held `?live=1` stream. Each independent request re-presents
client state (`?cached=` manifests, `?visible=` seeds, `__conn`
threading) and races the others — which is why the client layer carries
monotonic refetch seqs, the pageUrlKey stale-commit guard, deferred-abort
supersede, forced-label stripping, and the 96-token manifest cap.

The channel collapses this to two roles:

- **Upstream: the client states facts about itself.** Visibility flips
  (already shipped), page + frame URL moves, commit acks, telemetry.
  The connection session becomes the server's mirror of client state.
- **Downstream: one ordered delta stream.** The existing segment/lane
  driver, promoted from "the live special case" to the delivery path
  for everything after attach — navigation responses, refetch
  responses, lanes.

State that is re-presented per-request today is sent once at attach and
maintained by deltas. Ordering guards exist because independent HTTP
responses race; a single server-serialized downstream makes order a
property of the wire.

## The invariant

**The channel carries freshness, never semantics.** Concretely:

1. Every upstream frame is a statement of client state that could
   equally be presented on a discrete request — no frame kind may exist
   whose meaning depends on the channel being open.
2. Attach IS the discrete path: opening the channel presents the full
   client manifest (the attach body's `cached`; `?cached=` remains the
   discrete-GET form) plus
   the client's catch-up anchor (the statement's `since` — a
   reconnect whose anchor holds skips the initial segment and opens
   straight into lanes; an anchor failing its epoch/snapshot checks
   falls back to a manifest-rendered segment, over-fetch never stale).
   Reconnect, cold start, and degraded mode are the same code path at
   different frequencies: the manifest states WHAT the client holds,
   the anchor states WHEN it last heard.
3. First paint and the first interaction never wait on the channel.
   First paint stays a CDN-cacheable GET. An interaction that fires
   before attach completes falls back to a discrete request carrying
   the same frames.

This is the line between "parton over a channel" and LiveView: the
connection session is a **disposable, evidence-based mirror** —
authoritative state lives in cells (storage-backed) and in the client's
own cache. A process death loses nothing; the client reattaches
anywhere and resyncs by manifest. LiveView's assigns are authoritative
in-process state; ours never are.

## Wire shape

### Upstream envelope

One coalesced POST per batch (rAF/microtask-coalesced, like visibility
reports today), to a single framework endpoint that subsumes
`/__parton/visible`:

```
POST /__parton/channel
{ connection: string, seq: number, frames: Frame[] }
```

The endpoint enters a request context like any render request — it
resolves scope through the ALS and is the ONE place a channel
interaction can mint Set-Cookie (the held stream's headers are long
gone by the time a frame arrives). The connection id is SERVER-minted,
returned on the attach response — never a client-chosen URL param
(kills fixation and access-log leakage). Beacons are bound to the
attach credentials (Origin/Sec-Fetch-Site checks + cookie
double-check — beacons carry cookies anyway), and `url` frames are
validated same-origin server-side, not just client-side.

Reliability is explicit, not assumed: the client buffers reliable
envelopes until acknowledged and retransmits on reattach (SHIPPED in
W4 — the `reliable` producer flag, original page-lifetime seqs,
retransmit-first at establishment); application idempotence is per
frame kind, seq-ordered statement semantics (the shipped lastSeq gate
generalized per kind — never a whole-envelope replay gate, which
would break out-of-order statement queueing). The downstream carries
a cumulative "upstream seq applied" marker — the mirror image of the
client's `ack` frame — which is what prunes the buffer and what makes
`url` frames safe to send at all: a beacon's `204` is acceptance, not
delivery. The shipped kinds (visible, detach, ack) are all
loss-tolerant and skip the buffer; the machinery awaits W5's url /
cancel kinds.

Frame kinds, v1:

- `visible` — the current visibility report, unchanged in content
  (changed ids, wholesale visible set, flat cached-token array
  partitioned server-side by id prefix).
- `url` — page URL and/or per-frame URL moved. Carries the target and
  the navigation intent (push/replace/silent). The driver responds
  with a segment for the new request state, down the held stream.
- `ack` — segment/lane sequence numbers the client has COMMITTED.
  Moves the session's cached mirror from optimistic (promoted at emit)
  to evidence-based (advanced at ack). An unacked window past a
  threshold is backpressure: the driver coalesces lanes for that
  client instead of streaming ahead.
- `telemetry` — viewport size, scroll vector, timing marks. Lossy
  class (see below). First consumer: predictive chunk warming in the
  website world; second: the analytics sink apps currently buy from
  third parties.
- `cancel` — explicit cancellation of a named in-flight lane or
  producer stream (the frame long-poll supersede expressed as a frame
  instead of a connection abort).
- `detach` — explicit close (navigation to another origin, tab close
  via `keepalive` fetch).

Frames are ordered within the envelope; envelopes are ordered by `seq`
(the existing report-seq gate generalized). Two frame classes, declared
per kind: **reliable** (visible, url, ack — must apply exactly once, in
order) and **lossy** (telemetry — newest-wins, droppable). The class
distinction exists in the grammar NOW so a datagram transport can map
onto it later without a redesign.

### Downstream

Unchanged in kind: the segmented response with per-parton mux lanes and
fp/url/settled trailers. Two additions:

- Every segment/lane carries a **monotonic delivery seq** (the ack
  currency) and the **upstream seq it was rendered as-of** — the
  correlation that distinguishes pre-navigation lanes from
  post-navigation ones. The pageUrlKey guard doesn't vanish; it
  generalizes into the protocol: the client drops commits whose as-of
  seq predates its own navigation point. Server order alone is NOT
  enough — the client's URL advances at click time, ahead of the
  stream.
- Navigation segments are just segments: a `url` frame up produces a
  segment scoped to the new request state, in stream order. The
  refetch-ordering seq and deferred-abort supersede retire where the
  as-of correlation subsumes them; their discrete-mode twins survive
  in the GET fallback (one implementation, reached two ways).
- Producer-await streams (chat) do NOT fold into plain lanes: a lane
  ends at drain, a producer streams until its render resolves — and
  `markConnectionLive` is only honored in the whole-tree segment loop
  today. Frames hosting producers need a producer lane kind (or keep a
  dedicated connection); reserved in the grammar now, resolved in W5.

### Transport, v1 and later

v1 is **beacons up + held GET down**. Over H2/H3 both are streams on
one connection — per-envelope overhead is ~100–300 bytes under HPACK
and zero handshakes. Beacons are not a compromise: each carries the
browser's CURRENT `Cookie` header automatically, so cookie-varying
state stays browser-authoritative with no cookie protocol at all. A
held streaming-body POST would freeze cookies at open (and fetch
upload-streaming is Chromium-only, H2-required, `duplex: 'half'`);
WebSocket freezes them at handshake.

WebTransport (Baseline since Safari 26.4, 2026-03) is the designated
transport upgrade: true bidirectional streams plus datagrams for the
lossy class, one QUIC connection. It swaps in BEHIND the envelope
grammar; nothing above this section changes. Not scheduled — Node has
no native HTTP/3, so it waits on a terminating-proxy story.

## Pinned decisions

- **Actions stay discrete POSTs.** Set-Cookie/HttpOnly requires a
  discrete response; return values and per-action error semantics want
  HTTP's. With a channel attached the action response is ack-only
  (root suppressed, as deferred-only writes already do) and every UI
  consequence rides the stream — BUT the response carries the delivery
  seq those consequences ride, and the optimistic overlay holds until
  the client's committed seq passes it. Never cleared at returnValue
  alone: under backpressure coalescing that reopens the stale-flash
  window exactly when it matters. Writes are the request/response
  holdouts by design, not debt.
- **Degraded mode stays GET-shaped.** The discrete twin keeps
  `?cached=` + the manifest cap (CDN-cacheable, preload-compatible);
  attach is the only body-manifest request. "Attached" means
  DUPLEX-VERIFIED: a channel that has never acked once (blocked
  upstream, ad-blocked `/__parton/*` POSTs) drops to discrete — a
  half-working channel must degrade, never freeze liveness behind
  max backpressure.
- **The whole-tree reconcile survives as a scheduled pass.** Today the
  keepalive reopen cycle is the correctness backstop for lane
  relevance false-negatives; an indefinitely-lived channel would
  silently remove it. The channel makes it explicit: a periodic full
  segment (or fold audit) on the stream, cadence configurable.
- **The manifest moves to the attach body.** `?cached=` survives as
  the degraded-mode form; the 96-token cap and forced-label stripping
  go away for attached clients because the mirror is maintained by
  acks, not re-advertised.
- **Per-tab channel now.** One channel per page lifetime, as the
  heartbeat does today. SharedWorker + BroadcastChannel sharing is the
  existing IDEAS.md item, unblocked but not scheduled.
- **The 5s/20s heartbeat dance becomes channel lifecycle.** Keepalive
  stays anchored at useful activity (the zombie-connection rule);
  reattach-with-manifest replaces reopen-and-hope.
- **Telemetry ships only with its in-tree consumer** (world scroll
  warming) — no speculative analytics surface.

## Cost posture (why 100% is safe)

Measured (bench `soak` category, dev Flight, node 24): **~20KB heap
per parked connection** at the large-N asymptote — 10–50k per process
stands as the planning number. Two findings with design consequences:
**the wake-filter tax** — ~3–4.5µs CPU per connection per IRRELEVANT
bump (at 100 bumps/s × 5000 idle connections that's ~2 cores doing
nothing but filtering), so channel-primary wants relevance-indexed
wakes (wake only connections whose route can match the bump) instead
of wake-all-and-filter; and **per-wake parked-heap accretion**:
fixed — measured ≈0 B/wake (gc noise, −117…104 across the soak
scenarios) with every wake arm a disposer-registered listener behind
an entry latch; the lane-drained arm was the last promise-shaped one
(a `.then` reaction frees only at settle, and irrelevant bumps re-arm
inside one park — ~500B/wake while it stood).
W4's own delivery bookkeeping stays O(1) per wake (per-delivery
token records die at ack or connection close, bounded by the unacked
window). The dominant per-connection cost is OUR mirror (visible set +
cached tokens — world-page clients plausibly 100KB+), so the mirror is
what gets capped and measured: the bench gains a `soak` category
(N idle connections + M active lanes → RSS/CPU per connection) before
the channel becomes primary. The mirror is BOTH optimistic and
evidence-based, not either/or: an optimistic skip-set (emit-time, so a
same-parton re-lane within one RTT still skips) over an acked recovery
watermark (what reattach can trust). Acks report what the client
GAINED, never what it evicted — the flip-time cached-token replacement
survives as the eviction evidence. The soak bench explicitly targets
the two unbounded-growth paths found in review: per-id override growth
in the promote path, and server-side enqueue buffering for slow
readers. Deployment commits to long-lived sticky
processes — acceptable for the audience; serverless-per-request is
explicitly not a target. The multi-instance fan-out bus (a cell write
on process A waking a lane held by process B) is REQUIRED for
multi-process production and is a separate design note — out of scope
here, named so nothing below pretends otherwise.

## What retires, what remains

Retires with the channel primary: `?cached=` re-advertisement + cap +
forced-label stripping (attached clients), refetch-ordering seq +
pageUrlKey guard + deferred-abort supersede (subsumed by stream order),
`__conn` URL threading (the channel is the session), the visibility
fallback self-refetch (`?__cullFlip=1` — already reduced to cull-INs
only; cull-outs are purely local skeleton swaps), and emit-time mirror
promotion — both families: `promoteSnapshotsToCachedOverride` and
`promoteFpUpdatesToCachedOverride` (replaced by acks).

Remains, permanently: cold-start GET (CDN), action POSTs, the attach
request itself, the GET-shaped discrete fallback with every retired
guard's twin, and the pageUrlKey idea itself — generalized into the
as-of correlation seq rather than deleted.

## Landing sequence

Each package is a worktree branch, lands green (`yarn test` +
`yarn test:e2e`), docs ride along, one merge per package.

- **W1 — envelope + endpoint.** The upstream grammar, `/__parton/channel`,
  client-side frame coalescing/seq, visibility migrated onto it as the
  first frame kind (`/__parton/visible` folds in). Pure generalization
  of shipped behavior; no semantic change. LANDED — endpoint +
  hardening (origin, scope/cookie attach binding), the server-minted
  id handshake (the `conn` marker), `detach`, and the ChannelClient
  transport: [docs/internals/channel.md](../internals/channel.md).
  `__conn` URL threading retired here, ahead of the § What retires
  schedule.
- **W2 — attach manifest.** Manifest in the attach body; mirror seeded
  at attach; `?cached=` kept for discrete mode. Absorbs the `?since`
  anchor: manifest and anchor travel together as one attach statement —
  one catch-up mechanism, not two. LANDED — the attach POST
  (`x-parton-attach` on the page's `_.rsc` URL, body
  `{cached, since, visible}`; dispatch by marker, never body shape),
  statement-first reads in the segment driver + PartialRoot, the
  uncapped-body / capped-URL manifest split, the anchor made
  attach-only (`?since=` retired from every param list), and the
  attach as the explicit session-identity rebind point:
  [docs/internals/channel.md](../internals/channel.md) §The attach.
- **W3 — bench soak.** The connection-cost scenario, independent of
  W1/W2, numbers before the channel becomes primary.
- **W4 — acks + evidence-based mirror + backpressure.** Delivery seqs
  downstream, `ack` frames upstream, mirror advances on ack, lane
  coalescing for lagging clients. Kills the torn-connection/zombie
  class with a real signal. LANDED — per-connection delivery seqs on
  every payload segment and lane (`seq` entries, recorded at COMMIT,
  acked as a contiguous cumulative watermark), the `ack` frame + the
  downstream `applied` marker (page-lifetime envelope seqs; the
  attach statement's `applied` field seeds the session's gate), the
  layered mirror (optimistic emit-time skip-set over the
  client-proven ACKED layer; flip-statement tokens supersede both —
  the eviction evidence), the two-signal lane-opening gate
  (desiredSize pull-gate + the unacked delivery window, dirty-set
  coalescing on window-free), the never-acked degrade (server:
  deadline anchored at first delivered-settle, session notes the
  reason, driver stops holding; client: sticky page degrade on a
  failed first ack → the heartbeat's periodic discrete reloads), the
  scheduled whole-tree reconcile on long-lived lanes connections, and
  the reliable-class buffer + retransmit-on-reattach machinery
  awaiting W5's frames:
  [docs/internals/channel.md](../internals/channel.md) §Delivery is
  evidenced.
- **W5 — navigation + refetch over the channel.** `url` frames,
  navigation segments in stream order, discrete path refactored to the
  short-lived channel, subsumed client guards retired. The largest and
  last-risk package; starts only after W1+W4 are on master.
- **W6 — telemetry + world consumer.** Lossy frames, scroll-vector
  warming in the website world. LANDED (ahead of W5 — the two don't
  touch) — the `telemetry` frame kind + strict decoder, the lossy
  producer (`reportTelemetry` in `telemetry.ts`: newest-wins, rides
  envelopes other statements justify, drop on fail, never buffered),
  the session's latest-wins telemetry slot (NO wake, NO invalidation
  — context, not a dependency), and the segment driver's predictive
  warm pass at park (app-registered projector via
  `registerWarmProjector`; byte-silent nested warm scope; one
  projection per statement; `MAX_WARM_PER_PARK` bound;
  window-skipping; never keepalive activity) with the world's chunk
  warming as the in-tree consumer (scroller telemetry → swept-box
  projection → chunk byte-cache):
  [docs/internals/channel.md](../internals/channel.md) §Telemetry,
  [docs/internals/streaming.md](../internals/streaming.md)
  §Predictive warming at park. Measured effect: a warmed flip-in
  lane replays in ~3ms where the same parton's cold lane pays its
  full body (~127ms at a 120ms body) —
  `channel-warm.rsc.test.tsx`.
- **Docs sweep** rides each package. The prior-art LiveView rewrite
  landed with W6: state authority + degradation + wire/cache model
  replaced the per-request-HTTP contrast
  ([docs/reference/prior-art.md](../reference/prior-art.md) §Adjacent
  server + collaborative systems).

## Open questions

- ~~Backpressure threshold and coalescing policy~~ — RESOLVED in W4:
  SKIP intermediate lane renders (never render-and-drop) — cells
  carry state, not events, so one render of the latest value at
  window-free supersedes every skipped intermediate. Threshold
  `UNACKED_DELIVERY_WINDOW = 64`, sized against the W3 soak numbers
  (rationale at the constant in `segmented-response.ts`).
- Whether the frame long-poll supersede
  survives W5 or folds into the same stream-order argument.
- e2e scope isolation: resolved by the shipped pattern — upstream
  POSTs thread no scope (they run before the request ALS); isolation
  is the globally-unique connection id, and scope resolves only on the
  held downstream GET. The channel endpoint keeps exactly that shape.
- ~~The attach anchor vs acks~~ — RESOLVED in W4, as shipped fact:
  the three timeline statements never compete because they bound
  different things. The anchor (`since`) bounds the DOWNSTREAM resync
  window — what the initial segment must cover (honored: lanes-first;
  refused: full render). Delivery acks bound the MIRROR — which fps
  are client-proven holdings; the acked layer resets with the
  connection and reattach seeds the mirror from the attach manifest
  alone (the manifest is the durable evidence, so acks never become a
  second resync path). The `applied` watermark anchors the UPSTREAM
  envelope timeline — what the marker may assume already announced —
  and all three ride one attach statement.
- Multi-instance bus: separate note, blocking for multi-process
  production, not for this sequence.
- RemoteFrame under channel-primary: a nav segment containing a
  `<RemoteFrame>` settles only after the remote's trailer
  (deferCommitUntil) — third-party origin latency lands on the shared
  stream's supersede gate; remote invalidation never wakes the host
  driver (zero freshness once the reopen backstop retires); remote fps
  shift wholesale on a remote deploy, outside the host's epoch checks.
  Needs its own section before W5.
- HMR: registry-epoch change must PUSH a detach/reattach to open
  channels (`_registryEpoch` exists; nothing pushes it) — the 20s
  self-heal cycle retires with the heartbeat dance. The
  connection-session map also needs an HMR guard (module re-eval
  orphans live sessions today).
- Two URL writers: server-initiated `url` trailers (action POSTs) vs
  client `url` frames are unordered writers of the same state — server
  pushes need delivery seqs and a precedence rule.
- Wake priority: where queued `url` frames sit relative to pending
  flips and bump wakes. Position to defend: nav-first; old-route flip
  lanes then defer against the new routeKey (harmless, but say it).
- ~~Telemetry v1 cost honesty~~ — RESOLVED in W6, stated as shipped
  fact in [docs/internals/channel.md](../internals/channel.md)
  §Telemetry: a telemetry-only envelope body is ~200 B against
  ~430 B of fixed headers plus the full Cookie header — ~0.8 KB per
  beacon on a lean page, **~3.5–4.5 KB (>90 % cookie) under a
  consent-laden commerce cookie jar**. Contained in v1 by never
  letting telemetry justify an envelope alone (it rides flushes
  other statements schedule); the datagram transport class is the
  designated fix.
