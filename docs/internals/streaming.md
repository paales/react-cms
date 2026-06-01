# Streaming + live updates

How the framework's live-update path is shaped — what the segment
driver does, what `expiresAt` in `vary` means, and how the opt-in
heartbeat keeps a streaming connection alive.

## The render loop is top-down by design

Every server render walks the full route tree top-down. The server
re-renders **the whole world** for every segment of a streaming
response, and the fp-skip cascade does the pruning:

- Each parton computes `fp = hash(id|matchKey|vary|schema|props|inv|desc)`.
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

1. **A parton declares an `expiresAt` in `vary`** (time-based) or
   **reads a cell via `schema`** (write-driven via
   `refreshSelector("cell:<id>")`).
2. **The app's browser entry mounts `<LivePageHeartbeat />`**
   near the React root. After hydration it holds a `?streaming=1`
   long-poll open against the current URL.
3. **Server-side segment driver runs.** For each rendered segment,
   it races three arms:
   - `_waitForNextBump` — a `refreshSelector` lands (CRUD writes,
     `cell.set`, server-action invalidations) **that is relevant to
     this route**: it matches a rendered partial's labels + vary/args
     (`_routeHasMatchingBump`, see `segment-relevance.ts`). A bump for
     a different partition (another viewer's `cartId`, another
     session's cell) re-arms the wait WITHOUT re-rendering — so one
     viewer's write doesn't wake every open stream into a fp-skip
     pass. The wake itself is global (`_waitForNextBump` resolves on
     any bump); the relevance check is what gates the re-render.
   - `expiresAt` arm — the earliest `expiresAt` among the route's
     snapshots elapses.
   - Idle timeout (~20s) — the connection closes cleanly. The
     heartbeat's next interval tick (~5s default) reopens.
4. **On a relevant bump or an `expiresAt` boundary, the driver
   re-renders.** Unchanged partials fp-skip to placeholder bytes; the
   partial that triggered the wake emits its fresh content. Bytes go
   down the open connection as a new segment.
5. **Client per-segment trailer fires** `applyStandardTrailers`:
   updates the fp registry, updates the URL if a server-action
   navigated.

## Actions stay non-streaming

Server actions complete with a one-shot response (no `?streaming=1`
on their URL). Their bodies call `refreshSelector` / `cell.set` /
`getServerNavigation().reload({selector})`, which bumps the
**already-open** heartbeat stream. The segment driver wakes, the
next segment renders, the changed partial's fp moves, the bytes
ship. There's never more than one streaming connection per page
lifetime.

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
  `nav.reload({streaming: true})` opens the long-poll connection.
- **Interval re-fires** every 5s by default — but each tick is a
  no-op if a stream is already open. So in steady state there's
  exactly one streaming connection.
- **On `navigate`** (URL change), aborts the in-flight stream.
  The framework's nav handler then opens the new page's fetch;
  the heartbeat's next interval tick takes over once that's done.
- **No live-state gating.** The heartbeat is on or off at the app
  level, not per-page. A page with no `expiresAt` / cells still
  pays the cost of one open streaming connection — the fp-skip
  cascade makes that ~free, but `page.waitForLoadState("networkidle")`
  in tests won't settle.
- **Pinned to its open-time cookies.** The stream renders against the
  request that opened it. An action that changes a `vary`-input cookie
  (e.g. `cart_id` on a first add to an empty cart) is NOT reflected by
  the already-open stream — it keeps rendering the old cookie's view,
  which can clobber a fresh action-response update on the client. The
  action POST response is authoritative for these (its render sees the
  new cookie via the `setCookie` overlay); the heartbeat's stale render
  is the hazard. Pages whose action mutates a `vary` cookie rely on the
  action response and can opt the stream out (below); reopening the
  stream on a `vary`-cookie change would remove the hazard at the
  source.

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
\xFF[parton:next:0]\n
<flight rows for next segment…>
```

Order: Flight payload first, then trailer entries, then the
optional `next` delimiter. The client's `splitSegments` consumes
the body bytes until the first `\xFF` (UTF-8 invalid → never inside
Flight payload), reads trailer entries with `tryReadMarker`, and
either continues to the next segment or terminates.

## `expiresAt` vs `cache`

Two separate concepts:

- **`expiresAt` in `vary`** declares when a partial's fp becomes
  stale. The segment driver's expiresAt arm races against the
  earliest expiresAt across the route's snapshots, so a clock
  display with `expiresAt: time.nextSecond` ticks once a second on
  the open streaming connection. **No byte storage** — each
  re-render re-executes the partial's render body.

- **`cache: { maxAge: N }`** (or eventually `cache: true`)
  declares that the rendered Flight bytes should be stored and
  replayed on hit. Distinct on-disk/in-memory footprint; cache
  hits skip Render entirely. Today's TTL comes from `maxAge`;
  long-term the boolean form will draw TTL from vary's `expiresAt`.

The two are independent. Most partons declare one or the other,
not both. The streaming-demo's `LiveTick` uses `expiresAt`
without `cache`; the magento product-list uses `cache: { maxAge }`
without `expiresAt`. Where both are useful (a cached product card
that occasionally refreshes), use whichever TTL matches your
re-execution policy — but a "different TTL between cache and
expiresAt" combination has no useful interpretation (the cache
short-circuits the re-execution that expiresAt would have
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
