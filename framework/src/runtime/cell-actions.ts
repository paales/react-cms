"use server"

/**
 * Cell-write server action.
 *
 * One generic action: `__cellWrite(cellId, value, partition?)`. Each
 * `Cell<T>` exposes `.set` as a `Function.prototype.bind`-bound
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
 *   5. Fire `refreshSelector("cell:<id>")` inside a transaction so
 *      every parton reading this cell has its fp shift on the next
 *      render.
 */

import { getCellById, type CellVaryScope } from "../lib/cell.ts"
import { getCellStorage } from "./cell-storage.ts"
import { hash } from "../lib/hash.ts"
import { stableStringify } from "../lib/stable-stringify.ts"
import { getRegisteredMatchPatterns } from "../lib/partial.tsx"
import { buildTimeScope } from "../lib/time.ts"
import { createSessionReadSurface } from "./session.ts"
import { getRequest, getScope, parseCookies } from "./context.ts"
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
 * Returns `{invalidate: {selector: "cell:<id>"}}` — the framework's
 * action-response pipeline reads this and refetches every parton
 * carrying the matching label (cells auto-stamp `cell:<id>` onto
 * the labels of any parton whose `schema` reads them).
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

/** Shared write implementation. Caller is responsible for wrapping in
 *  a `runInvalidationTransaction` so the resulting `refreshSelector`
 *  bumps participate in atomic commit/rollback.
 *
 *  Pipeline per write: validate (throws on shape mismatch) → write
 *  (server's final-say canonicalisation; opt-in via the cell's
 *  `write` option) → storage → `refreshSelector`. Both validate and
 *  write run inside the transaction, so a throw rolls back the whole
 *  batch. */
function writeOneCell(
  cellId: string,
  value: unknown,
  partitionOverride: { vary?: Record<string, unknown> } | undefined,
): void {
  const cell = getCellById(cellId)
  if (!cell) throw new Error(`cell-write: unknown cell id "${cellId}"`)
  const validated = cell.validate(value)
  const stored = cell.write ? cell.write(validated) : validated
  let partitionKey: string
  if (partitionOverride?.vary) {
    partitionKey = hash(stableStringify(partitionOverride.vary))
  } else {
    const scope = buildCellVaryScope()
    partitionKey = hash(stableStringify(cell.vary(scope)))
  }
  getCellStorage().write(getScope(), cellId, partitionKey, stored)
  getServerNavigation().reload({ selector: `cell:${cellId}` })
}
