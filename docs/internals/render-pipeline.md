# Render pipeline

The framework runs every page through `<PartialRoot>` in either
**streaming mode** (full render) or **cache mode** (partial
refetch).

## Streaming mode

Triggered when no `?partials=` / `?tags=` filter is set, or when
the filter doesn't resolve to any registered spec id (registry
miss).

1. `PartialRoot` opens a request-scoped registry context (`mode:
   "streaming"`).
2. The page body runs; every `parton(...)`-returned
   component encountered renders fresh.
3. Each spec computes its fingerprint and either:
   - Skips (emits a placeholder) when its fingerprint matches the
     client's cached fp.
   - Renders, registering a snapshot via `<PartialBoundary>`.
4. On stream flush, `commitRequestRegistry` writes the rendered
   snapshots to the deduplicated variant store and replaces the
   current routeKey's hint wholesale (so ids no longer on the
   page drop off the hint). The routeKey is the hash of matched
   URLPatterns for the request URL, not the URL itself — see
   [`registry-internals.md`](./registry-internals.md).

## Cache mode

Triggered by a refetch with `?partials=` or `?tags=` resolving to
ids the route's hint table knows about.

1. `PartialRoot` opens a request-scoped registry context (`mode:
   "cache"`).
2. For each requested id, look up the snapshot via the routeKey
   hint, find the spec component (`getSpecComponentById(id)` or
   via spec catalog by `snap.type` for slot blocks), invoke it as
   a flat sibling.
3. The spec's body re-runs (match, schema, fingerprint, skip /
   render). No ancestor execution.
4. On commit, the routeKey's hint is patched (not replaced) — ids
   that didn't refetch keep their existing variant pointers.

## Both modes share one payload root

Whatever the mode, `PartialRoot` returns the SAME outer shape:
`<PageUrlProvider url={pageUrl}><PartialsClient mode=…>…`. The
root element type must match across modes, because a single page can
hold two live connections that commit onto the same React root as
alternating `BrowserRoot` payloads:

The `url` prop is the SSR / pre-hydration seed for descendant client
components' `useNavigation()` (see `PageUrlContext`) — consulted only
while `window.navigation` is absent. So `PartialRoot` only serializes it
on the **SSR document** render (where it strips framework-internal params
like `?cached=` first — those are consumed off the raw request and must
not echo back). On a client-driven `.rsc` refetch the value is never read
(the live Navigation API supersedes it), so `pageUrl` is `null` and the
whole row drops — the `?cached=` token list alone would otherwise run to
kilobytes echoed back on every navigation. The element type stays
`PageUrlProvider` either way, so the cross-mode reconciliation below holds.
`PartialRoot` distinguishes the two via the `x-parton-render` header that
`parseRenderRequest` stamps on `.rsc` requests.

- the chat overlay's frame refetch becomes a `markConnectionLive`
  long-poll and commits in **cache mode**;
- the page heartbeat holds a `?live=1` connection that also
  renders the open chat and commits in **streaming mode**.

If one payload's root were `<PageUrlProvider>` and the other a bare
`<PartialsClient>`, React would see a different element type at the
root on every segment seam and unmount + remount the whole subtree —
`page-shell` and everything under it torn down and recreated many
times a second (a full-page flicker). Identical roots let React
reconcile the two payloads in place.

`PartialsClient` carries the same requirement one level down: while a
Flight chunk is still in flight (the chat's `<ChunkSlot>` suspended),
the streaming-mode commit renders through the persisted `_template` +
cache — the exact path a cache-mode commit takes — rather than
returning raw children. Matching shapes there keep the partials
*inside* the page (e.g. the nav) reconciling too.

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

### Client module map

The client merge layer is split across focused modules under
`framework/src/lib/`; `partial-client.tsx` is the `"use client"`
boundary — it holds `PartialsClient` (the merge coordinator) and
re-exports the rest, so `@parton/framework/lib/partial-client.tsx`
stays the one import path:

| Module | Owns |
|---|---|
| `partial-client-state.ts` | ALL module-level mutable state, behind accessors: the partial cache + fingerprint maps (`cacheStore`, `registerClientPartial`, `getCachedPartialIds`, `pruneToLive`), the persisted template (`getTemplate` / `setTemplate`), the lane-commit subscription (`subscribeLaneCommits` / `notifyLaneCommit`), the in-flight registry (`abortPredecessors`), and the frame-URL cache. |
| `partial-cache.ts` | The tree walks: wrapper/placeholder detection, `harvestPartialIds`, `cacheFromStreamingChildren`, `substituteNested`, `unwrapLazy` + the `LAZY_PENDING` sentinel, `treeHasPendingLazy`, warm-preload (`_warmCacheFromPayload`), the per-parton lane commit (`_commitPartonLane` — synchronous cache walk + fp updates + the notify that re-renders `PartialsClient`; see [streaming.md](./streaming.md)) and the fp-trailer DOM scan. |
| `partial-template.tsx` | `deriveTemplate` + `renderTemplate`. |
| `refetch.ts` | `enqueueRefetch` (microtask-batched targeted refetch → `?partials=`), selector parsing, the silent-navigation info brand. |
| `frame-client.tsx` | The frames tree on the nav entry (read/write + the write serialiser), `FrameNameProvider`, frame refetch dispatch, and the window/frame imperative handle builders. |
| `use-navigation.tsx` | The `useNavigation()` hook layer (`[fire, progress]` tuples, `@self` resolution, preload), `useActivate`, `useScrollRestore`, `PageUrlContext`, `PartialIdContext`. |

### Bounding the client cache (and the pending-lazy guard)

Both commit paths bound `_currentPagePartials` / `_currentPageFingerprints`
to what the rendered page actually references, so a superseded variant
(a churned-away instance id, an evicted match variant) stops being
advertised in `?cached=`. The streaming-mode path prunes against the
walk's `seen` set; the cache-mode path harvests the rendered tree
(`renderTemplate` output) and drops anything not present.

Both prune **only on a complete render**. A substituted cache wrapper
can still carry an in-flight Flight lazy — a slow descendant (a search
stage, the chat's `<ChunkSlot>`) hadn't resolved when the wrapper was
last cached. The partials *behind* that lazy are still live but aren't
materialised in the rendered tree, so a harvest under-counts them.
Pruning then would evict their cache + advertised-fp entries, and the
next render's fp-skip placeholder would have nothing to substitute —
blanking the region until a full re-render restores it (the "content
behind the search disappears" bug). The streaming-mode path gets this
for free (it prunes only in its non-pending branch); the cache-mode
path guards explicitly via `treeHasPendingLazy(rendered)` and defers
the prune to a later commit whose render is whole.

## Preload (warm-only client commit)

`useNavigation().preload(target)` (see
[`frames-navigation.md`](../reference/frames-navigation.md) §Preload)
adds **no server mode**. Its server render is an ordinary
**streaming-mode** render of the destination URL, issued with the
client's current `?cached=` set — so shared chrome and parked off-route
partials fp-skip and only the destination-specific partials come down
fresh.

What's new is a **third client commit path** alongside streaming and
cache mode. The browser entry decodes the preload response and hands
each payload to `_warmCacheFromPayload`, which runs the same cache walk
(`cacheFromStreamingChildren`) the streaming-mode commit uses — filling
`_currentPagePartials` (subtrees) and `_currentPageFingerprints` (the fp
set `?cached=` advertises) — but **without** `setPayload`, without
deriving a `_template`, and without touching the visible tree. Nothing
mounts; no effects run. A later navigation to the destination then
fp-skips the warmed partials (their fps are now in `?cached=`) and
`renderTemplate` substitutes them from cache on the first commit, while
the nav revalidates against the server as usual.

Once warmed, the destination's ids ride in `?cached=` on every
subsequent request, so the cross-route keepalive path emits hidden
`<Activity>` placeholders for them on the current page's next render
(e.g. the heartbeat) — the preloaded subtree pre-mounts (DOM present,
effects deferred) ahead of the click, for free.

## Snapshot shape

```ts
interface PartialSnapshot {
  type: string                          // spec catalog tag
  fallback: ReactNode
  labels: string[]                      // refetch labels (selector)
  cache?: CacheOptions
  framePath: readonly string[]
  parentFrameChain: readonly string[]   // for cache-mode reconstruction
  parentPath: readonly string[]
  props?: Record<string, unknown>       // captured call-site JSX props
  constraintArgs?: Record<string, unknown> // bound-cell args, for invalidation matching
  varyKey?: string                      // stringified match params, for the descendant-fp fold
  deps?: ReadonlySet<string>            // tracked-read dep keys recorded this render
  matchKey?: string                     // variant key (hash of match params)
  schemaKey?: string                    // resolved-cell fp term, for the trailer's recompute
  emittedFp?: string                    // fp the render emitted (drift detection)
  wakeHints?: WakeHints                 // live box written by expires()/staleUntil()
}
```

Snapshots store no JSX. The derived bits that matter most:

- `props` — the call-site JSX props the spec was last rendered with.
  Cache-mode replays them so a child rendered via a parent wrapper
  still receives `id={...}` / `flavor={...}` etc. when the framework
  re-invokes it without going through the wrapper. Request-dependent
  inputs flow through tracked reads / `match` / cells, which
  re-resolve on the refetch.
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
against the current request. Cache-mode reconstruction
looks up the spec component by id (or by `type` for slot blocks)
and renders it with `{parent: {path: snap.parentPath, frameChain:
snap.parentFrameChain}}`, plus the snapshot props.

For storage details — variant deduplication, hint table, LRU
bounds — see [`registry-internals.md`](./registry-internals.md).

## Refetch addressing

Wire params:

| Param | Carries |
|---|---|
| `partials` | Selector labels (cosmetic `#`/`.` stripped). Resolves against snapshot `labels` AND `id` for fan-out targeting. |
| `cached` | `id:matchKey:fp,…` — fingerprints the client has |
| `__frame=...&__frameUrl=...` | session-write a frame URL before render |

After a server action commits, refetch routing is driven entirely by
the invalidation registry — actions call `getServerNavigation().reload({selector})`
in-body (queued inside the action's `runInvalidationTransaction`),
and the response render computes fresh fps for any partial whose
selector matches. Cold clients (no `?cached=`) receive the full root
tree; warm clients get fp-skip placeholders for everything unchanged.
No URL-rewrite step in between.

`PartialRoot` resolves `partials` against the route's hint table to
derive the union of ids to refetch — direct id match plus any
snapshot whose label list contains a wanted token. Unmatched tokens
trigger a streaming-mode fallback (so a fresh range expansion like
`?end=N+1` re-renders the page rather than producing a registry
miss).

## Selector-refetch commit ordering

Window-scoped selector refetches (`navigate({selector})` /
`reload({selector})`) are **not aborted on supersede** — aborting one
mid-decode rejects its whole Flight document and tears the page through
the error boundary. So a burst of fires (every search keystroke, a
rapidly-clicked refresh) all drain and commit. Their responses can
arrive **out of order**, so the framework must commit them in **issue
order, not arrival order**: a late older fire must not clobber a newer
one.

The arbiter is a monotonic per-selector issue sequence
(`lib/refetch-ordering.ts`). The refetch dispatcher
(`flushRefetchBatch`) stamps each fire with `nextRefetchSeq(key)` —
`key` is the sorted label set, matching `?partials=` — and hands the
host a commit gate bound to that seq. Before every segment commit the
host calls `claimRefetchCommit(key, seq)`, which returns `false` once a
newer seq has committed for that selector; a dropped commit is skipped
(trailers included) while the stream still drains.

This is the real signal, not the page-URL staleness check that sits
beside it. `pageUrlKey` drops a commit when the page **navigated away**
since the fire was issued (cross-nav staleness); it cannot order two
fires for the **same** URL — exactly the case that matters for live
server state, where a `reload({selector})` of a cell-backed or
time-varying partial returns different content on each fire of one URL.
The two guards are complementary: `pageUrlKey` for cross-navigation,
the issue sequence for same-selector supersession.

The fires are still not aborted, so a burst holds its connections until
each drains — superseded work isn't cancelled, only its commit is
dropped. That's a deliberate safety tradeoff (cancelling a committed
fire's stream would tear its visible tree); the cost is bounded
because superseded fires fp-skip to near-empty bytes.

## Fingerprint protocol

Each spec emits its `fp` via `<PartialErrorBoundary partialId,
partialFingerprint>`; the client's `_currentPageFingerprints` map
captures it. On the next nav the client serializes the map as
`?cached=`. The server's spec body skips when its current `fp` matches.

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

The fp folds in:

- spec id
- match params (`matchKey` plus their stable-stringified values)
- the prior render's recorded dep keys, re-read at the current
  request (store-and-reread) — cookies, search params, headers,
  pathname / `match()` reads, session, visibility, tags, and custom
  dep kinds (the CMS layer's `cms:<contentKey>` content hash, which
  is how a block's resolved fields move its fp)
- resolved schema cells (`schemaKey`: cell-id × partition × value)
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

Wrappers called with `outerChildren` (transparent passthrough) skip
fp-skip entirely — their output IS the children, which the JSX
parent renders directly, so there's nothing for fp-skip to gate.

## Addressable gate

A spec is *externally addressable* iff the author explicitly
declared at least one of `selector`, `schema`, or `match`. Specs
declaring none of the three are non-addressable: they have no
external refetch handle (`reload({selector})` requires a declared
selector, cell/session invalidation binds through `schema`,
URL-driven variant carve-out requires `match`). Auto-derived
selectors from `Render.name` don't count — they only exist to
give the spec catalog a unique id.

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
- `getCachedPartialIds()` therefore produces no
  `id:matchKey:fp` triple for the spec on the next nav's
  `?cached=`.

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
options.schema !== undefined || options.match !== undefined`) and
read in the render path as `spec.addressable`.

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
hydration) and `fp_warm` (from the trailer); the next nav's `?cached=`
carries both and the server's `shouldSkip` matches whichever applies.

Matching by `from` is load-bearing for concurrency. The trailer is
async — it lands after its response's body has committed. A concurrent
refetch for a DIFFERENT query against the same stable `(id, matchKey)`
(e.g. two search queries sharing a tracked-read+cell stage's constant matchKey)
can overwrite the slot — and clear its fp set — between the body commit
and the trailer. A "latest matchKey" heuristic would then pin this warm
fp onto the superseded slot, so `?cached=` would advertise a fingerprint
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
- **RSC response (GET *and* action POST)**: per-segment trailer
  entries after the Flight bytes (see `wrapStreamWithFpTrailer`,
  `wrapStreamWithCommitOnly`, and `splitSegments`). Each entry is
  framed as `\xFF[parton:tag:length]\n<length-byte body>` — one
  UTF-8-invalid lead byte (`\xFF` cannot occur inside Flight JSON)
  followed by an ASCII bracketed header readable in tcpdump / curl.
  Tags today: `fp` (fp updates), `url` (server-pushed URL push),
  `next` (segment delimiter, length 0). `splitSegments` is a
  no-holdback splitter — chunks forward to Flight immediately, so
  progressive rows stream with their original timing, and trailer
  bytes are peeled off the tail as they arrive.

Action POSTs use `wrapStreamWithCommitOnly`, which emits a `url`
trailer when the action body called `getServerNavigation().navigate(...)`
and otherwise emits no trailer entries. The browser-side
`setServerCallback` runs the response through `splitSegments` (same
splitter the GET path uses) so the `url` entry reaches the client
and gets applied via `history.{push,replace}State`. Cold→warm fp
drift on the action-response wrappers is still recovered via PEB-prop
hydration on the next visit — action POSTs deliberately omit the
`fp` trailer to keep the response single-segment and short.

An action whose every cell write went to a [`deferred`](../reference/cells.md#deferred-stream-only-writes)
cell takes this further: the entry renders `root: null` (no tree at
all), and the client's `setServerCallback` skips the commit
(`if (payload.root != null) setPayload(payload)`) while still reading
`returnValue`. The change reaches the page over the open heartbeat
stream instead. See [`streaming.md`](./streaming.md) § "Deferred
(stream-only) writes".

## Stream-driven commit timing

`commitRequestRegistry` runs on stream flush — not when the request
handler returns. Flight's `renderToReadableStream` returns its stream
eagerly while the actual render runs lazily as bytes are pulled, so
the handler returns with `pendingWrites`/`pendingHints` empty. If
commit fired at handler-return time, it would replace the route's
hint with the empty set — wiping the prior render's snapshots and
forcing the next request to recompute every spec's fold against
canonical state that's been eroded.

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
only. Schema/props cell resolution (`await resolveCellValue`) and the
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
