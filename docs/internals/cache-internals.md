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

- **Hole detection.** A hole root is a row whose _top-level_ element is
  the wrapper chain — `<Activity>` / `<Suspense>` (both `$…`-ref-typed)
  descending through single-element children — down to a
  `PartialErrorBoundary` (the element carrying `partialId`). In the
  cached body every such `partialId` is an inner hole; the cached spec's
  own boundary sits _outside_ the `<Cache>` wrap. The descent stops at
  content (a string-typed HTML element, or a multi-child array), so a
  content row that merely _inlines_ a synchronous parton among its
  children isn't mis-stripped — that parton freezes as cached content.
  Dynamic holes fetch, hence suspend, hence always outline, so this
  never costs a real hole.
- **Strip + GC.** Rewrite each hole root to the placeholder element,
  then mark-and-sweep from the root (`0`): rows no longer reachable —
  the frozen hole content — are dropped, so the stored payload never
  carries content the splice will replace.
- **Renumber + dedup.** Each spliced hole's rows are renumbered into
  an interleaved id lane above the scaffold's `maxId` — hole _i_ of
  _H_ maps a fresh internal id _n_ to `maxId + 1 + n*H + i`, so each
  hole owns one residue class mod _H_ and lanes stay disjoint for any
  _n_ (a deep render that emits large internal ids can't overrun an
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
  bytes: Uint8Array // stripped scaffolding (holes are placeholders)
  holes: StoredHole[] // inner partons to splice live, in document order
  meta: SpliceMeta // { maxId, shared } — renumber/dedup facts
  expiresAt: number // option window clamped to the body's expires()
  staleUntil: number // option window clamped to the body's staleUntil()
}
interface StoredHole {
  // HoleRef + the registry snapshot
  rowId: string // the seam id the parent `$L`s
  partialId: string
  snapshot: PartialSnapshot // parentPath/frameChain drive the fresh render
}
```

On a hit, `replayEntry` first `registerPartial`s each hole's snapshot,
so the parton stays addressable for `reload({selector})` and
isolated lane reads even though the cached spec's body was
short-circuited. Each hole then renders via `partialFromSnapshot`
(the same reconstruction an isolated lane render uses — right
Component via the `type` fallback, parent from the snapshot, props
replay, and `__instanceId` so the re-render keeps its per-instance
wire id).

## Cache key derivation

```ts
lookup = `${id}:${structuralFp}:${hash(stableStringify([matchParams]))}`
```

`id` is the placement's effective render id (`__instanceId` / the
call-site-props hash included), so two placements of one spec never
share an entry.

`structuralFp` is the spec's fingerprint folded with its descendant
fold, so it already moves when a tracked read's value, a
prop-resolved cell, props, an invalidation bump, or any descendant's
deps change — including a descendant added or removed (via the
fold). The trailing match-params
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

`Entry` carries `expiresAt` (now + maxAge*1000; `+Infinity` when no
`maxAge`) and `staleUntil` (expiresAt + swr*1000), each CLAMPED to
the boundary the body's `expires()` / `staleUntil()` hooks declared
during the render (`freshEntry` reads the parton's live wake-hint box
at store time, after the body settled) — the byte-cache counterpart
of fp-skip's TTL gate. `expires()` alone clamps both windows: an
expired declaration is a hard miss, never stale-servable, because the
SWR refresh re-encodes the same settled body output rather than
re-running the parton. On hit:

- `expiresAt > now` — fresh hit. Serve.
- `staleUntil > now` — stale-but-servable. Serve, kick off async
  refresh. The refresh runs in `refreshing: Set<string>` to dedupe
  thundering herds.
- Past both — miss.

The clamp is what makes derived time-shaped bodies (a value computed
from a persisted anchor + the render clock, cadence declared with
`expires()` — the website world's pulse) safe to byte-cache: their
key never moves (no write ever bumps the cell), so without the clamp
a `maxAge` window would replay stale derived bytes while the expiry
arm dutifully re-ran the body.

## Miss path

`attemptRender` tees the Flight stream of the rendered body:

1. **User branch** — decoded immediately (`liveTree`). Inner Suspense
   boundaries stay lazy so the client paints fallbacks while async
   work resolves — the cold render streams exactly like an uncached
   one.
2. **Storage branch** — buffered; on a clean settle, `stripHoles`'d
   and stored with each hole enriched by its registry snapshot
   (`settled` resolves with the outcome). Runs in the background on
   the streaming path; doesn't block the user-facing latency.

Cold-miss dedupe lives in `inFlightMiss: Map<baseKey, Attempt>` —
multiple concurrent requests for the same cold key share one
in-flight render (`{ liveTree, settled }`).

## Error recovery (the serve-stale-on-error engine)

The contract is [`docs/reference/errors.md`](../reference/errors.md);
the mechanism lives entirely in `cacheImpl`'s miss handling:

- **The failure signal is the body promise itself.** `children` IS
  the promise `spec.Render(...)` returned (partial.tsx builds the
  element before wrapping it in `<Cache>`), so `observeBody` attaches
  a rejection handler at the source — ahead of the Flight runtime's
  own (which attaches only when the render reaches the node). On
  rejection the real error object is classified
  (`isExpectedRenderError`: sentinels / cancellation pass through)
  and, for a genuine failure during an attempt, the failure record +
  retry boundary land SYNCHRONOUSLY, mid-render — strictly before
  the error row is encoded, hence before the segment driver's
  post-drain wheel sync reads the snapshot's wake-hint box. The
  observer attaches on EVERY path (hits included: the body runs every
  render, and a discarded rejection would otherwise be an unhandled
  rejection).
- **Per-scope recovery state.** `lastGood: Map<axis, Entry>` (axis =
  `id:varyHash` — the placement's identity WITHOUT the fp, so a
  dep-moved re-render still finds the variant's good bytes; bounded
  LRU, entries shared by reference with the store) and
  `failures: Map<axis, FailureRecord>`
  (`{attempts, since, nextRetryAt, lastError}`).
- **Never store an errored body.** `attemptRender`'s settle checks
  `body.outcome` after buffering: any rejection (including sentinels)
  skips the store — an entry is always a good render, and a
  sentinel's control-channel side effect can't ride a byte replay. A
  clean store updates `lastGood` and deletes the failure record.
- **Retry = a declared boundary.** `recordFailure` folds
  `nextRetryAt` (`min(base·2ⁿ⁻¹, cap)`, default 1s/16s,
  `_setErrorRetrySchedule` for tests) into the render's live
  wake-hint box with the same earliest-wins fold `expires()` uses —
  the deadline wheel and the fp-skip TTL gate treat the errored
  snapshot like any time-shaped one. No timers, no new delivery path.
- **Miss flow.** With an error-servable `lastGood`
  (`staleIfError`-gated): inside an outstanding failure's retry
  window, serve it directly (no attempt, no loader run, no event);
  past the window, run a BUFFERED attempt — hold the response until
  `settled`, serve fresh on success, serve last-known-good on
  failure. The buffering cost is confined to exactly this path (miss
  + prior good render). With no `lastGood`, stream the attempt as
  today: the failure surfaces as the boundary card, but the retry
  boundary is already armed.
- **The marker.** A stale serve wraps `replayEntry`'s tree in
  `<PartonStaleProvider stale={{since, attempts, retryAt}}>` (a
  zero-DOM client context from partial-error-boundary.tsx) —
  `usePartonStale()` is the explicit signal UI reads.
- **SWR refresh** re-encodes the same settled body output; when this
  render's body rejected, the refresh returns without storing — a
  failing body can never clobber the good entry it would otherwise
  overwrite.
- **Observability.** One `PartonErrorEvent` per attempt via
  `onPartonError` (default: a concise `console.error` line); the raw
  error is separately digest-logged by the Flight `onError` reporter.

## Slow-source diagnostic

`CacheOptions.__slowSource: { perChunkMs, chunkBytes? }` (dev-only)
feeds the splice's scaffold stream in fixed-size chunks separated by a
delay. Because `spliceHoles` forwards scaffold rows at feed pace, slow
replay staggers each row's arrival at the decoder — standing in for
the latency profile a slow source (or `<RemoteFrame>` cross-origin
fetch) would produce. `/cache-streaming-demo` drives it.

## Per-scope state

The cache store, refresh set, in-flight-miss map, and the recovery
state (`lastGood` / `failures`) all live under `ScopeState` keyed by
`getScope()`. Production: every request → `"default"` → one bucket.
Dev: Playwright workers stamp per-worker `x-test-scope` headers so
parallel runs don't contend.

## HMR + clear

`vite:beforeFullReload` fires `_clearCache()` to drop every scope.
Incremental HMR edits never clear the cache — they don't need to: the
cache key includes the fp, and the dev-only code-version term
([`render-pipeline.md`](./render-pipeline.md) § Dev HMR) moves every
fp on a server-code edit, so post-edit renders miss and old entries
age out. Test-only `/__test/clear-caches` endpoint forwards a
per-request scope token (or `?all=1` for everything).
