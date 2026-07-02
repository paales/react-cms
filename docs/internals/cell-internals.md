# Cell internals

Implementation details behind the [cell primitive](../reference/cells.md):
the write pipeline, the client-side batcher, the optimistic-value
plumbing inside `useCell`, the storage backends, and the `atomic()`
transaction overlay that lets app-level multi-cell writes commit
together and ship as one segment.

## Write pipeline

A cell write — whether from server-side `cellHandle.set(v)`, the
client's per-call `resolvedCell.set(v)` server-action ref, or a
batched `useCell(cell).set(v)` — flows through one shared
implementation: `writeOneCell(cellId, value, partitionOverride?)`
in `framework/src/runtime/cell-actions.ts`.

```
validate(value)             ← throws on shape mismatch (defends against
                              malicious client writes)
↓
write(validated)             ← optional cell-declared canonicalisation
                              (server's final say on stored shape)
↓
storage.write(scope, id,     ← writes to the active scope's bucket
              partKey, v)
↓
_recordCellWrite(            ← tallies this write (and whether the cell
  cell.deferred === true)      is `deferred`) on the request store, for
                               the deferred-commit decision (below)
↓
getServerNavigation()        ← bumps the invalidation registry with
  .reload({selector:           the partition-scoped selector
    buildCellSelector(          ("cell:<id>?<argsEncoded>",
      id, args)})               constraints as the query fragment)
```

The whole pipeline runs inside a `runInvalidationTransaction`. A
throw in `validate` or `write` discards the pending refreshSelector
bumps — observers can't see a partial commit.

The emitted selector is **partition-scoped**: args are URL-encoded
as `key1=value1&key2=value2` (keys sorted). Selector matching
against the registry uses `queryMatchingTs(labels, matchParams ∪
boundArgs)` — a `cell:<id>?uid=X` write only refreshes placements
whose effective constraints contain `uid=X`. Empty args fall back to
bare `cell:<id>` (matches every placement of that cell, used for
cells with no `partition` and no `.with()`).

**Partition derivation in `writeOneCell`.** The args come from, in
priority order: an explicit `partitionOverride.partition` (the
`.with(args).set` path) → the cell's `keyOf(value)` if present (value-keyed
fragment cells: the identity lives in the value, so `cell.set(value)`
needs no restated args) → `cell.partition(scope)` (request-derived). `keyOf` is
set by `fragmentCell` from its `key` option and runs against the validated
+ `write`-transformed value.

**Deferred-commit accounting.** `_recordCellWrite(cell.deferred === true)`
increments a per-request `{total, deferred}` tally on the context store.
After the action body runs, `_actionSuppressesCommit()` reads it: true iff
`total > 0 && total === deferred` — at least one write, all to `deferred`
cells. The app's RSC entry consults it to emit a **null-root** action
response (no re-render; the value rides the open heartbeat stream
instead), and the client skips committing a null root. A mixed batch
(`total !== deferred`) renders normally. See
[`../reference/cells.md`](../reference/cells.md#deferred-stream-only-writes)
and [`./streaming.md`](./streaming.md) § "Deferred (stream-only) writes".

Three server actions wrap the pipeline:

- **`__cellWrite(cellId, value, partitionOverride?)`** — single-cell
  write. The shape `cellHandle.set` binds to via
  `Function.prototype.bind`. Each invocation = one POST.
- **`__scopedCellWrite(cellId, partitionVary, value)`** — partition-
  args-baked write. The shape `cellHandle.with(args).set(value)`
  binds to. Args from the binding are part of the selector
  constraint.
- **`__cellWriteBatch(updates[])`** — multi-cell write. The shape
  the client-side coalescer (`_cellSetBatched` →
  `useCell(cell).set`) targets. Inside one transaction so all
  resulting `cell:<id>?<args>` bumps flush at outer commit and the
  segment driver wakes once.

Additionally, **`__cellInvalidate(cellId, args)`** fires the
partition-scoped selector WITHOUT touching storage — used by
`BoundCell.invalidate()` to force matching placements to re-resolve
(re-run the loader if storage is empty).

## Fragment auto-hydration

`fragmentCell(doc, {key})` self-registers in a module-scope
`Map<fragmentName, FragmentCell>` (HMR overwrites in place, like the cell
registry). `runQuery(client, doc, vars)` runs the query then calls
`hydrateFragmentsFromResult(doc, result)`:

1. `spreadSitesOf(doc)` walks the document AST once (cached per doc via a
   `WeakMap`), collecting every fragment spread as `{path, fragName,
   deferred}` — `path` uses result aliases, `deferred` flags an `@defer`
   directive on the spread.
2. For each non-deferred spread whose `fragName` has a registered cell,
   `collectAtPath(result, path)` gathers the node(s) at that path
   (flattening intermediate arrays), and each non-null node is hydrated
   via `cell.with(cell.keyOf(node)).hydrate(node)`.

`gqlCell`'s synthesized loader is `runQuery`, so pure query cells
auto-hydrate for free; custom loaders (a `localCell` computing an
aggregate) call `runQuery` themselves; mutations call
`hydrateFragmentsFromResult` directly on their response. Deferred spreads
are skipped here — they'd be resolved incrementally by a streaming loader
built on `parseMultipartStream` (see `multipart.ts`; the loader itself is
future work).

## Wire shape

`ResolvedCell<T>` over Flight:

```ts
{
  __cell: true,
  id: "demo.bumps",
  value: 5,                           // current resolved value
  set: <serverRef-of-__cellWrite-bound-to-id>,
}
```

`set` is `__cellWrite.bind(null, cellId)` — Flight handles bound
server-action refs natively (React 19+). The client invokes
`.set(v)` and the framework re-resolves `partitionKey` from the
action invocation's request scope. A cell resolved WITH explicit
args (a bound-cell prop) instead carries a `partition` field and a
`set` bound to `__scopedCellWrite` with those args baked, so client
invocations land on the right partition regardless of URL changes
between render and call. The action returns
`Promise<void>`; refetch is driven by
`getServerNavigation().reload({selector: "cell:<id>"})` inside
the action, which bumps the invalidation registry and shifts the
fp of every parton reading the cell on the next render.

The cell module handle (the module-singleton thing constructed via
`localCell(...)`, `gqlCell(...)`, or `fragmentCell(...)`) is
**distinct** from `ResolvedCell<T>`. The module handle carries
`partition`, `defaultValue`, `validate`, `write`, `load`, `storage` (a
lazy getter, see below), plus `with(args)` returning a
`BoundCell<T>`. The resolved cell carries `value` (and `set`, the
bound action ref the module handle also exposes). A `BoundCell<T>`
carries the partition args baked plus its own `set` / `update` /
`clear` / `invalidate` / `hydrate` methods. Only the resolved form
crosses Flight.

## Storage tiers

Two storage tiers, accessed via different module functions:

- **Persistent (`getCellStorage`)** — disk-backed singleton
  (`JsonFileCellStorage` at `cms/data/cells.json` by default).
  Survives process restart. `localCell` defaults here.
- **Ephemeral (`getEphemeralCellStorage`)** — connection-scoped
  `MemoryCellStorage`. Lazily created on first access via
  `_getRequestEphemeralStorage` (an ALS hook on the `RequestStore`).
  Discarded when the connection closes. The "connection" here is
  one ALS request context — same scope across all segments a
  streaming heartbeat emits, separate from concurrent POSTs and
  other tabs' heartbeats. `gqlCell` + `fragmentCell` always use
  this; `localCell` can opt in via `storage: getEphemeralCellStorage`.

The cell handle carries `storage: () => CellStorage` — a *getter*,
not a cached reference. Module-init runs outside any request, so a
cached ephemeral reference would lock to the wrong storage forever.
The getter pattern lets `localCell` use a stable singleton (where
late resolution doesn't matter) AND lets ephemeral cells resolve
fresh per request.

Every read/write site (`resolveCellValue`, `BoundCell.set/clear/
invalidate/hydrate`, `__cellWrite`'s `writeOneCell`, the props-
resolution path in `partial.tsx`) routes through `cellStorageForArgs`
to fetch the current storage — which also applies the active
`atomic()` overlay via `_txView`. Same code path for both tiers; the
only difference is which adapter it returns.

Outside-request fallback: `getEphemeralCellStorage` returns a fresh
`MemoryCellStorage` if no request is active (bootstrap, isolated
tests). Production paths always run inside `runWithRequestAsync`,
so they always get the per-request storage.

### Empty-session safety guard

A partition is *unresolved* when any of its values is the empty
string — the sentinel `session.id` returns for an anonymous request
with no `__frame_sid` cookie (see `createSessionReadSurface`). A
persistent cell partitioned on `{sid: session.id}` would otherwise
fold EVERY such visitor into the single `sid:""` slot, sharing (and
disk-persisting) state across distinct anonymous users — a cross-user
leak on exactly the axis `localCell`'s per-session pattern uses.

`cellStorageForArgs` guards at the routing boundary: an unresolved
partition routes to per-request ephemeral storage regardless of the
cell's own tier. The ephemeral bucket is request-scoped and never
touches disk, so two anonymous visitors get isolated state while a
write and a later read in the SAME request still cohere. A resolved
`session.id` is unchanged — it routes to the cell's persistent,
per-user partition. Already-ephemeral cells are unaffected.

When the guard routes a *persistent* cell to ephemeral, it emits a
dev-only, once-per-cell-id `console.warn` (gated on
`import.meta.env.DEV`): the cell's state won't persist, and the fix is
to establish a session (`ensureSessionId()`) before the cell resolves.
Apps that want per-user persistence for anonymous visitors mint the
session in their render (forms-demo does this) — session-minting is
app policy, not framework default.

## Resolution path — parton's wrapper component

The full wrapper pipeline (match gate → props cell resolution →
fingerprint → skip decision → render → boundary registration) is
documented in [`render-pipeline.md`](./render-pipeline.md) §"The
spec wrapper pipeline". The cell-specific parts:

- **Props phase** — the wrapper walks top-level JSX props; for each
  prop whose value is a `Cell<T>` or `BoundCell<T>` it awaits
  `resolveCellValue(cell, args)` (storage hit returns sync; storage
  miss + `load` defined runs the loader), replaces the prop with
  `ResolvedCell<T>`, stamps the `cell:<id>` label, adds the args to
  `boundArgsMerged`, and folds `cellId × partitionKey × value` into
  the `|schema=` fp term.
- **Constraint surface** — `effectiveConstraints = matchParams ∪
  boundArgsMerged`, passed to `queryMatchingTs(labels, surface)` →
  the `|inv=` fold. Matching is type-aware: non-string partition
  values (number, boolean, null) match type-exactly, so `{uid:123}`
  and `{uid:"123"}` stay distinct — mirroring the partition key
  (`hash(stableStringify(args))`). Bare string tokens still match
  loosely, so a hand-authored `cart_id=1234` matches a string
  constraint value `"1234"`.
- **fp** = `id|matchKey|vary|schema=<cellHashes>|props|inv|deps` —
  `deps` re-reads the recorded dep keys at the current request
  (store-and-reread). In-body resolutions and tracked reads record
  onto the live dep set during Render, for the NEXT fp.

**In-body resolution dep stamping.** `handle.resolve(args?)` (and the
inline `localCell(key, opts)` form, which builds its handle via
`finalizeScopedCell` and registers it in the cell registry so the
client write action finds it) resolves the value through the same
`resolveCellValue`, then stamps the partition-scoped selector —
`buildCellSelector(id, partition)`, the exact string a write fires —
onto `getCurrentParton().deps`. The boundary registers the live dep
set on the snapshot; `evalDepKeys`'s `cell:` branch re-reads the
selector's invalidation timestamp on every fold (store-and-reread),
and `PartialBoundary` surfaces the bare `cell:` name as a refetch
label with its constraints merged into the constraint surface. So a
write re-renders the reading parton and selector refetch finds it —
same wire ids, partitions, and labels as the prop-resolution path.

The wrapper is `async`. Cold-load paths await; hot paths (storage
warm) settle in a microtask — sync-equivalent in practice.

The props phase is top-level only. Cells nested inside object props
are NOT auto-resolved — pass them as top-level props if you want
framework tracking.

### Why `set` on the resolved cell isn't a bound *client* function

The natural shape would be: `resolvedCell.set` is a bound *client*
function ref that calls the batcher (`_cellSetBatched.bind(null,
id)`). Flight rejects this:

```
Error: Functions cannot be passed directly to Client Components
unless you explicitly expose it by marking it with "use server".
```

Bound server-action refs are a Flight-supported special case;
bound client function refs aren't. The Render function is server-
side, so we can't re-shape `set` there either. The conversion to
a client-side cell with a batched setter has to happen inside a
client component — which is why `useCell(serverCell): ClientCell`
exists. Documented in `framework/src/lib/cell-client.tsx`.

## Client-side batcher

`framework/src/lib/cell-client.tsx`. A `"use client"` module
exposing `useCell` plus the queue + flush internals.

### State

```ts
let queue: QueuedWrite[] = []          // pending writes since last flush
let flushScheduled = false              // microtask is pending
let inflight = false                    // a __cellWriteBatch POST is in flight

const latestSentByCell = new Map<string, unknown>()  // optimistic value per cell-id
const pendingByCell    = new Map<string, number>()    // queued + in-flight count
const cellVersion      = new Map<string, number>()    // per-cell-id monotonic counter
const subscribers      = new Set<() => void>()        // useCell subscriptions
```

### `enqueue(cellId, value, opts)` — the entry point

```ts
function enqueue(id, value, opts): Promise<void> {
  incrementPending(id, value)           // bumps pendingByCell[id] AND
                                        // sets latestSentByCell[id] = value,
                                        // then bumps cellVersion[id] and
                                        // notifies subscribers
  return new Promise((resolve, reject) => {
    queue.push({id, value, partition: opts, resolve, reject})
    if (inflight || flushScheduled) return  // a batch will pick this up
    flushScheduled = true
    queueMicrotask(flushQueue)
  })
}
```

The microtask boundary is what makes "calls in the same tick
coalesce" work — N synchronous `set` calls all push onto `queue`
before the microtask runs and turns them into one POST.

### `flushQueue` — single-inflight drain loop

```ts
async function flushQueue(): Promise<void> {
  if (inflight) return                  // someone beat us to it
  inflight = true
  flushScheduled = false
  try {
    while (queue.length > 0) {
      const batch = queue
      queue = []                        // reassign; new enqueues build the next batch
      try {
        await __cellWriteBatch(batch.map((w) => ({...})))
        for (const w of batch) {
          decrementPending(w.id)        // may clear latestSentByCell[id]
          w.resolve()
        }
      } catch (err) {
        for (const w of batch) {
          decrementPending(w.id)
          w.reject(err)
        }
      }
    }
  } finally {
    inflight = false
  }
}
```

Key invariants:

- **At most one POST in flight per tab.** New enqueues during
  in-flight just push to `queue`; the while-loop picks them up on
  the next iteration.
- **Strict send-order on the server.** The server-side
  `__cellWriteBatch` iterates `updates[]` in order inside one
  transaction. Plus single-inflight means the next batch can't
  start until the previous one commits — so the global write
  order matches the order entries left the client.
- **No write-write races.** With at most one POST in flight per
  cell, no overlapping writes can land in arbitrary order on the
  server.

### Optimistic value tracking

The hook returns `{value, serverValue, set, input}`. `value` is
**optimistic-aware** — latest local-set value if writes are
queued/in-flight for the cell, otherwise the server-authoritative
value from props.

Mechanism:

- `incrementPending(id, value)` sets `latestSentByCell[id] = value`
  AND bumps `cellVersion[id]`.
- `decrementPending(id)` checks if it's the last pending write for
  the id — if so, deletes `latestSentByCell[id]` AND bumps
  `cellVersion[id]`. Otherwise just decrements the count.
- `useCell` subscribes via `useSyncExternalStore` keyed on
  `cellVersion[id]`. The store re-renders the component only when
  THIS cell's version changes — other cells' activity doesn't
  trigger spurious renders.
- Inside the component body: `const value = latestSentByCell.has(id)
  ? latestSentByCell.get(id) : cell.value`. Computed fresh on each
  render against the current map state.

The "reconcile moment" is the render where the last pending write
drains and `latestSentByCell.delete(id)` fires: `value` flips from
the user's optimistic input to the server-authoritative shape
(which may differ if the server `write` normalised differently).

### `cell.input()` — the controlled-input binding

`useCell` allocates a `useRef<HTMLInputElement | null>(null)` and a
`useRef<number | null>(null)` for the pending caret position. A
`useLayoutEffect([value])` restores the caret after React commits:

```ts
useLayoutEffect(() => {
  if (pendingCaret.current == null || !inputRef.current) return
  const c = pendingCaret.current
  pendingCaret.current = null
  inputRef.current.setSelectionRange(c, c)
}, [value])
```

The `input(opts)` callback returns `{value, onChange, ref}`. Its
`onChange` reads `event.target.value` + `selectionStart`, runs
`opts.transform?(raw, caret)` (or identity), stashes the new caret
in `pendingCaret`, fires `set(transformed.value)`, then calls
`opts.onCommit?(transformed.value)` for cross-cell triggers.

## `atomic()` — the transaction overlay

`atomic(fn)` (in `lib/cell.ts`) is the public transactional write
boundary for plain server functions. Two layers compose:

1. **The storage overlay.** `atomic` opens an ALS-scoped write buffer
   (`cellTxStorage`). While active, `_txView` wraps every storage
   adapter the cell paths fetch (`cellStorageForArgs`, `peek`): writes
   land in the buffer instead of real storage, and reads check the
   buffer first — so `peek` / `resolve` / `update` inside the
   transaction see the overlaid values. On success the buffered
   writes flush to their real adapters BEFORE the invalidation
   fan-out commits, so the wake's re-render reads committed values. A
   throw discards the buffer — no storage write lands.

2. **The invalidation transaction.** `atomic` runs `fn` inside
   `runInvalidationTransaction`, which is **nestable** — each
   `cell.set` internally wraps in its own transaction, and with an
   enclosing tx active those inner wrappers are pass-throughs. All
   the `refreshSelector("cell:...")` bumps flush at the outer commit:
   the segment driver wakes once, one segment ships carrying every
   affected cell. A throw discards the pending bumps together with
   the storage buffer — observers can't see a partial commit, and the
   client's optimistic overlay rewinds when the rejected `set`
   promises settle.

```ts
"use server"
import { atomic } from "@parton/framework"

export async function commitCardForm({ name, number }) {
  await atomic(async () => {
    await cardName.set(name)
    await cardNumber.set(number)
    await cardCvc.set(computeCvc(name, number))
  })
}
```

Without the boundary each `cell.set` commits at its own boundary and
the three writes arrive as three separate segments — visually
out-of-step on watching tabs. `atomic` inside an active transaction
joins it (pass-through into the enclosing tx), so composed write
helpers batch into one commit.

The client-side batcher's `__cellWriteBatch` action body batches the
same way: every entry in the batch participates in one outer
`runInvalidationTransaction`.

## Storage

Pluggable via `setCellStorage(backend)`; default is
`JsonFileCellStorage` at `<CMS_DATA_DIR or cms/data>/cells.json`.

```ts
export interface CellStorage {
  read(scope, cellId, partitionKey): unknown
  write(scope, cellId, partitionKey, value): void
  clear(scope?: string | "all"): void
  flush?(): Promise<void>
}
```

Reads are **sync** — a warm cell resolution inside the render path
never awaits storage (only a cold loader does). Writes are sync at
the API boundary; durability is a property of the adapter (in-memory
adapters are instant; `JsonFileCellStorage` debounces to disk).

### Scope bucketing

```
scopes: Map<scope, Map<cellId, Map<partitionKey, value>>>
```

Per-scope storage isolates parallel Playwright workers (each scoped
via `x-test-scope` header — see
[`testing.md`](./testing.md)) so test state doesn't leak across
workers and so production state doesn't leak into test runs. Only
the **default** scope persists to disk. Test scopes stay in memory
and disappear when the process exits.

### Disk shape

```json
{
  "demo.bumps": {
    "<hash-of-empty-partition>": 5
  },
  "palette": {
    "<hash-of-{sid:abc123}>": "dark",
    "<hash-of-{sid:def456}>": "light"
  },
  "product-notes": {
    "<hash-of-{productId:42}>": "Notes for 42",
    "<hash-of-{productId:99}>": "Notes for 99"
  }
}
```

Top-level keys = cell ids. Inner keys =
`hash(stableStringify(cell.partition(scope)))` — so an omitted
`partition` (or a fixed `partition: {}`) collapses to one constant
partition slot.

### Debounced flush

Writes go to memory immediately and schedule a flush ~100 ms later.
Rapid-fire writes (the streaming-demo's per-second tick, an
autosave-on-keystroke form) coalesce into one file write per
window. On process exit a sync flush attempt drains the pending
write — best-effort; if the process is killed harder, the most
recent few writes can be lost. Cells aren't the right primitive
for durability-critical state.

### Atomic writes

Temp-file + rename, same as `cms-storage.ts::JsonFileStorage`.

### Pluggable driver

```ts
import { setCellStorage, type CellStorage } from "@parton/framework"

const redisStorage: CellStorage = {
  async read(scope, cellId, partitionKey) { … },
  async write(scope, cellId, partitionKey, value) { … },
  clear(scope) { … },
}

setCellStorage(redisStorage)
```

Drivers that need async reads (Redis, KV) ship a sync-ish wrapper
or a warm-cache step the runtime awaits at request entry — same
shape `cms-storage.ts` already uses.

## Debug hooks

### `_setCellWriteDelaySimulator(fn)`

Server-side debug-only hook in
`framework/src/runtime/cell-write-delay.ts`. Lets a demo install a
per-batch latency simulator:

```ts
import { _setCellWriteDelaySimulator } from "@parton/framework"

_setCellWriteDelaySimulator(() => {
  // Trimodal: ~fast / typing-speed / slower-than-typing
  const r = Math.random()
  if (r < 1 / 3) return Math.random() * 30
  if (r < 2 / 3) return 100 + Math.random() * 100
  return 400 + Math.random() * 100
})
```

`__cellWriteBatch` reads this every batch via `_getCellWriteDelay()`
and awaits the returned milliseconds before processing the batch.
Production code leaves the simulator `null`. Lives in its own
module (not the `"use server"` cell-actions one) so the setter can
be a regular sync export.

## Cell registry (module-scope state)

`framework/src/lib/cell.ts`. Module-scope `Map<id, Cell<unknown>>`
populated by `localCell({id, ...})` at module-init time. HMR
overwrites in place; the storage layer keys by id, so values from
the prior registration are unaffected.

`__cellWrite` / `__cellWriteBatch` look up cells by id from this
registry. An unknown id throws — defends against client requests
for cells whose modules haven't loaded yet on the current process.

## Related

- [`../reference/cells.md`](../reference/cells.md) — user-facing
  surface (construction, options, `resolve()`, `atomic()`, `useCell`,
  controlled-input discipline, examples).
- [`./render-pipeline.md`](./render-pipeline.md) — how fp folds
  in cell labels and the resolved-cell `schema=` term.
- [`./testing.md`](./testing.md) — `x-test-scope` header and
  per-worker storage isolation.
