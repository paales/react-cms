# Cache internals

`<Cache>` is an internal wrapper applied when a spec sets `cache`
in its options. It sits between the spec's body and the rendered
output; authors don't render it directly.

## One path: strip on store, splice on hit

A cached region is stored once and replayed once — there is no
"streaming vs dynamic" mode choice. The mechanism is byte-level, in
`framework/src/lib/flight-graph.ts`, and never decodes the cached
bytes to a React tree (which would force every Suspense boundary to
resolve — the flatten):

- **Store (miss).** Render the body to Flight bytes, then
  `stripHoles`: find every inner-parton boundary, replace it with an
  `<i hidden data-partial-id>` placeholder row, and GC the content it
  referenced. The stored payload is the lean, stable scaffolding.
- **Hit.** `spliceHoles` streams the stored scaffolding back row by
  row and, at each placeholder, splices a freshly-rendered parton —
  renumbered into a private id lane (its root takes the placeholder's
  seam id, so the parent's `$L` reference resolves to the fresh
  render) and deduped against the scaffold's client-module / symbol
  rows. The fresh render's own Suspense streams as its bytes arrive.

A region with no inner partons strips to zero holes, and `spliceHoles`
degenerates to passing the stored bytes straight through — the
streaming-preservation case, same path. So the cached frame is always
byte-replayed (Suspense pacing intact) while any dynamic holes inside
it re-render live per request.

Both the cache and `<RemoteFrame>` stitch at the wire level;
`flight-graph.ts` is the cache's row-graph layer, `flight-rewrite.ts`
the shared line-level one. `/cache-streaming-demo` exercises the
no-hole streaming replay; `/magento` (`#products` cached, per-card
`.price` partons as live holes) exercises the splice end-to-end
(`cache-dynamic-partial-holes.spec.ts`).

## The row-graph rewriter (`flight-graph.ts`)

A Flight row references other rows by id — `$<id>`, `$L<id>`,
`$@<id>`, each optionally carrying a `:deref.path` suffix
(`$1:props:parent:path`). A rendered subtree is the transitive
closure of one root row's references. Ref rewriting JSON-walks each
row's data and remaps only true ref-strings; a literal value
beginning with `$` is escaped on the wire as `$$…`, so a price string
like `"$5.00"` is never mistaken for a reference (this is why the
rewrite can't be a regex over the text).

- **Hole detection.** A hole root is a row whose *top-level* element is
  the wrapper chain — `<Activity>` / `<Suspense>` (both `$…`-ref-typed)
  descending through single-element children — down to a
  `PartialErrorBoundary` (the element carrying `partialId`). In the
  cached body every such `partialId` is an inner hole; the cached spec's
  own boundary sits *outside* the `<Cache>` wrap. The descent stops at
  content (a string-typed HTML element, or a multi-child array), so a
  content row that merely *inlines* a synchronous parton among its
  children isn't mis-stripped — that parton freezes as cached content.
  Dynamic holes fetch, hence suspend, hence always outline, so this
  never costs a real hole.
- **Strip + GC.** Rewrite each hole root to the placeholder element,
  then mark-and-sweep from the root (`0`): rows no longer reachable —
  the frozen hole content — are dropped, so the stored payload never
  carries content the splice will replace.
- **Renumber + dedup.** Each spliced hole's rows are renumbered into
  an interleaved id lane above the scaffold's `maxId` — hole *i* of
  *H* maps a fresh internal id *n* to `maxId + 1 + n*H + i`, so each
  hole owns one residue class mod *H* and lanes stay disjoint for any
  *n* (a deep render that emits large internal ids can't overrun an
  adjacent hole's range). Rows the scaffold already declares (client-module `I`
  rows, `$S` symbol rows — matched by data string) are dropped and the
  fresh refs routed to the scaffold's id, so splicing doesn't grow the
  payload. Precomputed-at-store-time facts (`maxId`, the shared-row
  map) ride in the entry as `SpliceMeta` so the splice never has to
  rebuffer the scaffold.

Every wire fact this machinery assumes (row framing and its
length-prefixed `T`-row exception, ref grammar, `$$` escaping, `I` /
`$S` row shapes and their flush order, hex row ids, the client's
first-wins tolerance of duplicate rows) is asserted against the real
Flight runtime's output by the conformance canary
`framework/src/lib/__tests__/flight-format-canary.rsc.test.tsx` — a
format change in a React upgrade fails there by name before it can
corrupt a splice.

## Entry shape

```ts
interface Entry {
  bytes: Uint8Array          // stripped scaffolding (holes are placeholders)
  holes: StoredHole[]        // inner partons to splice live, in document order
  meta: SpliceMeta           // { maxId, shared } — renumber/dedup facts
  expiresAt: number
  staleUntil: number
}
interface StoredHole {       // HoleRef + the registry snapshot
  rowId: string              // the seam id the parent `$L`s
  partialId: string
  snapshot: PartialSnapshot  // parentPath/frameChain drive the fresh render
}
```

On a hit, `replayEntry` first `registerPartial`s each hole's snapshot,
so the parton stays addressable for `reload({selector})` and
cache-mode reads even though the cached spec's body was
short-circuited. Each hole then renders via `partialFromSnapshot`
(the same reconstruction an isolated partial-refetch uses — right
Component via the `type` fallback, parent from the snapshot, props
replay, and `__instanceId` so the re-render keeps its per-instance
wire id).

## Cache key derivation

```ts
lookup = `${spec.id}:${structuralFp}:${hash(stableStringify([matchParams]))}`
```

`structuralFp` is the spec's fingerprint folded with its descendant
fold, so it already moves when a tracked read's value, schema, props,
an invalidation bump, or any descendant's deps change — including a
descendant added or removed (via the fold). The trailing match-params
hash is a stable, legible axis on top of that.

The lookup fp folds the PRIOR render's dep record (store-and-reread);
the STORE key is computed lazily after the body has rendered,
recomputing the structural fp with the LIVE tracked-read set — so no
entry is ever keyed dep-less. On a warm record the two keys are
equal; on a cold record the lookup misses into a fresh render
(over-fetch, never stale bytes served under different read values),
and per-value entries coexist.

`hash()` is a 64-bit composite — two independent 32-bit mixers
(djb2-with-xor + FNV-1a) each run through MurmurHash3's `fmix32` and
concatenated to 16 hex chars (`framework/src/lib/hash.ts`).
`stableStringify` (`framework/src/lib/stable-stringify.ts`) canonicalizes the
hash input — distinct sentinels for `undefined` / `NaN` / `±Infinity`
/ `BigInt`, ms-encoded `Date`, sorted-content `Set` / `Map`, and
`<circular>` for self-referential structures so a malformed
key input fails loudly instead of recursing forever.

## Stale-while-revalidate

```ts
{ maxAge: 60, staleWhileRevalidate: 30 }
```

`Entry` carries `expiresAt` (now + maxAge*1000) and `staleUntil`
(expiresAt + swr*1000). On hit:

- `expiresAt > now` — fresh hit. Serve.
- `staleUntil > now` — stale-but-servable. Serve, kick off async
  refresh. The refresh runs in `refreshing: Set<string>` to dedupe
  thundering herds.
- Past both — miss.

## Miss path

`renderMissAndStore` tees the Flight stream of the rendered body:

1. **User branch** — decoded immediately, returned to the outer
   render. Inner Suspense boundaries stay lazy so the client paints
   fallbacks while async work resolves — the cold render streams
   exactly like an uncached one.
2. **Storage branch** — buffered, `stripHoles`'d, stored with each
   hole enriched by its registry snapshot. Runs in the background;
   doesn't block the user-facing latency.

Cold-miss dedupe lives in `inFlightMiss: Map<baseKey, Promise>` —
multiple concurrent requests for the same cold key share one
in-flight render.

## Slow-source diagnostic

`CacheOptions.slowSource: { perChunkMs, chunkBytes? }` (dev-only)
feeds the splice's scaffold stream in fixed-size chunks separated by a
delay. Because `spliceHoles` forwards scaffold rows at feed pace, slow
replay staggers each row's arrival at the decoder — standing in for
the latency profile a slow source (or `<RemoteFrame>` cross-origin
fetch) would produce. `/cache-streaming-demo` drives it.

## Per-scope state

The cache store, refresh set, and in-flight-miss map all live under
`ScopeState` keyed by `getScope()`. Production: every request →
`"default"` → one bucket. Dev: Playwright workers stamp per-worker
`x-test-scope` headers so parallel runs don't contend.

## HMR + clear

`vite:beforeFullReload` fires `_clearCache()` to drop every scope.
Test-only `/__test/clear-caches` endpoint forwards a per-request scope
token (or `?all=1` for everything).
