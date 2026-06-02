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
3. The spec's body re-runs (vary, fingerprint, skip / render). No
   ancestor execution.
4. On commit, the routeKey's hint is patched (not replaced) — ids
   that didn't refetch keep their existing variant pointers.

## Both modes share one payload root

Whatever the mode, `PartialRoot` returns the SAME outer shape:
`<PageUrlProvider url={request.url}><PartialsClient mode=…>…`. The
root element type must match across modes, because a single page can
hold two live connections that commit onto the same React root as
alternating `BrowserRoot` payloads:

- the chat overlay's frame refetch becomes a `markConnectionLive`
  long-poll and commits in **cache mode**;
- the page heartbeat holds a `?streaming=1` connection that also
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
  varyKey?: string                      // hash of last varyResult, for descendant-fp fold
}
```

Snapshots store no JSX. They DO capture two derived bits:

- `props` — the call-site JSX props the spec was last rendered with.
  Cache-mode replays them so a child rendered via a parent wrapper
  still receives `id={...}` / `flavor={...}` etc. when the framework
  re-invokes it without going through the wrapper. Request-dependent
  inputs flow through `vary` / `match` / cells, which re-resolve on
  the refetch.
- `varyKey` — hash of the spec's `varyResult` on its most-recent
  render. Feeds the descendant-fp fold so an ancestor's fingerprint
  reflects every descendant's deps. Without it, a wrapper whose own
  JSX is unchanged would fp-skip and starve its descendants of a
  re-evaluation even when their URL / CMS deps just changed.

The `varyResult` itself is NOT stored — `vary` is recomputed on the
current request inside the spec component. Cache-mode reconstruction
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
[`partial-client.tsx::cacheStore`](../../framework/src/lib/partial-client.tsx))
and the next nav can fp-skip against a stale entry while the cache
slot points at fresh content, surfacing the wrong subtree on
substitution. The async warm-fp trailer upholds the same invariant by
aliasing its warm fp onto the slot still holding the matching cold fp
rather than the latest-rendered one (see *Cold → warm fp drift* below) —
so a trailer from a query a concurrent refetch already superseded is
dropped, not mis-attached.

The fp folds in:

- spec id
- vary result (stable-stringified)
- call-site JSX props (`extraProps`)
- frame URL (own and ambient)
- CMS resolved fields contribution (for `block` specs;
  folded in via the wrapper's `vary` augmentation, keyed by the
  instance's `__instanceId`)
- every previously-registered descendant spec's `varyKey` snapshot,
  resolved against the *current* request via the spec catalog's
  `match` + `vary` (transitive descendant fp propagation — an
  ancestor fp-skip can never serve a stale subtree). The
  descendant's request is frame-resolved through its stored
  `framePath` so a nested-frame nav that moves only an inner
  frame's URL still shifts the descendant's contribution — without
  this, an outer `match`/`vary`-stable wrapper would fp-skip and
  freeze a cached inner-frame body in place

Wrappers called with `outerChildren` (transparent passthrough) skip
fp-skip entirely — their output IS the children, which the JSX
parent renders directly, so there's nothing for fp-skip to gate.

## Addressable gate

A spec is *externally addressable* iff the author explicitly
declared at least one of `selector`, `vary`, or `match`. Specs
declaring none of the three are non-addressable: they have no
external refetch handle (`reload({selector})` requires a declared
selector, session/tag invalidation requires `vary` deps,
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
parent's `computeDescendantFold` picks up the child's `varyKey`
contributions. The parent's wire fp moves
whenever a non-addressable child's deps would have moved — so
fp-skipping the parent never serves a stale child. The gate
only collapses the *wire identity*, never the structural one.

The gate is computed once at spec construction time
(`addressable = options.selector !== undefined ||
options.vary !== undefined || options.match !== undefined`) and
read in the render path as `spec.addressable`.

## Cold → warm fp drift and the trailer

A spec's fp folds in `descendantFold`, which reads
`getRouteSnapshots()` at fp-computation time. The fp computation
runs INSIDE `createSpecComponent` BEFORE `<PartialBoundary>` registers
the spec — so on the FIRST render of a route in a fresh scope, no
descendants of this spec are in the snapshot map yet (they render
later in the tree). The fold is empty; the spec emits `fp_cold`.

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
`framework/src/lib/partial-client.tsx`) scans `document.childNodes` +
`document.documentElement.childNodes` for the comment, parses the JSON,
and for each entry aliases `to` (warm) onto whichever `(id, matchKey)`
slot's fp set still holds `from` (cold) — matched by CONTENT, not by
"most recently rendered". The slot now carries BOTH `fp_cold` (from PEB
hydration) and `fp_warm` (from the trailer); the next nav's `?cached=`
carries both and the server's `shouldSkip` matches whichever applies.

Matching by `from` is load-bearing for concurrency. The trailer is
async — it lands after its response's body has committed. A concurrent
refetch for a DIFFERENT query against the same stable `(id, matchKey)`
(e.g. two search queries sharing a vary+cell stage's constant matchKey)
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
