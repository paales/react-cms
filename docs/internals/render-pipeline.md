# Render pipeline

Every request renders through `<PartialRoot>` as ONE whole-tree
pass; isolated per-parton re-renders exist only as LANES on a held
live connection, reconstructed from snapshots via
`partialFromSnapshot`. There is no partial-refetch request mode.

## The whole-tree pass

Every render `<PartialRoot>` runs — the SSR document, the attach's
first segment, navigation segments, action responses, reconciles.

1. `PartialRoot` opens a request-scoped registry context (`mode:
   "streaming"`).
2. The page body runs; every `parton(...)`-returned
   component encountered runs the wrapper pipeline (below) —
   rendering fresh or fp-skipping to a placeholder — and registers
   a snapshot via `<PartialBoundary>` either way.
3. On stream flush, `commitRequestRegistry` merges the rendered
   snapshots into the deduplicated variant store and MERGES
   `pendingHints` into the current routeKey's hint. Both passes
   merge — wholesale replace would erode the descendants of every
   fp-skipped ancestor (see
   [`registry-internals.md`](./registry-internals.md)). The
   routeKey is the hash of matched URLPatterns for the request
   URL, not the URL itself.

## The lane pass — isolated re-renders

A held connection's segment driver re-renders individual partons as
per-parton lanes — a viewport flip, a bump or expiry wake, a `url`
statement's `?__force=` target, a frame navigation's subtrees (see
[`streaming.md`](./streaming.md)).

1. Each lane opens a registry context (`mode: "cache"`) inside the
   connection's request scope.
2. The target id's snapshot is looked up via the routeKey hint and
   reconstructed with `partialFromSnapshot`: resolve the
   Component (`componentById` by id, or the spec catalog by
   `snap.type` for per-instance placements) and invoke it as a
   flat sibling with `__parent={path, frameChain}`,
   `__instanceId={id}` and the snapshot's captured props. A
   remote-sourced snapshot (`snap.source.kind === "remote"`)
   instead renders a fresh `<RemoteFrame>` at the remote's
   `/__remote/<id>` endpoint, so the re-render routes back to the
   origin that produced it.
3. The spec's wrapper re-runs the same pipeline (match, props cell
   resolution, fingerprint, skip / render). No ancestor execution.
4. On commit, the routeKey's hint is merged — ids that didn't
   re-render keep their existing variant pointers.

## The spec wrapper pipeline

Every placement of a `parton(...)` component runs the same async
wrapper (`createSpecComponent` in `partial.tsx`):

1. **Identity.** `__instanceId` (slot wiring / snapshot replay) or
   a hash of the call-site JSX props derives the effective id;
   `__parent` (isolated renders) or server context supplies the
   parent.
2. **Frame + match gate.** The request is frame-resolved through
   the parent's frame chain; the compiled gate (`compileMatch` in
   `lib/match.ts`) evaluates it — URLPattern strings plus per-value
   predicates over `searchParams` / `cookies` / `headers`. Gates
   see the request AS SENT (raw `Cookie` header, no same-request
   `setCookie` overlay) with the `TRANSPORT_PARAMS` (`cached`,
   `__frame`, `__frameUrl`) stripped, so transport
   noise never splits variant identity. A
   miss emits the parked keepalive (one hidden `<Activity>` per
   cached matchKey) and returns.
3. **Self-context.** The wrapper stamps `getCurrentParton()` (id,
   frame-resolved request, match params, live `deps` / `tags`
   sets, the wake-hint box) onto the rendering ALS frame — what the
   tracked server-hooks read (see
   [`server-context.md`](./server-context.md)).
4. **Props cell resolution.** Top-level JSX props holding a
   `Cell` / `BoundCell` are awaited into `ResolvedCell`s; each
   stamps a `cell:<id>` label, merges its args into the constraint
   surface, and folds `cellId × partition × value` into the
   `|schema=` fp term. Top-level only — cells nested inside object
   props are not resolved. See
   [`cell-internals.md`](./cell-internals.md).
5. **Fingerprint + skip decision** (see below and *Fingerprint
   protocol*).
6. **Render.** `Render(props)` runs; tracked hooks and in-body
   `cell.resolve()` record onto the live dep set for the NEXT fp.
   `cache` wraps the body in `<Cache>` (byte cache — see
   [`cache-internals.md`](./cache-internals.md)); the body is
   wrapped in `PartialErrorBoundary` (+ an outer keyed `Suspense`
   when `fallback` is set) and a matchKey-keyed `<Activity>` when
   keepalive is on.
7. **Boundary registration.** `<PartialBoundary>` calls
   `registerPartial(id, snapshot)` — on the skip and defer paths
   too, threading the prior snapshot's `deps` / `wakeHints`
   through so a pass without a body run doesn't erode the record.
   `registerPartial` stamps the `_seq` freshness guard and eagerly
   publishes to the canonical store (see
   [`registry-internals.md`](./registry-internals.md)).

### Skip decision

fp-skip emits an `<i hidden data-partial-id data-partial-match>`
placeholder instead of the body only when ALL of these hold:

- `fpSkip !== false` — the spec hasn't opted out
  (always-authoritative surfaces like the CMS editor chrome do);
- the client's cached manifest contains the computed fp — the attach
  statement's `cached` tokens, carried on the connection (or an
  action POST's capped `?cached=` URL form), backed by the
  connection's ACKED layer (fps whose delivering emission the client
  committed), consulted on an optimistic miss;
- the id is not an explicit target (a `url` statement's `?__force=`
  label resolved to it, a forced lane) — an explicit refetch must
  re-render. A culling flip's lane is NOT explicit: its fp-skip
  placeholder is the restore-with-zero-bytes confirmation, stamped
  `data-partial-confirm` on a MEASURED verdict — see *Cull-to-park*;
- the spec wasn't called with `children`: a transparent wrapper's
  output IS its children, which the JSX parent renders directly,
  so there is nothing for fp-skip to gate;
- the cold-record gate passes: with no prior snapshot for this
  variant the fp folded NO deps, so skipping is allowed only when
  `committedDepsEvidence(id)` proves every committed variant of
  the id recorded an empty read set; otherwise decline and render
  (over-fetch, never stale);
- the prior snapshot isn't past its `expires()` boundary — the
  fp-skip TTL gate.

## One payload root

`PartialRoot` returns ONE outer shape for every render:
`<PageUrlProvider url={pageUrl}><PartialsClient>…`. Every payload
the client commits onto the React root — the SSR document, the
attach's whole-tree first segment, navigation segments, action
responses — shares that root element type, so React reconciles
successive payloads in place. A differing root element type at any
segment seam would unmount + remount the whole subtree —
`page-shell` and everything under it torn down and recreated (a
full-page flicker).

The `url` prop is the SSR / pre-hydration seed for descendant client
components' `useNavigation()` (see `PageUrlContext`) — consulted only
while `window.navigation` is absent. So `PartialRoot` only serializes it
on the **SSR document** render (where it strips framework-internal params
first — those are consumed off the raw request and must not echo back).
On a client-driven render (the attach's drive, an action POST) the value
is never read (the live Navigation API supersedes it), so `pageUrl` is
`null` and the whole row drops — an action URL's `?cached=` token list
alone would otherwise run to kilobytes echoed back into the payload.
The element type stays `PageUrlProvider` either way. `PartialRoot`
distinguishes the two via the `x-parton-render` header stamped on
client-driven render requests (`parseRenderRequest` for action POSTs,
the attach endpoint for the connection's drive).

`PartialsClient` carries the same requirement one level down: while a
Flight chunk is still in flight (the chat's producer lane holding a
`<ChunkSlot>` suspended), the commit renders through the persisted
`_template` + cache — the same path a lane commit's template
re-render takes — rather than returning raw children. Matching
shapes there keep the partials *inside* the page (e.g. the nav)
reconciling too.

This reuse is scoped to the **same page**. `_template` records the
pathname it was derived for (`_templateRoute`); the pending-lazy
fallback reuses it only when the current pathname matches. A
cross-page nav (e.g. `/magento → /`) whose new page still has a chunk
in flight falls back to raw `children`, so React resolves the new page
via Suspense instead of re-rendering the prior page's template — which
would otherwise leave the page stuck on the one just navigated away
from. Same-page query / state changes (`?chat=open`, `?q=…`) keep the
same `match`-driven structure, so they reuse the template. See
[`streaming.md`](./streaming.md) and `PartialsClient` in
`partial-client.tsx`.

### Module map

`framework/src/lib/` — the render pipeline and the client merge
layer. `partial-client.tsx` is the `"use client"` boundary — it
holds `PartialsClient` (the merge coordinator) and re-exports the
client-side siblings, so `@parton/framework/lib/partial-client.tsx`
stays the one import path.

Server pipeline:

| Module | Owns |
|---|---|
| `partial.tsx` | `parton()`, `createSpecComponent` (the wrapper pipeline), `PartialBoundary`, `PartialRoot`, `partialFromSnapshot`, `computeRouteKey`, the descendant fold + per-pass fold scratch. |
| `match.ts` | `compileMatch` — the request gate (URLPattern strings + per-value predicates), `TRANSPORT_PARAMS` stripping, gate signatures for routeKey hashing. |
| `partial-registry.ts` | Snapshot store + hint table + `_seq` freshness guard + per-request registry ALS. See [`registry-internals.md`](./registry-internals.md). |
| `partial-request-state.ts` | The per-request partial state: the parsed cached manifest (`cachedFingerprints`, `cachedMatchKeys`) and the explicit-target set (`explicitIds` — `?__force=` labels resolved to ids, forced lanes; never skipped). |
| `current-parton.ts` | The parton self-context (`getCurrentParton`, `tag`) on the rendering ALS frame — read-your-own, not inherited. |
| `server-hooks.ts` | Tracked reads (`cookie`, `searchParam`, `header`, `pathname`, `match`, `session`, `visible`), wake hints (`expires`, `staleUntil`, `time`), `registerDepKind`, and `evalDepKeys` (the store-and-reread evaluator). |
| `spec-catalog.ts` | The `id → {Component, match, labels}` catalog snapshot reconstruction (`partialFromSnapshot`) and the descendant fold resolve specs from. |
| `cache.tsx` / `cache-options.ts` / `flight-graph.ts` | The byte cache (strip-on-store / splice-on-hit). See [`cache-internals.md`](./cache-internals.md). |
| `cell.ts` / `cell-gql.ts` | Cell handles, `resolveCellValue`, `atomic()`'s ALS storage overlay, fragment auto-hydration. Write endpoints live in `runtime/cell-actions.ts`. See [`cell-internals.md`](./cell-internals.md). |
| `frame.tsx` / `remote-frame.tsx` / `snapshot-trailer.ts` / `flight-rewrite.ts` | `<Frame>` scope opening; cross-origin parton embedding + its wire-level snapshot sidecar and line-level Flight rewriter. |
| `server-context.ts` / `partial-context.ts` | The server-context primitive + the `ParentContext` consumer. See [`server-context.md`](./server-context.md). |
| `flight-runtime.ts` / `multipart.ts` / `hash.ts` / `stable-stringify.ts` / `time.ts` | Vendored Flight entry points; GraphQL `@defer` multipart parsing; the 64-bit hash + canonical stringify; the render clock. |

Wire layer (trailers, segments, lanes — see
[`streaming.md`](./streaming.md)):

| Module | Owns |
|---|---|
| `fp-trailer.ts` | The stream wrappers: `wrapStreamWithFpTrailer` (settle-time + flush fp emission), `wrapStreamWithCommitOnly` (action POSTs, `url` entry), `wrapSsrStreamWithFpTrailer` (the `<!--fp-trailer:…-->` HTML comment). |
| `fp-trailer-marker.ts` | The `\xFF[parton:tag:length]\n` marker grammar + tag taxonomy (`fp`, `url`, `conn`, `next`, `settled`, `lanes`, `mux`, `muxend`). |
| `fp-trailer-split.ts` | The client splitter: `splitSegments` (no-holdback, milestone-gated cooperative abort, the progressive `onEntry` surface the `conn` handshake rides), `splitAtFpTrailer`. |
| `segment-trailers-client.ts` | Applying a segment's standard trailers client-side — `fp` via `_applyFpUpdates`, `url` via `_windowNav().navigate(…, { silent: true })`. |
| `segmented-response.ts` / `segment-relevance.ts` / `parton-mux.ts` | The server segment driver + lane pump, the bump-relevance predicate, and the per-parton lane mux/demux framing. |
| `connection-session.ts` / `channel-protocol.ts` | Per-live-connection session state keyed by the SERVER-minted connection id — the visible set the cull gate reads on a live connection, statement application (`reportConnectionVisibility`), and the channel endpoint body (`handleChannelPost` — `POST /__parton/channel`, with its origin + attach-binding checks); the shared envelope grammar (`ChannelEnvelope`, frame kinds, `decodeChannelEnvelope`). See [channel.md](./channel.md) and [streaming.md](./streaming.md) §Visibility rides the connection. |

Client merge layer:

| Module | Owns |
|---|---|
| `partial-client-state.ts` | ALL module-level mutable state, behind accessors: the partial cache + fingerprint maps (`cacheStore`, `registerClientPartial`, `touchClientPartial`, `_applyFpUpdates`, `pruneToLive`; the cached manifest has two forms — the attach statement's BODY manifest (`getAllCachedPartialTokens`) carries everything, no request line to protect, while the action POST's `?cached=` URL form (`getCachedPartialIds`) is doubly bounded: `FP_CAP_PER_VARIANT` fps per variant, `CACHED_MANIFEST_CAP` entries total, parked-by-culling ids first (`_setManifestPriorityIds`) then newest-sighting-first, since it travels in the request URL and a many-parton page would otherwise blow the server's request-line limit; `CLIENT_POOL_CAP` bounds distinct ids, aging out the least-recently-sighted — every walk touches the ids it sees, so recency means "still emitted by commits"), the id-pruned listener (`_setIdPrunedListener` — the page-membership teardown signal cull-park registers on), the persisted template (`getTemplate` / `setTemplate`), the lane-commit subscription (`subscribeLaneCommits` / `notifyLaneCommit`), the live-connection id (`_setLiveConnectionId` / `_getLiveConnectionId`) + the take-once catch-up anchor, and the frame-URL cache. |
| `partial-cache.ts` | The tree walks: wrapper/placeholder detection, `harvestPartialIds`, `cacheFromStreamingChildren`, `substituteNested`, `unwrapLazy` + the `LAZY_PENDING` sentinel (pending lazies' Flight chunks are captured into `LazyWalkStats.thenables` so `PartialsClient` can arrange a re-walk when they land), `treeHasPendingLazy`, the per-parton lane commit (`_commitPartonLane` — synchronous cache walk + fp updates + the notify that re-renders `PartialsClient`; see [streaming.md](./streaming.md)) and the fp-trailer DOM scan. |
| `partial-template.tsx` | `deriveTemplate` + `renderTemplate`. |
| `cull-key.ts` / `cull-park.ts` / `cull-pair.tsx` | Cull-to-park (see the section below): the registry-internal `~cull` variant-key grammar; the client pool state (reported viewport per id, the parked-by-culling LRU + `CULL_PARK_CAP`, the drop-on-drift generation + `parkedSince`, the observer refcount); the `CullPair` client component (both `<Activity>` slots in one component — content + inline skeleton — modes from the reported state, display-state priming, per-slot observers). |
| `refetch.ts` | `enqueueRefetch` (microtask-batched targeted refetch → one channel `url` statement: the page URL with the labels as its one-shot `?__force=` overlay, intent "silent"), selector parsing, the silent-navigation info brand. |
| `frame-client.tsx` | The frames tree on the nav entry (read/write + the write serialiser), `FrameNameProvider`, frame refetch dispatch, and the window/frame imperative handle builders. |
| `use-navigation.tsx` | The `useNavigation()` hook layer (`[fire, progress]` tuples, `@self` resolution, preload), `useActivate`, `useScrollRestore`, `PageUrlContext`, `PartialIdContext`. |
| `cell-client.tsx` | `useCell` + the client-side write batcher (see [`cell-internals.md`](./cell-internals.md)). |
| `channel-client.ts` | The channel's client transport ([`channel.md`](./channel.md)): envelope assembly + per-connection seq, rAF-coalesced serialized flushes over registered producers, the delivery-failure hand-back, connection lifecycle (`_channelWireEntry` establishment from the stream's `conn` handshake, the presence-only `data-parton-live` marker), and the `pagehide` detach frame. |
| `live-page-heartbeat.tsx` | The held connection's keeper (mounted by `bootBrowser`) — each fire is the ATTACH: a `POST /__parton/live` whose JSON body is the full client statement, carrying the measured visible seed (the first fire waits for the first viewport measurement when cullable observers are mounted), the uncapped manifest, and the take-once catch-up anchor from the document ([`channel.md`](./channel.md) §The attach). Its ~5s interval tick is the reattach loop — a no-op while a connection is open, the recovery path after a transient tear. Connection ids are server-minted; establishment rides the stream's `conn` entry, not this component (see [`streaming.md`](./streaming.md)). |
| `visibility.tsx` / `page-interactive.ts` | The viewport observer for cullable partons + the flip controller — the channel's first producer (display-state priming, delta-only dispatch, first-measurement sync, `visible` frames onto the open live connection; with no connection the flips PEND and ride the next attach's first flush); the `data-parton-interactive` root marker. |

`framework/src/runtime/` holds the request plumbing: `context.ts`
(request ALS, scope derivation, the cached-fp override carrier, the
settle-trailer sink, `markConnectionLive`, deferred-commit flags),
`request.tsx` (`parseRenderRequest`, `stripFrameworkParams`,
`HEADER_RSC_RENDER`), `invalidation-registry.ts` (`refreshSelector`
bumps + `queryMatchingTs` + transactions), `server-navigation.ts`
(`getServerNavigation().reload/navigate`), `session.ts` (frame-URL
session store), `cell-actions.ts` / `cell-storage.ts` /
`cell-write-delay.ts` (cell writes), `navigation-api.ts` /
`navigation-error.ts` / `error-boundary.tsx` / `redirect-client.tsx`
(client nav + error recovery), `capability.ts` /
`remote-endpoints.tsx` (host→remote scoping), and the
`cms-*.ts` CMS layer.

`framework/src/entry/` is the app entry surface — the three factories
an app's thin `src/entry.{rsc,ssr,browser}.tsx` files delegate to:
`rsc.tsx` (`createRscHandler({Root, notFound?, fetch?, remote?,
clearCaches?})` — remote-endpoint dispatch, the DEV-only
`/__test/clear-caches` endpoint, action decode inside an invalidation
transaction, the segment driver + fp-trailer wiring, and the SSR
handoff via `import.meta.viteRsc.loadModule("ssr", "index")`, which
the plugin resolves from the APP's vite config, so the framework
never imports app code), `ssr.tsx` (`renderHTML` — Flight→HTML with
the inline FLIGHT_DATA injection), and `browser.tsx` (`bootBrowser()`
— hydration, the Navigation API intercept, the attach transport
(`window.__rsc_live_attach` — the channel's opening statement and the
page's one held stream), the server-action callback, and
`<LivePageHeartbeat />`).

### Bounding the client cache (and the pending-lazy guard)

The payload commit bounds `_currentPagePartials` / `_currentPageFingerprints`
to what the rendered page actually references, so a superseded variant
(a churned-away instance id, an evicted match variant) stops being
advertised in the cached manifest. The walk prunes against its `seen`
set — fresh wrappers, placeholders, and the nested (id, matchKey)
pairs harvested from cached wrappers. Lane commits never prune: they
only write fresher content into slots the page already references.

The prune runs **only on a complete render**. A substituted cache
wrapper can still carry an in-flight Flight lazy — a slow descendant
(a search stage, the chat's `<ChunkSlot>`) hadn't resolved when the
wrapper was last cached. The partials *behind* that lazy are still
live but aren't materialised in the rendered tree, so a harvest
under-counts them. Pruning then would evict their cache +
advertised-fp entries, and the next render's fp-skip placeholder
would have nothing to substitute — blanking the region until a full
re-render restores it (the "content behind the search disappears"
bug). So the walk prunes only in its non-pending branch, deferring to
a later commit whose render is whole.

A second bound, `CLIENT_POOL_CAP`, caps the number of distinct ids
retained across a long journey (a scroll across a cullable field
registers an entry per parton ever visited). Eviction is
oldest-registered-first but **exempts ids the live tree still
references** (the prune set from the most recent payload commit,
recorded as `_liveTreeIds`): the template re-substitutes those ids'
placeholders from the cache on every re-render, so destroying one
blanks that subtree permanently — nothing refetches it, because the
fp-skip placeholder is the server saying "you have this". The page
shell is the canonical would-be victim: its element identity is
stable, React bails out of re-rendering its boundary, and it never
re-registers for recency — under churn it becomes the pool's oldest
entry while being the subtree everything hangs off. A page whose
live tree alone exceeds the cap keeps every live entry (correctness
bounds memory there); the cap bounds everything else.

## Preload (server-side warm intent)

`useNavigation().preload(target)` (see
[`frames-navigation.md`](../reference/frames-navigation.md) §Preload)
adds **no client commit path and no request mode**. Attached, it
ships a lossy `warm` frame on the channel (newest-wins — one pending
target, the latest hover); applying one replaces the connection
session's warm slot and wakes the segment driver, whose park point
runs ONE byte-silent whole-tree render of the stated target
(`warmPreloadTarget` in `segmented-response.ts`). The render runs
inside a nested request scope for the target URL
(`_runWithWarmRequestScope`) and drains into the void — no
controller, no delivery seq, no promote, never keepalive activity —
under the same delivery-window discipline as the telemetry warm
pass. The durable effects are the caches it fills (`<Cache>`
byte-cache entries, loader caches) and the target route's registered
snapshots; the navigation statement that follows renders warm, so
its segment carries only genuine deltas. Nothing reaches the client
until the navigation itself.

On a DEGRADED page the client appends a Speculation Rules prefetch
rule for the target document instead (`use-navigation.tsx`) — the
browser warms the document HTTP entry a degraded navigation loads.
Pre-establishment the intent DROPS: a preload must never trigger an
attach, and a stale hint is worth less than none.

## Snapshot shape

```ts
interface PartialSnapshot {
  type: string                          // spec catalog tag
  fallback: ReactNode
  labels: string[]                      // refetch labels (selector)
  cache?: CacheOptions
  framePath: readonly string[]
  parentFrameChain: readonly string[]   // for isolated reconstruction
  parentPath: readonly string[]
  props?: Record<string, unknown>       // captured call-site JSX props
  constraintArgs?: Record<string, unknown> // bound-cell args, for invalidation matching
  varyKey?: string                      // stringified match params, for the descendant-fp fold
  deps?: ReadonlySet<string>            // tracked-read dep keys recorded this render
  matchKey?: string                     // variant key (hash of match params)
  schemaKey?: string                    // resolved-cell fp term, for the trailer's recompute
  emittedFp?: string                    // fp the render emitted (drift detection)
  source?: SnapshotSource               // remote-origin stamp; refetch routes back via <RemoteFrame>
  _seq?: number                         // registration sequence — the freshness guard
  wakeHints?: WakeHints                 // live box written by expires()/staleUntil()
}
```

Snapshots store no JSX. The derived bits that matter most:

- `props` — the call-site JSX props the spec was last rendered with.
  The lane pass replays them so a child rendered via a parent wrapper
  still receives `id={...}` / `flavor={...}` etc. when the framework
  re-invokes it without going through the wrapper. Request-dependent
  inputs flow through tracked reads / `match` / cells, which
  re-resolve on the re-render.
- `deps` — the dependency keys the spec's tracked reads recorded on
  its most-recent render (`"cookie:cart_id"`, `"search:q"`, …). The
  spec's next own fp and every ancestor's descendant fold re-read
  each key's current value (store-and-reread), so a tracked read
  moves the fp with no declaration. The LIVE Set is stored, so reads
  landing after the render's awaits are captured by the time the
  next fold runs.
- `varyKey` — the spec's match params, stable-stringified, on its
  most-recent render. Together with `deps` it feeds the
  descendant-fp fold so an ancestor's fingerprint reflects every
  descendant's deps. Without them, a wrapper whose own JSX is
  unchanged would fp-skip and starve its descendants of a
  re-evaluation even when their URL / CMS deps just changed.

Dep VALUES are NOT stored — every fold re-reads the recorded keys
against the current request. Isolated reconstruction
(`partialFromSnapshot`) looks up the spec component by id (or by
`type` for per-instance placements) and renders it as
`<Component __parent={{path: snap.parentPath, frameChain:
snap.parentFrameChain}} __instanceId={id} {...snap.props} />`.

For storage details — variant deduplication, hint table, LRU
bounds — see [`registry-internals.md`](./registry-internals.md).

## Refetch addressing

Targeted work is addressed on the CHANNEL, not the URL. A selector
refetch (`reload({selector})` / `navigate({selector})`) is a `url`
statement — the page URL with the labels as its one-shot `?__force=`
overlay, intent "silent". The driver resolves the labels against the
route's snapshots (direct id match plus any snapshot whose label list
contains a wanted token — cosmetic `#`/`.` stripped), renders a
whole-tree segment (the URL may have moved with the fire, and fp-skip
prunes the unchanged to placeholders), and lanes each named target
EXPLICIT — forced past fp-skip. The overlay never enters request
state; a statement that fired pre-establishment latches and rides the
attach it triggers.

The URL params that remain:

| Param | Carries |
|---|---|
| `cached` | `id:matchKey:fp,…` — the capped manifest form on an action POST's URL. The attach statement's `cached` field is the uncapped body form. |
| `__frame=...&__frameUrl=...` | session-write a frame URL before render — the DOCUMENT carrier (a degraded page's frame navigation, the CMS preview iframe) |

`cached`, `__frame` and `__frameUrl` are the `TRANSPORT_PARAMS`
(`lib/match.ts`) — `match` never sees them. Everything else rides the
channel: the visible set is connection-session state (the attach's
`visible` seed + `visible` frames), the catch-up anchor is the attach
statement's `since`, holding open is the attach itself, and commit
mode (`streaming`) is client-local. (The live connection's id travels
the OTHER way — server-minted, shipped as the stream's `conn` entry,
presented back on channel envelopes; it is never a URL param.) The
resolved visibility is still a real request dimension — the cull gate
reads the connection session and the resolved state folds into fps.

After a server function commits, refetch routing is driven entirely by
the invalidation registry — cell writes fire their `cell:` selectors
(batched inside `atomic()`), and a function can call
`getServerNavigation().reload({selector})` in-body (queued inside the
invalidation transaction); the response render computes fresh fps for
any partial whose selector matches. Cold clients (an empty manifest)
receive the full root tree; warm clients get fp-skip placeholders for
everything unchanged. No URL-rewrite step in between.

## Cull-to-park

A cullable keepalive parton (declared with the `cull` spec option —
see [`partial.md`](../reference/partial.md#view-culling--the-cull-gate))
treats its culled state as a parked VARIANT rather than a
replacement. The moving parts, end to end:

- **The gate** (the `cull` option in `partial.tsx`). Culling gates
  existence: the wrapper resolves `readVisible(request, id) ??
  seed(props)` BEFORE schema/cell resolution, records
  `visible:<id>?seed=<0|1>` (the seed's VALUE rides the dep key; its
  tracked-read inputs — an anchor `searchParam()` — ride the dep set
  alongside), and on a culled verdict skips the body entirely. The fp
  folds the RESOLVED state ("1"/"0", never the raw unmeasured token),
  so unmeasured and measured renders that resolve the same way fold
  the same fp — the first client measurement moves only the partons
  it actually flips.
- **The culled emission.** No body, no client-side fp registration
  (nothing to advertise), no cell resolution — a culled parton is
  dark to cell invalidation until it flips back in. The registry
  still keeps a per-state snapshot under the `~cull`-suffixed variant
  key (REGISTRY-INTERNAL — `lib/cull-key.ts`, see
  [`registry-internals.md`](./registry-internals.md)): its deps are
  the gate's reads, so ancestors' descendant folds see flips, and
  `lookupPartial(id, culled)` folds the record of the state being
  entered (falling back to the sibling; a cross-state fp can never
  collide because the visible dep folds a distinct token per state).
- **The pair** (`cullPairOf` in `partial.tsx`, `lib/cull-pair.tsx`).
  Every emission of a cullable keepalive parton — fresh, culled,
  fp-skip, match-miss park — is ONE `<CullPair>` client component
  holding two `<Activity>` slots. The content slot's child is this
  render's PEB-wrapped body or the placeholder hole (ALWAYS shipped:
  the mounted pair lives in the persisted template or an ancestor's
  cached wrapper; a later flip-in's bytes can only reach the tree
  through a hole). The skeleton slot's child is the spec's
  `cull.skeleton` element — inline, client-rendered from the
  placement's serializable props, never cached, never fingerprinted —
  so a cull-out never needs server bytes. A culling flip is a MODE
  change on the two Activities, computed client-side from the
  visibility controller's reported state (`useSyncExternalStore` over
  `cull-park.ts`) — the flip shows the moment the observer reports;
  the skeleton also shows in view while the content slot has nothing
  to render yet. Each slot wraps its child in a
  `<VisibilityObserver>`; the CONTENT observer mounts only over real
  content — an unbacked hole is a connected zero-size node whose
  testimony would flip an in-view parton right back out (a lane-rate
  flip loop). On mount the pair PRIMES the controller with its
  emission's server-computed state (`_primeVisible`), overlaid by any
  live report for the id — the DISPLAY state — so first measurements
  that agree with what's actually shown dispatch nothing. An id whose
  reported state the page-membership prune evicted primes COLD
  instead (`cullStateGone` leaves a tombstone, retired by the next
  fresh content store): its emission predates the park, so the
  baseline is out and the observer's first measurement is
  authoritative — an in-flip drives, an out-agreement rides.
- **The revalidation.** Flips ride the connection as session state (a
  `visible` frame on a channel envelope): flipped-IN partons come
  back as lane segments, cull-OUTs lane nothing — see
  [`streaming.md`](./streaming.md) and [`channel.md`](./channel.md).
  With no connection open the flips PEND and ride the next attach —
  its `visible` seed states the full set, its whole-tree first
  segment materializes anything in view, and the queued flips ride
  the fresh connection's first flush, fp-skipping to confirmations
  where the segment already delivered the bytes. The render reads the
  connection's CURRENT visible set, so an fp match answers with a
  CONFIRMATION placeholder (`data-partial-confirm` — a cullable
  spec's skip verdict at a MEASURED visible set, distinct from a
  plain hole; an unmeasured skip says nothing about a parked fiber's
  state and carries no marker); a moved fp answers with fresh bytes.
- **While parked, the server stays quiet.** On a live connection,
  bump/expiry wakes skip any parton whose own snapshot or cullable
  ancestor's is outside the session's measured visible set
  (`isParkedOnConnection` in `segmented-response.ts` — see
  [`streaming.md`](./streaming.md)): the parked copy is a hidden
  Activity slot, so lanes at it would ship bytes nobody sees — and
  they'd never stop, since snapshots persist for everything ever
  rendered. The flip-in revalidation is the catch-up: its fp folds
  every bump that landed while parked, so it re-renders fresh.
- **Drop-on-drift** (`cull-park.ts`). The content slot's `<Activity>`
  is keyed by a per-id GENERATION. A fresh content store for an id
  whose mounted fiber has been parked since its bytes were minted
  (`parkedSince` — set on the cull-out report, cleared by the
  confirmation placeholder or consumed by the bump) bumps the
  generation: the parked fiber is dropped and the fresh bytes mount
  as a real remount. Ordinary in-view live updates reconcile in
  place. Both signals ride the commit walk, so the two outcomes of a
  revalidation cannot race each other.
- **The parked budget** (`CULL_PARK_CAP`, 64). Culled ids form an
  LRU (most-recently-culled kept); past the cap the oldest id's
  content is destroyed (`evictCulledContent` — cache slots +
  advertised fps; the inline skeleton needs no cache entry and keeps
  holding the parton's space) and its next return renders cold.
  Parked ids also hold capped-manifest slots ahead of the recency
  walk (`_setManifestPriorityIds` — the action POST's `?cached=` URL
  form; the attach's body manifest is uncapped): on a busy live page,
  lane registrations would otherwise churn a parked id out of the
  manifest and its restore could never be fp-confirmed.
- **Page-membership teardown.** All per-id cull state dies when the
  merge layer's prune drops the id's last cache/fp entries
  (`_setIdPrunedListener`) — observer lifecycles are NOT that signal:
  an Activity flip can unmount one slot's observer in a different
  render pass than it mounts the other's, so the visibility
  controller's gone-handling only clears the live reported set
  (self-healing — a re-mounting observer's initial
  IntersectionObserver callback re-reports) and never cancels a
  pending flip.

## Selector-refetch commit ordering

Selector refetches ride the held stream, so ordering is structural:
responses arrive in STREAM ORDER — a newer fire's covering segment is
emitted after the older's, so a late older response clobbering a
newer one cannot happen on the wire. The remaining staleness class is
client-side motion: a delivery rendered before the client's own
navigation must not commit over the new page. Every emission
therefore carries the navigation point it was rendered AS-OF (the
`seq` entry's `asof` — the envelope seq of the last `url` statement
the connection's request state reflects, see
[`channel.md`](./channel.md)), and the client commits a delivery only
when its as-of covers the client's current navigation point
(`_channelDeliveryCommittable`). An as-of-dropped delivery still acks
as processed; the server's fold gate keeps its fps out of the acked
mirror. Superseded work isn't cancelled — a superseded window fire's
whole-tree segment still drains, its cost bounded because fp-skip
prunes it to near-empty bytes, and a newer statement's covering
segment resolves the older fires' milestones too. (Frame fires are
the exception: a superseding frame statement ships an explicit
`cancel` co-rider that aborts the in-flight lane render server-side.)

## Fingerprint protocol

Each spec emits its `fp` via `<PartialErrorBoundary partialId,
partialFingerprint>`; the client's `_currentPageFingerprints` map
captures it. The map IS the manifest: the attach statement's `cached`
field carries every token, an action POST serializes the capped
`?cached=` URL form, and on a held connection the driver appends
newly-emitted tuples directly to the connection's carrier between
emissions. The server's spec body skips when its current `fp` matches.

`_currentPageFingerprints` is `Map<id, Map<matchKey, Set<fp>>>` —
each (id, matchKey) variant can carry multiple fingerprints. The
set accumulates the COLD fp (what the spec emitted at first-render
time) and the WARM fp (computed post-commit with full descendant
fold; shipped via the trailer — see below). The server's
`parseCachedTokens` mirrors the shape, and the fp-match check is
`cachedFps.has(fp)`.

The fp set is bounded to "fps that match the cache slot's current
contents". When `cacheStore` overwrites a `(id, matchKey)` slot,
the corresponding fp set is cleared before the walk re-registers
the current render's fp. Without this, fps from prior navigations
accumulate (e.g. `frames-main-list` cycling between listing and
product detail under a constant matchKey — see
[`partial-client-state.ts::cacheStore`](../../framework/src/lib/partial-client-state.ts))
and the next nav can fp-skip against a stale entry while the cache
slot points at fresh content, surfacing the wrong subtree on
substitution. The async warm-fp trailer upholds the same invariant by
aliasing its warm fp onto the slot still holding the matching cold fp
rather than the latest-rendered one (see *Cold → warm fp drift* below) —
so a trailer from a query a concurrent refetch already superseded is
dropped, not mis-attached.

Each `(id, matchKey)` fp set is additionally capped at
`FP_CAP_PER_VARIANT` (4) entries, oldest-first — a live parton
re-emitting per segment would otherwise inflate the manifest
unboundedly.

The fp folds in:

- spec id
- match params (`matchKey` plus their stable-stringified values,
  the `vary=` term)
- the prior render's recorded dep keys, re-read at the current
  request (store-and-reread) — cookies, search params, headers,
  pathname / `match()` reads, session, visibility, tags, and custom
  dep kinds (the CMS layer's `cms:<contentKey>` content hash, which
  is how a block's resolved fields move its fp)
- prop-resolved cells (`schemaKey`: cell-id × partition × value)
- call-site JSX props (`extraProps`)
- frame URL (own and ambient)
- every previously-registered descendant spec's contribution — its
  stored `varyKey` + dep record, re-evaluated against the *current*
  request (transitive descendant fp propagation — an
  ancestor fp-skip can never serve a stale subtree). The
  descendant's request is frame-resolved through its stored
  `framePath` so a nested-frame nav that moves only an inner
  frame's URL still shifts the descendant's contribution — without
  this, an outer match-stable wrapper would fp-skip and
  freeze a cached inner-frame body in place

The full gate list for when a matching fp actually skips is the
*Skip decision* above.

## Addressable gate

A spec is *externally addressable* iff the author explicitly
declared `selector` or `match`. Specs declaring neither are
non-addressable: they have no external refetch handle
(`reload({selector})` requires a declared selector, URL-driven
variant carve-out requires `match`). Auto-derived selectors from
`Render.name` don't count — they only exist to give the spec
catalog a unique id.

Non-addressable specs **don't emit a `partialFingerprint` on the
wire**. The four-step fp cycle is collapsed for them:

- `<PartialErrorBoundary>` is emitted via conditional spread
  (`{...fpProp}`) so the prop is omitted from Flight's
  serialized prop bag rather than appearing as the
  `"$undefined"` sentinel. Wire bytes drop accordingly.
- `PartialBoundary`'s `emittedFp` is `undefined`, so
  `computeFpUpdates` in `fp-trailer.ts` (which already skips
  `!snap.emittedFp`) omits the spec from the trailer.
- `registerClientPartial` is guarded by
  `if (this.props.partialFingerprint)`, so no entry lands in
  `_currentPageFingerprints` for the id.
- the manifest accessors (`getAllCachedPartialTokens` /
  `getCachedPartialIds`) therefore produce no `id:matchKey:fp`
  triple for the spec.

Critically, **the descendant fold still folds non-addressable
specs in**. Snapshots are recorded unconditionally
(`registerPartial` runs from every `<PartialBoundary>`), so the
parent's `computeDescendantFold` picks up the child's `varyKey` +
dep-record contributions. The parent's wire fp moves
whenever a non-addressable child's deps would have moved — so
fp-skipping the parent never serves a stale child. The gate
only collapses the *wire identity*, never the structural one.

The gate is computed once at spec construction time
(`addressable = options.selector !== undefined ||
options.match !== undefined`) and read in the render path as
`spec.addressable`.

## Cold → warm fp drift and the trailer

A spec's fp folds in `descendantFold`, which the per-pass fold cache
resolves at fp-computation time. The fp computation runs INSIDE
`createSpecComponent` BEFORE `<PartialBoundary>` registers the spec —
so on the FIRST render of a route in a fresh scope, no descendants of
this spec are in the snapshot set yet (they render later in the tree).
The fold is empty; the spec emits `fp_cold`.

That same top-down ordering is what makes the per-pass fold cache
transparent. The fold reads its descendants from the **fold base** —
the canonical (prior-commit) snapshots for the route, built once per
pass by `getFoldBaseSnapshots`, NOT the live `pendingWrites` overlay.
Because every ancestor renders before any of its descendants
re-register this pass, an ancestor never sees a descendant's
this-pass `pendingWrites` entry anyway; folding the overlay in would
be a no-op, so the base stays canonical-only and is memoized for the
whole pass. The fold then walks a per-pass `ancestor → descendants`
index (so each fold is O(its descendants), a leaf O(1)) and a per-pass
contribution memo (each descendant's params/dep/hash work runs once,
since a descendant's contribution depends only on `(descId, snap,
current request)`, never on which ancestor folds it). The fingerprints
are byte-identical to a per-call full-snapshot rebuild + scan; the
cache only removes the O(N²) tax of redoing that work per parton.

After the render commits, every spec on the page has a snapshot. The
same spec on the next request would compute a non-empty fold and a
different `fp_warm`. Without intervention, the client sends `fp_cold`
on the next visit, the server computes `fp_warm`, mismatch — and the
client pays a wasted body re-run.

The **fp-trailer** ships the cold→warm drift to the client in the SAME
response. Each entry is a `{from, to}` pair — `from` is the cold fp the
body emitted, `to` the recomputed warm fp (see `FpUpdate` in
`fp-trailer-marker.ts`). It rides as an HTML comment after `</html>`:

```html
</html><!--fp-trailer:{"magento":{"from":"<fp_cold>","to":"<fp_warm>"}}-->
```

The server-side machinery (`wrapSsrStreamWithFpTrailer` in
`framework/src/lib/fp-trailer.ts`):

1. Captures the request URL + scope at wrap time.
2. On stream flush (after `commitRequestRegistry` has fired),
   re-reads the route's snapshot set from the canonical store and
   recomputes each spec's fp via `recomputeFp` — same formula as the
   render-time path, but against the post-commit snapshot map.
3. For every spec where `recomputed !== emittedFp`, emits
   `{from: emittedFp, to: recomputed}` into the trailer JSON. Specs
   with no descendants (leaves) typically produce no drift; specs with
   descendants typically do.

The client-side `_applyFpTrailerFromDocument` (in
`framework/src/lib/partial-cache.ts`) scans `document.childNodes` +
`document.documentElement.childNodes` for the comment, parses the JSON,
and for each entry aliases `to` (warm) onto whichever `(id, matchKey)`
slot's fp set still holds `from` (cold) — matched by CONTENT, not by
"most recently rendered". The slot now carries BOTH `fp_cold` (from PEB
hydration) and `fp_warm` (from the trailer); the manifest advertises
both and the server's `shouldSkip` matches whichever applies.

Matching by `from` is load-bearing for concurrency. The trailer is
async — it lands after its response's body has committed. A concurrent
refetch for a DIFFERENT query against the same stable `(id, matchKey)`
(e.g. two search queries sharing a tracked-read+cell stage's constant matchKey)
can overwrite the slot — and clear its fp set — between the body commit
and the trailer. A "latest matchKey" heuristic would then pin this warm
fp onto the superseded slot, so the manifest would advertise a fingerprint
whose content the slot no longer holds; a server fp-skip on it restores
the wrong node. Content-matching drops such a superseded trailer (no
slot holds `from`), keeping the advertised fp-set in lockstep with the
node each slot actually holds — the invariant that makes every fp-skip
safe. This is exactly the search type→backspace stale-result guard in
`e2e-testing/e2e/search-result-ordering.spec.ts` and the unit
reproduction in `partial-client-fp-desync.test.tsx`.

Comment-after-`</html>` is parsed late under streaming HTML — by the
time hydration runs the comment may not yet be in the DOM.
`_applyFpTrailerFromDocument` retries on the `load` event, which only
fires once the response body has been fully consumed; the additive
nature of `registerClientPartial` makes the double-scan safe.

Two transports, both at the same routeKey-bound flush hook:

- **SSR HTML response**: `<!--fp-trailer:JSON-->` comment after
  `</html>` (see `wrapSsrStreamWithFpTrailer`). Picked up by
  `_applyFpTrailerFromDocument` at hydration time, or — when the
  parser hasn't reached the trailing comment by then — on the
  subsequent `load` event.
- **RSC response (the attach's held stream *and* action POSTs)**:
  per-segment trailer entries after the Flight bytes (see
  `wrapStreamWithFpTrailer`,
  `wrapStreamWithCommitOnly`, and `splitSegments`). Each entry is
  framed as `\xFF[parton:tag:length]\n<length-byte body>` — one
  UTF-8-invalid lead byte (`\xFF` cannot occur inside Flight JSON)
  followed by an ASCII bracketed header readable in tcpdump / curl.
  Entry tags: `fp` (fp updates), `url` (server-pushed URL push);
  the milestone tags (`next`, `settled`, `lanes`, `mux`, `muxend`)
  belong to the live-connection wire shape — see
  [`streaming.md`](./streaming.md). `splitSegments` is a
  no-holdback splitter — chunks forward to Flight immediately, so
  progressive rows stream with their original timing, and trailer
  bytes are peeled off the tail as they arrive.

Action POSTs use `wrapStreamWithCommitOnly`, which emits a `url`
trailer when the action body called `getServerNavigation().navigate(...)`
and otherwise emits no trailer entries. The browser-side
`setServerCallback` runs the response through `splitSegments` (same
splitter the attach path uses) so the `url` entry reaches the client,
where `applyStandardTrailers` (`segment-trailers-client.ts`)
applies it via `_windowNav().navigate(url, { history, silent:
true })` — the Navigation API, never the History API, so
`currentEntry` stays in sync and the page-level intercept stands
down. Cold→warm fp drift on the action-response wrappers is still
recovered via PEB-prop hydration on the next visit — action POSTs
deliberately omit the `fp` trailer to keep the response
single-segment and short.

An action whose every cell write went to a [`deferred`](../reference/cells.md#deferred-stream-only-writes)
cell takes this further: the entry renders `root: null` (no tree at
all), and the client's `setServerCallback` skips the commit
(`if (payload.root != null) setPayload(payload)`) while still reading
`returnValue`. The change reaches the page over the held live
connection instead. See [`streaming.md`](./streaming.md) § "Deferred
(stream-only) writes".

## Stream-driven commit timing

`commitRequestRegistry` runs on stream flush — not when the request
handler returns. Flight's `renderToReadableStream` returns its stream
eagerly while the actual render runs lazily as bytes are pulled, so
the handler returns with `pendingWrites`/`pendingHints` empty. Each
registry context commits exactly once (the `committed` latch); a
commit fired at handler-return time would consume that latch on an
empty buffer, so this render's registrations and invalidations would
never be applied — and the fp-trailer's flush-time recompute (which
reads the committed canonical store) would run against a store the
render never updated.

The wrappers in `fp-trailer.ts`
(`wrapStreamWithCommitOnly`, `wrapStreamWithFpTrailer`,
`wrapSsrStreamWithFpTrailer`) call `deferRequestRegistryCommit()`
internally, which sets a flag on the request context that suppresses
the runWithRequestAsync auto-commit. Commit then fires when the
TransformStream's `flush` callback runs — which only happens after
the upstream Flight render has emitted its last chunk, by which point
every spec has registered.

## Error containment

The per-partial `<PartialErrorBoundary>` wraps the *resolved body*
only. Props cell resolution (`await resolveCellValue`) and the
synchronous `Render` call both run earlier in the spec component —
above where that boundary sits in the returned tree. A React error
boundary catches throws from its descendants, so it cannot catch a
throw from the component that *renders* it. Uncaught, such a throw
propagates to the RSC entry and takes down the whole render (cold
loads 500; client navigations hit the global boundary).

So `createSpecComponent` wraps the resolver: the exported `Component`
is a thin shell that `await`s the inner `renderSpec` in a `try/catch`.
An uncaught throw becomes a `<PartialErrorCard>` (the same card the
boundary renders) in the parton's place — containment without
disturbing the success-path tree shape, so the client wrapper-walker,
fp registration, and Activity keying are all unchanged on the happy
path. The catch rethrows `__framework`-branded errors
(`NotFoundError` / `RedirectError` / `NavigationError`) so route
controls still reach the entry / host boundary. A throw from a child
that streams *after* `renderSpec` returns is still caught by the inner
`PartialErrorBoundary`.

The client has a counterpart for a different failure: a superseding
navigation tears the in-flight RSC Flight stream while React is
rendering the prior payload, which the Flight client surfaces as
`"Connection closed."` (not a clean `AbortError`) — thrown during
render, so no `.catch` sees it. `<NavigationErrorBoundary>` (framework;
wrapped around `payload.root` *inside* the host's browser root, so the
payload state and heartbeat survive a recovery) classifies that family
(`isTransientNavError`: connection-closed, torn Suspense, abort,
concurrent-commit `removeChild`/`insertBefore`) and remounts its
children against the now-current payload, bounded by a recovery budget.
Genuine errors, and a tear that never settles, rethrow to
`<GlobalErrorBoundary>`. It can't rescue a *deferred* part whose server
render fails and closes the whole payload stream — there's no intact
payload to remount — so that surfaces the error page; the durable fix
is server-side containment at the failing partial.
