# Manifest tracking

Tracked accessors (`getCookie`, `getHeader`, `getSearchParam`,
`getPathname`) record `(kind, name)` pairs into a per-Partial set
called the **access manifest**. The manifest drives two things:

- **`<Partial cache>` cache key.** The set of keys is the cache key
  surface; resolving them against the current request and hashing
  yields the cache key.
- **Structural fingerprint.** Every Partial folds its previous
  render's manifest (resolved against the current request) into
  `fp` and `structuralFp`. Plus every transitive descendant's
  manifest, so an ancestor whose JSX is unchanged still invalidates
  when a descendant's URL dep moves.

Implementation in `framework/context.ts` (`trackAccess`,
`recordAccess`, `ManifestScope`). The store the manifest lives in
moves between two scopes for two reasons.

## Two scopes, dual attribution

Every accessor call writes to BOTH scopes when both are active:

```ts
function trackAccess(kind: string, name: string): void {
  const key = `${kind}:${name}`;
  // ALS scope (Cache via runWithCacheManifest).
  const alsScope = manifestContext.getStore();
  if (alsScope) recordAccess(alsScope, key);
  // Per-request cell scope (Partial body).
  const cellScope = partialManifestCell().current;
  if (cellScope && cellScope !== alsScope) recordAccess(cellScope, key);
}
```

| Scope | Backing | Set by | Used for |
|---|---|---|---|
| ALS scope | `AsyncLocalStorage<ManifestScope>` | `<Cache>` via `runWithCacheManifest` | Cache key derivation |
| Cell scope | `React.cache(() => {current: ManifestScope \| null})` | Every `<Partial>` body | Partial structural fingerprint |

A single accessor read inside a `<Cache>` inside a `<Partial>`
attributes to BOTH:

- The Cache scope folds it into the cache key on the next render.
- The Partial scope folds it into `fp` / `structuralFp` so the
  Partial's fingerprint changes when this read changes.

The two scopes always have a **superset/subset relationship** by
construction. Cache opens its scope inside the Partial's body, so
every Cache-attributed read is also Partial-attributed. Partial-
attributed reads from outside any `<Cache>` aren't Cache-attributed,
which is correct — they don't go into the cache key but they do
need to invalidate the Partial's fingerprint.

## Why two

The distinction is propagation across `await`:

- **`<Cache>`**: opens its body inside `runWithCacheManifest`, an
  ALS scope. Cache renders content through Flight (`renderToReadable
  Stream`), which awaits internally; ALS propagates through awaits
  via `async_hooks` inheritance, so descendants' reads inside the
  Cache subtree continue to attribute correctly past awaits.
- **Per-Partial fp**: doesn't have a Flight roundtrip. The cell is
  set synchronously on Partial entry; descendants must read at the
  sync top of their bodies (before any `await`), because the cell
  drifts across awaits — a sibling Partial running between the
  ancestor's setup and the descendant's resume will have overwritten
  the cell.

This is the same constraint as the frame-scope cell: rich
propagation comes from the Flight roundtrip; the cell-mutation
pattern preserves streaming at the cost of hoisting discipline.

The result: `<Cache>` enforces hoisting via `HoistingViolationError`
on the cache-key surface only. The per-Partial fp lifts the same
rule to every Partial body.

## `recordAccess`

```ts
function recordAccess(scope: ManifestScope, key: string): void {
  if (scope.current.has(key)) return;
  if (scope.stored !== null && !scope.stored.has(key)) {
    const prevKeys = [...scope.stored].sort();
    scope.onViolation?.();
    scope.stored = null;
    throw new HoistingViolationError(scope.partialId, key, prevKeys);
  }
  scope.current.add(key);
}
```

Flow:

1. Already recorded → no-op.
2. Stored manifest exists AND key isn't in it → hoisting violation.
   Call `onViolation`, clear local stored (so further new keys this
   render don't re-throw), throw.
3. Add to current.

`scope.stored` is the previous render's manifest, seeded by the
caller. `scope.current` accumulates this render's reads.

## HoistingViolationError

```
HoistingViolationError: Partial "products" read "url:promo" on this
render, but its previous render didn't see it (previous keys:
[cookie:cart_id, header:auth]).

Two common causes:
  1. A conditional read inside this Partial's body — move the
     getCookie / getHeader / getSearchParam / getPathname call to
     the top of the body, before any branching, like a React hook.
  2. Cell drift: another Partial's body called a tracked accessor
     AFTER an `await`, by which point the per-request manifest cell
     had been overwritten by this Partial's body. The read got
     attributed to "products" by accident. Find the Partial actually
     doing the read and hoist its accessor call ABOVE the await ...
```

The error message names BOTH causes because cell-drift attributions
are misleading — the Partial named in the error is not necessarily
the one doing the read. Cell drift attributes to whichever Partial
set the cell most recently, which in async-sibling-interleave
scenarios is rarely the one with the bug.

## Self-recovery

A naive throw is sticky: the manifest captured before the throw
persists in the registry as `stored` for the next render, the same
new key gets read, the same throw fires. Browser refresh doesn't
fire HMR's `clearRegistry`; without recovery the dev has to restart
the server.

`onViolation` fixes this. The per-Partial cell scope sets it:

```ts
const manifestScope: ManifestScope = {
  current: new Set(),
  stored: previousSnap?.manifest ?? null,
  partialId: id,
  onViolation: () => {
    invalidateSnapshot(route, id);
  },
};
```

`invalidateSnapshot(route, partialId)` records an invalidation in
the per-request registry context (commit excludes the id from
canonical) AND removes the snapshot from the request's pendingWrites.
Outside a request context, drops directly from `canonical.live` and
`canonical.baseline`. Next render starts with `stored = null` for
this Partial; the hoisting check has nothing to compare against, so
the same comparison won't loop. Browser refresh recovers.

## Empty-manifest fp-skip avoidance

A Partial that fp-skips on its FIRST encounter (typically because the
client cached its fingerprint on a different route — the client
cache is id-keyed, not route-keyed) used to register a snapshot with
`manifest: stored ?? current` — and `current` is an empty Set when
the body never ran. The next render seeded `stored = empty Set`,
then the body's first tracked-accessor read tripped the hoisting
check ("new key not in `[]`"). The editor's `cms-edit-fields`
exhibited this on cross-route nav into a `?select=` URL.

Fix: the fp-skip register path uses `manifest: stored ?? undefined`.
When there's no prior render to carry forward, the snapshot stores
`undefined` instead of an empty Set; the next render seeds
`stored = null` (no comparison) and the body discovers its real
dependency surface freely. The fp-skip optimization itself still
fires when the structural fp matches — only the poison-empty-Set
side effect is gone.

The Cache ALS scope deliberately does NOT set `onViolation`. Cache's
Flight roundtrip + reliable ALS propagation means a hoisting
violation there is genuinely the author's bug — recovery via HMR
after the fix is the right model. The cell scope sets it because
cell-drift attributions can blame the wrong Partial, and the
violation becomes unrecoverable without an automatic clear.

## Manifest store and resolution

The cache layer keeps its own store:

```ts
manifestStore: Map<string, Set<string>>
//             ^^^ baseKey (id:fingerprint:idsHash) → manifest keys
```

On a hit, the prior manifest comes from the store. On a miss, the
fresh manifest is captured during render and written back. On SWR
refresh, the same flow runs in a separate ALS scope.

`resolveManifest(manifest, request?)` resolves each key against a
request:

```ts
for (const spec of manifest) {
  const colonIdx = spec.indexOf(":");
  const kind = spec.slice(0, colonIdx);
  const name = spec.slice(colonIdx + 1);
  switch (kind) {
    case "cookie": values[spec] = readCookieFromRequest(request, name) ?? ""; break;
    case "header": values[spec] = request.headers.get(name) ?? ""; break;
    case "url":    values[spec] = url.searchParams.get(name) ?? ""; break;
    case "pathname": {
      const matched = matchRoutePattern(url.pathname, name);
      values[spec] = matched ? JSON.stringify(sortedKeys(matched)) : "";
      break;
    }
  }
}
```

Pathname keys serialize the matched params as stable-stringified
JSON — sort keys so two requests on `/p/alpha` produce identical
strings regardless of object property order.

The optional `request` argument lets callers route resolution
through a frame's request. `<Cache>` inside a frame passes the
frame's Request so URL/pathname keys resolve against the frame URL.

## Descendant manifest fold

`computeDescendantManifestKey` in `partial-component.tsx` walks the
*previous* render's snapshots looking for descendants:

```ts
function computeDescendantManifestKey(ownId, ownFrameChain, rawContent) {
  const contributions = new Map<string, string>();
  walkJsxForDescendantManifest(rawContent, ownFrameChain, contributions);
  walkRegistryForDescendantManifest(ownId, ownFrameChain, contributions);
  if (contributions.size === 0) return "";
  const sorted = [...contributions.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `|desc=${sorted.map(([id, sub]) => `${id}{${sub}}`).join(",")}`;
}
```

Two walks combine, deduped by descendant effective id:

### Static JSX walk

`walkJsxForDescendantManifest` recurses through `rawContent` looking
for `<Partial>` elements directly visible. For each, parse the
selector → effective id → look up previous-render snapshot →
resolve manifest against descendant's effective request → contribute.

Catches first-render-of-a-Partial cases where the registry doesn't
yet link the descendant via `parentPath` (because the user passed
`parent={ROOT}` instead of `parent={capturePartialContext()}`, or
because the descendant just hasn't run yet).

### Registry walk

`walkRegistryForDescendantManifest` walks every snapshot in the
previous-render registry, filtering to those whose `parentPath`
includes `ownId`. Catches dynamic Partials produced inside opaque
async components when the author threaded `parent` correctly — they
won't show up in the static JSX walk because they live inside a
function component the walk doesn't enter.

### Resolution

Each descendant's manifest resolves against the **descendant's own
effective request**:

```ts
function descendantSnapshotRequest(snap, ancestorFrameChain) {
  if (snap.framePath.length > 0) return resolveFrameRequest(snap.framePath, snap.frameUrl);
  if (ancestorFrameChain.length > 0) return resolveFrameRequest(ancestorFrameChain, undefined);
  return getRequest();
}
```

Self-framing descendant → its own frame's request. Non-framed
descendant inside a framed ancestor → ambient frame's request.
Otherwise → page request.

This matters because frame URL changes need to invalidate the
ancestor's fp. If the ancestor folded the descendant's manifest
against the page request, a frame-URL change wouldn't propagate up.

### Over-folding bias

A snapshot that USED to live under this ancestor but no longer does
still contributes until the next render swaps in a fresh "previous"
map. The cost is extra re-renders (over-invalidation). The benefit
is never serving stale subtrees on fp-skip. Always favor over-
invalidation in this kind of resolution.
