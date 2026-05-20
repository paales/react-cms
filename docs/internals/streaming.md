# Streaming + live updates

How the framework's live-update path is shaped — what the segment
driver does, what `expiresAt` in `vary` means, and why the heartbeat
opens a full-page connection instead of a selector-narrowed one.

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
2. **Server-side `fp-trailer` emits `live: "1"`** at end of each
   response, derived from `_readSnapshotsForRoute`'s view of which
   partials have finite `expiresAt` or `cell:*` labels.
3. **Client `<LivePageHeartbeat>` reads the trailer**, sees `1`,
   opens a long-poll `reload({streaming: true})` against the current
   URL.
4. **The segment driver holds the response open** for up to
   `KEEPALIVE_MS` (20s), racing three arms:
   - `_waitForNextBump` — a `refreshSelector` lands.
   - `expiresAt` arm — the earliest `expiresAt` among the route's
     snapshots elapses.
   - Idle timeout — the connection closes cleanly.
5. **Whichever arm wins, the driver re-renders.** Unchanged partials
   fp-skip to placeholder bytes; the partial that triggered the wake
   emits its fresh content. Bytes go down the open connection as a
   new segment.
6. **Client per-segment trailer fires** `applyStandardTrailers`:
   updates the fp registry, updates `liveSignal`. If the new trailer
   says `live: "0"`, the heartbeat closes and stays dormant.

## SSR-time vs streaming-time liveness

The initial page-load response is HTML containing the embedded RSC
stream. Trailers in the embedded Flight aren't reachable through the
client's `applyStandardTrailers` path (those run on `fetch()`
responses, not on `rscStream`). So the server emits the live state
as a sibling HTML comment after `</html>`:

```html
<!--fp-trailer:{"id": "fp", ...}-->
<!--parton-live:1-->
```

`applyLiveStateFromDocument` runs once during browser-entry startup
and seeds `liveSignal` from the comment. The heartbeat reads
`getLiveSignal()` on mount and either opens or stays dormant.

Subsequent navigations + action responses go through
`applyStandardTrailers`, which reads the `live` trailer entry and
updates the same signal. The mechanism is unified — only the
transport differs (HTML comment vs. binary marker).

## Why the heartbeat aborts on navigation

When the user navigates away from a live page, the heartbeat's
in-flight connection is moot — the URL changed, the segment driver
is rendering the OLD URL, and its server-side state no longer
matches what the user is looking at. The heartbeat listens for the
`navigate` event on `window.navigation`, aborts the in-flight
fetch, and clears `liveSignal`.

The framework's nav handler then fetches the new URL. That
response's trailer rebinds `liveSignal` based on the new page's
actual liveness. If the new page is also live, the heartbeat
reopens; if not, it stays dormant.

The reopen has a small grace delay (~1s) to give the navigation
response's trailer time to arrive before the heartbeat decides to
reopen. Without this gap, a fast nav-to-non-live page would race —
the old connection aborts, the loop checks `liveSignal` (still
true from the previous page), and reopens before the new trailer
has flipped it. The 1s delay closes that race.

## What this means for tests

`page.waitForLoadState("networkidle")` settles when there are no
in-flight requests for 500ms. A live page has the heartbeat's
long-poll open, so networkidle won't settle on that page — that's
correct: the page IS doing work, the test should sync on a
specific state (`waitForSelector`, `waitForFunction`) instead.

`networkidle` works fine on non-live pages (no expiresAt, no cells)
because the heartbeat is dormant.

## Wire shape

Each segment's bytes look like:

```
<flight rows…>
\xFF[parton:fp:N]\n<N-byte JSON: id→warm_fp>
\xFF[parton:url:M]\n<M-byte JSON: {window?, frames?, history?}>
\xFF[parton:live:1]\n0|1
\xFF[parton:next:0]\n
<flight rows for next segment…>
```

Order: Flight payload first, then trailer entries, then the
optional `next` delimiter. The client's `splitSegments` consumes
the body bytes until the first `\xFF` (UTF-8 invalid → never inside
Flight payload), reads trailer entries with `tryReadMarker`, and
either continues to the next segment or terminates.
