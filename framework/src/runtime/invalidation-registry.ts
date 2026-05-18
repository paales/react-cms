/**
 * Server-side invalidation registry.
 *
 * Flat append-only list of `{name, constraints, ts}` entries. Each
 * `refreshSelector(spec)` call adds one entry; partial fingerprints
 * fold in the latest matching `ts` so any tagged invalidation shifts
 * the partial's fp on the next render. Pure version-stamp model, no
 * per-client bookkeeping — the client's `?cached=` is the source of
 * truth for what fp it has.
 *
 * Selector grammar (matches the client-side `selector` vocabulary —
 * same labels declared via `selector: ["cart"]` on a spec):
 *
 *   "cart"                   → name="cart", constraints={}
 *   "cart?cart_id=1234"      → name="cart", constraints={cart_id:"1234"}
 *   "price?sku=A&zone=EU"    → name="price", constraints={sku:"A",zone:"EU"}
 *
 * Bare name = unconstrained = matches every partial declaring that
 * label, regardless of vary. Query-string constraints scope down to
 * partials whose vary inputs satisfy the key=value pairs as a subset.
 *
 * ── Transactional bumps ─────────────────────────────────────────────
 *
 * A server action can call `refreshSelector` and have the bump apply
 * to subsequent renders only if the action *succeeds*. Wrap the
 * action body in `runInvalidationTransaction(fn)`: during `fn`,
 * `refreshSelector` calls land in a pending list rather than the
 * registry. On success the pending list flushes to the registry with
 * a fresh `ts`; on throw the pending list is discarded.
 *
 * Outside a transaction, `refreshSelector` writes to the registry
 * immediately — useful for external server-side tasks (LLM stream
 * handlers, schedulers) that should affect any live connection right
 * away.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface InvalidationEntry {
  name: string
  /** Key→value constraints; entry only matches when every pair
   *  appears as-is in the partial's vary inputs. Empty object matches
   *  any partial with the given name. */
  constraints: Record<string, string>
  ts: number
}

export interface ParsedSelector {
  name: string
  constraints: Record<string, string>
}

// ─── Module state ─────────────────────────────────────────────────────

let nextTs = 1
const entries: InvalidationEntry[] = []
/** Lookup by name. Mirrors `entries`; mutations stay in lockstep. */
const byName = new Map<string, InvalidationEntry[]>()

interface InvalidationTransaction {
  pending: ParsedSelector[]
}

const transactionContext = new AsyncLocalStorage<InvalidationTransaction>()

// ─── Selector parsing ─────────────────────────────────────────────────

/**
 * Parse a single selector string into `{name, constraints}`. Leading
 * `#` or `.` (CSS-style decorators) is stripped — the framework
 * treats them as cosmetic. Whitespace inside isn't supported.
 */
export function parseSelector(spec: string): ParsedSelector {
  let s = spec.trim()
  if (s.startsWith("#") || s.startsWith(".")) s = s.slice(1)
  const qIdx = s.indexOf("?")
  if (qIdx < 0) return { name: s, constraints: {} }
  const name = s.slice(0, qIdx)
  const constraints: Record<string, string> = {}
  for (const pair of s.slice(qIdx + 1).split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    if (eq < 0) {
      constraints[decodeURIComponent(pair)] = ""
    } else {
      constraints[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    }
  }
  return { name, constraints }
}

/** Parse a list of selector tokens — accepts string-with-whitespace
 *  or array form, mirrors `selector` on a spec. */
export function parseSelectors(spec: string | string[]): ParsedSelector[] {
  const tokens = Array.isArray(spec) ? spec : spec.split(/\s+/)
  const out: ParsedSelector[] = []
  for (const t of tokens) {
    const trimmed = t.trim()
    if (!trimmed) continue
    out.push(parseSelector(trimmed))
  }
  return out
}

// ─── Mutations ────────────────────────────────────────────────────────

/**
 * Record an invalidation. If called inside `runInvalidationTransaction`,
 * the bump waits in the transaction's pending list until commit;
 * otherwise it writes to the registry immediately with a fresh `ts`.
 *
 * Accepts a single selector string (`"cart"`, `"cart?cart_id=1234"`),
 * or an array of them, or a `selector: ...` options bag — mirrors the
 * shape of `getServerNavigation(scope).reload({selector})`.
 */
export function refreshSelector(spec: string | string[]): void {
  const parsed = parseSelectors(spec)
  if (parsed.length === 0) return
  const tx = transactionContext.getStore()
  if (tx) {
    for (const p of parsed) tx.pending.push(p)
  } else {
    for (const p of parsed) commitOne(p)
  }
}

function commitOne(parsed: ParsedSelector): void {
  const entry: InvalidationEntry = { name: parsed.name, constraints: parsed.constraints, ts: nextTs++ }
  entries.push(entry)
  const list = byName.get(parsed.name)
  if (list) list.push(entry)
  else byName.set(parsed.name, [entry])
}

// ─── Transactions ─────────────────────────────────────────────────────

/**
 * Run `fn` inside an invalidation transaction. Any `refreshSelector`
 * calls during `fn` queue into the transaction's pending list. If
 * `fn` resolves, the pending bumps are flushed to the registry with
 * fresh timestamps. If `fn` throws, the pending bumps are discarded
 * and the error is rethrown.
 *
 * Use this for server actions: bump cart on success, leave registry
 * untouched on action throw so a failed mutation doesn't trigger
 * downstream refetches.
 */
export async function runInvalidationTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const tx: InvalidationTransaction = { pending: [] }
  try {
    const result = await transactionContext.run(tx, fn)
    for (const p of tx.pending) commitOne(p)
    return result
  } catch (err) {
    // Discard tx.pending — it's local to this scope and not visible
    // outside.
    throw err
  }
}

/**
 * Manually flush any pending bumps from the active transaction (if
 * any) into the registry. Used by the segment-loop driver to advance
 * one tick within a long-running connection without ending the
 * transaction scope. Outside a transaction this is a no-op.
 */
export function _flushPendingInvalidations(): void {
  const tx = transactionContext.getStore()
  if (!tx) return
  for (const p of tx.pending) commitOne(p)
  tx.pending = []
}

// ─── Queries ──────────────────────────────────────────────────────────

/**
 * Return the maximum `ts` of any registry entry whose `name` matches
 * one of `labels` AND whose `constraints` are a subset of `varyInputs`.
 * Returns 0 when nothing matches.
 *
 * Pure read against the registry; doesn't consider pending bumps in
 * an active transaction (a partial computing its fp while an action is
 * still queueing bumps would otherwise see a moving target on each
 * fold).
 */
export function queryMatchingTs(
  labels: readonly string[],
  varyInputs: Record<string, unknown> | null | undefined,
): number {
  if (labels.length === 0) return 0
  let max = 0
  for (const label of labels) {
    const list = byName.get(label)
    if (!list) continue
    for (const entry of list) {
      if (entry.ts <= max) continue
      if (matchesConstraints(varyInputs, entry.constraints)) {
        max = entry.ts
      }
    }
  }
  return max
}

function matchesConstraints(
  varyInputs: Record<string, unknown> | null | undefined,
  constraints: Record<string, string>,
): boolean {
  for (const k in constraints) {
    if (!varyInputs) return false
    const v = (varyInputs as Record<string, unknown>)[k]
    if (v == null) return false
    if (String(v) !== constraints[k]) return false
  }
  return true
}

// ─── Test / debug ─────────────────────────────────────────────────────

/** Test/debug: snapshot of registry state. */
export function _registryStats(): { entries: number; nextTs: number; byName: number } {
  return { entries: entries.length, nextTs, byName: byName.size }
}

/** Test-only: wipe all entries and reset `ts`. */
export function _clearInvalidationRegistry(): void {
  entries.length = 0
  byName.clear()
  nextTs = 1
}
