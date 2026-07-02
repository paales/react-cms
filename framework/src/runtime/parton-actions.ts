"use server"

/**
 * Parton-action dispatcher.
 *
 * One generic action: `__partonAction(actionId, matchParams, args)`.
 * Each action declared on a parton (`actions: {save: async (scope,
 * args) => ...}`) gets a bound reference for the Render prop bag:
 *
 *   __partonAction.bind(null, "<partonId>/<actionName>", matchParams)
 *
 * Client invokes `(args)`; server receives `(actionId, matchParams,
 * args)` and dispatches under a stamped CurrentParton (id, the
 * action's own request, the baked params).
 *
 * Resolution path inside the dispatcher:
 *
 *   1. Look up handler in the action registry. Unknown id → throw.
 *   2. Look up the parton's schema callback in the schema registry and
 *      re-run it — tracked hooks read the action's request; every cell
 *      gets its value read from storage at the partition derived from
 *      the cell's vary (scoped cells: matchParams or descriptor.varyFn
 *      output; module cells: their own vary against the action's
 *      request scope).
 *   3. Build the handler scope: match params + resolved schema.
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

import { getActionById, getInlineCellsForParton, getSchemaForParton } from "../lib/parton-actions.ts"
import {
  buildResolvedCell,
  cellStorageForArgs,
  computeCellPartitionKey,
  computePartitionKeyFromArgs,
  computeScopedCellPartitionKey,
  finalizeScopedCell,
  isModuleCell,
  isScopedCellDescriptor,
  makeScopedCellFactories,
  type CellInterface,
  type CellVaryScope,
  type ResolvedCell,
  type ScopedCellDescriptor,
} from "../lib/cell.ts"
import { _runWithCurrentParton, type CurrentParton } from "../lib/current-parton.ts"
import { ROOT, type PartialCtx } from "../lib/partial-context.ts"
import { _isParkSignal } from "../lib/server-hooks.ts"
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
 * Resolve a parton's schema at dispatch time. Returns the resolved
 * record (cells become ResolvedCells, plain values pass through) plus
 * a map of which schema keys are scoped cells (for auto-write).
 * Scoped-cell partitions derive from the ref's baked match params;
 * tracked hooks inside the callback read the action's own request via
 * the stamped CurrentParton.
 */
function resolveSchemaForAction(
  partonId: string,
  matchParams: Record<string, unknown>,
): {
  resolved: Record<string, unknown>
  cellsByKey: Map<string, ResolvedCell<unknown>>
} {
  const resolved: Record<string, unknown> = {}
  const cellsByKey = new Map<string, ResolvedCell<unknown>>()
  const schemaCb = getSchemaForParton(partonId)
  // A `park()` here means the schema's gate condition holds at dispatch
  // time. Parking is a render-emission concept — an action has no
  // boundary to replace — so surface it as a dispatch error: the client
  // shouldn't be able to invoke actions on a parton it can't see.
  let raw: Record<string, unknown>
  try {
    raw = schemaCb ? schemaCb(makeScopedCellFactories<unknown>()) : {}
  } catch (err) {
    if (_isParkSignal(err)) {
      throw new Error(
        `action dispatch for "${partonId}": its schema parked for this request — ` +
          `a parked parton cannot handle actions`,
      )
    }
    throw err
  }
  for (const key of Object.keys(raw)) {
    const val = raw[key]
    if (isScopedCellDescriptor(val)) {
      const descriptor = val as ScopedCellDescriptor<unknown>
      const cell = finalizeScopedCell(descriptor, partonId, key)
      const partitionVary = descriptor.varyFn
        ? descriptor.varyFn(matchParams as never)
        : matchParams
      const partitionKey = computeScopedCellPartitionKey(descriptor, matchParams)
      const stored = cellStorageForArgs(cell, partitionVary).read(getScope(), cell.id, partitionKey)
      const value = stored === undefined ? cell.defaultValue : stored
      const resolvedCell = buildResolvedCell(cell, value, partitionVary)
      resolved[key] = resolvedCell
      cellsByKey.set(key, resolvedCell)
    } else if (isModuleCell(val)) {
      const c = val as CellInterface<unknown>
      const cellScope = buildCellVaryScope()
      const cellArgs = c.vary(cellScope)
      const partitionKey = computeCellPartitionKey(c, cellScope)
      const stored = cellStorageForArgs(c, cellArgs).read(getScope(), c.id, partitionKey)
      const value = stored === undefined ? c.defaultValue : stored
      const resolvedCell = buildResolvedCell(c, value)
      resolved[key] = resolvedCell
      cellsByKey.set(key, resolvedCell)
    } else {
      resolved[key] = val
    }
  }
  // Inline cells (`localCell("key", …)` in Render) aren't in the schema
  // callback — they were recorded on the parton's snapshot at render
  // (increment 2). Rebuild + resolve each so the handler gets it by key
  // without a render. Schema wins if a key is somehow declared both ways.
  const inlineCells = getInlineCellsForParton(partonId)
  if (inlineCells) {
    const inlineScope = buildCellVaryScope()
    for (const [key, rec] of inlineCells) {
      if (cellsByKey.has(key)) continue
      const cell = finalizeScopedCell(rec.descriptor, partonId, key)
      // Re-derive a `vary`-partitioned cell against THIS request (the
      // action's session), so a per-session cell resolves at the caller's
      // partition — not the last render's recorded one.
      const partition = rec.varyFn ? rec.varyFn(inlineScope) : rec.partition
      const partitionKey = computePartitionKeyFromArgs(partition)
      const stored = cellStorageForArgs(cell, partition).read(getScope(), cell.id, partitionKey)
      const value = stored === undefined ? cell.defaultValue : stored
      const resolvedCell = buildResolvedCell(cell, value, partition)
      resolved[key] = resolvedCell
      cellsByKey.set(key, resolvedCell)
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
  matchParams: Record<string, unknown>,
  resolved: Record<string, unknown>,
  cellsByKey: Map<string, ResolvedCell<unknown>>,
  args: Record<string, unknown>,
  pending: Map<string, PendingWrite>,
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    ...matchParams,
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
 * `__partonAction.bind(null, actionId, matchParams)`; the client's
 * action invocation lands here with `(actionId, matchParams, args)`.
 *
 * The dispatch runs under a stamped `CurrentParton` (see
 * `_runWithCurrentParton`): id = the bound parton, request = the
 * action's OWN request, params = the baked match-param record — the
 * one thing that must ride the ref, since the POST URL doesn't carry
 * the route. Tracked hooks inside the schema callback (or the handler)
 * read the caller's current cookies/session — strictly more correct
 * than replaying render-time values. The dep/tag sets it accumulates
 * go nowhere: an action registers no snapshot.
 */
export async function __partonAction(
  actionId: string,
  matchParams: Record<string, string>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = getActionById(actionId)
  if (!handler) throw new Error(`unknown parton action: "${actionId}"`)
  const slashIdx = actionId.indexOf("/")
  if (slashIdx < 0) throw new Error(`malformed action id (expected partonId/actionName): "${actionId}"`)
  const partonId = actionId.slice(0, slashIdx)
  const self: CurrentParton = {
    id: partonId,
    tags: new Set(),
    deps: new Set(),
    request: getRequest(),
    params: matchParams ?? {},
    phase: "schema",
    wakeHints: {},
  }

  return await _runWithCurrentParton(self, () => runInvalidationTransaction(async () => {
    const { resolved, cellsByKey } = resolveSchemaForAction(partonId, matchParams ?? {})
    const pending = new Map<string, PendingWrite>()
    const scope = buildHandlerScope(matchParams ?? {}, resolved, cellsByKey, args, pending)

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
  }))
}
