> **Superseded 2026-07-02 by [docs/internals/streaming.md](../internals/streaming.md).**
> §3's per-parton multiplexed lanes are shipped: `driveLaneStream` in
> `segmented-response.ts` (server), the `lanes` region in
> `fp-trailer-split.ts` + `_commitPartonLane` (client). The §1/§2 wire
> facts stay pinned by `flight-duplicate-rows` / `flight-stream-slots`
> tests and the flight-format canary.

# Flight multi-update — can one response write the same slot twice?

Research question: the live-update path emits whole-tree segments,
and each segment settles only as fast as its slowest Suspense
boundary — `driveSegmentedResponse` drains the entire segment render
before it emits `settled` and arms the next wake
(`segmented-response.ts`, the inner `reader.read()` loop in
`driveSegmentedResponse`). Does the Flight wire format allow writing
the SAME slot multiple times within one response, so one parton could
update repeatedly without waiting for slow siblings?

**Verdict: yes for stream-typed slots, no for plain model rows — and
neither re-renders committed content.** The row grammar has exactly
one multi-write mechanism: a slot opened as a `ReadableStream` /
`AsyncIterable` (`R`/`r`/`X`/`x` rows), where every later same-id row
is an `enqueue` into that slot. A duplicate *plain* model row is not
"last write wins" — it throws inside the client's row loop and tears
down the rest of the response. And even the legal multi-write slots
only deliver *values* to a stream object the client must consume;
React never re-renders a committed fiber because a chunk resolved.
So "one parton updates repeatedly" cannot be expressed inside one
Flight *document* at the row level — it needs either a
streaming-value slot that a client component renders from, or
multiple independent documents multiplexed on one connection (§3).

All findings are pinned by rsc-tier tests:

- `framework/src/lib/__tests__/flight-duplicate-rows.rsc.test.tsx`
  (+ `.rsc-prod` twin — dev and prod builds behave identically)
- `framework/src/lib/__tests__/flight-stream-slots.rsc.test.tsx`
- `framework/src/lib/__tests__/parton-mux.rsc.test.tsx` (the §3
  prototype, transport in `framework/src/lib/parton-mux.ts`)

File/line citations are against the vendored bundles under
`node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/`
(the exact runtime both the app and the test harness execute, via
`flight-runtime.ts` / `test/rsc-server.ts`).

## 1. Duplicate plain model rows: fatal, first value wins

The client's row dispatch (`processFullBinaryRow`, dev build
`react-server-dom-webpack-client.edge.development.js` L4451–4471;
prod build `…client.edge.production.js` L1927–1932) routes an
untyped model row whose id already has a chunk to:

```js
function resolveModelChunk(response, chunk, value) {
  if ("pending" !== chunk.status) chunk.reason.enqueueModel(value);
  else { /* resolve the pending chunk */ }
}
```

(dev L1812–1825, prod L863–875). Any non-`pending` chunk is assumed
to be a **stream slot** whose `reason` is a controller. Only
`startReadableStream` (dev L3021) and `startAsyncIterable` (dev
L3113) ever install such a controller. For a plain model chunk,
`reason` is the Response object (uninitialized `resolved_model`,
`createResolvedModelChunk` dev L1791) or `null` (initialized
`fulfilled`, `initializeModelChunk` dev L1900–1941). Either way the
duplicate row throws a TypeError (`….enqueueModel is not a
function` / null deref).

The throw escapes the row loop, rejects the reader chain, and lands
in `reportGlobalError` (dev L1951): the response is marked closed,
every still-`pending` chunk rejects with the TypeError, every open
stream slot's controller errors, and **no further rows of the
response are processed**. Observed behavior, dev and prod
identically:

- **The second value never reaches the tree.** The first row's value
  stays; already-buffered `resolved_model` chunks still initialize
  lazily on await, so a payload whose refs all resolved before the
  duplicate decodes normally with the *first* value.
- **No warning, no graceful skip.** Anything after the duplicate row
  is dead: a `$L` ref whose row would have arrived later rejects with
  the TypeError (via the closed response's `getChunk`, dev L2013
  area / prod L950–956).
- Byte-typed duplicates (`T` text rows, case 84 dev L4394) hit the
  same wall through `enqueueValue`.

The server never produces this shape: task ids are allocated
monotonically (`request.nextChunkId`) and an id is only re-emitted
for stream-slot values and dev-only `D`/`W` debug sidecars. The test
pins that too. So duplicate plain rows are purely a post-processing
hazard (a splice bug in `flight-graph.ts` would manifest as this
teardown) — not an update channel.

## 2. Streaming-value slots: the sanctioned multi-write rows

The Flight server serializes `ReadableStream` and async-iterable
*values* as slots that receive multiple writes over time
(`react-server-dom-webpack-server.edge.development.js`):

| Row | Meaning | Server | Client |
|---|---|---|---|
| `<id>:R` / `<id>:r` | open ReadableStream slot (object / byte mode) | `serializeReadableStream` L1287 | `startReadableStream` dev L3021 |
| `<id>:X` / `<id>:x` | open AsyncIterable / AsyncIterator slot | `serializeAsyncIterable` L1363 | `startAsyncIterable` dev L3113 |
| `<id>:<json>` (same id, untyped) | next value (model) | `tryStreamTask` per chunk (L1302–1307) | `enqueueModel` → **full model parse** |
| `<id>:T<len>,<bytes>` (same id) | next value (raw string) | text path | `enqueueValue` |
| `<id>:C` / `<id>:C<final>` | close slot (`X`/`x` may carry a return value) | L1290–1292 / L1368–1377 | case 67, controller `close` |

Key answers:

- **Successive values CAN be full RSC subtrees.** `enqueueModel`
  routes each value through `createResolvedModelChunk` →
  `initializeModelChunk` → `JSON.parse(json, response._fromJSON)` —
  the same model parser as any row, so a value can be a React
  element tree, reference other rows (`$L`, `$@`), client references,
  the lot. The test decodes a stream of `<p>`/`<section>` elements
  arriving over time into one slot.
- **But the client surface is a value stream, not a tree update.**
  The slot decodes to ONE stable object — a `ReadableStream` or
  async iterable. React does not subscribe to it; nothing re-renders
  when a value lands. To paint successive values, a client component
  must consume the iterator and `setState` per value (`use()` cannot
  loop an iterable). That's the same "chunk resolution alone can't
  re-render committed fibers" constraint from a different angle —
  the state update is still the only re-render trigger; the slot
  just moves where it comes from.
- **Ordering/holdback:** `startReadableStream` chains values behind
  any still-initializing predecessor (`previousBlockedChunk`, dev
  L3043–3075), so values surface in wire order even when one of them
  waits on a module load. `startAsyncIterable` buffers into an
  indexed ring so multiple iterations replay the full history.
- **Abort:** server-side `renderToReadableStream(model, manifest,
  {signal})` abort (server dev L5850–5859 → `abort` L3820) emits one
  error row aliased to every open task — the client's pending
  `next()` rejects with the abort reason immediately. Cancelling the
  *response* stream aborts the whole render the same way (L5899).
  The producer, though, is cancelled via `iterator.throw(reason)`
  (L1423) — and async-generator operations are serialized, so the
  throw **queues behind the producer's in-flight `await`**. A
  producer parked on a never-settling promise never observes the
  abort (pinned in the test). Producers for infinite feeds must be
  written abort-aware (race the gate against a signal), or they leak.
- **Close:** a response that ends while a slot is open errors the
  slot with `Connection closed.` (`reportGlobalError` errors
  fulfilled chunks with a controller `reason`, dev L1956–1961) — the
  consumer's next `next()` rejects rather than hangs.
- **Backpressure: none.** The server pumps the producer at its own
  pace (`progress` → `reader.read()` loop, no destination check),
  and the edge build's `writeChunkAndReturn` (L49–75) never reports
  pressure — a slow consumer buffers bytes in the response queue; it
  never slows the producer. An unbounded feed on a stalled client is
  unbounded server memory.
- **A held-open slot holds the whole response open.** Each pending
  stream task keeps `pendingChunks` non-zero, so `renderToReadableStream`
  simply doesn't close — one HTTP response, trickling. This is the
  in-document analogue of `markConnectionLive`.
- **Wire caveat for our tooling:** string values emit as
  `T`-rows — length-prefixed, NOT newline-terminated.
  `flight-rewrite.ts`'s split-on-`\n` assumption ("row data is JSON")
  does not hold for payloads carrying streamed raw strings; the
  rewriter is safe today only because cached subtrees don't contain
  stream slots. Pinned in the test as a tripwire.

How this relates to what's shipped: the chat demo does NOT use
stream slots. It re-renders the whole message per chunk as a new
*segment* (`docs/notes/AA_CHAT_STREAMING.md`,
`e2e-testing/src/app/chat/`) — one Flight document per chunk, with
`<ChunkSlot>` + `markConnectionLive()` keeping the segment loop
alive. `multipart.ts` is the same shape one layer down (GraphQL
`@defer` chunks arriving inside one upstream response). A stream
slot would instead deliver message deltas *inside one document* to a
client component that renders them — fewer bytes (no per-chunk
re-render of the message scaffold), but it moves the render loop to
the client and gives up fp-skip/registry participation for the
streamed content. Worth having in the toolbox; not a replacement for
the segment loop.

## 3. Per-parton multiplexed payloads

Premise (why not "just" fix segments): committed React content only
re-renders via a state update. Chunk resolution fills *pending* holes
(Suspense reveals); it never revisits a committed fiber. So any
repeated-update design ends at "hand React a new tree and set
state" — the question is only the *granularity* of that tree. Today's
granularity is the whole page: every segment is a full root payload,
committed via `setPayload`, and the segment driver
(`driveSegmentedResponse`) fully drains each render before arming
the next — so one slow boundary head-of-line-blocks every other
parton's next tick, and a 1 Hz `expiresAt` clock stalls behind a 3 s
cell fetch that happens to share the page.

The alternative: the live connection carries multiple INDEPENDENT
mini-payloads — each a single parton's render, which is exactly what
the partial-refetch path already produces (cache mode invokes one
spec by id as a flat sibling; see
`docs/internals/render-pipeline.md` §Cache mode) — framed with a
parton id on the existing `\xFF[parton:tag:len]\n` marker grammar,
decoded client-side with one `createFromReadableStream` per lane,
and applied through the template-substitution path
(`_currentPagePartials` + `renderTemplate`/`substituteNested`)
instead of whole-page `setPayload`.

### Prototype (works today)

`framework/src/lib/parton-mux.ts` +
`__tests__/parton-mux.rsc.test.tsx`:

```
\xFF[parton:mux:N]\n<parton-id>\n<one chunk of that parton's Flight bytes>
\xFF[parton:muxend:M]\n<parton-id>
```

`muxPartonStreams` pumps each parton's `renderToReadableStream`
output concurrently, framing chunk-per-frame so each payload's own
Suspense pacing survives; `demuxPartonStreams` reassembles per-lane
body streams for independent decode. The test renders a fast parton
and a gated-slow parton and pins the point of the whole design: the
fast payload **closes on the wire and decodes to completion while
the slow sibling is still suspended**, and a torn connection errors
only the still-open lanes. The tags are local to the prototype;
adoption moves them into `fp-trailer-marker.ts`'s taxonomy alongside
`fp`/`url`/`next`/`settled`.

### What the server driver needs

`driveSegmentedResponse` keeps its skeleton (wake arms: relevant
bump / earliest `expiresAt` / keepalive) and changes the emit step:

1. **Render per-parton, not whole-tree per tick.** The relevance
   check already computes *which* snapshots a bump touched
   (`_routeHasMatchingBump` / `segment-relevance.ts` matches labels +
   vary/args); today the answer is thrown away and the whole world
   re-renders. The driver would instead take the matching snapshot
   ids and render each through the cache-mode reconstruction path
   (spec component by id, snapshot props, parent frame chain — the
   same thing a `?partials=` refetch does), one
   `renderToReadableStream` per parton, muxed as frames. `expiresAt`
   wakes map to the snapshot(s) that declared the deadline.
2. **Per-lane trailers.** Each mini-payload needs its own fp
   bookkeeping (`wrapStreamWithFpTrailer` per lane, or a `muxfp`
   frame keyed by parton id) and its own settled milestone — which
   the `muxend` frame already IS: "this parton's iteration is done"
   written by the producer, replacing the segment-level `settled`
   for abort gating.
3. **Registry commit per mini-render.** The segment loop leans on
   commit-on-flush (`deferRequestRegistryCommit`) with one render in
   flight per request context at a time. Concurrent per-parton
   renders inside one request ALS would interleave `pendingWrites`;
   the driver needs per-render registry scoping (or to serialize
   renders and only interleave *bytes*, which forfeits render-level
   parallelism but keeps today's invariants — an acceptable first
   cut, since the win is not blocking the WIRE on slow boundaries).
4. **Cached-fp promotion per lane** — `promoteSnapshotsToCachedOverride`
   already works per-snapshot; it just runs per `muxend` instead of
   per segment.

### What the client needs

The decode side is mechanical (the prototype's demux + one
`createFromReadableStream` per lane). The commit side is the real
work, and it's all inside `partial-client.tsx` (not touched here —
under restructure):

- A mini-payload's root is a parton subtree, not an `RscPayload`.
  Applying it is a cache write for `(id, matchKey)` — the walk
  `_warmCacheFromPayload` already performs — plus a re-render
  trigger. Today NOTHING re-renders on a cache write (preload relies
  on the next nav); `PartialsClient` needs a subscription/version so
  a cache commit schedules a `startTransition` re-render of the
  template, and `renderTemplate`/`substituteNested` substitutes the
  fresh subtree in place. That's "template substitution instead of
  whole-page setPayload".
- Per-lane trailers apply through the existing
  `applyStandardTrailers` / `applyFpUpdates` content-matched (`from`
  → `to`) path unchanged.

### What breaks — open problems, ranked

1. **The client commit trigger.** The template/cache machinery
   assumes commits arrive as whole-root payloads; a
   cache-write-then-rerender path exists nowhere. Also the tearing
   rule: one mini-payload must commit atomically (decode fully, then
   swap), or a parent's placeholder can substitute a half-written
   child entry. This is the gating piece and lives squarely in
   `partial-client.tsx`.
2. **Server-side render isolation.** Concurrent renders in one
   request context interleave `pendingWrites`, tracked-read state,
   and the per-request cached-fp override (see
   `docs/internals/server-isolation.md`). Serializing renders while
   interleaving bytes dodges it initially; true parallel renders
   need per-render registry frames.
3. **Ancestor fp bookkeeping drifts.** The descendant fold moves an
   ancestor's warm fp whenever a descendant's deps move. Whole-tree
   segments recompute and re-advertise ancestor fps every tick
   (trailer `{from,to}`); per-parton ticks never run the ancestors,
   so the client keeps advertising ancestor fps whose fold inputs
   have moved. Consequence: the next full render correctly declines
   the ancestor's fp-skip and re-renders it — correct but wasteful
   (one redundant ancestor re-run per changed-descendant epoch).
   Fixing it properly means recomputing affected ancestors' folds
   per tick (cheap — fold-only, no body run) and shipping their fp
   updates as trailer entries on the child's lane.
4. **Ordering.** Same-parton updates are ordered by the lane (one
   connection, frames in order) — free. Cross-parton ordering is
   deliberately abandoned: that's the point. The remaining hazard is
   cross-CONNECTION: a targeted refetch and the live mux both
   updating one parton — already arbitrated by issue-seq
   (`refetch-ordering.ts` / `claimRefetchCommit`), which the
   mini-payload commit path must also call. Parent/child races
   (parent lane re-renders a region whose child lane is also live)
   resolve through the cache the same way nested partials already
   do, provided commits are atomic per payload (problem 1).
5. **Abort semantics.** Segment-level `settled` disappears on this
   path; per-lane `muxend` replaces it. The cooperative abort
   becomes: on navigate-away, stop consuming new lanes, let open
   lanes drain to `muxend` (bounded by their own renders), then
   cancel. Server side, aborting the response aborts each in-flight
   per-parton render via its own `signal` — and lanes that already
   ended are unaffected, which is strictly better tear granularity
   than today (a whole-segment tear rejects the entire committed
   payload's pending refs).
6. **fp-skip interaction.** Inside a lane, fp-skip still applies to
   the parton's own descendants (the mini-render threads the
   request's `cachedFingerprints` like any cache-mode render). At
   the driver level, fp-skip's role is *replaced* by the relevance
   check — render only bumped partons rather than render-everything
   /skip-most. The residual risk is relevance false-negatives
   (a dependency the label/vary surface doesn't capture); the
   whole-tree segment path degrades to correct-but-wasteful in that
   case, per-parton degrades to *missing* the update. Mitigation:
   keep the low-frequency whole-tree render as a periodic
   reconciliation tick (the keepalive reopen already provides one).
7. **Per-lane decode overhead.** Each mini-payload is its own Flight
   document: client-reference `I` rows and symbol rows re-ship per
   lane, and each lane holds a Response instance until `muxend`.
   Today's segments pay the same per-segment cost, so this is a
   wash, but high-frequency lanes make it per-update; the
   `flight-graph.ts` dedup machinery (shared-row remap) is the
   existing answer if it ever shows up in profiles.

### Alternative considered: one document, one `X` slot per parton

Since §2 shows a slot's values can be element trees, the driver
could render `{lanes: {[partonId]: asyncIterable}}` in ONE Flight
document, pushing each parton's fresh subtree into its own iterator.
One decoder, shared row space, module dedup across updates for free.
Rejected as the primary shape because it trades away exactly the
pieces the mux keeps: values inside a slot are decoded in the host
document's context (no per-update trailer hook, no independent
abort — a torn connection errors every slot at once, §2), the
producer-cancellation queueing hazard applies to every lane, and the
client still needs a bespoke consume-and-setState surface that
bypasses the partial cache — whereas mux lanes are byte-identical to
refetch responses the cache path already understands. The `X`-slot
shape stays attractive for *within-parton* delta feeds (chat tokens,
tickers) where the consumer is a leaf client component anyway.
