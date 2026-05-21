"use server"

/**
 * Parton-action dispatcher.
 *
 * One generic action: `__partonAction(actionId, partonVary, args)`. Each
 * action declared on a parton (`actions: {save: async (scope, args) =>
 * ...}`) gets a bound reference for the Render prop bag:
 *
 *   __partonAction.bind(null, "<partonId>/<actionName>", partonVary)
 *
 * Client invokes `(args)`; server receives `(actionId, partonVary, args)`
 * and dispatches.
 *
 * Resolution path inside the dispatcher:
 *
 *   1. Look up handler in the action registry. Unknown id → throw.
 *   2. Look up the parton's schema callback in the schema registry.
 *      Resolve schema against the bound `partonVary` — every cell gets
 *      its value read from storage at the partition derived from the
 *      cell's vary (scoped cells: partonVary or descriptor.varyFn output;
 *      module cells: their own vary against the action's request scope).
 *   3. Build the handler scope: vary output + resolved schema + parent.
 *      Args overlay onto matching cells' `.value` so the handler sees
 *      "post-args" state via `scope.cardName.value`.
 *   4. Run the handler inside `runInvalidationTransaction`. Author may
 *      do explicit `cell.set(...)` writes inside; they participate in
 *      the same transaction.
 *   5. After handler returns successfully, auto-write any `args[K]`
 *      whose key matches a schema cell. All writes commit at the outer
 *      transaction boundary; segment driver wakes once.
 *
 * A throw at any point rolls back the transaction — both auto-writes
 * and any explicit handler writes discard. The client's optimistic UI
 * (via `usePartonAction`) clears its in-flight values and the cell
 * view falls back to its prior server-authoritative shape.
 */

import { getActionById, getSchemaForParton } from "../lib/parton-actions.ts"
import {
  buildResolvedCell,
  computeCellPartitionKey,
  computeScopedCellPartitionKey,
  finalizeScopedCell,
  isModuleCell,
  isScopedCellDescriptor,
  makeScopedCellFactories,
  type Cell,
  type CellVaryScope,
  type ResolvedCell,
  type ScopedCellDescriptor,
} from "../lib/cell.ts"
import { ROOT, type PartialCtx } from "../lib/partial-context.ts"
import { getCellStorage } from "./cell-storage.ts"
import { getRequest, getScope, parseCookies } from "./context.ts"
import { runInvalidationTransaction } from "./invalidation-registry.ts"
import { createSessionReadSurface } from "./session.ts"
import { buildTimeScope } from "../lib/time.ts"

function searchParamsToRecord(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of sp) out[k] = v
  return out
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h) out[k.toLowerCase()] = v
  return out
}

/** Build a `CellVaryScope` from the current request context. Used to
 *  resolve module-scope cells nested inside a parton's schema (those
 *  partition via their own `vary` against the request scope, same as
 *  outside a schema). */
function buildCellVaryScope(): CellVaryScope {
  const request = getRequest()
  const url = new URL(request.url)
  return {
    url,
    pathname: url.pathname,
    search: searchParamsToRecord(url.searchParams),
    cookies: parseCookies(request),
    headers: headersToRecord(request.headers),
    params: {},
    session: createSessionReadSurface(),
    time: buildTimeScope(),
  }
}

/**
 * Resolve a parton's schema against a bound parton vary. Returns the
 * resolved record (cells become ResolvedCells, plain values pass
 * through) plus a map of which schema keys are scoped cells (for
 * auto-write).
 */
function resolveSchemaForAction(
  partonId: string,
  partonVary: Record<string, unknown>,
): {
  resolved: Record<string, unknown>
  cellsByKey: Map<string, ResolvedCell<unknown>>
} {
  const schemaCb = getSchemaForParton(partonId)
  const resolved: Record<string, unknown> = {}
  const cellsByKey = new Map<string, ResolvedCell<unknown>>()
  if (!schemaCb) return { resolved, cellsByKey }
  const factories = makeScopedCellFactories<unknown>()
  const raw = schemaCb({ cell: factories })
  for (const key of Object.keys(raw)) {
    const val = raw[key]
    if (isScopedCellDescriptor(val)) {
      const descriptor = val as ScopedCellDescriptor<unknown>
      const cell = finalizeScopedCell(descriptor, partonId, key)
      const partitionKey = computeScopedCellPartitionKey(descriptor, partonVary)
      const stored = getCellStorage().read(getScope(), cell.id, partitionKey)
      const value = stored === undefined ? cell.defaultValue : stored
      const partitionVary = descriptor.varyFn
        ? descriptor.varyFn(partonVary as never)
        : partonVary
      const resolvedCell = buildResolvedCell(cell, value, partitionVary)
      resolved[key] = resolvedCell
      cellsByKey.set(key, resolvedCell)
    } else if (isModuleCell(val)) {
      const c = val as Cell<unknown>
      const cellScope = buildCellVaryScope()
      const partitionKey = computeCellPartitionKey(c, cellScope)
      const stored = getCellStorage().read(getScope(), c.id, partitionKey)
      const value = stored === undefined ? c.defaultValue : stored
      const resolvedCell = buildResolvedCell(c, value)
      resolved[key] = resolvedCell
      cellsByKey.set(key, resolvedCell)
    } else {
      resolved[key] = val
    }
  }
  return { resolved, cellsByKey }
}

/** Pending-writes map populated during action body execution. Cell
 *  writes inside the handler don't hit storage directly; they push
 *  here. The dispatcher commits the map atomically AFTER the handler
 *  resolves successfully; a throw discards the map untouched, so
 *  explicit handler writes roll back together with the auto-writes.
 *
 *  Module-scope cells in the schema use `null` partition — their write
 *  will resolve partition from the active request at commit time.
 *  Scoped cells have an object partition baked at resolution time. */
interface PendingWrite {
  value: unknown
  partition: Record<string, unknown> | null
}

/**
 * Build the handler scope with deferred-write resolved cells.
 *
 *   - `.value` overlays args onto matching cells (handler sees the
 *     proposed new state via `scope.cardName.value`). Subsequent
 *     `cell.set(v)` calls inside the handler further overlay the
 *     view for any post-set reads.
 *   - `.set` pushes the write into `pending` instead of hitting
 *     storage. The dispatcher commits `pending` after the handler
 *     succeeds.
 *
 *  This makes the entire action body transactional at the storage
 *  layer: on a throw, `pending` is dropped before commit, and no
 *  storage write lands.
 */
function buildHandlerScope(
  partonVary: Record<string, unknown>,
  resolved: Record<string, unknown>,
  cellsByKey: Map<string, ResolvedCell<unknown>>,
  args: Record<string, unknown>,
  pending: Map<string, PendingWrite>,
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    ...partonVary,
    parent: ROOT as PartialCtx,
  }
  for (const [key, resolvedVal] of Object.entries(resolved)) {
    const cell = cellsByKey.get(key)
    if (!cell) {
      scope[key] = resolvedVal
      continue
    }
    // Args overlay onto the initial .value snapshot for this scope
    // entry. Subsequent handler-side writes further overlay via the
    // deferred `set`.
    const overlayedInitialValue =
      args[key] !== undefined ? args[key] : cell.value
    const partition: Record<string, unknown> | null = cell.partition ?? null
    const cellId = cell.id
    // The deferred resolved cell. `.value` reads the pending map first,
    // falling back to the overlayed initial value, so handler code
    // that writes then reads (`cell.set(x); cell.value`) sees `x`.
    // Note: we capture `overlayedInitialValue` by closure, so the
    // returned cell view is internally consistent during the
    // handler's execution.
    const deferred: ResolvedCell<unknown> = {
      __cell: true,
      id: cellId,
      get value(): unknown {
        const entry = pending.get(cellId)
        return entry ? entry.value : overlayedInitialValue
      },
      partition: partition ?? undefined,
      set: async (v: unknown) => {
        pending.set(cellId, { value: v, partition })
      },
    }
    scope[key] = deferred
  }
  return scope
}

/**
 * Generic action dispatcher. Bound at parton-resolution time as
 * `__partonAction.bind(null, actionId, partonVary)`; the client's
 * action invocation lands here with `(actionId, partonVary, args)`.
 *
 * Module-level callers (`Spec.actions.X(args, {vary?})`) resolve
 * partonVary first via the registry's lookup helper, then call here
 * directly.
 */
export async function __partonAction(
  actionId: string,
  partonVary: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = getActionById(actionId)
  if (!handler) throw new Error(`unknown parton action: "${actionId}"`)
  const slashIdx = actionId.indexOf("/")
  if (slashIdx < 0) throw new Error(`malformed action id (expected partonId/actionName): "${actionId}"`)
  const partonId = actionId.slice(0, slashIdx)

  return await runInvalidationTransaction(async () => {
    const { resolved, cellsByKey } = resolveSchemaForAction(partonId, partonVary)
    const pending = new Map<string, PendingWrite>()
    const scope = buildHandlerScope(partonVary, resolved, cellsByKey, args, pending)

    // Stage args as pending writes BEFORE the handler runs. The
    // handler can read them via overlayed `.value` and can overwrite
    // via explicit `.set` (subsequent set wins). Args without a
    // matching cell don't get staged — they just flow to the handler
    // as opaque data.
    for (const argKey of Object.keys(args)) {
      const argValue = args[argKey]
      if (argValue === undefined) continue
      const cell = cellsByKey.get(argKey)
      if (!cell) continue
      pending.set(cell.id, {
        value: argValue,
        partition: cell.partition ?? null,
      })
    }

    const handlerResult = await handler(scope, args)

    // Commit phase — handler returned without throwing. Drain `pending`
    // by invoking the real resolved cell's `set`, which hits storage
    // and fires `refreshSelector("cell:<id>")`. All commits happen
    // inside this transaction's nested context; the outer flush
    // (handled by `runInvalidationTransaction`) batches the refreshes
    // into one fan-out.
    for (const [cellId, entry] of pending) {
      // Find the real resolved cell for this id. We iterate cellsByKey
      // to find a matching entry rather than indexing by argKey,
      // because explicit handler writes might write a cell that wasn't
      // passed as an arg.
      let realCell: ResolvedCell<unknown> | undefined
      for (const cell of cellsByKey.values()) {
        if (cell.id === cellId) {
          realCell = cell
          break
        }
      }
      if (!realCell) continue
      await realCell.set(entry.value)
    }

    return handlerResult
  })
}
