/**
 * Cell — typed, identity-keyed slot of server-authoritative state.
 *
 * Two construction paths:
 *
 *   - `localCell({id, shape, vary?, initial, write?, load?})` —
 *     module-scope, backed by the active `CellStorage` adapter.
 *     `vary` (optional) derives partition from request scope; `.with(args)`
 *     binds explicit placement-derived args.
 *
 *   - `gqlCell(typedDoc)` (in cell-gql.ts) — same `Cell<T>` shape with
 *     `load` auto-synthesized from a gql.tada-typed document.
 *
 * Partitioning sources:
 *   - `vary` callback (request-derived, optional)
 *   - `.with(args)` bound at the call site (placement-derived)
 *   - Both can compose into a single partition object.
 *
 * Storage model: storage is the authoritative source. `load` runs on
 * cold-start (storage miss) and populates the slot. Mutations write
 * storage explicitly and fire partition-scoped invalidation. No TTL.
 *
 * Reading: a parton declares cells via `schema` or by accepting them
 * as JSX props (auto-resolved by the framework before Render).
 *
 * Writing: `cell.with(args).set(value)` writes storage at the bound
 * partition AND fires `refreshSelector("cell:<id>?<args>")` so only
 * placements bound to the same args refetch.
 *
 * See `docs/reference/cells.md` for the user-facing surface.
 */

import {
  __cellWrite as _cellWriteAction,
  __scopedCellWrite as _scopedCellWriteAction,
} from "../runtime/cell-actions.ts"
import { getCellStorage } from "../runtime/cell-storage.ts"
import { getRequest, getScope, parseCookies } from "../runtime/context.ts"
import { createSessionReadSurface } from "../runtime/session.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { buildTimeScope } from "./time.ts"
import type { VaryScope } from "./partial.tsx"
import type { SessionId } from "../runtime/session.ts"

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Sync request scope a cell's `vary` callback sees. Same shape as a
 * parton's `VaryScope` minus `instanceId` (cells aren't per-placement)
 * and with the narrower `SessionId`.
 */
export type CellVaryScope = Omit<VaryScope, "instanceId" | "session"> & {
  session: SessionId
}

/** Args object — the placement/partition inputs that hash to a
 *  partition key. */
export type CellArgs = Record<string, unknown>

/** Shape declaration accepted by `localCell({shape: ...})`. */
export type CellShapeSpec =
  | "string"
  | "number"
  | "boolean"
  | "opaque"
  | { enum: readonly string[] }

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
export type ValueOfShape<S> =
  S extends "string" ? string :
  S extends "number" ? number :
  S extends "boolean" ? boolean :
  S extends "opaque" ? unknown :
  S extends { enum: readonly (infer V)[] } ? V :
  never

/**
 * Module-scope cell handle. Constructed via `localCell({...})` or
 * `gqlCell(...)` and held as a module export.
 *
 * Carries the static decisions (id, shape, vary, defaultValue, load)
 * plus methods for binding and mutating partitions:
 *
 *   - `with(args)` returns a `BoundCell<T>` with partition baked.
 *   - `set(value, opts?)` writes the partition derived from
 *     `cell.vary(request)` (or the explicit `opts.vary` override).
 *   - `peek()` sync-reads the current stored value at the partition
 *     derived from request scope.
 */
export interface Cell<T> {
  readonly __cell: true
  readonly id: string
  readonly shape: CellShape
  readonly defaultValue: T
  /** Vary callback. Runs against the request scope; the hashed output
   *  is part of the storage partition key. Default: `() => ({})`. */
  readonly vary: (scope: CellVaryScope) => CellArgs
  /** Optional async loader — runs on cold-start (storage miss) at the
   *  partition, result populates storage. */
  readonly load?: (args: CellArgs) => Promise<T>
  /**
   * Bind this cell to explicit args, returning a `BoundCell<T>` with
   * the partition baked. Use at JSX placement sites:
   *
   *     <CartLine item={cartItemCell.with({itemId})} parent={parent} />
   */
  with(args: CellArgs): BoundCell<T>
  /**
   * Mutation surface. Server-side: invokes the action synchronously
   * against the current request scope. Client-side: Flight-serialized
   * server reference; partition resolves from the action's request
   * scope on the server.
   *
   * Optional `opts.vary` overrides the cell's own vary callback —
   * useful for cross-context mutations.
   */
  set(value: T, opts?: { vary?: CellArgs }): Promise<void>
  /** Synchronous server-side read of the stored value at the partition
   *  derived from `cell.vary(currentRequest)`. Returns `defaultValue`
   *  on miss. Does NOT trigger the loader. */
  peek(): T
  /** Internal — validates an incoming value against the cell's shape. */
  validate(value: unknown): T
  /** Internal — server-side write-pipeline transform. */
  write?(value: T): T
}

/**
 * Bound cell — a `Cell<T>` with a specific partition baked. Created by
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
  /** Functional update: read current value, apply updater, write back.
   *  Reads via the cell's loader/storage; applies updater synchronously;
   *  writes result. */
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
  set(value: T, opts?: { vary?: CellArgs }): Promise<void>
}

// ─── Cell registry (module-scope state) ───────────────────────────────

const cellRegistry = new Map<string, Cell<unknown>>()

export function getCellById(id: string): Cell<unknown> | undefined {
  return cellRegistry.get(id)
}

/** Type predicate — works on module handles and resolved cells. */
export function isCellHandle(value: unknown): value is Cell<unknown> | ResolvedCell<unknown> {
  return typeof value === "object" && value !== null && (value as { __cell?: boolean }).__cell === true
}

export function isModuleCell(value: unknown): value is Cell<unknown> {
  return isCellHandle(value) && typeof (value as Cell<unknown>).vary === "function"
}

export function isBoundCell(value: unknown): value is BoundCell<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __boundCell?: boolean }).__boundCell === true
  )
}

/** Compute the partition key for a cell against a request scope. */
export function computeCellPartitionKey(cell: Cell<unknown>, scope: CellVaryScope): string {
  const out = cell.vary(scope)
  return hash(stableStringify(out))
}

/** Compute the partition key from explicit args. */
export function computePartitionKeyFromArgs(args: CellArgs): string {
  return hash(stableStringify(args))
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
      return ((v: unknown): T => {
        if (typeof v !== "string") {
          throw new TypeError(`cell ${id}: expected string, got ${typeof v}`)
        }
        return v as T
      })
    case "number":
      return ((v: unknown): T => {
        if (typeof v !== "number" || Number.isNaN(v)) {
          throw new TypeError(`cell ${id}: expected number, got ${typeof v}`)
        }
        return v as T
      })
    case "boolean":
      return ((v: unknown): T => {
        if (typeof v !== "boolean") {
          throw new TypeError(`cell ${id}: expected boolean, got ${typeof v}`)
        }
        return v as T
      })
    case "opaque":
      // No runtime validation for opaque cells — author owns the TS
      // type, framework treats the value as a black box.
      return ((v: unknown): T => v as T)
    case "enum": {
      const allowed: ReadonlySet<string> = new Set(shape.values)
      const values = shape.values
      return ((v: unknown): T => {
        if (typeof v !== "string" || !allowed.has(v)) {
          throw new TypeError(
            `cell ${id}: expected one of ${values.join(", ")}, got ${String(v)}`,
          )
        }
        return v as T
      })
    }
  }
}

function constantVary(): CellArgs {
  return {}
}

function registerCell<T>(handle: Cell<T>): Cell<T> {
  // HMR overwrites in place. Storage is keyed by id, so values from
  // the prior registration are unaffected.
  cellRegistry.set(handle.id, handle as Cell<unknown>)
  return handle
}

/** Bind the generic `__cellWrite` server action to a specific cell id. */
function bindSetter(id: string): Cell<unknown>["set"] {
  return _cellWriteAction.bind(null, id) as unknown as Cell<unknown>["set"]
}

/** Per-cell `peek` — sync server-side read at the partition derived
 *  from the cell's own vary against the active ALS request context. */
function buildPeek<T>(
  id: string,
  validate: (v: unknown) => T,
  defaultValue: T,
  varyFn: (scope: CellVaryScope) => CellArgs,
): Cell<T>["peek"] {
  return () => {
    const varyOut = varyFn(buildCellVaryScopeFromRequest())
    const partitionKey = hash(stableStringify(varyOut))
    const stored = getCellStorage().read(getScope(), id, partitionKey)
    if (stored === undefined) return defaultValue
    try {
      return validate(stored)
    } catch {
      return defaultValue
    }
  }
}

function buildCellVaryScopeFromRequest(): CellVaryScope {
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
 * Used by the schema/prop resolution path and by `BoundCell.update`.
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
export async function resolveCellValue<T>(
  cell: Cell<T>,
  args: CellArgs,
): Promise<T> {
  const partitionKey = hash(stableStringify(args))
  const stored = getCellStorage().read(getScope(), cell.id, partitionKey)
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
    getCellStorage().write(getScope(), cell.id, partitionKey, transformed)
    return transformed
  }
  return cell.defaultValue
}

// ─── BoundCell construction ───────────────────────────────────────────

/** Construct a bound cell from a Cell handle + args. The bound view
 *  carries the cellId + args plus convenience methods that bake the
 *  args into the write action invocation. */
function buildBoundCell<T>(cell: Cell<T>, args: CellArgs): BoundCell<T> {
  const cellId = cell.id
  return {
    __boundCell: true,
    cellId,
    args,
    async set(value: T): Promise<void> {
      await _scopedCellWriteAction(cellId, args, value)
    },
    async update(updater: (current: T) => T): Promise<void> {
      const current = await resolveCellValue(cell, args)
      const next = updater(current)
      await _scopedCellWriteAction(cellId, args, next)
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
      getCellStorage().write(getScope(), cellId, partitionKey, undefined)
      const { __cellInvalidate } = await import("../runtime/cell-actions.ts")
      await __cellInvalidate(cellId, args)
    },
    hydrate(value: T): void {
      const partitionKey = hash(stableStringify(args))
      const validated = cell.validate(value)
      const stored = cell.write ? cell.write(validated) : validated
      getCellStorage().write(getScope(), cellId, partitionKey, stored)
    },
  }
}

// ─── Module-scope localCell ───────────────────────────────────────────

/** Options for `localCell({...})`. */
export interface LocalCellOpts<S extends CellShapeSpec, T = ValueOfShape<S>> {
  id: string
  shape: S
  initial: T
  /** Sync callback `(scope) => CellArgs`. Output hashes into the
   *  storage partition key. Omit for a cell whose partition comes
   *  entirely from `.with()` at call sites (or for a single-slot
   *  cell when nothing binds args). */
  vary?: (scope: CellVaryScope) => CellArgs
  /** Async loader — runs on storage miss at a partition. Result is
   *  validated, run through `write` if present, then stored. Use for
   *  cells whose initial value is fetched from upstream (GraphQL,
   *  REST, etc.) instead of a static default. */
  load?: (args: CellArgs) => Promise<T>
  /** Server-side write-pipeline transform. Runs after `validate` and
   *  before storage on every write. */
  write?: (value: T) => T
}

/**
 * Module-scope cell backed by local storage.
 *
 *     export const palette = localCell({
 *       id: "palette",
 *       shape: { enum: ["light", "dark"] as const },
 *       vary: ({session}) => ({sid: session.id}),
 *       initial: "dark",
 *     })
 *
 *     export const cartItemCell = localCell({
 *       id: "cart-item",
 *       shape: "opaque",
 *       initial: null as CartItem | null,
 *       // No vary — partition comes from .with({itemId}) at placement sites.
 *     })
 */
export function localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
  opts: LocalCellOpts<S, T>,
): Cell<T> {
  const shape = shapeFromSpec(opts.shape)
  const validate = makeValidator<T>(opts.id, shape)
  const varyFn = opts.vary ?? constantVary
  const handle: Cell<T> = {
    __cell: true,
    id: opts.id,
    shape,
    defaultValue: opts.initial,
    vary: varyFn,
    load: opts.load,
    with: (args: CellArgs): BoundCell<T> => buildBoundCell(handle, args),
    set: bindSetter(opts.id) as Cell<T>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
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
export function buildResolvedCell<T>(
  handle: Cell<T>,
  value: T,
  partition?: CellArgs,
): ResolvedCell<T> {
  if (partition !== undefined) {
    return {
      __cell: true,
      id: handle.id,
      value,
      partition,
      set: _scopedCellWriteAction.bind(null, handle.id, partition) as ResolvedCell<T>["set"],
    }
  }
  return {
    __cell: true,
    id: handle.id,
    value,
    set: handle.set,
  }
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
// record is processed. Its `vary` callback receives the parton's
// resolved vary output — partition can NARROW the parton's dependency
// surface but not expand beyond it.

/**
 * Descriptor returned by the schema-callback `localCell(...)` factory.
 * Carries everything needed to finalize into a `Cell<T>` once the
 * framework knows the schema key and the owning parton id.
 */
export interface ScopedCellDescriptor<T> {
  readonly __scopedCellDescriptor: true
  readonly shape: CellShape
  readonly defaultValue: T
  readonly varyFn?: (partonVary: never) => CellArgs
  readonly write?: (value: T) => T
  readonly load?: (args: CellArgs) => Promise<T>
  readonly validate: (value: unknown) => T
}

export function isScopedCellDescriptor(
  value: unknown,
): value is ScopedCellDescriptor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __scopedCellDescriptor?: boolean }).__scopedCellDescriptor === true
  )
}

/** Options for `schema({localCell}) => ({ x: localCell({...}) })`. */
export interface ScopedLocalCellOpts<S extends CellShapeSpec, PV, T = ValueOfShape<S>> {
  shape: S
  initial: T
  vary?: (partonVary: PV) => CellArgs
  write?: (value: T) => T
  load?: (args: CellArgs) => Promise<T>
}

export interface ScopedCellFactories<PV> {
  localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
    opts: ScopedLocalCellOpts<S, PV, T>,
  ): ScopedCellDescriptor<T>
}

export function makeScopedCellFactories<PV>(): ScopedCellFactories<PV> {
  return {
    localCell<S extends CellShapeSpec, T = ValueOfShape<S>>(
      opts: ScopedLocalCellOpts<S, PV, T>,
    ): ScopedCellDescriptor<T> {
      const shape = shapeFromSpec(opts.shape)
      return {
        __scopedCellDescriptor: true,
        shape,
        defaultValue: opts.initial,
        varyFn: opts.vary as ((pv: never) => CellArgs) | undefined,
        write: opts.write,
        load: opts.load,
        validate: makeValidator<T>("scoped-cell", shape),
      }
    },
  }
}

/**
 * Finalize a scoped descriptor into a `Cell<T>` handle keyed by
 * compound id `<partonId>/<schemaKey>`. Registered into the cell
 * registry so `__cellWrite` / `__cellWriteBatch` can look it up by id.
 */
export function finalizeScopedCell<T>(
  descriptor: ScopedCellDescriptor<T>,
  partonId: string,
  schemaKey: string,
): Cell<T> {
  const id = `${partonId}/${schemaKey}`
  const validate = makeValidator<T>(id, descriptor.shape)
  const handle: Cell<T> = {
    __cell: true,
    id,
    shape: descriptor.shape,
    defaultValue: descriptor.defaultValue,
    vary: () => ({}),
    load: descriptor.load,
    with: (args: CellArgs): BoundCell<T> => buildBoundCell(handle, args),
    set: bindSetter(id) as Cell<T>["set"],
    peek: () => descriptor.defaultValue,
    validate,
    write: descriptor.write,
  }
  cellRegistry.set(id, handle as Cell<unknown>)
  return handle
}

/**
 * Compute the storage partition key for a scoped cell given the
 * parton's resolved vary output.
 */
export function computeScopedCellPartitionKey(
  descriptor: ScopedCellDescriptor<unknown>,
  partonVary: CellArgs | null | undefined,
): string {
  const base = partonVary ?? {}
  const out = descriptor.varyFn
    ? descriptor.varyFn(base as never)
    : base
  return hash(stableStringify(out))
}
