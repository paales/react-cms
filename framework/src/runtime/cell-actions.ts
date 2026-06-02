"use server"

/**
 * Cell-write server action.
 *
 * One generic action: `__cellWrite(cellId, value, partition?)`. Each
 * `CellInterface<T>` exposes `.set` as a `Function.prototype.bind`-bound
 * reference (`__cellWrite.bind(null, id)`), so author code calls
 * `palette.set("dark")` and the framework routes by the bound id.
 *
 * Resolution path:
 *
 *   1. Look up the cell by id in the cell registry. Unknown id →
 *      throw; the registry is populated as a side-effect of
 *      `cell.<shape>(...)` module-init.
 *   2. Validate the incoming value against the cell's shape (throws
 *      on mismatch — defends against malicious client writes).
 *   3. Resolve the partition key:
 *      - Explicit `partition` argument wins (used for cross-context
 *        mutations: action fired from /cart updating notes for a
 *        product not in the URL).
 *      - Otherwise run `cell.vary` against a `CellVaryScope` built
 *        from the current request. `params` is populated from any
 *        registered URLPattern that matches the request URL — same
 *        derivation pass `partial.tsx` does for spec match.
 *   4. Write storage at `(getScope(), cellId, partitionKey)`.
 *   5. Fire `refreshSelector("cell:<id>?<args>")` inside a transaction
 *      — partition-scoped, only partons whose constraint surface
 *      includes matching args see fp shift on the next render. Args
 *      are URL-encoded as the query-string fragment; bare
 *      `cell:<id>` is emitted only when args are empty.
 */

import { getCellById, type CellVaryScope } from "../lib/cell.ts"
import { hash } from "../lib/hash.ts"
import { stableStringify } from "../lib/stable-stringify.ts"
import { getRegisteredMatchPatterns } from "../lib/partial.tsx"
import { buildTimeScope } from "../lib/time.ts"
import { createSessionReadSurface } from "./session.ts"
import { _recordCellWrite, getRequest, getScope, parseCookies } from "./context.ts"
import { runInvalidationTransaction } from "./invalidation-registry.ts"
import { getServerNavigation } from "./server-navigation.ts"
import { _getCellWriteDelay } from "./cell-write-delay.ts"

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

/**
 * Walk every registered URLPattern, exec against `url`, merge each
 * matching pattern's named param groups. Last-wins on key collision.
 * Same idea as `extractNamedParams` in partial.tsx — but here we
 * don't know which spec's pattern to use (action context, no
 * parton render bound), so we union across all matches.
 */
function deriveParamsForActionRequest(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pattern of getRegisteredMatchPatterns()) {
    const result = pattern.exec(url)
    if (!result) continue
    const groups = { ...result.pathname.groups, ...result.search.groups }
    for (const [k, v] of Object.entries(groups)) {
      if (typeof v !== "string") continue
      if (/^\d+$/.test(k)) continue
      out[k] = v
    }
  }
  return out
}

/** Build a `CellVaryScope` from the current request context. Used
 *  inside the write action when no explicit partition override was
 *  supplied. */
function buildCellVaryScope(): CellVaryScope {
  const request = getRequest()
  const url = new URL(request.url)
  return {
    url,
    pathname: url.pathname,
    search: searchParamsToRecord(url.searchParams),
    cookies: parseCookies(request),
    headers: headersToRecord(request.headers),
    params: deriveParamsForActionRequest(request.url),
    session: createSessionReadSurface(),
    time: buildTimeScope(),
  }
}

/**
 * Internal cell-write entry point. Client code obtains a bound
 * reference to this action via `cell.<shape>(...).set` — the bound
 * function calls in here with the cellId already baked in.
 *
 * Wrapped in `runInvalidationTransaction` so a thrown validation
 * error (bad client payload) leaves the registry untouched.
 *
 * The write itself calls `getServerNavigation().reload({selector:
 * "cell:<id>"})` (see `writeOneCell`), which bumps the invalidation
 * registry inside the active transaction. Every parton whose schema
 * reads this cell (cells auto-stamp `cell:<id>` onto those partons'
 * labels) sees a new fingerprint and re-renders on the action's
 * response render.
 */
export async function __cellWrite(
  cellId: string,
  value: unknown,
  partitionOverride?: { vary?: Record<string, unknown> },
): Promise<void> {
  await runInvalidationTransaction(async () => {
    writeOneCell(cellId, value, partitionOverride)
  })
}

/**
 * Scoped cell-write entry point. Scoped cells (declared inside a
 * parton's `schema({cell})` callback) need partition baked at parton-
 * resolution time — their partition is the parton's vary output (or a
 * subset via the descriptor's `vary`), which isn't derivable from the
 * action's request scope alone.
 *
 * The resolved scoped cell's `set` field binds to this action as
 * `__scopedCellWrite.bind(null, cellId, partitionVary)` — both id and
 * partition are baked. Client invokes `(value)`; server receives
 * `(cellId, partitionVary, value)` and writes against the explicit
 * partition.
 *
 * Same transaction + validation semantics as `__cellWrite`.
 */
export async function __scopedCellWrite(
  cellId: string,
  partitionVary: Record<string, unknown>,
  value: unknown,
): Promise<void> {
  await runInvalidationTransaction(async () => {
    writeOneCell(cellId, value, { vary: partitionVary })
  })
}

/**
 * Batched cell-write entry point. Counterpart of `__cellWrite` for the
 * client-side microtask coalescer (`_cellSetBatched` in
 * `lib/cell-client.tsx`): instead of one POST per `cell.set` call, the
 * batcher accumulates writes within a tick and flushes them as a single
 * POST into here.
 *
 * Writes are processed sequentially in send-order — the framework does
 * not parallelise commits across cells. The whole batch lives inside
 * one `runInvalidationTransaction` so every affected `cell:<id>` bump
 * flushes together at outer commit; the segment driver wakes once and
 * one segment ships carrying every changed cell.
 *
 * On validation failure for ANY entry the whole batch rolls back —
 * the transaction discards its pending bumps and re-throws the error.
 * Mirrors the safety guarantee of single-write `__cellWrite`.
 */
export async function __cellWriteBatch(
  updates: ReadonlyArray<{
    id: string
    value: unknown
    partition?: { vary?: Record<string, unknown> }
  }>,
): Promise<void> {
  if (updates.length === 0) return
  const delay = _getCellWriteDelay()
  if (typeof delay === "number" && delay > 0) {
    await new Promise((r) => setTimeout(r, delay))
  }
  await runInvalidationTransaction(async () => {
    for (const u of updates) writeOneCell(u.id, u.value, u.partition)
  })
}

/**
 * Encode args object as a query-string fragment for partition-scoped
 * selectors: `{itemId: "abc"}` → `itemId=abc`. Empty args → empty
 * string (bare selector). Used to emit `cell:<id>?<args>` from the
 * write/invalidate path so only partons whose constraint surface
 * includes the same args refetch.
 *
 * Encoding rules:
 *   - Keys sorted (deterministic across same args object).
 *   - Values stringified via `String(v)`; constraint matching is
 *     string-equality (see `matchesConstraints` in
 *     invalidation-registry.ts).
 *   - URL-encoded so `&`, `=`, `?` in values don't break the parser.
 */
function encodeArgsForSelector(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  if (keys.length === 0) return ""
  const parts: string[] = []
  for (const k of keys) {
    const v = args[k]
    if (v === undefined || v === null) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.join("&")
}

/** Build the partition-scoped selector string for a cell + args.
 *  Returns bare `cell:<id>` when args are empty. */
function buildCellSelector(cellId: string, args: Record<string, unknown>): string {
  const encoded = encodeArgsForSelector(args)
  return encoded ? `cell:${cellId}?${encoded}` : `cell:${cellId}`
}

/** Shared write implementation. Caller is responsible for wrapping in
 *  a `runInvalidationTransaction` so the resulting `refreshSelector`
 *  bumps participate in atomic commit/rollback.
 *
 *  Pipeline per write: validate (throws on shape mismatch) → write
 *  (server's final-say canonicalisation; opt-in via the cell's
 *  `write` option) → storage → `refreshSelector` (partition-scoped).
 *  Both validate and write run inside the transaction, so a throw
 *  rolls back the whole batch.
 *
 *  Selector emission is partition-scoped: if args are available (via
 *  `partitionOverride.vary` or `cell.vary(scope)`), the emitted
 *  selector carries them as constraints (`cell:<id>?key=value`).
 *  Only partons whose effective constraint surface includes the same
 *  args match — other placements of the same cell at different
 *  partitions don't refetch. */
function writeOneCell(
  cellId: string,
  value: unknown,
  partitionOverride: { vary?: Record<string, unknown> } | undefined,
): void {
  const cell = getCellById(cellId)
  if (!cell) throw new Error(`cell-write: unknown cell id "${cellId}"`)
  const validated = cell.validate(value)
  const stored = cell.write ? cell.write(validated) : validated
  let args: Record<string, unknown>
  if (partitionOverride?.vary) {
    args = partitionOverride.vary
  } else if (cell.keyOf) {
    // Value-keyed cell (fragment cells): the partition lives in the
    // value itself. `cell.set(value)` routes to `keyOf(value)`'s
    // partition without the caller restating the identity in `.with()`.
    args = cell.keyOf(stored)
  } else {
    const scope = buildCellVaryScope()
    args = cell.vary(scope)
  }
  const partitionKey = hash(stableStringify(args))
  cell.storage().write(getScope(), cellId, partitionKey, stored)
  // Count the write for the deferred-commit decision. A write to a
  // `deferred` cell lets the action response skip its re-render — the
  // open streaming connection carries the new value instead.
  _recordCellWrite(cell.deferred === true)
  getServerNavigation().reload({ selector: buildCellSelector(cellId, args) })
}

/**
 * Partition-scoped invalidate — fires the `cell:<id>?<args>` signal
 * WITHOUT writing storage. Used by `BoundCell.invalidate()` to force
 * matching placements to re-resolve (re-run the loader on next render
 * if storage is empty, or just refetch the parton's bytes if not).
 */
export async function __cellInvalidate(
  cellId: string,
  args: Record<string, unknown>,
): Promise<void> {
  await runInvalidationTransaction(async () => {
    getServerNavigation().reload({ selector: buildCellSelector(cellId, args) })
  })
}
