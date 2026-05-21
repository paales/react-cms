/**
 * Cell — typed, identity-keyed slot of server-authoritative state.
 *
 * A cell is constructed once at module scope (`cell.string(...)`,
 * `cell.number(...)`, …) and declares:
 *   - an `id` (the wire identifier),
 *   - a `vary` callback (request → storage partition key),
 *   - a default value,
 *   - a runtime shape (for validation on client writes).
 *
 * Reading: a parton's `schema` option declares cell handles. The
 * framework runs each cell's `vary` against the request scope,
 * looks up the storage slot, and passes the resolved value to
 * Render as a `ResolvedCell<T>` (`{id, value, set}`).
 *
 * Writing: `cell.set(v)` is a server-action reference. Server-side
 * it runs the action directly; client-side it's a Flight-serialized
 * server reference that re-runs against the action's request scope.
 *
 * See `docs/notes/cells.md` for the live design doc.
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
 * parton's `VaryScope` minus `instanceId` (cells aren't per-
 * placement) and with the narrower `SessionId` (cells only need
 * `session.id`; the named-key session readers live on vary for the
 * legacy editor-shell callers).
 */
export type CellVaryScope = Omit<VaryScope, "instanceId" | "session"> & {
  session: SessionId
}

/** Cell shape catalog — drives runtime validation on client writes. */
export type CellShape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }

/**
 * Module-scope cell handle. Constructed once via `cell.<shape>(...)`
 * and held as a module export. Carries the static decisions (id,
 * shape, vary, defaultValue) plus the bound `set` server-action ref
 * — the same `set` reference flows into `ResolvedCell` and across
 * Flight to client components, so client and server invocations land
 * in the same handler.
 */
export interface Cell<T> {
  readonly __cell: true
  readonly id: string
  readonly shape: CellShape
  readonly defaultValue: T
  readonly vary: (scope: CellVaryScope) => Record<string, unknown>
  /**
   * Mutation surface. Server-side: invokes the action synchronously
   * against the current request scope. Client-side: Flight-serialized
   * server reference; partition key resolves from the action's
   * request scope on the server.
   *
   * Optional `opts.vary` overrides the cell's own vary callback —
   * useful for cross-context mutations (action fired from /cart
   * updating notes for a product not in the URL).
   */
  set(value: T, opts?: { vary?: Record<string, unknown> }): Promise<void>
  /**
   * Synchronous server-side read of the current stored value. Reads
   * the cell's storage at `(getScope(), id, partitionKey)` where
   * the partition key is computed from the cell's own `vary`
   * callback against the active request scope.
   *
   * Must be called inside a request context (vary / render / action
   * body). Returns `defaultValue` on storage miss.
   */
  peek(): T
  /** Internal — coerces / validates an incoming value into T. Throws
   *  on shape mismatch. */
  validate(value: unknown): T
  /** Internal — server-side write-pipeline transform. Runs after
   *  `validate` and before storage on every write. `undefined` when
   *  the cell didn't declare a `write` option. Gives the server final
   *  say on the stored shape regardless of what the client sent
   *  (uppercase + strip specials on a name field, even when the
   *  client typed raw). A `read` counterpart for read-time
   *  transforms is designed but not shipped — waiting for a caller. */
  write?(value: T): T
}

/**
 * Resolved cell — the per-render view a parton's `schema` produces.
 * Carries the resolved `.value` plus the same bound `set` action
 * reference as the source `Cell<T>`. This is what Render receives
 * and what crosses Flight to client components.
 *
 * `partition` is set for scoped cells (declared inline in `schema({cell})`)
 * — it's the parton's vary output (possibly narrowed by the descriptor's
 * `vary` callback) used as the storage partition. Carried on the wire so
 * the client batcher can include it in `__cellWriteBatch` entries; the
 * resolved cell's `set` already has partition baked at resolution time
 * for non-batched direct calls. Module-scope cells leave this undefined;
 * their partition resolves from the action's request scope at write time.
 */
export interface ResolvedCell<T> {
  readonly __cell: true
  readonly id: string
  readonly value: T
  readonly partition?: Record<string, unknown>
  set(value: T, opts?: { vary?: Record<string, unknown> }): Promise<void>
}

// ─── Cell registry (module-scope state) ───────────────────────────────

const cellRegistry = new Map<string, Cell<unknown>>()

export function getCellById(id: string): Cell<unknown> | undefined {
  return cellRegistry.get(id)
}

/** Type predicate — works on both module handles and resolved cells. */
export function isCellHandle(value: unknown): value is Cell<unknown> | ResolvedCell<unknown> {
  return typeof value === "object" && value !== null && (value as { __cell?: boolean }).__cell === true
}

export function isModuleCell(value: unknown): value is Cell<unknown> {
  return isCellHandle(value) && typeof (value as Cell<unknown>).vary === "function"
}

/** Compute the partition key for a cell against a request scope. */
export function computeCellPartitionKey(cell: Cell<unknown>, scope: CellVaryScope): string {
  const out = cell.vary(scope)
  return hash(stableStringify(out))
}

// ─── Common factory plumbing ──────────────────────────────────────────

interface CommonOpts<T> {
  id: string
  initial: T
  vary?: (scope: CellVaryScope) => Record<string, unknown>
  /** Server-side write-pipeline transform. Runs after `validate` and
   *  before storage on every write — gives the server final say on
   *  the stored shape regardless of what the client sent. Use for
   *  canonicalisation (uppercase, trim, format) and server-only rules
   *  (length cap not shared with the client, deduplication, etc.).
   *  Called inside the cell-write transaction; throwing rolls the
   *  batch back. A `read` counterpart for read-time transforms is
   *  designed but deferred until a caller needs the split. */
  write?: (value: T) => T
}

function constantPartitionVary(): Record<string, unknown> {
  return {}
}

function registerCell<T>(handle: Cell<T>): Cell<T> {
  if (cellRegistry.has(handle.id)) {
    // Module reload (HMR) — overwrite. Keep the latest definition.
    // The storage layer is keyed by id; values from the prior
    // registration are unaffected.
  }
  cellRegistry.set(handle.id, handle as Cell<unknown>)
  return handle
}

/** Bind the generic `__cellWrite` server action to a specific cell
 *  id. The bound function is a stable server-action reference: it
 *  crosses Flight as a server-ref with the id baked in, so client
 *  invocations land in the same handler the server uses. */
function bindSetter(id: string): Cell<unknown>["set"] {
  // `bind` on a server-action reference yields a partially-applied
  // server reference. React 19's Flight encoder handles this — the
  // serialized form carries the bound argument; the client receives
  // a callable that fires the bound action with the remaining args.
  return _cellWriteAction.bind(null, id) as unknown as Cell<unknown>["set"]
}

/** Per-cell `peek` — bound at construct time. Resolves scope and
 *  vary against the active ALS request context, so callers don't
 *  need to thread them through their own closures. */
function buildPeek<T>(
  id: string,
  validate: (v: unknown) => T,
  defaultValue: T,
  varyFn: (scope: CellVaryScope) => Record<string, unknown>,
): Cell<T>["peek"] {
  return () => {
    const varyOut = varyFn(buildCellVaryScopeFromRequest())
    const partitionKey = hash(stableStringify(varyOut))
    const stored = getCellStorage().read(getScope(), id, partitionKey)
    if (stored === undefined) return defaultValue
    try {
      return validate(stored)
    } catch {
      // Stored value drifted off-shape (manual edit, legacy data) —
      // surface the default rather than throwing inside a render.
      return defaultValue
    }
  }
}

/** Build a `CellVaryScope` from the active request. Used by `peek`
 *  when the caller is inside any framework-managed request context
 *  (vary, render, action, scheduled task). */
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

// ─── Factories ────────────────────────────────────────────────────────

interface StringOpts extends CommonOpts<string> {}
function makeString(opts: StringOpts): Cell<string> {
  const validate = (value: unknown): string => {
    if (typeof value !== "string") {
      throw new TypeError(`cell ${opts.id}: expected string, got ${typeof value}`)
    }
    return value
  }
  const varyFn = opts.vary ?? constantPartitionVary
  const handle: Cell<string> = {
    __cell: true,
    id: opts.id,
    shape: { kind: "string" },
    defaultValue: opts.initial,
    vary: varyFn,
    set: bindSetter(opts.id) as Cell<string>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
  }
  return registerCell(handle)
}

interface NumberOpts extends CommonOpts<number> {}
function makeNumber(opts: NumberOpts): Cell<number> {
  const validate = (value: unknown): number => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new TypeError(`cell ${opts.id}: expected number, got ${typeof value}`)
    }
    return value
  }
  const varyFn = opts.vary ?? constantPartitionVary
  const handle: Cell<number> = {
    __cell: true,
    id: opts.id,
    shape: { kind: "number" },
    defaultValue: opts.initial,
    vary: varyFn,
    set: bindSetter(opts.id) as Cell<number>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
  }
  return registerCell(handle)
}

interface BooleanOpts extends CommonOpts<boolean> {}
function makeBoolean(opts: BooleanOpts): Cell<boolean> {
  const validate = (value: unknown): boolean => {
    if (typeof value !== "boolean") {
      throw new TypeError(`cell ${opts.id}: expected boolean, got ${typeof value}`)
    }
    return value
  }
  const varyFn = opts.vary ?? constantPartitionVary
  const handle: Cell<boolean> = {
    __cell: true,
    id: opts.id,
    shape: { kind: "boolean" },
    defaultValue: opts.initial,
    vary: varyFn,
    set: bindSetter(opts.id) as Cell<boolean>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
  }
  return registerCell(handle)
}

interface EnumOpts<T extends string> extends CommonOpts<T> {}
function makeEnum<const T extends readonly string[]>(
  values: T,
  opts: EnumOpts<T[number]>,
): Cell<T[number]> {
  const allowed: ReadonlySet<string> = new Set(values)
  const validate = (value: unknown): T[number] => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new TypeError(
        `cell ${opts.id}: expected one of ${values.join(", ")}, got ${String(value)}`,
      )
    }
    return value as T[number]
  }
  const varyFn = opts.vary ?? constantPartitionVary
  const handle: Cell<T[number]> = {
    __cell: true,
    id: opts.id,
    shape: { kind: "enum", values },
    defaultValue: opts.initial,
    vary: varyFn,
    set: bindSetter(opts.id) as Cell<T[number]>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
  }
  return registerCell(handle)
}

/**
 * Cell factory namespace. Pick the shape matching the value type;
 * shape drives runtime validation on client writes.
 *
 *     export const palette = cell.enum(["light", "dark"], {
 *       id: "palette",
 *       vary: ({session}) => ({sid: session.id}),
 *       initial: "dark",
 *     })
 */
export const cell = {
  string: makeString,
  number: makeNumber,
  boolean: makeBoolean,
  enum: makeEnum,
} as const

// ─── Resolved-cell construction ───────────────────────────────────────

/**
 * Build a per-render `ResolvedCell<T>` view from a module handle and
 * its resolved value. Used by the partial render path (`schema`
 * resolution) — the resolved view is what Render receives and what
 * crosses Flight to client components.
 *
 * For module-scope cells: omit `partition`. The cell's `set` is the
 * module-scope bound action (`__cellWrite.bind(null, id)`) — partition
 * resolves from the action invocation's request scope.
 *
 * For scoped cells: pass `partition` (the parton's vary output, or the
 * descriptor's vary-narrowed subset). The cell's `set` becomes
 * `__scopedCellWrite.bind(null, id, partition)` — partition baked at
 * resolution time so client calls land on the right partition
 * regardless of URL changes between render and call.
 */
export function buildResolvedCell<T>(
  handle: Cell<T>,
  value: T,
  partition?: Record<string, unknown>,
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
 *  runs don't leak. Production HMR overwrites in place; this is the
 *  full reset path. */
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
//
// The factory inside the callback returns a `ScopedCellDescriptor<T>`.
// The framework finalizes descriptors into `Cell<T>` handles + registers
// them under the compound id during the schema-resolution phase in
// `partial.tsx`.

/**
 * Descriptor returned by the schema-callback `cell.<shape>(...)` factory.
 * Carries everything needed to finalize into a `Cell<T>` once the
 * framework knows the schema key and the owning parton id.
 *
 * `varyFn` is optional. When omitted, the partition key is computed from
 * the parton's full vary output (the cell partitions on every dimension
 * the parton depends on). When provided, the function receives the
 * parton's vary output and returns a subset — narrowing the partition.
 */
export interface ScopedCellDescriptor<T> {
  readonly __scopedCellDescriptor: true
  readonly shape: CellShape
  readonly defaultValue: T
  readonly varyFn?: (partonVary: never) => Record<string, unknown>
  readonly write?: (value: T) => T
  readonly validate: (value: unknown) => T
}

/** Type predicate for descriptors. Distinct from `isModuleCell` because
 *  descriptors don't carry their own `id` or registered `vary` — they
 *  need finalization. */
export function isScopedCellDescriptor(
  value: unknown,
): value is ScopedCellDescriptor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __scopedCellDescriptor?: boolean }).__scopedCellDescriptor === true
  )
}

interface ScopedCommonOpts<T, PV> {
  initial: T
  /** Optional partition narrower. Receives the parton's resolved vary
   *  output; returns a subset object that hashes into the cell's
   *  partition key. Omit to partition on the entire parton vary output. */
  vary?: (partonVary: PV) => Record<string, unknown>
  /** Server-side write-pipeline transform. Same semantic as module-scope
   *  cells. Runs after `validate`, before storage. */
  write?: (value: T) => T
}

/**
 * Factory namespace passed as `{cell}` into a parton's `schema` callback.
 * Mirrors the module-scope `cell` factory's surface (`string`, `number`,
 * `boolean`, `enum`) but the options omit `id` (auto-derived from the
 * schema key) and the `vary` callback narrows the parton's vary output
 * instead of taking a request scope.
 *
 * Generic `PV` carries the parton's vary output type so the cell's
 * `vary` callback parameter is typed correctly without manual generics.
 */
export interface ScopedCellFactories<PV> {
  string(opts: ScopedCommonOpts<string, PV>): ScopedCellDescriptor<string>
  number(opts: ScopedCommonOpts<number, PV>): ScopedCellDescriptor<number>
  boolean(opts: ScopedCommonOpts<boolean, PV>): ScopedCellDescriptor<boolean>
  enum<const T extends readonly string[]>(
    values: T,
    opts: ScopedCommonOpts<T[number], PV>,
  ): ScopedCellDescriptor<T[number]>
}

function makeStringValidator(id: string): (v: unknown) => string {
  return (v) => {
    if (typeof v !== "string") {
      throw new TypeError(`cell ${id}: expected string, got ${typeof v}`)
    }
    return v
  }
}
function makeNumberValidator(id: string): (v: unknown) => number {
  return (v) => {
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new TypeError(`cell ${id}: expected number, got ${typeof v}`)
    }
    return v
  }
}
function makeBooleanValidator(id: string): (v: unknown) => boolean {
  return (v) => {
    if (typeof v !== "boolean") {
      throw new TypeError(`cell ${id}: expected boolean, got ${typeof v}`)
    }
    return v
  }
}
function makeEnumValidator<const T extends readonly string[]>(
  id: string,
  values: T,
): (v: unknown) => T[number] {
  const allowed: ReadonlySet<string> = new Set(values)
  return (v) => {
    if (typeof v !== "string" || !allowed.has(v)) {
      throw new TypeError(
        `cell ${id}: expected one of ${values.join(", ")}, got ${String(v)}`,
      )
    }
    return v as T[number]
  }
}

/**
 * Build the `{cell}` factory bag for a parton's `schema` callback.
 *
 * The validators bake in a placeholder id ("scoped-cell"); finalization
 * replaces the id with `<partonId>/<schemaKey>` before registration.
 * The placeholder only surfaces in error messages thrown from a
 * descriptor's `validate` before finalization, which shouldn't happen
 * in normal flow.
 */
export function makeScopedCellFactories<PV>(): ScopedCellFactories<PV> {
  return {
    string: (opts) => ({
      __scopedCellDescriptor: true,
      shape: { kind: "string" },
      defaultValue: opts.initial,
      varyFn: opts.vary as ((pv: never) => Record<string, unknown>) | undefined,
      write: opts.write,
      validate: makeStringValidator("scoped-cell"),
    }),
    number: (opts) => ({
      __scopedCellDescriptor: true,
      shape: { kind: "number" },
      defaultValue: opts.initial,
      varyFn: opts.vary as ((pv: never) => Record<string, unknown>) | undefined,
      write: opts.write,
      validate: makeNumberValidator("scoped-cell"),
    }),
    boolean: (opts) => ({
      __scopedCellDescriptor: true,
      shape: { kind: "boolean" },
      defaultValue: opts.initial,
      varyFn: opts.vary as ((pv: never) => Record<string, unknown>) | undefined,
      write: opts.write,
      validate: makeBooleanValidator("scoped-cell"),
    }),
    enum: (values, opts) => ({
      __scopedCellDescriptor: true,
      shape: { kind: "enum", values },
      defaultValue: opts.initial,
      varyFn: opts.vary as ((pv: never) => Record<string, unknown>) | undefined,
      write: opts.write,
      validate: makeEnumValidator("scoped-cell", values),
    }),
  }
}

/**
 * Finalize a scoped descriptor into a `Cell<T>` handle keyed by compound
 * id `<partonId>/<schemaKey>`. Registered into the cell registry so
 * `__cellWrite` / `__cellWriteBatch` can look it up by id (same path
 * module-scope cells use). Subsequent renders re-run the schema
 * callback, producing fresh descriptors that re-finalize and overwrite
 * the registry entry — idempotent, matches HMR overwrite semantics.
 *
 * The finalized cell's `vary` callback is a no-op wrapper: scoped cells'
 * partition is resolved against the parton's vary output (not request
 * scope), so the runtime threads the parton vary through to the
 * descriptor's `varyFn` directly. The Cell handle's own `vary` is
 * `() => ({})` to keep module-scope-style API consistent, but it's
 * never the partition source for scoped cells.
 */
export function finalizeScopedCell<T>(
  descriptor: ScopedCellDescriptor<T>,
  partonId: string,
  schemaKey: string,
): Cell<T> {
  const id = `${partonId}/${schemaKey}`
  const validate = (value: unknown): T => {
    // Re-create validator with the real id so error messages are useful.
    switch (descriptor.shape.kind) {
      case "string":
        return makeStringValidator(id)(value) as T
      case "number":
        return makeNumberValidator(id)(value) as T
      case "boolean":
        return makeBooleanValidator(id)(value) as T
      case "enum":
        return makeEnumValidator(id, descriptor.shape.values)(value) as T
    }
  }
  const handle: Cell<T> = {
    __cell: true,
    id,
    shape: descriptor.shape,
    defaultValue: descriptor.defaultValue,
    // Scoped cells' partition is the parton's vary output (possibly
    // narrowed by descriptor.varyFn). This handle's `vary` is unused
    // for partition resolution — the schema-phase code in partial.tsx
    // computes the partition directly from descriptor.varyFn +
    // partonVary. We keep this stub so the Cell<T> shape matches
    // module-scope cells (for the registry's signature).
    vary: () => ({}),
    set: bindSetter(id) as Cell<T>["set"],
    peek: () => {
      // peek doesn't make sense for scoped cells outside their owning
      // parton's render path — the partition depends on the parton's
      // vary, which isn't reachable from a bare module context. If a
      // caller really needs sync read, they should route through an
      // action.
      return descriptor.defaultValue
    },
    validate,
    write: descriptor.write,
  }
  cellRegistry.set(id, handle as Cell<unknown>)
  return handle
}

/**
 * Compute the storage partition key for a scoped cell given the parton's
 * resolved vary output. The descriptor's `varyFn` narrows the partition
 * surface if provided; otherwise the parton's full vary output is the
 * partition.
 */
export function computeScopedCellPartitionKey(
  descriptor: ScopedCellDescriptor<unknown>,
  partonVary: Record<string, unknown> | null | undefined,
): string {
  const base = partonVary ?? {}
  const out = descriptor.varyFn
    ? descriptor.varyFn(base as never)
    : base
  return hash(stableStringify(out))
}
