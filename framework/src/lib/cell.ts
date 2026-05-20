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

import { __cellWrite as _cellWriteAction } from "../runtime/cell-actions.ts"
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
}

/**
 * Resolved cell — the per-render view a parton's `schema` produces.
 * Carries the resolved `.value` plus the same bound `set` action
 * reference as the source `Cell<T>`. This is what Render receives
 * and what crosses Flight to client components.
 */
export interface ResolvedCell<T> {
  readonly __cell: true
  readonly id: string
  readonly value: T
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
 */
export function buildResolvedCell<T>(handle: Cell<T>, value: T): ResolvedCell<T> {
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
