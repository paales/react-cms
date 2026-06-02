# Cell internals

Implementation details behind the [cell primitive](../reference/cells.md):
the write pipeline, the client-side batcher, the optimistic-value
plumbing inside `useCell`, the storage backends, and the
nested-transaction batching that lets app-level multi-cell writes
ship as one segment.

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
refreshSelector(             ← bumps the invalidation registry with
  "cell:" + id +               partition-scoped constraints encoded
  "?<argsEncoded>")            as the query-string fragment
```

The whole pipeline runs inside a `runInvalidationTransaction`. A
throw in `validate` or `write` discards the pending refreshSelector
bumps — observers can't see a partial commit.

The emitted selector is **partition-scoped**: args are URL-encoded
as `key1=value1&key2=value2` (keys sorted). Selector matching
against the registry uses `queryMatchingTs(labels, vary ∪ boundArgs)`
— a `cell:<id>?uid=X` write only refreshes placements whose
effective constraints contain `uid=X`. Empty args fall back to bare
`cell:<id>` (matches every placement of that cell, used for cells
with no `vary` and no `.with()`).

**Partition derivation in `writeOneCell`.** The args come from, in
priority order: an explicit `partitionOverride.vary` (the
`.with(args).set` path) → the cell's `keyOf(value)` if present (value-keyed
fragment cells: the identity lives in the value, so `cell.set(value)`
needs no restated args) → `cell.vary(scope)` (request-derived). `keyOf` is
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
action invocation's request scope. The action returns
`Promise<void>`; refetch is driven by
`getServerNavigation().reload({selector: "cell:<id>"})` inside
the action, which bumps the invalidation registry and shifts the
fp of every parton reading the cell on the next render.

The cell module handle (the module-singleton thing constructed via
`localCell(...)`, `gqlCell(...)`, or `fragmentCell(...)`) is
**distinct** from `ResolvedCell<T>`. The module handle carries
`vary`, `defaultValue`, `validate`, `write`, `load`, `storage` (a
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
invalidate/hydrate`, `__cellWrite`'s `writeOneCell`, the schema-
resolution path in `partial.tsx`) calls `cell.storage()` to fetch
the current storage. Same code path for both tiers; the only
difference is which adapter the getter returns.

Outside-request fallback: `getEphemeralCellStorage` returns a fresh
`MemoryCellStorage` if no request is active (bootstrap, isolated
tests). Production paths always run inside `runWithRequestAsync`,
so they always get the per-request storage.

## Resolution path — parton's wrapper component

`createSpecComponent` builds an async React component for every spec.
On each render the wrapper:

1. **match phase** — URLPattern gate. Mismatch → parked keepalive.
2. **vary phase** — sync callback, output drives fp's vary axis.
3. **schema phase** — for each entry in the schema record:
   - **Module cell**: run `cell.vary(scope)` → args; await
     `resolveCellValue(cell, args)` (storage hit returns sync;
     storage miss + `load` defined runs loader). Build
     `ResolvedCell`. Stamp `cell:<id>` label. Add args to
     `boundArgsMerged`.
   - **Scoped descriptor**: finalize → compute partition from
     descriptor's `vary` over the parton's vary output → resolve.
   - **Bound cell** (a `BoundCell<T>` in the schema record): use
     baked args directly. Same resolution.
4. **Props phase** *(new)* — walk top-level JSX props:
   - For each prop whose value is a `Cell<T>` or `BoundCell<T>`,
     resolve as above, replace the prop with `ResolvedCell<T>`,
     stamp label, add args.
5. **Constraint surface** — `effectiveConstraints = vary ∪
   boundArgsMerged`. Passed to `queryMatchingTs(labels, surface)` →
   `inv` fold.
6. **fp** = `id|matchKey|vary|schema=<cellHashes>|props|inv`.
7. **Render** with the assembled prop bag (resolved cells, vary
   output, schema-resolved entries, parent context).

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

## Nested-transaction batching

`runInvalidationTransaction` is **nestable** — when an enclosing tx
is already active, the inner call is a pass-through. App-level
multi-cell writes use this to batch correctly:

```ts
"use server"
import { runInvalidationTransaction } from "@parton/framework"

export async function commitCardForm({ name, number }) {
  await runInvalidationTransaction(async () => {
    await cardName.set(name)
    await cardNumber.set(number)
    await cardCvc.set(computeCvc(name, number))
  })
}
```

Each `cell.set` internally wraps in its own
`runInvalidationTransaction`; with nesting, those inner wrappers
join the outer tx. All three `refreshSelector("cell:...")` bumps
flush at the outer commit — the segment driver wakes once, one
segment ships carrying every affected cell. Without nesting each
`cell.set` would commit at its own boundary and the three writes
would arrive as three separate segments — visually out-of-step on
watching tabs.

The client-side batcher's `__cellWriteBatch` action body does the
same thing implicitly: every entry in the batch participates in
one outer `runInvalidationTransaction`.

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

Reads are **sync** — `parton.schema` resolution happens
synchronously inside the render path. Writes are sync at the API
boundary; durability is a property of the adapter (in-memory
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
    "<hash-of-empty-vary>": 5
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
`hash(stableStringify(cell.vary(scope)))` — so `vary: () => ({})`
collapses to one constant partition slot.

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
  surface (construction, options, schema reads, `useCell`,
  controlled-input discipline, examples).
- [`./render-pipeline.md`](./render-pipeline.md) — how fp folds
  in schema-resolved cell labels.
- [`./testing.md`](./testing.md) — `x-test-scope` header and
  per-worker storage isolation.
