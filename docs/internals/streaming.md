# Streaming + live updates

How the framework's live-update path is shaped — what the segment
driver does, what the `expires()` wake hint means, and how the opt-in
heartbeat keeps a streaming connection alive.

## The render loop is top-down by design

Every server render walks the full route tree top-down. The server
re-renders **the whole world** for every segment of a streaming
response, and the fp-skip cascade does the pruning:

- Each parton computes
  `fp = hash(id|matchKey|vary|schema|props|inv|deps)` folded with
  its frame URL and the descendant fold (see
  [`render-pipeline.md`](./render-pipeline.md) §Fingerprint
  protocol).
- If the client sent that fp in `?cached=`, the parton emits an
  `<i hidden data-partial-id>` placeholder and never runs its
  Render body. Anything inside the parton is collapsed to one
  cheap byte.
- The descendant-fold means an ancestor's fp moves whenever any
  descendant's deps would have moved, so fp-skipping the ancestor
  never serves a stale subtree.

The result: a "full-page re-render" while nothing has changed costs
~zero wire bytes. The cascade is the optimization; the framework
doesn't need to know which subtree changed.

This is the same shape as React's client-side render: every state
change re-renders the whole component tree, and reconciliation finds
the diff. The server does the same thing, with fp-skip playing the
reconciliation role at the wire boundary.

**Don't try to narrow live updates with a selector.** A heartbeat
that asks for `?selector=cell:*` adds invalidation-routing
machinery (which labels? what about `refreshSelector("page-block")`
from a CMS edit?) to save work the cascade already saves. Profile
before optimizing — in practice the fp-skip cascade is faster than
any selector-routing logic that could replace it.

## How a live update lands

1. **A parton declares a freshness boundary via `expires()`**
   (time-based) or **resolves a cell** — `cell.resolve()` in its body
   or a cell-bearing prop (write-driven via
   `refreshSelector("cell:<id>")`).
2. **The browser bootstrap mounts `<LivePageHeartbeat />`** near
   the React root (`bootBrowser()` in `framework/src/entry/browser.tsx`). After hydration it holds a `?live=1`
   long-poll open against the current URL (it fires
   `reload({streaming: true, live: true, attach})` — `live` is what
   holds the connection open; `streaming` only sets the client commit
   mode). Each fire is an ATTACH: a POST whose body carries the full
   client statement — the uncapped manifest, the catch-up anchor, the
   current viewport seed, and the upstream-applied watermark
   ([`channel.md`](./channel.md) §The
   attach); the SERVER mints the fire's **connection id** at session open
   and ships it down as the stream's `conn` entry (see
   §Visibility rides the connection and
   [`channel.md`](./channel.md)). On a DEGRADED channel
   (`_channelIsDegraded()` — the page's first delivery ack could
   never be delivered upstream) the heartbeat stops attaching: each
   interval tick fires a one-shot discrete reload instead — periodic
   polling at the heartbeat's own cadence
   ([`channel.md`](./channel.md) §The never-acked degrade).
3. **Server-side segment driver runs.** For each rendered segment,
   it races the wake arms:
   - `_onNextBump` — a `refreshSelector` lands (CRUD writes,
     `cell.set`, server-action invalidations) **that is relevant to
     this route**: it matches a rendered partial's labels +
     constraint args (match params ∪ bound cell args)
     (`_routeHasMatchingBump`, see `segment-relevance.ts`). A bump for
     a different partition (another viewer's `cartId`, another
     session's cell) re-arms the wait WITHOUT re-rendering — so one
     viewer's write doesn't wake every open stream into a fp-skip
     pass. The wake itself is global (`_onNextBump` fires on any
     bump); the relevance check is what gates the re-render.

     Every park's arms observe per-park state and release on wake —
     the **wake-arm release invariant**: wake arms are
     disposer-registered listeners with entry latches, never `.then`
     reactions on a promise that outlives one race iteration. A
     reaction only frees when its promise settles, and an irrelevant
     bump re-arms the race WITHIN one park — so a promise-shaped arm
     on long-lived state (the registry's waiter set, the session's
     `flipWakes`, the lane driver's drain wakes) accretes one
     reaction, retaining its whole wake race, per idle wake for as
     long as the connection holds. `waitForSegmentWake` builds one
     deferred per race iteration and disposes every registration
     when it settles; the lane driver's drain signal and the
     session's flip signal are latch + listener set, the latch
     re-checked at each iteration's entry so a signal that raced a
     losing arm is consumed, not starved.
   - Expiry arm — the earliest `expires()` boundary among the
     route's snapshots (read through `effectiveExpiresAt`) elapses.
   - Visibility arm (lane driver only) — a channel envelope's
     `visible` frame lands on the connection session, naming flipped
     parton ids ([`channel.md`](./channel.md)). The same listener-set
     arm carries every session-state wake: a delivery `ack` freeing
     the unacked window, an applied-watermark advance to announce,
     and a `url` frame latching — which outranks every other latch at
     wait entry: the driver tears open lanes, applies the statement's
     URL to the connection's request state, and answers with a
     whole-tree navigation segment before anything else runs
     ([`channel.md`](./channel.md) §Navigation rides the channel).
   - Never-acked degrade arm (lane driver only) — a timer anchored at
     the connection's first delivered-settle while its first ack is
     outstanding; on firing, the session notes
     `degradedReason: "never-acked"` and the driver stops holding
     ([`channel.md`](./channel.md) §The never-acked degrade).
   - Idle timeout (~20s) — the connection closes cleanly. The
     heartbeat's next interval tick (~5s default) reopens. In the
     lane loop the deadline is anchored at the last USEFUL activity
     (a lane started, a flip processed), not re-armed per wake: bump
     wakes whose touched set comes up empty (all matches parked)
     ship nothing, and a torn connection is only detectable at
     enqueue time — a per-wake re-arm would let steady bump traffic
     hold a fully-parked, possibly torn connection open forever,
     each wake re-scanning the route (zombie connections accumulate
     one per refresh and peg the server).
4. **On a relevant bump, an expiry boundary, or a visibility flip,
   the driver renders per-parton lanes.** The wake resolves WHICH
   snapshot ids it touched (`_routeMatchingBumpIds` for bumps;
   the due-expiry set for time wakes; the statement's `changed` ids
   for visibility flips), and each touched parton
   renders in isolation through the snapshot-reconstruction path a
   `?partials=` refetch uses (`partialFromSnapshot` →
   `renderToReadableStream`). Each render's bytes frame as an
   independent `mux` lane (`driveLaneStream` in
   `segmented-response.ts`), interleaved as the renders produce them —
   a fast parton's lane closes on the wire while a slow sibling's
   render is still suspended, so no update waits on the slowest
   Suspense boundary. One lane per parton id at a time: a wake that
   touches an open lane marks it dirty and the pump re-renders on
   drain. Ancestors never re-run, and each lane's fp trailer is scoped
   to the lane's OWN subtree (`flushScopeId` on
   `wrapStreamWithFpTrailer`): a snapshot's `emittedFp` only advances
   when it re-renders, so an unscoped flush fold would re-detect —
   and re-ship — the whole route's standing cold→warm drift on every
   lane frame (multi-KB fp payloads duplicated per frame, O(route)
   hashing per frame on a many-parton route). Ancestor fold drift is
   NOT healed on lanes — an honest ancestor fold needs every
   descendant's contribution, a route-wide pass — it rides the next
   whole-tree segment; until then the ancestor over-fetches on its
   next render, never serves stale.

   **Parked partons don't lane.** Bump and expiry wakes drop ids whose
   own snapshot, or a cullable ancestor's, is outside the session's
   measured visible set (`isParkedOnConnection` — the same
   `visible:<id>?seed=…` gate dep + session-set signal the cull gate
   reads). A
   parked parton's client copy is a hidden Activity slot
   (cull-to-park); lanes at it ship bytes nobody sees, and since
   route snapshots persist for everything ever rendered, a held
   connection would otherwise lane-render every parton the client
   ever scrolled past at full invalidation rate, forever. A parked
   parton's due `expiresAt` is likewise excluded from the expiry arm
   (arming on a deadline that never lanes would hot-spin the wake
   loop). Staleness is impossible: the flip-in revalidation's fp
   folds every bump that landed while parked, so it re-renders fresh
   — it can only miss, never false-match. Visibility flips bypass
   the skip: they ARE the state transition. An unmeasured session
   (`visible: null`) parks nothing.

   **Output is pull-gated.** `createSegmentedResponse` (the entry's
   wrapper around `driveSegmentedResponse`) wires the response
   stream's own `pull` / `cancel` callbacks as the driver's demand
   signal (`SegmentedResponseDemand`): while the consumer's queue is
   full (`desiredSize <= 0`) every renderer-output enqueue — segment
   bytes and lane frames alike — parks until the next pull, and not
   reading the next chunk propagates the wait into the Flight
   stream itself, so a stalled reader holds at most one frame per
   open lane server-side instead of every wake's payload for the
   connection's lifetime. Wakes still fire while gated; they
   coalesce on the open lane's dirty flag. A cancel (the consumer
   tearing the stream — the explicit no-pull-is-coming signal)
   releases parked pumps and marks the connection closed; the wake
   loop's exit likewise releases them, tearing only lanes whose
   consumer stopped pulling (client-safe: a torn lane rejects only
   its own un-committed decode).

   **Lane OPENING gates on the unacked delivery window too** — the
   second backpressure signal, catching what `desiredSize` can't see
   (bytes the kernel swallowed that the client never committed).
   Window exceeded → touched ids coalesce into a dirty set and render
   their latest state when a delivery ack frees it — correct for
   cells (state, not events), nothing dropped. See
   [`channel.md`](./channel.md) §Backpressure.
5. **The client demuxes and commits per lane.** The splitter
   (`splitSegments`) classifies the region off the server's `lanes`
   marker and yields each lane's body — itself shaped like a
   one-segment fp-trailer stream. The browser entry decodes each lane
   independently (`splitAtFpTrailer` + `createFromReadableStream`,
   successive lanes for the same parton chained in arrival order) and
   hands the subtree to `_commitPartonLane`: a synchronous cache walk
   (wrapper + nested entries + fingerprints), the lane's fp updates,
   then a notify that schedules a `startTransition` re-render of
   `PartialsClient` — `renderTemplate` / `substituteNested` swap the
   fresh subtree in place. No whole-payload `setPayload` is involved,
   so a lane commit can never remount the page shell. The commit is
   also the moment the delivery seq the emission carried is RECORDED
   — the channel transport acks the contiguous commit watermark
   upstream ([`channel.md`](./channel.md) §Delivery is evidenced).

Relevance false-negatives (a dependency the label/constraint surface
doesn't capture) degrade to a MISSED update on the lane path, where
the old whole-tree path degraded to a wasted re-render. Two backstops
cover the two connection lifetimes: an IDLE connection closes after
~20s (keepalive), the heartbeat reopens it, and the reopened
connection's first segment is always whole-tree; a connection that
steady relevant wakes keep alive indefinitely emits a scheduled
whole-tree reconcile segment ON its own stream instead —
`RECONCILE_INTERVAL_MS`, anchored at the last full segment, evaluated
at wakes ([`channel.md`](./channel.md) §The whole-tree reconcile).
Either way, a full fp-skip pass reconciles anything the lanes missed.

## Writes stay non-streaming

Server functions complete with a one-shot response (no `?live=1` on
their URL). Their bodies call `cell.set` (batched in `atomic()`) /
`refreshSelector` / `getServerNavigation().reload({selector})`, which
bumps the **already-open** heartbeat stream. The segment driver
wakes, the next segment renders, the changed partial's fp moves, the
bytes ship. The heartbeat is the one connection a write ever needs.

A frame refetch, though, CAN open a second connection: the chat
overlay's frame nav renders a `markConnectionLive` sentinel, so that
targeted (cache-mode) refetch holds open and streams alongside the
heartbeat's `?live=1` connection. Two live connections then commit
onto the same React root. That's safe only because every payload —
cache or streaming — carries the identical
`<PageUrlProvider><PartialsClient>` root; otherwise the alternating
commits would remount the whole page on each seam. See
[`render-pipeline.md`](./render-pipeline.md) ("Both modes share one
payload root").

## `streaming` vs `live` — two orthogonal flags

A held-open connection is gated only on the request being a live
subscription. There are two URL flags, and conflating them is a bug:

- **`?streaming=1`** (`reload/navigate({streaming: true})`) is a
  CLIENT commit-mode switch. `true` commits each segment
  progressively (`setPayloadRaw` — Suspense fallbacks, per-chunk
  reveal); `false` swaps atomically inside a transition. It has **no**
  server effect — it does not hold the connection open.
- **`?live=1`** (`reload({live: true})`) is the SERVER hold-open
  subscription. The segment driver parks the connection for the
  keepalive and pushes a fresh segment on every route-relevant bump /
  `expires()` boundary. Only `<LivePageHeartbeat>` sets it.

So the segment driver holds a response open iff `?live=1` **or** a
render called `markConnectionLive()`. A targeted
`reload({selector, streaming: true})` (a search keystroke, a
"refetch this card" button) is a one-shot: it commits its segment
progressively and the connection closes. It does **not** park for the
keepalive — a one-shot refetch that held open would pin any
`committed && !finished` spinner in its loading state for the full
20s.

The two subscription kinds emit differently after their first
segment. A `?live=1` subscription switches to per-parton lanes (its
wakes are relevance-matched bumps / `expires()` boundaries, which
name the partons to render). A `markConnectionLive()` subscription
(the chat's `ChunkSlot`) stays whole-tree: its next content comes
from the render itself resolving a producer await, not from a bump,
so there is nothing for a lane to key on — and inside a `?live=1`
lane render, `markConnectionLive()` is not honored for the same
reason.

## Deferred (stream-only) writes

A normal action POST still carries a re-render: the changed partials'
bytes come back on the response and the client commits them, *and* the
bump wakes the heartbeat which ships the same change to every other
viewer. For a write whose only job is to broadcast — a cursor / scroll /
presence firehose — the POST-side render is pure duplication of what the
heartbeat already delivers, and committing it back over the writer's
optimistic/local view costs a reconcile per keystroke.

A cell declared [`deferred: true`](../reference/cells.md#deferred-stream-only-writes)
opts its writes out of the POST-side commit. The wire mechanics are a
null root:

1. **Server accounting.** `writeOneCell` calls `_recordCellWrite(cell.deferred)`
   on every write; `_actionSuppressesCommit()` is true when the request
   made at least one cell write and **every** write was to a deferred
   cell (a mixed batch is false — the non-deferred cell still needs its
   render). Both live on the request-scoped store in `context.ts`.
2. **Null-root response.** The framework's RSC handler
   (`createRscHandler` in `framework/src/entry/rsc.tsx`) builds the action payload
   as `root: isAction && actionStatus === undefined && _actionSuppressesCommit() ? null : <Root/>`.
   A suppressed action renders no tree — the POST body is just the
   `returnValue`. Errored actions (`actionStatus` set) always render so
   the failure surfaces.
3. **Client skip-commit.** `setServerCallback` still captures
   `returnValue` (so the `cell.set` promise resolves and the optimistic
   overlay reconciles) but guards the commit: `if (payload.root != null)
   setPayload(payload)`. A null root is never committable — committing
   it would blank the page — so the guard is safe for every action, not
   just deferred ones.

The bump itself is unchanged: it lands in the invalidation registry
exactly as a non-deferred write's would, so the **already-open
heartbeat** wakes on it (relevance-gated like any other), re-renders,
and ships the new value as the next segment — to the writer and every
other viewer alike. The asymmetry is the point: the write goes up on a
cheap one-shot POST, the value comes down on the shared stream.

Storage caveat: a deferred cell must use storage visible across
connections (the write POST and a viewer's heartbeat are different
connections). Default `localCell` storage is process-global; the
request-scoped `getEphemeralCellStorage` is **not** a valid pairing —
the write would never reach another connection's render.

## Visibility rides the connection

View culling (the `cull` gate, [`partial.md`](../reference/partial.md)
§View culling) is the same up-cheap/down-stream asymmetry as deferred
writes, applied to a request dimension that moves while a connection
is open. A viewport flip is not a data write — it changes what the
CONNECTION should be rendering — so with a live stream open it must
not fire a second render channel (a `reload({selector})`) that races
the stream's own renders for the same partons: two channels, double
bytes, commit contention.

The pieces:

- **Connection sessions** (`lib/connection-session.ts`). A `?live=1`
  request gets a server-side session opened by the segment driver
  before its first segment renders — under a SERVER-MINTED id the
  stream ships down as its `conn` entry (the establishment
  handshake; see [`channel.md`](./channel.md)) — and closed when the
  drive loop exits. The session holds the connection's current
  **visible set**, seeded from the attach statement's `visible`
  (`null` when unmeasured; a statement-less in-process live GET seeds
  from `?visible=`) and stamped onto
  the request ALS store for the connection's lifetime, plus the
  attach's scope + session identity (what every channel envelope
  must re-present — rebound fresh by every attach). The store is
  `globalThis`-backed so it survives
  dev-server module re-evaluation: the held driver keeps the store
  it opened its session in while the channel endpoint resolves the
  module fresh per edit — both must address the same map, or every
  envelope 404s until the heartbeat's next reopen.
- **The `visible` frame** (`lib/channel-protocol.ts`, on
  `POST /__parton/channel` envelopes — endpoint mechanics, security
  checks, and the other frame kinds live in
  [`channel.md`](./channel.md)). The client's visibility controller
  states flips as `{changed, visible, cached}`; the server applies
  the statement to the session and answers `204` with no body — the
  flipped partons' bytes come down the live stream as lane segments,
  never on this response. Each `changed` id queues as a pending flip
  carrying the frame's OWN statement about it — the id's presence in
  THAT frame's `visible` snapshot (present = in-flip, absent =
  out-flip). The statement, not the latest set, is what the flip
  resolves against: a snapshot's id-absence without a `changed`
  entry is not testimony (the controller drops mid-swap nodes from
  `inView` without flipping them — `reportGone` — so a burst's later
  snapshot legitimately dips below an earlier in-flip), and the
  client states each flip exactly once, so resolving an in-flip
  against a later dip would drop it forever. The envelope `seq` is a
  page-lifetime-monotonic counter ([`channel.md`](./channel.md)
  §Wire shape): the session applies `visible`
  only from statements at or past the last applied (two in-flight
  envelopes can't commit an older set over a newer one) while
  `changed` ids still queue regardless — a superseded statement's
  flips still get their resolution, and per id the statement with
  the highest seq stands (only an explicit later out-flip cancels a
  pending in-flip). `cached` rides ON the statement: the client's
  CURRENT `id:matchKey:fp` tokens for the changed ids — its actual
  holdings at flip time, which the driver swaps into the
  connection's cached override before each direct flip's lane
  renders. `404` means "no such connection" — the explicit signal
  for the transport to clear its published id and for that batch
  (and everything until the heartbeat re-establishes) to ride the
  render-reload fallback.
- **The visibility wake.** The lane driver races the session's flip
  wakes alongside the bump/expiry/keepalive arms. On a flip wake
  it drains the session's pending statements; only in-flips lane
  (through the same `partialFromSnapshot` path bump lanes use) — a
  cull-OUT is complete on the client the moment it happens (the pair
  swaps to its inline skeleton; no server bytes exist for a culled
  state), so an out-flip's entire server effect is the session-set
  update the statement already applied. Before an in-flip's lane
  renders, the session set LEARNS its id when the latest snapshot
  dipped below it (a wholesale replacement, never an in-place
  mutation): the lane's cull gate reads the session set, the lane
  ships the in-state, and the client's pair re-primes its controller
  from that emission — so the connection's knowledge for the id is
  "in view". The next statement still replaces the set wholesale.
  Flip-in lane
  renders carry a request state backed by the connection's cached
  override, so a flip may FP-SKIP: a skip is the zero-byte
  confirmation that the client's parked copy is current (see
  [render-pipeline.md](./render-pipeline.md#cull-to-park)). The
  verdict is computed against
  the client's ACTUAL holdings — a direct flip's stated `cached`
  tokens replace the override's entries for the id first (the
  additive override alone drifts from the client: prunes, evictions,
  slot overwrites — and confirming a phantom copy would blank the
  parton); a deferred flip keeps the override as promoted, since the
  materializing render's just-promoted fps are exactly what the
  client's slot received. Per-lane fp-trailers also fold their warm
  fps back into the override (`onUpdates`), so a drift between a
  lane's render and its flush stays tracked. Every promotion path
  bounds the override's per-id fp/matchKey sets at `OVERRIDE_SET_CAP`
  (8), oldest-first — the server-side mirror of the client's
  `FP_CAP_PER_VARIANT`: a parton drifting every lane would otherwise
  grow its sets for the connection's whole lifetime, and an evicted
  entry only costs an over-fetch, never staleness. Lanes start in statement order — the
  controller sends in-view flips before cull-outs, so the visible
  world's renders lead. A flip whose id has NO route snapshot yet
  (the statement raced the render that first materializes its parton
  — a chunk reported in-view while its container's flip-in lane is
  still streaming) is DEFERRED, never dropped: the client states
  each flip exactly once, so a drop would leave the parton stale
  until the next whole-tree reconciliation. Deferred ids re-resolve
  on every subsequent wake (the materializing lane's drain is itself
  a wake) and never arm one, so an id that never materializes can't
  busy-loop the driver. Each deferred entry keeps its statement's
  seq: only a NEWER statement about the id supersedes it — an
  explicit out-flip cancels the wait, a fresh in-flip re-arms it
  with fresh cached tokens.
- **The read stays request-reproducible.** The cull gate and the fp
  fold's store-and-reread both resolve through one function
  (`readVisible` in `server-hooks.ts`): the connection session's set
  first, the request's `?visible=` URL param as the no-session
  fallback. The session's set IS part of the connection's request
  state — updated only by statements, and every update arrives with
  an explicit wake naming the ids it flipped, so a set change can
  never leave a rendered parton stale (the tracking invariant holds:
  the read is a function of connection state the framework
  invalidates on, not of untracked nondeterminism). The fp-trailer's
  flush recompute reads the same set, so hook read and fold agree.

Client-side transport selection lives in the controller
(`lib/visibility.tsx`): the baseline per id is the DISPLAYED state —
each `CullPair` primes it on mount with its emission's `culled` prop,
which the controller overlays with any live report for the id (the
same `reported ?? culled` precedence the pair's own display uses;
a restored parked subtree re-mounts pairs whose emissions predate
their cull-outs, and a raw-prop prime would poison the baseline so
the observer's genuine flip against the showing skeleton reads as a
no-delta duplicate and never dispatches) — so a first measurement
that agrees with what's actually shown dispatches nothing, and
priming is inert once an id has a real report. The controller is the
channel's first PRODUCER (`lib/channel-client.ts` — see
[`channel.md`](./channel.md)): real deltas schedule a transport
flush (rAF-coalesced, one dispatch in flight), ordered
viewport-first on both paths (in-view flips outrank stale cull-outs
— across batches, since the cap slices in-view first, and within one
dispatch). Only deltas and the once-per-establishment sync drive a
flush; measurement-only state is a PASSENGER on the next driven
envelope (the ack-cadence rule — see the newly-measured sync below). At flush time, `collect` receiving the open connection's
id contributes ONE `visible` frame (cap 256; ids ride the envelope's
JSON body, so no request-line limit); receiving `null` runs the
one-shot `reload({selector, params: {visible}})` fallback for the
flipped-IN ids only (cap 48, the `?partials=` request-line bound;
cull-outs are local — the inline skeleton — and have no server
effect without a session). The connection id is SERVER-minted and
established by the stream's `conn` entry as it is read (the wire
hook in `entry/browser.tsx` → `_channelEstablished`); the transport
clears it when the connection settles or an envelope's delivery
fails. Three seams keep the set in sync across the connection's
lifecycle:

- **The seed.** Each attach states the controller's current set as
  the statement's `visible` (`null` while unmeasured), so a REOPENED
  connection's whole-tree first segment renders against the measured
  viewport instead of the cold anchor seed — without it, every
  reopen would clobber flip-committed content back to the anchor
  state. (`?visible=` remains the URL carrier for the discrete
  no-session reload fallback.)
- **The first-measurement sync.** The controller's establishment
  listener arms a full-set statement (`changed: []`) at the first
  viewport measurement — whichever side of the connection's
  establishment it lands on — so a connection established before
  hydration finished measuring still learns the set. The sync DRIVES
  a flush of its own: the gap it closes can cover partons the user is
  looking at (flips that rode the reload fallback between the seed
  and establishment), and nothing else is guaranteed to flush after
  establishment (a catch-up attach on a quiet route may never commit
  a delivery). Once per establishment, so the cost is one envelope
  per connection.
- **The newly-measured sync.** A first measurement for an id the
  session has never heard of (late-adopting subtrees measure after
  the seed and any earlier sync) marks the statement due even when
  it AGREES with the primed display state — without it the session
  would park every late-measuring parton for the connection's life.
  Unlike the establishment sync it is a PASSENGER: it requests no
  flush, riding the next driven envelope (a flip, a threshold ack)
  as the full-set report. An agreeing measurement has zero urgency —
  an out-agreement's absence from the session set already parks it
  correctly, an in-agreement only lags its live lane cadence, and
  the next attach's seed is the durable re-establisher (the
  loss-tolerant class). During a scroll, lane commits mount fresh
  skeletons every frame — a flush per agreeing wave would be one
  cookie-laden `changed: []` POST per frame.
- **Only measured nodes testify.** Three rules keep the observer's
  evidence honest across content transitions
  (`VisibilityObserver` in `lib/visibility.tsx`, `CullPair` in
  `lib/cull-pair.tsx`):
  - An IO callback whose pruned node set is EMPTY reports nothing —
    zero connected nodes means the parton is mid-swap (a flip lane's
    commit disconnects the old body before the new one reports), not
    "out". Reporting "out" on no evidence starts a flip loop: out →
    cull lane → placeholder commits → intersects → "in" → content
    lane → swap → transient empty → "out" → … at rAF rate,
    remounting the subtree and re-shipping its body every cycle.
  - The content slot's observer mounts only over REAL content. An
    unbacked slot renders the bare `<i data-partial>` hole — a
    CONNECTED zero-size node, so the empty-set rule can't catch it —
    and an observer over it testifies "out" for a parton squarely in
    view, flipping it right back out: the same loop at lane rate.
    While content is missing, the skeleton slot is showing and its
    observer is the parton's testimony.
  - An observer attached while its fragment had NO host children
    (dehydrated nested boundaries on a fast prod hydration,
    unresolved Flight lazies) re-attaches when content arrives —
    `_sweepEmptyVisibilityObservers()`, run on the framework's
    content-arrival signals: a cullable boundary's observer mounting
    and every `PartialsClient` commit. React's `FragmentInstance`
    attaches observers to later PLACEMENTS on its own, but not to
    hydration ADOPTIONS — without the sweep, such a parton never
    reports, the session's set never contains it, and everything the
    server parks behind it stays parked (the world's
    frozen-after-refresh bug: the seed quad tiles hydrate exactly
    like this). Covered by
    `visibility-late-content.browser.test.tsx` (real Chromium,
    red without the sweep).

When no live connection is open (heartbeat disabled, or between
keepalive close and the next fire), the reload fallback is the whole
story — one-shot renders whose `?visible=` param the hook reads
directly. Verified end to end by
`framework/src/lib/__tests__/connection-visibility.rsc.test.tsx` (the
in-process drive) and the product-browse e2e specs (the fallback
path).

## Predictive warming at park

The lane driver's one speculative move: when it is about to park and
the session holds a telemetry statement it has not yet projected
(`ConnectionSession.telemetry` — the channel's lossy frame,
[`channel.md`](./channel.md) §Telemetry), it hands the statement plus
the route's PARKED cullable partons (`isParkedOnConnection`) to the
app-registered projector (`registerWarmProjector`,
`lib/warm-projection.ts`) and renders the returned ids into the
server byte-cache — so the next real flip-in's lane replays warm
bytes instead of running a cold subtree
(`framework/src/lib/segmented-response.ts::warmProjectedPartons`).
The geometry — horizon, velocity judgment, coordinate math — is the
app's; the framework owns only the mechanism and its hard edges:

- **Byte-silent.** Each warm render runs inside a nested warm scope
  (`_runWithWarmRenderScope`) that presents the target id as visible
  WITHOUT touching the connection's real session, carries no cached
  override and a fresh empty partial state (never fp-skips, never
  touches the mirror), mints no delivery seq, and drains into the
  void. The only durable effects are the byte-cache entry and the
  parton's re-registered content snapshot.
- **One projection per statement.** The statement's envelope seq is
  the dedup key — re-parking on the same statement projects nothing;
  the seq latch (`pendingWarmStatement`) also catches a statement
  that landed while the driver was busy, the same shape as
  `pendingFlips`. No await sits between the wait-entry latch checks
  and the wake arms (an envelope can only land at an await point), so
  no statement slips between a checked latch and an armed listener.
- **Bounded and preemptible.** At most `MAX_WARM_PER_PARK` renders
  per statement (rationale at the constant), and a flip landing
  mid-pass ends it — real statements outrank speculation.
- **Window-respecting, never activity.** A pass is skipped entirely
  while the unacked delivery window is exceeded (a window-skip
  records nothing, so the freeing ack's wake projects the same
  statement), and warming never extends the keepalive — it is not
  client-evidenced activity.

First consumer: the website world's chunk warming
(`website/src/app/world/warm.ts` — the projector;
`scroller.tsx` — the telemetry producer; `chunk.tsx` — the `cache`
option the warm fills). Covered by
`framework/src/lib/__tests__/channel-warm.rsc.test.tsx` (the
warm-vs-cold flip latency, byte silence, the cap, the window) and
the world validator's warm-path scenario.

## The heartbeat rides the browser bootstrap

`bootBrowser()` (`framework/src/entry/browser.tsx`) mounts
`<LivePageHeartbeat />` next to the payload root, so every app on the
standard entry surface holds one streaming connection. An app
assembling a custom browser bootstrap mounts it itself, near the
React root:

```tsx
import { LivePageHeartbeat } from "@parton/framework/lib/live-page-heartbeat.tsx"

// …alongside <BrowserRoot />
<LivePageHeartbeat />
```

Behaviour:

- **Initial fire** waits for three events: React's first commit (the
  effect runs post-commit, once `PartialErrorBoundary` renders have
  populated the cold fps), the browser `load` event (which is when
  the SSR HTML's `<!--fp-trailer:…-->` comment has been parsed and
  its warm-fp corrections applied — firing earlier would send
  cold-only fps and re-render every drifted parton, a visible flash
  for time-dependent content), AND — when cullable observers are
  mounted — the first viewport measurement (an
  IntersectionObserver always fires an initial callback per target,
  so a page with observers WILL measure; waiting means the fire's
  `?visible=` seed is the measured set, not the cold seed; a page
  with no cullables has nothing to wait for). Then
  `nav.reload({streaming: true, live: true, attach})` opens the
  long-poll connection — `live` holds it open, `streaming` commits
  each pushed segment progressively, and the fire ships as the ATTACH
  POST: the body statement carries the client's FULL manifest (the
  refetch dispatcher fills it, uncapped — the discrete `?cached=` URL
  form keeps its 96-entry cap) plus the current visible seed; the
  FIRST fire after a document load
  also presents the document's catch-up anchor (below). The SERVER
  mints the fire's connection id at session open and ships it down
  as the stream's `conn` entry; the channel transport establishes on
  receipt (setting the presence-only `data-parton-live` marker) so
  producers can address the open connection — and the visibility
  controller's full set syncs at the first measurement, whichever
  side of the establishment it lands on — see §Visibility rides the
  connection and [`channel.md`](./channel.md).
- **Live catch-up (the attach anchor).** The SSR document's trailing
  comments include `<!--live-anchor:{"epoch","ts"}-->` — the
  invalidation registry's timeline point the document represents
  (`epoch` names the registry lifetime; `ts` is its logical
  counter). The client stores it take-once; the heartbeat's first
  fire presents it as the attach statement's `since` (the anchor
  rides ONLY the attach body — no URL form), and the segment driver
  — when
  the epoch matches the current registry lifetime and the route
  still has snapshots — SKIPS the initial whole-route segment
  entirely: the response opens directly with the `lanes` marker,
  anchored at the document's timestamp, so the first wake lanes
  exactly what bumped or expired after the document rendered. The
  world's live boot is ~18 bytes instead of a route replay. The
  driver installs the connection's cached override from the
  statement's manifest (normally PartialRoot's job during
  the skipped segment) so flip confirms stay truthful. Anchor
  invalid (restart, registry clear, HMR-wiped snapshots) or absent
  (reopens attach with `since: null`, as do post-navigation fires) →
  the full initial render, over-
  fetch never stale. Client-side, a lanes-first stream resolves the
  reload's `streaming` milestone at the lanes marker (there is no
  payload to commit — the current tree IS the state).
- **Interval re-fires** every 5s by default — but each tick is a
  no-op if a stream is already open. So in steady state there's
  exactly one streaming connection.
- **On a `navigate`**, the abort check defers one microtask and
  consumes the channel's navigation claim: a CLAIMED navigation (the
  navigate listener routed it through the channel — attached,
  non-degraded, window-scoped) KEEPS the stream, because the `url`
  frame moves the server's request state and the navigation segment
  arrives on this very connection; tearing it would strand the
  navigation ([`channel.md`](./channel.md) §Navigation rides the
  channel). An UNCLAIMED navigation (discrete GET, frame session
  updates, pre-attach) aborts the in-flight stream as before; the
  next interval tick reopens on the now-current URL. The abort is
  **cooperative**: the transport (`splitSegments`) holds it until the
  in-flight segment's render has settled (the server's `settled`
  marker — see [Wire shape](#wire-shape)), then cancels the reader. So
  the body always closes with all its bytes delivered; it never closes
  mid-render, which would reject the committed payload's pending
  references (`"Connection closed."`, thrown while rendering the
  deferred parts) and tear the visible page through the error boundary
  (the "URL search breaks the underlying page" bug).
- **No live-state gating.** The heartbeat is on or off at the app
  level, not per-page. A page with no `expires()` / cells still
  pays the cost of one open streaming connection — the fp-skip
  cascade makes that ~free, but `page.waitForLoadState("networkidle")`
  in tests won't settle.
- **Pinned to its open-time cookies.** The stream renders against the
  request that opened it. An action that changes a cookie some
  parton's `cookie()` read depends on (e.g. `cart_id` on a first add
  to an empty cart) is NOT reflected by the already-open stream — it
  keeps rendering the old cookie's view, which can clobber a fresh
  action-response update on the client. The action POST response is
  authoritative for these (its render sees the new cookie via the
  `setCookie` overlay); the heartbeat's stale render is the hazard.
  Pages whose action mutates a tracked cookie rely on the action
  response and can opt the stream out (below); reopening the stream
  on a tracked-cookie change would remove the hazard at the source.

What this means for tests: sync on a specific selector / element /
DOM state, not on `networkidle`. The latter assumes "all requests
finished," which is false by design when a long-poll is open.

A spec that asserts on an exact set of RSC requests ("this nav made
exactly one refetch") or on interaction state can't tolerate the
heartbeat's background streaming connection. Such specs set
`window.__partonHeartbeatDisabled = true` via `page.addInitScript`
before navigating; `<LivePageHeartbeat>` reads the flag in its effect
and never opens the connection. Specs that exercise streaming itself
(chat, streaming-demo) leave it on.

## Wire shape

Each segment's bytes look like:

```
<flight rows…>
\xFF[parton:fp:N]\n<N-byte JSON: id→{from: cold_fp, to: warm_fp}>
\xFF[parton:url:M]\n<M-byte JSON: {window?, frames?, history?}>
\xFF[parton:settled:0]\n
\xFF[parton:next:0]\n
<flight rows for next segment…>
```

The tags split into two grammatical roles. **Milestones** (`settled`,
`next`, `lanes`, `mux`, `muxend`) are phase transitions: they end the
segment's body block. **Entries** (`fp`, `url`, `conn`, `seq`,
`applied`, any future data tag) carry data and may appear ANYWHERE —
interleaved between Flight rows, not just after the body. The server exploits that for
settle-time trailer emission: every parton's subtree settlement is
observable (the `SettleScope` refcount in the Flight patch — see
[server-context.md](./server-context.md)), and
`wrapStreamWithFpTrailer` registers a per-response sink that emits a
parton's warm-fp entry the moment ITS subtree settles, so a fast
parton's `{from,to}` never waits on a slow sibling's loader. Each
emission carries the CUMULATIVE update map; the whole-stream flush is
a safety net (aborted subtrees, post-settle invalidation drift) — so
the last `fp` entry on the wire is always complete and consumers keep
last-wins semantics. Lane renders skip the sink (`incremental: false`
— a lane is one parton, its flush already fires at that parton's
completion). The `conn` entry is the live connection's SERVER-MINTED
id — the channel's establishment handshake ([`channel.md`](./channel.md)):
emitted once per connection, ahead of the first segment's Flight rows
(or right after the `lanes` marker on a catch-up boot), so the
transport can address the session before the first render drains. On
a live connection two more entry tags flow: `seq` — the per-connection
monotonic DELIVERY seq plus the navigation point the emission was
rendered as-of, on every payload segment (body `<seq> <asof>`, ahead
of its Flight rows) and every lane (`<parton-id>\n<seq> <asof>`,
immediately before its `muxend`) — the currency of the client's
commit acks and of its stale-commit arbitration
([`channel.md`](./channel.md) §Navigation rides the channel) — and
`applied`, the cumulative upstream-envelope-applied watermark that
prunes the client transport's retransmit buffer
([`channel.md`](./channel.md) §Delivery is evidenced).

The client's `splitSegments` consumes body bytes until a `\xFF`
(UTF-8 invalid → never inside Flight payload), reads the marker with
`tryReadMarker`, records entry tags into the segment's trailer map and
keeps the body flowing, and transitions phases on milestone tags.
Entries ALSO surface progressively through the iterator's `onEntry`
hook the moment they are read — how the `conn` handshake reaches the
channel transport without waiting for the segment's trailer map to
resolve at settle.

The `settled` marker is the driver's explicit "this iteration is
done" signal, written once a segment's render has fully drained (body
plus `fp`/`url` trailers). It is what makes the heartbeat's abort
safe: `splitSegments` cancels the reader immediately if the in-flight
segment is already settled (the steady state — parked between
segments awaiting the next bump), and DEFERS the cancel until the
marker arrives if the render is still mid-flight, so an abort never
closes a body before its deferred references land. This is the
real-signal alternative to inferring "safe to abort" from a pathname
comparison — the producer states the milestone rather than the
consumer guessing it.

A live subscription's connection, after its whole-tree first segment,
carries a **lanes region** instead of further payload segments:

```
\xFF[parton:next:0]\n
\xFF[parton:lanes:0]\n
\xFF[parton:mux:N]\n<parton-id>\n<one chunk of that parton's payload>
\xFF[parton:mux:N]\n<other-id>\n<chunk>            ← lanes interleave
\xFF[parton:muxend:M]\n<parton-id>                 ← that payload is complete
\xFF[parton:settled:0]\n                           ← quiesce: every lane drained
```

The `lanes` marker is what lets the splitter classify the segment
before picking a decoder. Each lane's reassembled body is
byte-identical to a one-shot refetch response (Flight payload + its
own `fp` trailer), so the client decodes it with the same
`splitAtFpTrailer` path. A parton id may open again after its
`muxend` — that's the next re-render of the same parton on the same
connection. Lanes regions are always safe to abort immediately: a
torn lane rejects only its own un-committed decode, never a committed
tree, so the deferred-abort gate applies only to payload segments.
Every exit from a lanes region tears its still-open lanes the same
way — source close, invalid frame, and a `next` delimiter arriving
mid-payload all error the open bodies, so a lane's decode always
settles (rejects) rather than hanging on a stream nothing closes. A
lanes region ends cleanly with a `next` delimiter in two cases, both
flowing a payload segment and reopening the region with `next` +
`lanes`: the driver's scheduled whole-tree reconcile, at quiesce
([`channel.md`](./channel.md) §The whole-tree reconcile), and a
consumed `url` frame's navigation segment — which does NOT wait for
quiesce: the driver tears the open lanes server-side first (each
pump exits at its next check point, or its render reader is
cancelled; no `muxend`, no `seq` entry — the client's region exit
rejects exactly those bodies), because their content is the route
the client just left ([`channel.md`](./channel.md) §Navigation rides
the channel). After a navigation segment's reopen, the statement's
`?__force=` targets lane immediately, rendered EXPLICIT — the lane
state's `explicitIds`, so fp-skip and the defer gate both yield: a
refetch target re-renders on the lane path exactly as it would on a
discrete `?partials=` render.

## The stream must pass through untransformed

The segment driver's byte timing IS the protocol: a live connection
parks between wakes, and each framed lane must reach the client the
moment it drains. A compressing intermediary that buffers whole
blocks (a non-flushing brotli/gzip middleware, an nginx default, a
CDN transform) holds those frames until its block fills — on a
stream whose traffic has gone quiet, indefinitely. The observable
failure is a client pipeline frozen mid-stream with the connection
"open": the server keeps framing lanes into the compressor's buffer
and the demux never sees another byte (the world's
hard-scroll-edge chunks never materializing was exactly this).

Two guards keep transforms off the wire:

- Every segmented `.rsc` response declares `Cache-Control:
  no-transform` — the spec-level instruction that the payload must
  not be modified in transit. Real deployments' proxies honor it.
  ALL segmented GETs get the stamp, not just `?live=1`: a plain GET
  can go live mid-render (`markConnectionLive()` — the chat), which
  is unknowable at header time, and even the framework's own
  per-write-flush compressor measurably delays mid-stream pushes
  (the chat's progressive rows flake under it).
- The framework's dev/preview compressor
  (`framework/src/vite/compression.ts`, the `rscCompression()` vite
  plugin) honors `no-transform` at its compress decision AND strips
  the request's `Accept-Encoding` after capturing it, so every
  downstream compressor (vite preview ships its own, non-flushing
  one) stands down. Documents and action responses still compress —
  with a flush per write, so progressive rows keep their timing.
  (One-shot `.rsc` refetches are the casualty: compressing them
  needs a header-time "will never hold open" signal that doesn't
  exist yet. Their decoded size is small post-catch-up — the live
  boot no longer replays the route — so the loss is bounded.)

## `expires()` vs `cache`

Two separate concepts:

- **The `expires()` hook** declares when a partial's fp becomes
  stale. The segment driver's expiry arm races against the
  earliest boundary across the route's snapshots, so a clock
  display with `expires(time().nextSecond)` ticks once a second on
  the open streaming connection. **No byte storage** — each
  re-render re-executes the partial's render body.

- **`cache: { maxAge: N }`** (or eventually `cache: true`)
  declares that the rendered Flight bytes should be stored and
  replayed on hit. Distinct on-disk/in-memory footprint; cache
  hits skip Render entirely. Today's TTL comes from `maxAge`;
  long-term the boolean form will draw TTL from the `expires()`
  boundary.

The two are independent. Most partons declare one or the other,
not both. The streaming-demo's `LiveTick` uses `expires()`
without `cache`; the magento product-list uses `cache: { maxAge }`
without `expires()`. Where both are useful (a cached product card
that occasionally refreshes), use whichever TTL matches your
re-execution policy — but a "different TTL between cache and
`expires()`" combination has no useful interpretation (the cache
short-circuits the re-execution that `expires()` would have
triggered).

## GraphQL `@defer` (incremental delivery)

Distinct from the framework's own parton-level streaming: `@defer` lets a
GraphQL server send a query's slow fields *after* the initial payload, as
`multipart/mixed` chunks (`{data, hasNext: true}` then
`{incremental: [{data, path}], hasNext}`). `framework/src/lib/multipart.ts`
parses this — `parseMultipartStream` yields each chunk as its bytes
arrive (the unit a defer-aware loader consumes); `parseMultipartResponse`
is the buffered merge.

How it maps onto the existing machinery (design; the loader is future
work): a `@defer`'d *named fragment* becomes a pending `fragmentCell`
partition. A child parton bound to it reads cold and **suspends at its
own boundary** — which is already a Suspense boundary, so its `fallback`
streams within the same response (no heartbeat needed; the patches arrive
on the same upstream request). When the parent's streaming loader sees the
matching `incremental` patch, it hydrates the partition and the child
resolves. That's a server-side `useSuspenseFragment`: the cell is the
addressable, independently-re-renderable unit; `@defer` is just the wire
telling us when each one is ready. `graphql-request` buffers, so the
loader needs a raw streaming `fetch` + the multipart parser — the piece
still to build, behind a concrete `@defer` demo.
