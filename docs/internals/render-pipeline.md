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
2. The page body runs; every `ReactCms.partial(...)`-returned
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

## Snapshot shape

```ts
interface PartialSnapshot {
  type: string                          // spec catalog tag
  fallback: ReactNode
  errorWith: ReactNode | undefined
  uniqueTokens: string[]
  sharedTokens: string[]
  cache?: CacheOptions
  framePath: readonly string[]
  parentFrameChain: readonly string[]   // for cache-mode reconstruction
  frameUrl?: string
  parentPath: readonly string[]
  cmsId?: string
  props?: Record<string, unknown>       // captured call-site JSX props
  varyKey?: string                      // hash of last varyResult, for descendant-fp fold
}
```

Snapshots store no JSX. They DO capture two derived bits:

- `props` — the call-site JSX props the spec was last rendered with.
  Cache-mode replays them so a child rendered via a parent wrapper
  still receives `id={...}` / `flavor={...}` etc. when the framework
  re-invokes it without going through the wrapper. A client-supplied
  `partialProps` overlay (see `?partialProps=` below) wins over the
  snapshot replay so deep refetches can change the prop. Per-scope
  state — concurrent requests from the same scope with different
  prop values for the same id could race.
- `varyKey` — hash of the spec's `varyResult` on its most-recent
  render. Feeds the descendant-fp fold so an ancestor's fingerprint
  reflects every descendant's deps. Without it, a wrapper whose own
  JSX is unchanged would fp-skip and starve its descendants of a
  re-evaluation even when their URL / CMS deps just changed.

The `varyResult` itself is NOT stored — `vary` is recomputed on the
current request inside the spec component. Cache-mode reconstruction
looks up the spec component by id (or by `type` for slot blocks)
and renders it with `{parent: {path: snap.parentPath, frameChain:
snap.parentFrameChain}}`, plus the snapshot props (overlaid by any
client-sent `partialProps` overlay).

For storage details — variant deduplication, hint table, LRU
bounds — see [`registry-internals.md`](./registry-internals.md).

## Refetch addressing

Wire params:

| Param | Carries |
|---|---|
| `partials` | `#`-token names (without `#`) |
| `tags` | `.`-token names (without `.`) |
| `cached` | `id:fp,id:fp,...` — fingerprints the client has |
| `partialProps` | JSON `{"<id>":{<propName>:<value>}}` — call-site prop overlay; overrides snapshot-replayed `props` |
| `__populateCache` | flag to re-render fresh after a server-action invalidate, repopulating the client cache |
| `__frame=...&__frameUrl=...` | session-write a frame URL before render |

`PartialRoot` resolves `partials` / `tags` against the route's
hint table to derive the union of ids to refetch. Unmatched
`#`-tokens trigger a streaming-mode fallback (so a fresh range
expansion like `?end=N+1` re-renders the page rather than producing
a registry miss).

## Fingerprint protocol

Each spec emits its `fp` via `<PartialErrorBoundary partialId,
partialFingerprint>`; the client's `_currentPageFingerprints` map
captures it. On the next nav the client serializes the map as
`?cached=`. The server's spec body skips when its current `fp` matches.

`_currentPageFingerprints` is `Map<id, Set<fp>>` — each id can carry
multiple fingerprints. The set accumulates the COLD fp (what the spec
emitted at first-render time) and the WARM fp (computed post-commit
with full descendant fold; shipped via the trailer — see below). The
server's `parseCachedFingerprints` mirrors the shape, and the fp-match
check is `cachedFps.has(fp)`.

The fp folds in:

- spec id
- vary result (stable-stringified)
- call-site JSX props (`extraProps`)
- frame URL (own and ambient)
- CMS resolved fields contribution (when `cmsId` is set)
- every previously-registered descendant spec's `varyKey` snapshot,
  resolved against the *current* request via the spec catalog's
  `match` + `vary` (transitive descendant fp propagation — an
  ancestor fp-skip can never serve a stale subtree)

Wrappers called with `outerChildren` (transparent passthrough) skip
fp-skip entirely — their output IS the children, which the JSX
parent renders directly, so there's nothing for fp-skip to gate.

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

The **fp-trailer** ships `fp_warm` to the client in the SAME response.
It rides as an HTML comment after `</html>`:

```html
</html><!--fp-trailer:{"magento":"<fp_warm>","magento-header":"<fp_warm>"}-->
```

The server-side machinery (`wrapSsrStreamWithFpTrailer` in
`framework/src/lib/fp-trailer.ts`):

1. Captures the request URL + scope at wrap time.
2. On stream flush (after `commitRequestRegistry` has fired),
   re-reads the route's snapshot set from the canonical store and
   recomputes each spec's fp via `recomputeFp` — same formula as the
   render-time path, but against the post-commit snapshot map.
3. For every spec where `recomputed !== emittedFp`, emits the drift
   into the trailer JSON. Specs with no descendants (leaves) typically
   produce no drift; specs with descendants typically do.

The client-side `_applyFpTrailerFromDocument` (in
`framework/src/lib/partial-client.tsx`) scans `document.childNodes` +
`document.documentElement.childNodes` for the comment, parses the
JSON, and calls `registerClientPartial` for each entry — adding to
the Set rather than overwriting, so the client carries BOTH `fp_cold`
(from PEB hydration) and `fp_warm` (from the trailer). The next nav's
`?cached=` carries both, and the server's `shouldSkip` matches
whichever applies.

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
- **RSC GET response**: length-prefixed binary segment after the
  main Flight bytes (see `wrapStreamWithFpTrailer` and
  `splitAtFpTrailer`). The 12-byte sentinel
  (`\xFF\xFE` + ASCII `fp-updates` + `\xFD\xFC`) marks the boundary;
  invalid UTF-8 lead bytes make it impossible for the marker to
  occur inside the Flight JSON. `splitAtFpTrailer` is a no-holdback
  splitter — chunks forward to Flight immediately, so progressive
  rows stream with their original timing, and the trailer is parsed
  from a rolling tail buffer on source-end.

Action POSTs (`renderRequest.isAction === true`) skip the trailer.
Flight stops reading once the action result row resolves; a splitter
waiting for the trailer past that point can stall under
backpressure. The cold→warm path for action POSTs falls back to the
same single-round-trip warm-up that any cold-without-trailer hits:
the next visit registers warm fps via PEB-prop hydration on the
fresh wrapper the action response emitted.

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
