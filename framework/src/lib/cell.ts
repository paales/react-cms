/**
 * Cell — typed, identity-keyed slot of server-authoritative state.
 *
 * Two construction paths:
 *
 *   - `localCell({id, shape, partition?, initial, write?, load?})` —
 *     module-scope, backed by the active `CellStorage` adapter.
 *     `partition` (optional) derives the slot from request scope; `.with(args)`
 *     binds explicit placement-derived args.
 *
 *   - `gqlCell(typedDoc)` (in cell-gql.ts) — same `CellInterface<T>` shape with
 *     `load` auto-synthesized from a gql.tada-typed document.
 *
 * Partitioning sources:
 *   - `partition` (fixed record or request-derived callback, optional)
 *   - `.with(args)` bound at the call site (placement-derived)
 *   - Both can compose into a single partition object.
 *
 * Storage model: storage is the authoritative source. `load` runs on
 * cold-start (storage miss) and populates the slot. Mutations write
 * storage explicitly and fire partition-scoped invalidation. No TTL.
 *
 * Reading: a Render body resolves cells where it uses them —
 * `await handle.resolve(args?)` for module cells, the inline
 * `localCell(key, opts)` form for parton-scoped ones — or accepts
 * them as JSX props (auto-resolved by the framework before Render).
 *
 * Writing: `cell.with(args).set(value)` writes storage at the bound
 * partition AND fires `refreshSelector("cell:<id>?<args>")` so only
 * placements bound to the same args refetch. `cell.update(updater)`
 * (and `cell.with(args).update(updater)`) is the reducer form — next
 * derives from current in one synchronous section, so concurrent
 * writers compose instead of clobbering. Server-side only.
 *
 * See `docs/reference/cells.md` for the user-facing surface.
 */

import {
  __cellWrite as _cellWriteAction,
  __scopedCellWrite as _scopedCellWriteAction,
} from "../runtime/cell-actions.ts"
import { buildCellPartitionScope, updateOneCell } from "../runtime/cell-write.ts"
import { AsyncLocalStorage } from "node:async_hooks"
import { getCurrentParton } from "./current-parton.ts"
import { buildCellSelector, runInvalidationTransaction } from "../runtime/invalidation-registry.ts"
import {
  getCellStorage,
  getEphemeralCellStorage,
  type CellStorage,
} from "../runtime/cell-storage.ts"
import { getRequest, getScope, parseCookies } from "../runtime/context.ts"
import { embedDepthOf } from "./page-embed.ts"
import { embedCellWrite } from "./cell-client.tsx"
import { createSessionReadSurface } from "../runtime/session.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { buildTimeScope, type TimeScope } from "./time.ts"
import type { SessionId } from "../runtime/session.ts"

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Sync request scope a cell's `partition` callback sees. Cells keep a
 * declared partition callback — unlike partons, a partition must be
 * re-derivable OUTSIDE a render (action dispatch resolves cells
 * against the caller's request), so it can't be an in-body read.
 */
export interface CellPartitionScope {
  /** The (frame-resolved) request URL, already parsed. */
  url: URL
  /** Shortcut for `url.pathname`. */
  pathname: string
  /** Search params as a destructurable record. Missing keys are
   *  `undefined`. Multi-valued keys carry only their first value. */
  search: Partial<Record<string, string>>
  /** Cookies parsed from the request's `Cookie` header. */
  cookies: Partial<Record<string, string>>
  /** Request headers as a destructurable record, lowercased keys. */
  headers: Partial<Record<string, string>>
  /** Match params of the enclosing parton, when resolved inside one. */
  params: Record<string, string>
  /** Session identity — the partition axis for per-user cells. */
  session: SessionId
  /** Wall-clock snapshot for the current request. */
  time: TimeScope
}

/** Args object — the placement/partition inputs that hash to a
 *  partition key. */
export type CellArgs = Record<string, unknown>

/** Shape declaration accepted by `localCell({shape: ...})`. */
export type CellShapeSpec = "string" | "number" | "boolean" | "opaque" | { enum: readonly string[] }

/** Runtime shape descriptor stored on the handle — drives validation.
 *  `opaque` accepts any value (used for object/list-shaped cells where
 *  the author owns the TS type and the framework doesn't validate). */
export type CellShape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "opaque" }
  | { kind: "enum"; values: readonly string[] }

/** Map a `CellShapeSpec` to its runtime value type. `opaque` is unknown
 *  on inference; authors supply an explicit type parameter. */
export type ValueOfShape<S> = S extends "string"
  ? string
  : S extends "number"
    ? number
    : S extends "boolean"
      ? boolean
      : S extends "opaque"
        ? unknown
        : S extends { enum: readonly (infer V)[] }
          ? V
          : never

/**
 * Module-scope cell handle. Constructed via `localCell({...})` or
 * `gqlCell(...)` and held as a module export.
 *
 * Carries the static decisions (id, shape, partition, defaultValue, load)
 * plus methods for binding and mutating partitions:
 *
 *   - `with(args)` returns a `BoundCell<T>` with partition baked.
 *   - `set(value, opts?)` writes the partition derived from
 *     `cell.partition(request)` (or the explicit `opts.partition` override).
 *   - `peek()` sync-reads the current stored value at the partition
 *     derived from request scope.
 */
export interface CellInterface<T, A extends CellArgs = CellArgs> {
  readonly __cell: true
  readonly id: string
  readonly shape: CellShape
  readonly defaultValue: T
  /** Storage-adapter getter — invoked per-use rather than cached at
   *  construction, because ephemeral storage is request-scoped (a
   *  fresh adapter per request) and module-init runs outside any
   *  request. `localCell` returns the persistent disk-backed
   *  singleton; `gqlCell` + `fragmentCell` return the active request's
   *  per-request `MemoryCellStorage`. */
  readonly storage: () => CellStorage
  /** Vary callback. Runs against the request scope; the hashed output
   *  is part of the storage partition key. Default: `() => ({})`. */
  readonly partition: (scope: CellPartitionScope) => CellArgs
  /** Optional async loader — runs on cold-start (storage miss) at the
   *  partition, result populates storage. */
  readonly load?: (args: CellArgs) => Promise<T>
  /** Optional value→partition extractor. When present, `cell.set(value)`
   *  with no explicit `.with()` partition derives the partition from
   *  `keyOf(value)` rather than the `partition` callback — the identity lives
   *  in the value itself (fragment cells keyed by `id`/`uid`). Set by
   *  `fragmentCell` from its `key` option. */
  readonly keyOf?: (value: T) => CellArgs
  /**
   * Bind this cell to explicit args, returning a `BoundCell<T>` with
   * the partition baked. Use at JSX placement sites:
   *
   *     <CartLine item={cartItemCell.with({itemId})} />
   *
   * `A` (the args type) defaults to `CellArgs`; gqlCell/fragmentCell set
   * it to the document's variables / key shape so `.with` is typed.
   */
  with(args: A): BoundCell<T>
  /**
   * Resolve this cell inside a parton's Render: read the stored value
   * (running the loader on a miss) at `args` — or at the cell's own
   * `partition` against the current request when omitted — and record
   * the partition-scoped `cell:` dependency on the rendering parton,
   * so a write re-renders it (the boundary also surfaces the label for
   * selector refetch). Returns the same `ResolvedCell<T>` the prop
   * path produces, Flight-portable with a bound `set`.
   *
   *     const bumps = await bumpsCell.resolve()
   *     const line = await cartLineCell.resolve({ uid })
   */
  resolve(args?: A): Promise<ResolvedCell<T>>
  /**
   * Mutation surface. Server-side: invokes the action synchronously
   * against the current request scope. Client-side: Flight-serialized
   * server reference; partition resolves from the action's request
   * scope on the server.
   *
   * Optional `opts.partition` overrides the cell's own partition callback —
   * useful for cross-context mutations.
   */
  set(value: T, opts?: { partition?: CellArgs }): Promise<void>
  /**
   * Reducer-form mutation: read the current stored value, apply
   * `updater(current) => next`, write the result through set's full
   * pipeline (shape validation of the result, `write`
   * canonicalisation, partition-scoped invalidation, `atomic()`
   * batching). The read→updater→write section is synchronous, so
   * concurrent updates on the same (cell, partition) COMPOSE — both
   * increments land — where read-modify-write around `set` would
   * clobber. Reach for it whenever `next` derives from `current`
   * (counters, map merges); keep `set` for values you already hold.
   *
   * SERVER-SIDE ONLY: an updater is a function, which Flight cannot
   * serialize client→server — call `update` inside a `"use server"`
   * function; the composed result reaches clients on the action's
   * response render like any other server-authoritative value.
   * Updaters must be sync (an async updater throws — it would reopen
   * the read→write gap).
   *
   * The partition derives like set's: `opts.partition` when given,
   * otherwise the cell's own `partition` callback against the current
   * request. Value-keyed cells (`keyOf`) have no derivable partition
   * before the read — bind it explicitly: `cell.with(key).update(fn)`.
   * A cold loader-backed slot is warmed (loader run, result seeded)
   * before the updater applies.
   */
  update(updater: (current: T) => T, opts?: { partition?: CellArgs }): Promise<void>
  /** Synchronous server-side read of the stored value. The partition
   *  is `args` when given, otherwise derived from
   *  `cell.partition(currentRequest)`. Returns `defaultValue` on miss.
   *  Does NOT trigger the loader.
   *
   *  Scoped cells (schema / inline `localCell`) partition storage by
   *  the owning parton's match params, which `peek` can't re-derive
   *  without a render — their no-arg `peek()` reads the `{}` partition
   *  (the slot a match-param-less parton resolves), and
   *  reading a narrower partition requires naming it explicitly:
   *  `peek(partitionArgs)`. */
  peek(args?: CellArgs): T
  /** Internal — validates an incoming value against the cell's shape. */
  validate(value: unknown): T
  /** Internal — server-side write-pipeline transform. */
  write?(value: T): T
  /** Write authorization — who may write this cell. Evaluated at the
   *  write choke point against the CALLER's request scope (the same
   *  `CellPartitionScope` the `partition` callback sees) plus the
   *  write's resolved partition args; `false` throws
   *  `CellWriteDenied` before anything commits. Absent ⇒ writable by
   *  any caller that can name the cell id. See `LocalCellOpts.writeGuard`. */
  readonly writeGuard?: (scope: CellPartitionScope, args: CellArgs) => boolean
  /** When set, a write to this cell does NOT make the action POST
   *  carry a re-render: the response root is omitted and the new value
   *  propagates only via the already-open streaming connection (the
   *  heartbeat's `?streaming=1` segment). For high-frequency,
   *  last-write-wins broadcast state — cursor / scroll / presence —
   *  where the writer paints locally and other viewers catch up on the
   *  stream, so paying a full action-response render per keystroke (and
   *  committing it back over the optimistic value) is pure waste. See
   *  `docs/reference/cells.md` § "Deferred (stream-only) writes". */
  readonly deferred?: boolean
  /** Cross-process publication — the outward half of state across the
   *  boundary (`docs/reference/remote-frame.md` § remoteCell). `true`
   *  (or a capability guard returning `true`) lets another parton
   *  process ATTACH to this cell's committed bumps and READ its value
   *  through the producer's `/__remote/cells/*` endpoints
   *  (`createRemoteHandler` — the app must configure `remote`). A
   *  guard callback authorizes each attach/read against the caller's
   *  presented capability bag. Absent/false ⇒ never served across the
   *  boundary (403). */
  readonly publish?: boolean | ((capability: Record<string, unknown>) => boolean)
}

/**
 * A persistent local cell — what `localCell(...)` returns. Same contract
 * as `CellInterface<T>`; named for symmetry with `GqlCell` / `FragmentCell`
 * (the three constructors' return types) and as a home for any future
 * local-only surface.
 */
export interface LocalCell<T> extends CellInterface<T> {}

/**
 * Bound cell — a `CellInterface<T>` with a specific partition baked. Created by
 * `cell.with(args)`. The framework recognizes bound cells in parton
 * props and resolves them to `ResolvedCell<T>` before Render. The
 * bound `args` participate in the parton's invalidation-constraint
 * surface — partition-scoped writes (`cell:<id>?<args>`) only refresh
 * placements bound to matching args.
 */
export interface BoundCell<T> {
  readonly __boundCell: true
  readonly cellId: string
  readonly args: CellArgs
  /** Write the new value at this bound partition. Fires
   *  `refreshSelector("cell:<id>?<args>")`. */
  set(value: T): Promise<void>
  /** Reducer-form mutation at this bound partition — read current
   *  value (warming a cold loader first), apply `updater(current) =>
   *  next` synchronously, write back through set's full pipeline.
   *  Concurrent updates compose; see `CellInterface.update`. Server-
   *  side only (updaters don't cross Flight). */
  update(updater: (current: T) => T): Promise<void>
  /** Reset storage to the cell's `defaultValue` and fire partition-
   *  scoped invalidation. Use when the entity logically no longer
   *  exists (cart line removed, draft discarded). */
  clear(): Promise<void>
  /** Wipe storage at this partition (next read is cold) and fire
   *  partition-scoped invalidation. The next render at this partition
   *  re-runs the loader. Use when upstream data has changed and the
   *  cell must re-fetch (e.g. after a mutation that doesn't return
   *  the full new value). */
  invalidate(): Promise<void>
  /** Sync write to storage at this partition WITHOUT firing the
   *  partition-scoped signal. Use during initial cold-load hydration
   *  (e.g. a parent cell's `load` populating child cells) where the
   *  signal would cause an unwanted refetch cascade — the wrappers
   *  haven't rendered yet, so there's nothing to invalidate. Bypasses
   *  the action layer; storage adapter sees a direct write. */
  hydrate(value: T): void
}

/**
 * Resolved cell — the per-render view a parton's schema/props
 * produces. Carries the resolved `.value` plus the same bound `set`
 * action reference. This is what Render receives and what crosses
 * Flight to client components.
 */
export interface ResolvedCell<T> {
  readonly __cell: true
  readonly id: string
  readonly value: T
  readonly partition?: CellArgs
  /** Call as a METHOD (`cell.set(v)`), never detached. The declared
   *  `this` makes a destructured or callback-prop extraction
   *  (`const { set } = cell`, `onClick={cell.set}`) a compile error:
   *  inside an embed render `set` is a client reference that reads
   *  `this.id` / `this.partition` off the cell at call time, so a
   *  detached call would lose the cell's identity. */
  set(this: ResolvedCell<T>, value: T, opts?: { partition?: CellArgs }): Promise<void>
}

/**
 * Thrown when a cell's `writeGuard` denies a write. Fires at the write
 * choke point (`assertCellWritable` in `runtime/cell-write.ts`), BEFORE
 * the value reaches storage — a denied write commits nothing and bumps
 * nothing, and inside `atomic()` the throw rolls the whole batch back.
 * Server-side type: over Flight a client's `.set` promise simply
 * rejects (production redacts the message), so denial UI is whatever
 * the author renders for the rejection.
 */
export class CellWriteDenied extends Error {
  readonly cellId: string
  constructor(cellId: string) {
    super(`cell "${cellId}": write denied by the cell's writeGuard`)
    this.name = "CellWriteDenied"
    this.cellId = cellId
  }
}

/**
 * The resolved value type of a cell handle — what `ResolvedCell` carries
 * and a parton's Render receives. Use it to type Render props off the cell
 * itself instead of a hand-written alias:
 *
 *     function CartRender({ cart }: { cart: ResolvedCell<CellValue<typeof cartCell>> })
 */
export type CellValue<C> = C extends CellInterface<infer T, any> ? T : never

// ─── Cell registry (module-scope state) ───────────────────────────────

const cellRegistry = new Map<string, CellInterface<unknown>>()

export function getCellById(id: string): CellInterface<unknown> | undefined {
  return cellRegistry.get(id)
}

/** Ids of every PUBLISHED cell (`publish` set) — the remote
 *  manifest's `publishes` inventory. Guard callbacks count as
 *  published (per-capability authorization happens at the attach). */
export function _listPublishedCellIds(): string[] {
  const out: string[] = []
  for (const cell of cellRegistry.values()) {
    if (cell.publish !== undefined && cell.publish !== false) out.push(cell.id)
  }
  return out.sort()
}

/** Type predicate — works on module handles and resolved cells. */
export function isCellHandle(
  value: unknown,
): value is CellInterface<unknown> | ResolvedCell<unknown> {
  return (
    typeof value === "object" && value !== null && (value as { __cell?: boolean }).__cell === true
  )
}

export function isModuleCell(value: unknown): value is CellInterface<unknown> {
  return isCellHandle(value) && typeof (value as CellInterface<unknown>).partition === "function"
}

export function isBoundCell(value: unknown): value is BoundCell<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __boundCell?: boolean }).__boundCell === true
  )
}

/** Compute the partition key for a cell against a request scope. */
export function computeCellPartitionKey(
  cell: CellInterface<unknown>,
  scope: CellPartitionScope,
): string {
  const out = cell.partition(scope)
  return hash(stableStringify(out))
}

/** Compute the partition key from explicit args. */
export function computePartitionKeyFromArgs(args: CellArgs): string {
  return hash(stableStringify(args))
}

/**
 * A partition is "unresolved" when any of its values is the empty
 * string — the sentinel `session.id` returns for an anonymous request
 * with no `__frame_sid` cookie (see `createSessionReadSurface`). A
 * persistent cell partitioned on `{sid: session.id}` would otherwise
 * fold EVERY such visitor into the single `sid:""` slot, sharing (and
 * disk-persisting) state across distinct anonymous users.
 */
function isUnresolvedPartition(args: CellArgs): boolean {
  for (const k in args) {
    if (args[k] === "") return true
  }
  return false
}

/**
 * Cell ids already warned about an unresolved persistent partition.
 * The warning fires once per id — a hot path resolves the same cell on
 * every request, and a session that never resolves would otherwise log
 * on each one.
 */
const warnedUnresolvedPersistent = new Set<string>()

/**
 * Dev-only, once-per-cell-id nudge: a PERSISTENT cell (one whose
 * `storage()` is the persistent singleton) resolved to an unresolved
 * partition — an empty-string `session.id` — and is being routed to
 * ephemeral storage to stay leak-safe, so its state won't persist.
 * Tell the author the partition never resolved and how to make it
 * persist (establish a session before the cell resolves). No-op for an
 * already-ephemeral cell (gqlCell / fragmentCell): routing its
 * partition to ephemeral persists nothing either way.
 */
function warnUnresolvedPersistent(id: string, storage: CellStorage): void {
  if (!import.meta.env?.DEV) return
  if (storage !== getCellStorage()) return
  if (warnedUnresolvedPersistent.has(id)) return
  warnedUnresolvedPersistent.add(id)
  console.warn(
    `[cell] persistent cell "${id}" partitioned on an empty session ` +
      `→ routed to ephemeral storage (state won't persist). Establish a ` +
      `session (ensureSessionId) before the cell resolves so it routes to ` +
      `per-user persistent storage.`,
  )
}

/** Test-only: reset the once-per-id warning dedup. */
export function _resetUnresolvedPersistentWarnings(): void {
  warnedUnresolvedPersistent.clear()
}

/**
 * Resolve the storage backend for a cell at a given partition. The
 * cell's own `storage()` for a resolved partition; per-request
 * EPHEMERAL storage when the partition is unresolved (an empty
 * `session.id` component). The ephemeral bucket is request-scoped and
 * never touches disk, so two anonymous visitors get isolated state
 * instead of a shared persistent slot — closing the cross-user leak
 * the session docstring warns about. Already-ephemeral cells
 * (gqlCell / fragmentCell) are unaffected: their `storage()` is the
 * same per-request store either way — and they get no warning, since
 * routing an already-ephemeral partition to ephemeral persists nothing
 * either way.
 */
export function cellStorageForArgs(cell: CellInterface<unknown>, args: CellArgs): CellStorage {
  if (!isUnresolvedPartition(args)) return _txView(cell.storage())
  warnUnresolvedPersistent(cell.id, cell.storage())
  return _txView(getEphemeralCellStorage())
}

// ─── atomic() — the transactional write overlay ───────────────────────

interface CellTxWrite {
  storage: CellStorage
  scope: string
  cellId: string
  partitionKey: string
  value: unknown
}

/** ALS-scoped write buffer for `atomic()`. While active, every cell
 *  write lands here instead of real storage (reads see the overlay);
 *  success flushes to storage before the invalidation fan-out commits,
 *  a throw discards the buffer with the pending invalidations. */
const cellTxStorage = new AsyncLocalStorage<Map<string, CellTxWrite>>()

const txKey = (scope: string, cellId: string, pk: string): string => `${scope}|${cellId}|${pk}`

/** Wrap a storage adapter in the active transaction's overlay (identity
 *  outside a transaction). */
export function _txView(real: CellStorage): CellStorage {
  const tx = cellTxStorage.getStore()
  if (!tx) return real
  return {
    read(scope, cellId, partitionKey) {
      const buffered = tx.get(txKey(scope, cellId, partitionKey))
      return buffered ? buffered.value : real.read(scope, cellId, partitionKey)
    },
    write(scope, cellId, partitionKey, value) {
      tx.set(txKey(scope, cellId, partitionKey), {
        storage: real,
        scope,
        cellId,
        partitionKey,
        value,
      })
    },
    clear(scope) {
      real.clear(scope)
    },
    flush: real.flush?.bind(real),
  }
}

/**
 * Atomic write boundary for server functions. Every cell write inside
 * `fn` commits together when it returns: writes buffer in an overlay
 * (reads inside the transaction see them), the invalidation fan-out
 * fires once (one live-driver wake, one lane pass — not one per
 * write), and a throw discards every buffered write, rolling the
 * client's optimistic overlay back with them. Unrelated to React's
 * `startTransition` (client render priority) — this is server-side
 * write atomicity.
 *
 *     "use server"
 *     export async function saveCard(args: { name: string; cvc: string }) {
 *       await atomic(async () => {
 *         await cardName.set(args.name)
 *         await cardCvc.set(args.cvc)
 *       })
 *     }
 */
export async function atomic<T>(fn: () => Promise<T>): Promise<T> {
  if (cellTxStorage.getStore()) return runInvalidationTransaction(fn)
  const tx = new Map<string, CellTxWrite>()
  return runInvalidationTransaction(async () => {
    const result = await cellTxStorage.run(tx, fn)
    // Success: land the buffered writes on real storage BEFORE the
    // enclosing invalidation transaction commits its fan-out, so the
    // wake's re-render reads the committed values.
    for (const w of tx.values()) w.storage.write(w.scope, w.cellId, w.partitionKey, w.value)
    return result
  })
}

// ─── Shared validator / shape plumbing ────────────────────────────────

function shapeFromSpec(spec: CellShapeSpec): CellShape {
  if (spec === "string") return { kind: "string" }
  if (spec === "number") return { kind: "number" }
  if (spec === "boolean") return { kind: "boolean" }
  if (spec === "opaque") return { kind: "opaque" }
  return { kind: "enum", values: spec.enum }
}

function makeValidator<T>(id: string, shape: CellShape): (v: unknown) => T {
  switch (shape.kind) {
    case "string":
      return (v: unknown): T => {
        if (typeof v !== "string") {
          throw new TypeError(`cell ${id}: expected string, got ${typeof v}`)
        }
        return v as T
      }
    case "number":
      return (v: unknown): T => {
        if (typeof v !== "number" || Number.isNaN(v)) {
          throw new TypeError(`cell ${id}: expected number, got ${typeof v}`)
        }
        return v as T
      }
    case "boolean":
      return (v: unknown): T => {
        if (typeof v !== "boolean") {
          throw new TypeError(`cell ${id}: expected boolean, got ${typeof v}`)
        }
        return v as T
      }
    case "opaque":
      // No runtime validation for opaque cells — author owns the TS
      // type, framework treats the value as a black box.
      return (v: unknown): T => v as T
    case "enum": {
      const allowed: ReadonlySet<string> = new Set(shape.values)
      const values = shape.values
      return (v: unknown): T => {
        if (typeof v !== "string" || !allowed.has(v)) {
          throw new TypeError(`cell ${id}: expected one of ${values.join(", ")}, got ${String(v)}`)
        }
        return v as T
      }
    }
  }
}

function constantPartition(): CellArgs {
  return {}
}

/** Marker on normalized partition callbacks whose output can never
 *  derive from request scope (absent or a fixed record) — the broadcast
 *  eligibility classifier's positive signal (`_cellBroadcastSafe`).
 *  A user-supplied callback is never marked: it receives the partition
 *  scope (session, cookies, headers, URL) and can bake a per-viewer
 *  identity into the partition WITHOUT a tracked read. */
const VIEWER_INDEPENDENT_PARTITION = Symbol("viewer-independent-partition")

function markViewerIndependent(
  fn: (scope: CellPartitionScope) => CellArgs,
): (scope: CellPartitionScope) => CellArgs {
  ;(fn as unknown as Record<symbol, boolean>)[VIEWER_INDEPENDENT_PARTITION] = true
  return fn
}
markViewerIndependent(constantPartition)

/** Normalize the `partition` option (fixed record | callback | absent)
 *  to the canonical callback form the handle stores. */
function normalizePartition(
  p: CellArgs | ((scope: CellPartitionScope) => CellArgs) | undefined,
): (scope: CellPartitionScope) => CellArgs {
  if (p === undefined) return constantPartition
  if (typeof p === "function") return p
  return markViewerIndependent(() => p)
}

/**
 * Whether a `cell:<id>` dep is safe to treat as viewer-INDEPENDENT for
 * broadcast-lane eligibility (`lib/broadcast.ts`). Conservative — both
 * conditions must positively hold, anything else is unsafe:
 *
 *   - the cell's storage is the process-global persistent singleton
 *     (`getCellStorage`). Ephemeral storage is request/connection-
 *     scoped (gqlCell / fragmentCell / `storage: getEphemeralCellStorage`),
 *     so its values are per-viewer by construction; a custom adapter's
 *     scope is unknowable.
 *   - the cell's partition cannot derive from request scope: absent or
 *     a fixed record (`VIEWER_INDEPENDENT_PARTITION`). A partition
 *     CALLBACK reads the request's session/cookies/headers without a
 *     tracked read, so a per-viewer partition would be invisible to
 *     the dep record. (Explicit `.with(args)` partitions are covered
 *     by the registry's standing props contract: per-viewer variation
 *     flows through tracked reads, never placement props.)
 *
 * An unregistered id (a cell the process no longer knows) is unsafe.
 */
export function _cellBroadcastSafe(cellId: string): boolean {
  const cell = cellRegistry.get(cellId)
  if (!cell) return false
  if (cell.storage !== getCellStorage) return false
  return (
    (cell.partition as unknown as Record<symbol, boolean | undefined>)[
      VIEWER_INDEPENDENT_PARTITION
    ] === true
  )
}

function registerCell<T>(handle: CellInterface<T>): CellInterface<T> {
  // HMR overwrites in place. Storage is keyed by id, so values from
  // the prior registration are unaffected.
  cellRegistry.set(handle.id, handle as CellInterface<unknown>)
  return handle
}

/** Bind the generic `__cellWrite` server action to a specific cell id. */
function bindSetter(id: string): CellInterface<unknown>["set"] {
  return _cellWriteAction.bind(null, id) as unknown as CellInterface<unknown>["set"]
}

/** Per-cell `peek` — sync server-side read. Explicit `args` name the
 *  partition directly; otherwise it derives from the cell's own partition callback
 *  against the active ALS request context. */
function buildPeek<T>(
  id: string,
  storage: () => CellStorage,
  validate: (v: unknown) => T,
  defaultValue: T,
  partitionFn: (scope: CellPartitionScope) => CellArgs,
): CellInterface<T>["peek"] {
  return (args?: CellArgs) => {
    const partition = args ?? partitionFn(buildCellPartitionScopeFromRequest())
    const partitionKey = hash(stableStringify(partition))
    let readStorage = _txView(storage())
    if (isUnresolvedPartition(partition)) {
      warnUnresolvedPersistent(id, storage())
      readStorage = _txView(getEphemeralCellStorage())
    }
    const stored = readStorage.read(getScope(), id, partitionKey)
    if (stored === undefined) return defaultValue
    try {
      return validate(stored)
    } catch {
      return defaultValue
    }
  }
}

function buildCellPartitionScopeFromRequest(): CellPartitionScope {
  const request = getRequest()
  const url = new URL(request.url)
  const search: Record<string, string> = {}
  for (const [k, v] of url.searchParams) search[k] = v
  const cookies = parseCookies(request)
  const headers: Record<string, string> = {}
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v
  return {
    url,
    pathname: url.pathname,
    search,
    cookies,
    headers,
    params: {},
    session: createSessionReadSurface(),
    time: buildTimeScope(),
  }
}

/**
 * Resolve the stored value at a partition, running the loader on miss.
 * Used by the schema/prop resolution path.
 *
 * Behavior:
 *   - Storage hit → return validated value.
 *   - Storage miss + `load` defined → run loader, validate, write
 *     storage, return value.
 *   - Storage miss + no loader → return `defaultValue`.
 *
 * Reads are sync when storage is warm (the common case after first
 * hydration). The cold-start path is the only async branch.
 */
export async function resolveCellValue<T>(cell: CellInterface<T>, args: CellArgs): Promise<T> {
  const partitionKey = hash(stableStringify(args))
  const storage = cellStorageForArgs(cell as CellInterface<unknown>, args)
  const stored = storage.read(getScope(), cell.id, partitionKey)
  if (stored !== undefined) {
    try {
      return cell.validate(stored)
    } catch {
      return cell.defaultValue
    }
  }
  if (cell.load) {
    const loaded = await cell.load(args)
    const validated = cell.validate(loaded)
    const transformed = cell.write ? cell.write(validated) : validated
    storage.write(getScope(), cell.id, partitionKey, transformed)
    return transformed
  }
  return cell.defaultValue
}

// ─── Reducer-form update ──────────────────────────────────────────────

/**
 * The implementation behind `CellInterface.update` and
 * `BoundCell.update`. Derives the partition (explicit args → the
 * cell's own `partition` callback against the caller's request — same
 * priority as set's write path, minus `keyOf`: a value-keyed cell's
 * identity lives in the value, which an update can't know before the
 * read, so it must be bound explicitly), warms a cold loader-backed
 * slot, then runs the SYNCHRONOUS read→updater→write section
 * (`updateOneCell` — see the serialization invariant in
 * `runtime/cell-write.ts`).
 *
 * Wrapped in `runInvalidationTransaction` like every set path: inside
 * an `atomic()` the wrapper is a pass-through, so the update reads the
 * transaction overlay, its write buffers with the batch, and a throw
 * (the updater's own, or shape validation of its result) rolls the
 * whole batch back.
 */
async function updateCell<T>(
  cell: CellInterface<T>,
  updater: (current: T) => T,
  explicitArgs?: CellArgs,
): Promise<void> {
  let args: CellArgs
  if (explicitArgs !== undefined) {
    args = explicitArgs
  } else if (cell.keyOf) {
    throw new Error(
      `cell-update: cell "${cell.id}" is value-keyed (keyOf) — its partition lives in the ` +
        `value, which update can't derive before reading it. Bind the identity explicitly: ` +
        `cell.with(key).update(updater).`,
    )
  } else {
    args = cell.partition(buildCellPartitionScope())
  }
  await runInvalidationTransaction(async () => {
    await warmColdSlot(cell, args)
    updateOneCell(cell as CellInterface<unknown>, args, updater as (current: unknown) => unknown)
  })
}

/**
 * Run the cell's loader for a still-cold slot so the synchronous
 * read-modify-write that follows composes over the loaded value, not
 * `defaultValue`. Mirrors `resolveCellValue`'s loader branch
 * (validate → `write` canonicalisation → storage, no signal) with one
 * addition: the slot is re-checked after the await and seeded ONLY if
 * still cold — a write that landed while the loader ran is a commit,
 * and the loader's snapshot must never clobber it.
 */
async function warmColdSlot<T>(cell: CellInterface<T>, args: CellArgs): Promise<void> {
  if (!cell.load) return
  const partitionKey = hash(stableStringify(args))
  const c = cell as CellInterface<unknown>
  if (cellStorageForArgs(c, args).read(getScope(), cell.id, partitionKey) !== undefined) return
  const loaded = await cell.load(args)
  const storage = cellStorageForArgs(c, args)
  if (storage.read(getScope(), cell.id, partitionKey) !== undefined) return
  const validated = cell.validate(loaded)
  const stored = cell.write ? cell.write(validated) : validated
  storage.write(getScope(), cell.id, partitionKey, stored)
}

// ─── BoundCell construction ───────────────────────────────────────────

/** Construct a bound cell from a Cell handle + args. The bound view
 *  carries the cellId + args plus convenience methods that bake the
 *  args into the write action invocation. */
function buildBoundCell<T>(cell: CellInterface<T>, args: CellArgs): BoundCell<T> {
  const cellId = cell.id
  return {
    __boundCell: true,
    cellId,
    args,
    async set(value: T): Promise<void> {
      await _scopedCellWriteAction(cellId, args, value)
    },
    async update(updater: (current: T) => T): Promise<void> {
      await updateCell(cell, updater, args)
    },
    async clear(): Promise<void> {
      // Reset to defaultValue — semantic: "this entity is gone, use
      // the cell's empty shape." Fires partition-scoped invalidation
      // through the write action.
      await _scopedCellWriteAction(cellId, args, cell.defaultValue)
    },
    async invalidate(): Promise<void> {
      // Wipe storage to cold so the next read re-runs the loader.
      // Then fire the partition-scoped signal so connected viewers
      // re-resolve (and hit the loader since storage is now empty).
      const partitionKey = hash(stableStringify(args))
      cellStorageForArgs(cell as CellInterface<unknown>, args).write(
        getScope(),
        cellId,
        partitionKey,
        undefined,
      )
      const { __cellInvalidate } = await import("../runtime/cell-actions.ts")
      await __cellInvalidate(cellId, args)
    },
    hydrate(value: T): void {
      const partitionKey = hash(stableStringify(args))
      const validated = cell.validate(value)
      const stored = cell.write ? cell.write(validated) : validated
      cellStorageForArgs(cell as CellInterface<unknown>, args).write(
        getScope(),
        cellId,
        partitionKey,
        stored,
      )
    },
  }
}

// ─── Module-scope localCell ───────────────────────────────────────────

/** Options for `localCell({...})`. */
export interface LocalCellOpts<S extends CellShapeSpec, T = ValueOfShape<S>> {
  id: string
  shape: S
  initial: T
  /** Storage partition — a fixed args record, or a sync callback
   *  `(scope) => CellArgs` for request-derived partitions
   *  (`partition: ({session}) => ({sid: session.id})`). The output
   *  hashes into the storage partition key; a callback re-runs in the
   *  ACTION's request too, so a per-session cell resolves at the
   *  caller's partition there. Omit for a cell whose partition comes
   *  entirely from `.with()` at call sites (or for a single-slot
   *  cell when nothing binds args). */
  partition?: CellArgs | ((scope: CellPartitionScope) => CellArgs)
  /** Async loader — runs on storage miss at a partition. Result is
   *  validated, run through `write` if present, then stored. */
  load?: (args: CellArgs) => Promise<T>
  /** Server-side write-pipeline transform. Runs after `validate` and
   *  before storage on every write. */
  write?: (value: T) => T
  /** Write authorization — who may write this cell. A sync predicate
   *  over the CALLER's request scope (the same `CellPartitionScope`
   *  the `partition` callback sees — session, cookies, headers, URL)
   *  plus the write's resolved partition args, so a partitioned cell
   *  can pin writes to their owner:
   *
   *      writeGuard: ({ session }, args) => args.sid === session.id
   *
   *  Enforced at the write choke point, so EVERY path passes through
   *  it — the client `.set` action POST, a server function's `.set`,
   *  `update`, the write batcher, `atomic()` batches. `false` throws
   *  `CellWriteDenied` before the storage write: nothing commits, no
   *  invalidation fires, and inside `atomic()` the whole batch rolls
   *  back. Omitted ⇒ today's open default: any caller that can name
   *  the cell id may write it. */
  writeGuard?: (scope: CellPartitionScope, args: CellArgs) => boolean
  /** Optional storage adapter. Defaults to the persistent disk-backed
   *  singleton (`getCellStorage`). Pass `getEphemeralCellStorage` to
   *  opt into request-scoped in-memory storage (for cells whose data
   *  flows from upstream and shouldn't persist to disk). Pass a
   *  function for any custom backend. */
  storage?: CellStorage | (() => CellStorage)
  /** Skip the action-response re-render on every write to this cell;
   *  let the open streaming connection carry the new value instead.
   *  See `CellInterface.deferred`. Pair with a process-global in-memory
   *  storage (so the value is visible across connections without
   *  hitting disk) for cursor / presence broadcast. */
  deferred?: boolean
  /** Publish this cell across the process boundary (remoteCell) —
   *  see `CellInterface.publish`. Default: never served (403). */
  publish?: boolean | ((capability: Record<string, unknown>) => boolean)
}

/**
 * Module-scope cell backed by PERSISTENT local storage. Survives
 * process restart; values land in `cms/data/cells.json` (default
 * adapter). Use for state you actually want to keep across runs —
 * user preferences, editor toggles, draft form data.
 *
 *     export const palette = localCell({
 *       id: "palette",
 *       shape: { enum: ["light", "dark"] as const },
 *       partition: ({session}) => ({sid: session.id}),
 *       initial: "dark",
 *     })
 *
 * For upstream-loaded entity caches (cart, product, user) use
 * `gqlCell`. For sibling-hydrated entities (cart-line) use
 * `fragmentCell`. Both default to ephemeral in-memory storage so
 * disk doesn't accumulate stale cache entries.
 */
/** Options for the inline `localCell("key", {...})` form — declared
 *  inside a parton's `Render`, bound to the calling parton. */
export interface InlineLocalCellOpts<S extends CellShapeSpec, T = ValueOfShape<S>> {
  shape: S
  initial: T
  /** Storage partition — a fixed args record (placement-derived), or
   *  a request-derived callback, e.g.
   *  `partition: ({session}) => ({sid: session.id})`. A callback is
   *  re-run at render AND in the action's request — so a per-session
   *  cell resolves at the caller's partition in the action too, never
   *  a stale recorded one. Defaults to a single slot (`{}`). */
  partition?: CellArgs | ((scope: CellPartitionScope) => CellArgs)
  write?: (value: T) => T
  load?: (args: CellArgs) => Promise<T>
  /** Write authorization — same contract as the module form's
   *  `writeGuard` (see `LocalCellOpts.writeGuard`). */
  writeGuard?: (scope: CellPartitionScope, args: CellArgs) => boolean
}

/**
 * Inline form — called inside a parton's `Render`:
 * `const notes = await localCell("notes", { shape: "string", initial: "" })`.
 * Resolves against the CALLING parton (id `<partonId>/<key>`, via the
 * self-context), folds the cell's invalidation into the fp through the
 * dep-record (store-and-reread), and returns a `ResolvedCell` whose `.set`
 * writes the bound partition. The auto-tracked replacement for a `schema`
 * cell — declared where it's used, no factory threading.
 */
export function localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
  key: string,
  opts: InlineLocalCellOpts<S, T>,
): Promise<ResolvedCell<T>>
/** Module-scope form — a standalone persistent cell handle. */
export function localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
  opts: LocalCellOpts<S, T>,
): LocalCell<T>
export function localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
  keyOrOpts: string | LocalCellOpts<S, T>,
  inlineOpts?: InlineLocalCellOpts<S, T>,
): Promise<ResolvedCell<T>> | LocalCell<T> {
  if (typeof keyOrOpts === "string") {
    return resolveInlineLocalCell<S, T>(keyOrOpts, inlineOpts as InlineLocalCellOpts<S, T>)
  }
  return registerCell(_buildLocalCellHandle(keyOrOpts))
}

/**
 * Build a module-form local-cell handle WITHOUT registering it in the
 * process cell registry. Framework-internal: `remoteCell`
 * (`runtime/remote-cell.ts`) builds its host-side read handle here —
 * the handle's id must equal the REMOTE cell's id (selector identity
 * across the boundary), and registering it would claim that id in
 * THIS process's registry (write actions, endpoint lookups) for a
 * cell this process doesn't own.
 */
export function _buildLocalCellHandle<S extends CellShapeSpec, T = ValueOfShape<S>>(
  opts: LocalCellOpts<S, T>,
): LocalCell<T> {
  const shape = shapeFromSpec(opts.shape)
  const validate = makeValidator<T>(opts.id, shape)
  const partitionFn = normalizePartition(opts.partition)
  const storage: () => CellStorage = !opts.storage
    ? getCellStorage
    : typeof opts.storage === "function"
      ? opts.storage
      : () => opts.storage as CellStorage
  const handle: CellInterface<T> = {
    __cell: true,
    id: opts.id,
    shape,
    defaultValue: opts.initial,
    storage,
    partition: partitionFn,
    load: opts.load,
    with: (args: CellArgs): BoundCell<T> => buildBoundCell(handle, args),
    resolve: (args?: CellArgs) => resolveInBody(handle, args),
    set: bindSetter(opts.id) as CellInterface<T>["set"],
    update: (updater, opts2) => updateCell(handle, updater, opts2?.partition),
    peek: buildPeek(opts.id, storage, validate, opts.initial, partitionFn),
    validate,
    write: opts.write,
    writeGuard: opts.writeGuard,
    deferred: opts.deferred,
    publish: opts.publish,
  }
  return handle
}

async function resolveInlineLocalCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
  key: string,
  opts: InlineLocalCellOpts<S, T>,
): Promise<ResolvedCell<T>> {
  const cp = getCurrentParton()
  if (!cp) {
    throw new Error(`localCell(${JSON.stringify(key)}, …): must be called inside a parton's Render`)
  }
  const id = `${cp.id}/${key}`
  // Partition: a callback (re-derivable — re-run in the action's
  // request so a per-session cell resolves at the caller's partition
  // there too) or a fixed value, default single-slot.
  const partition: CellArgs =
    typeof opts.partition === "function"
      ? opts.partition(buildCellPartitionScopeFromRequest())
      : (opts.partition ?? {})
  const shape = shapeFromSpec(opts.shape)
  // The descriptor is the rebuild input: `finalizeScopedCell` turns it
  // into a handle (registered in the cell registry by id so the client
  // write action finds it), and it's recorded on the snapshot so an
  // action can rebuild + resolve this cell without a render.
  const descriptor: ScopedCellDescriptor<T> = {
    __scopedCellDescriptor: true,
    shape,
    defaultValue: opts.initial,
    partitionFn: undefined,
    write: opts.write,
    writeGuard: opts.writeGuard,
    load: opts.load,
    validate: makeValidator<T>(id, shape),
  }
  const handle =
    (getCellById(id) as CellInterface<T> | undefined) ?? finalizeScopedCell(descriptor, cp.id, key)
  const value = await resolveCellValue(handle, partition)
  // Fold the cell's invalidation into the fp via the dep-record: the
  // `cell:` branch in evalDepKeys re-reads its timestamp (store-and-
  // reread), so a write re-renders this parton on the next nav. The dep is
  // the partition-scoped SELECTOR (`cell:<id>?<partition>`) — the exact
  // string the write fires — so a partitioned write's bump is matched
  // (queryMatchingTs needs the constraints, not just the name).
  cp.deps.add(buildCellSelector(id, partition))
  return buildResolvedCell(handle, value, partition)
}

// ─── Ephemeral-cell builder (shared by gqlCell + fragmentCell) ────────

/**
 * Internal helper — build an `opaque`-shaped Cell backed by the
 * ephemeral in-memory storage. Used by `gqlCell` (with a loader) and
 * `fragmentCell` (without). Authors supply the TS type parameter to
 * narrow the cell's value; runtime treats the value as a black box.
 */
export function buildEphemeralCell<T>(
  id: string,
  initial: T,
  load: ((args: CellArgs) => Promise<T>) | undefined,
  keyOf?: (value: T) => CellArgs,
  write?: (value: T) => T,
): CellInterface<T> {
  const shape: CellShape = { kind: "opaque" }
  const validate = makeValidator<T>(id, shape)
  const handle: CellInterface<T> = {
    __cell: true,
    id,
    shape,
    defaultValue: initial,
    // Lazy getter — ephemeral storage is request-scoped, can't be
    // resolved at module-init time.
    storage: getEphemeralCellStorage,
    partition: constantPartition,
    load,
    keyOf,
    with: (args: CellArgs): BoundCell<T> => buildBoundCell(handle, args),
    resolve: (args?: CellArgs) => resolveInBody(handle, args),
    set: bindSetter(id) as CellInterface<T>["set"],
    update: (updater, opts) => updateCell(handle, updater, opts?.partition),
    peek: buildPeek(id, getEphemeralCellStorage, validate, initial, constantPartition),
    validate,
    write,
  }
  return registerCell(handle)
}

// ─── Resolved-cell construction ───────────────────────────────────────

/**
 * Build a per-render `ResolvedCell<T>` view from a module handle and
 * its resolved value.
 *
 * For module-scope cells: omit `partition`. The cell's `set` is the
 * module-scope bound action — partition resolves from the action
 * invocation's request scope.
 *
 * For scoped or placement-bound cells: pass `partition` (the resolved
 * args). The cell's `set` becomes
 * `__scopedCellWrite.bind(null, id, partition)` — partition baked at
 * resolution time so client calls land on the right partition
 * regardless of URL changes between render and call.
 */
/** In-body resolution — the implementation behind `handle.resolve()`. */
async function resolveInBody<T>(
  handle: CellInterface<T>,
  args: CellArgs | undefined,
): Promise<ResolvedCell<T>> {
  const partition = args ?? handle.partition(buildCellPartitionScopeFromRequest())
  const value = await resolveCellValue(handle, partition)
  // The dep is the partition-scoped selector — the exact string a
  // write fires — so a partitioned write's bump is matched, and the
  // boundary surfaces the bare `cell:` name as a refetch label.
  getCurrentParton()?.deps.add(buildCellSelector(handle.id, partition))
  return buildResolvedCell(handle, value, args !== undefined ? partition : undefined)
}

/** Whether the current render is a `<RemoteFrame>` embed hop (the
 *  producer side of a splice). No request context ⇒ not a render ⇒
 *  false. */
function inEmbedRender(): boolean {
  try {
    return embedDepthOf(getRequest().headers) > 0
  } catch {
    return false
  }
}

export function buildResolvedCell<T>(
  handle: CellInterface<T>,
  value: T,
  partition?: CellArgs,
): ResolvedCell<T> {
  // Inside a `<RemoteFrame>` embed the resolved cell crosses the splice
  // — the host decodes the producer's payload and re-encodes it into
  // its own document render, which a bound server-action ref cannot
  // survive (it stalls the host stream). Carry the write as a CLIENT
  // reference instead: the id + partition ride as data, and
  // `embedCellWrite` (a host-bundle client fn) re-routes through the
  // ordinary batcher on the browser. Client refs re-encode across an
  // ungoverned same-origin embed exactly like any client component.
  const set = inEmbedRender()
    ? (embedCellWrite as unknown as ResolvedCell<T>["set"])
    : partition !== undefined
      ? (_scopedCellWriteAction.bind(null, handle.id, partition) as ResolvedCell<T>["set"])
      : handle.set
  if (partition !== undefined) {
    return { __cell: true, id: handle.id, value, partition, set }
  }
  return { __cell: true, id: handle.id, value, set }
}

/** Test-only — wipe the registry between tests so cells from prior
 *  runs don't leak. Production HMR overwrites in place. */
export function _clearCellRegistry(): void {
  cellRegistry.clear()
}

// ─── Scoped cell descriptors ──────────────────────────────────────────
//
// A scoped cell is declared inline inside a parton's `schema` callback,
// not as a module-scope export. It has no author-supplied `id`; the
// framework derives `<partonId>/<schemaKey>` when the schema's return
// record is processed. Its `partition` callback receives the parton's
// match params — partition can NARROW the parton's dependency
// surface but not expand beyond it.

/**
 * Descriptor returned by the schema-callback `localCell(...)` factory.
 * Carries everything needed to finalize into a `CellInterface<T>` once the
 * framework knows the schema key and the owning parton id.
 */
export interface ScopedCellDescriptor<T> {
  readonly __scopedCellDescriptor: true
  readonly shape: CellShape
  readonly defaultValue: T
  readonly partitionFn?: (partonVary: never) => CellArgs
  readonly write?: (value: T) => T
  readonly writeGuard?: (scope: CellPartitionScope, args: CellArgs) => boolean
  readonly load?: (args: CellArgs) => Promise<T>
  readonly validate: (value: unknown) => T
}

export function isScopedCellDescriptor(value: unknown): value is ScopedCellDescriptor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __scopedCellDescriptor?: boolean }).__scopedCellDescriptor === true
  )
}

export function finalizeScopedCell<T>(
  descriptor: ScopedCellDescriptor<T>,
  partonId: string,
  schemaKey: string,
): CellInterface<T> {
  const id = `${partonId}/${schemaKey}`
  const validate = makeValidator<T>(id, descriptor.shape)
  // Scoped cells default to persistent storage — they're typically
  // tied to parton state like form drafts that authors want to keep
  // across renders. Override via a future `storage` option on the
  // descriptor if needed.
  // The handle's own `partition` is constant — an inline cell's
  // partition is fixed at declaration (the descriptor's `partition`
  // record/callback, default `{}`), not derived from request scope.
  // `peek` follows the same rule: no-arg reads the `{}` partition;
  // callers that need a parton-partitioned slot pass its args
  // (`peek(partitionArgs)`). See `CellInterface.peek`.
  const handle: CellInterface<T> = {
    __cell: true,
    id,
    shape: descriptor.shape,
    defaultValue: descriptor.defaultValue,
    storage: getCellStorage,
    partition: constantPartition,
    load: descriptor.load,
    with: (args: CellArgs): BoundCell<T> => buildBoundCell(handle, args),
    resolve: (args?: CellArgs) => resolveInBody(handle, args),
    set: bindSetter(id) as CellInterface<T>["set"],
    update: (updater, opts) => updateCell(handle, updater, opts?.partition),
    peek: buildPeek(id, getCellStorage, validate, descriptor.defaultValue, constantPartition),
    validate,
    write: descriptor.write,
    writeGuard: descriptor.writeGuard,
  }
  cellRegistry.set(id, handle as CellInterface<unknown>)
  return handle
}
