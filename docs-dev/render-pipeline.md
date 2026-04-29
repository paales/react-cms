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
   route's hint table wholesale (so ids no longer on the page drop
   off this route's hint).

## Cache mode

Triggered by a refetch with `?partials=` or `?tags=` resolving to
ids the route's hint table knows about.

1. `PartialRoot` opens a request-scoped registry context (`mode:
   "cache"`).
2. For each requested id, look up the snapshot via the route hint,
   find the spec component (`getSpecComponentById(id)` or via spec
   catalog by `snap.type` for slot blocks), invoke it as a flat
   sibling.
3. The spec's body re-runs (vary, fingerprint, skip / render). No
   ancestor execution.
4. On commit, the route's hint is patched (not replaced) — ids
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
}
```

Snapshots store no JSX, and they don't capture the spec's
`varyResult` either — `vary` is recomputed on the current request
inside the spec component, and no consumer of the snapshot reads
the previous render's `varyResult`. Cache-mode reconstruction
looks up the spec component by id (or by `type` for slot blocks)
and renders it with `{parent: {path: snap.parentPath, frameChain:
snap.parentFrameChain}}`.

For storage details — variant deduplication, hint table, LRU
bounds — see [`registry-internals.md`](./registry-internals.md).

## Refetch addressing

Wire params:

| Param | Carries |
|---|---|
| `partials` | `#`-token names (without `#`) |
| `tags` | `.`-token names (without `.`) |
| `cached` | `id:fp,id:fp,...` — fingerprints the client has |
| `__populateCache` | flag to re-render fresh after a server-action invalidate, repopulating the client cache |
| `__frame=...&__frameUrl=...` | session-write a frame URL before render |

`PartialRoot` resolves `partials` / `tags` against the route's
hint table to derive the union of ids to refetch. Unmatched
`#`-tokens trigger a streaming-mode fallback (so a fresh range
expansion like `?end=N+1` re-renders the page rather than producing
a registry miss).

## Fingerprint protocol

Each spec emits its `fp` via `<PartialErrorBoundary partialId,
partialFingerprint>`; the client's `_fingerprints` map captures it.
On the next nav the client serializes the map as `?cached=`. The
server's spec body skips when its current `fp` matches.

The fp folds in:

- spec id
- vary result (stable-stringified)
- frame URL (own and ambient)
- CMS resolved fields contribution (when `cmsId` is set)
