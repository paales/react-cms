# Streaming + live updates

How the framework's live-update path is shaped — what the segment
driver does, what the `expires()` wake hint means, and how the opt-in
heartbeat keeps a streaming connection alive.

## The render loop is top-down by design

Every server render walks the full route tree top-down. The server
re-renders **the whole world** for every segment of a streaming
response, and the fp-skip cascade does the pruning:

- Each parton computes `fp = hash(id|matchKey|schema|props|inv|deps|desc)`.
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
   (time-based) or **reads a cell via `schema`** (write-driven via
   `refreshSelector("cell:<id>")`).
2. **The app's browser entry mounts `<LivePageHeartbeat />`**
   near the React root. After hydration it holds a `?live=1`
   long-poll open against the current URL (it fires
   `reload({streaming: true, live: true})` — `live` is what holds the
   connection open; `streaming` only sets the client commit mode).
3. **Server-side segment driver runs.** For each rendered segment,
   it races three arms:
   - `_waitForNextBump` — a `refreshSelector` lands (CRUD writes,
     `cell.set`, server-action invalidations) **that is relevant to
     this route**: it matches a rendered partial's labels +
     constraint args (match params ∪ bound cell args)
     (`_routeHasMatchingBump`, see `segment-relevance.ts`). A bump for
     a different partition (another viewer's `cartId`, another
     session's cell) re-arms the wait WITHOUT re-rendering — so one
     viewer's write doesn't wake every open stream into a fp-skip
     pass. The wake itself is global (`_waitForNextBump` resolves on
     any bump); the relevance check is what gates the re-render.
   - Expiry arm — the earliest `expires()` boundary among the
     route's snapshots (read through `effectiveExpiresAt`) elapses.
   - Idle timeout (~20s) — the connection closes cleanly. The
     heartbeat's next interval tick (~5s default) reopens.
4. **On a relevant bump or an expiry boundary, the driver
   renders per-parton lanes.** The relevance check resolves WHICH
   snapshot ids the wake touched (`_routeMatchingBumpIds` for bumps;
   the due-expiry set for time wakes), and each touched parton
   renders in isolation through the snapshot-reconstruction path a
   `?partials=` refetch uses (`partialFromSnapshot` →
   `renderToReadableStream`). Each render's bytes frame as an
   independent `mux` lane (`driveLaneStream` in
   `segmented-response.ts`), interleaved as the renders produce them —
   a fast parton's lane closes on the wire while a slow sibling's
   render is still suspended, so no update waits on the slowest
   Suspense boundary. One lane per parton id at a time: a wake that
   touches an open lane marks it dirty and the pump re-renders on
   drain. Ancestors never re-run — each lane's fp trailer carries
   `{from,to}` updates for every route snapshot whose recomputed fp
   drifted, which includes ancestors whose descendant fold the lane's
   commit just moved.
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
   so a lane commit can never remount the page shell.

Relevance false-negatives (a dependency the label/constraint surface
doesn't capture) degrade to a MISSED update on the lane path, where the old
whole-tree path degraded to a wasted re-render. The backstop is the
keepalive cycle: the connection closes after ~20s idle, the
heartbeat reopens it, and a reopened connection's first segment is
always whole-tree — a periodic full reconciliation.

## Actions stay non-streaming

Server actions complete with a one-shot response (no `?live=1` on
their URL). Their bodies call `refreshSelector` / `cell.set` /
`getServerNavigation().reload({selector})`, which bumps the
**already-open** heartbeat stream. The segment driver wakes, the
next segment renders, the changed partial's fp moves, the bytes
ship. The heartbeat is the one connection actions ever need.

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
2. **Null-root response.** The app's RSC entry builds the action payload
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

## The heartbeat is opt-in

The framework doesn't auto-inject a heartbeat. Apps that want live
updates mount `<LivePageHeartbeat />` from their browser entry,
near the React root:

```tsx
// entry.browser.tsx
import { LivePageHeartbeat } from "@parton/framework/lib/live-page-heartbeat.tsx"

// …alongside <BrowserRoot />
<LivePageHeartbeat />
```

Behaviour:

- **Initial fire** deferred by one macrotask so React's commit
  phase (which wires `setPayloadRaw`) runs first. Then
  `nav.reload({streaming: true, live: true})` opens the long-poll
  connection — `live` holds it open, `streaming` commits each pushed
  segment progressively.
- **Interval re-fires** every 5s by default — but each tick is a
  no-op if a stream is already open. So in steady state there's
  exactly one streaming connection.
- **On any `navigate`**, aborts the in-flight stream; the next
  interval tick reopens on the now-current URL. Every page change is
  partial here, so there is no "same page" to keep the old stream
  for — it always reopens for the new URL. The abort is
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

Order: Flight payload first, then trailer entries, then the `settled`
milestone, then the optional `next` delimiter. The client's
`splitSegments` consumes the body bytes until the first `\xFF` (UTF-8
invalid → never inside Flight payload), reads trailer entries with
`tryReadMarker`, and either continues to the next segment or
terminates.

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
