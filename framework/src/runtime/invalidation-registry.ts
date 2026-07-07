/**
 * Server-side invalidation registry.
 *
 * Compacted latest-per-key store of `{name, constraints, ts}` entries:
 * exactly ONE entry per (name, canonical-constraints) pair. Each
 * `refreshSelector(spec)` call stamps a fresh monotonic `ts`; a bump
 * for a pair already present overwrites that entry's `ts` in place.
 * Lossless: consumers only ever read the MAX matching `ts`
 * (`queryMatchingTs`), and two same-pair entries match exactly the
 * same constraint surfaces, so the newer `ts` subsumes the older for
 * every possible query. Storage is therefore bounded by live
 * (name × constraint-tuple) cardinality, never by bump count — a
 * ticker bumping one partition every 100ms holds one entry no matter
 * how long the server has been up.
 *
 * Partial fingerprints fold in the latest matching `ts` so any tagged
 * invalidation shifts the partial's fp on the next render. Pure
 * version-stamp model, no per-client bookkeeping — the client's
 * `?cached=` is the source of truth for what fp it has.
 *
 * Selector grammar (matches the client-side `selector` vocabulary —
 * same labels declared via `selector: ["cart"]` on a spec):
 *
 *   "cart"                   → name="cart", constraints={}
 *   "cart?cart_id=1234"      → name="cart", constraints={cart_id:"1234"}
 *   "price?sku=A&zone=EU"    → name="price", constraints={sku:"A",zone:"EU"}
 *
 * Bare name = unconstrained = matches every partial declaring that
 * label, regardless of constraints. Query-string constraints scope
 * down to partials whose constraint surface (match params + bound
 * cell args) satisfies the key=value pairs as a subset.
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
import { stableStringify } from "../lib/stable-stringify.ts"

export interface InvalidationEntry {
  name: string
  /** Key→value constraints; entry only matches when every pair
   *  appears in the partial's constraint surface (string-loose for bare
   *  tokens, type-exact for tagged ones — see `matchesConstraints`).
   *  Empty object matches any partial with the given name. */
  constraints: Record<string, unknown>
  ts: number
}

export interface ParsedSelector {
  name: string
  /** Decoded constraint values. Hand-authored tokens (`cart_id=1234`)
   *  decode to strings — matched type-loosely against the constraint surface.
   *  Type-tagged tokens (emitted by `encodeArgsForSelector` for
   *  non-string partition values) decode to their original JS type and
   *  match type-exactly, so a number partition `{uid:123}` and a string
   *  partition `{uid:"123"}` stay distinct — mirroring the partition key
   *  (`hash(stableStringify(args))`), which already keeps them apart. */
  constraints: Record<string, unknown>
}

/**
 * Sigil marking a type-tagged constraint value. A token `key=\x01<json>`
 * carries the value's JSON encoding rather than a bare string, so a
 * non-string partition component round-trips through the selector with
 * its type intact. `\x01` (Start-of-Heading) never appears in a
 * hand-authored selector or a URL-decoded key/value, so its presence
 * unambiguously signals the tagged form.
 */
const TYPE_TAG = "\x01"

// ─── Module state ─────────────────────────────────────────────────────

let nextTs = 1
/** name → (canonical constraints key → entry). The constraints key is
 *  `stableStringify(constraints)` — key-sorted and type-preserving, so
 *  a string constraint `{uid: "123"}` and a number constraint
 *  `{uid: 123}` stay distinct entries (they match different surfaces,
 *  mirroring the partition-key identity). One entry per key: a newer
 *  same-key bump overwrites `ts` in place. */
const byName = new Map<string, Map<string, InvalidationEntry>>()

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
  const constraints: Record<string, unknown> = {}
  for (const pair of s.slice(qIdx + 1).split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    if (eq < 0) {
      constraints[decodeURIComponent(pair)] = ""
    } else {
      constraints[decodeURIComponent(pair.slice(0, eq))] = decodeConstraintValue(
        decodeURIComponent(pair.slice(eq + 1)),
      )
    }
  }
  return { name, constraints }
}

/** Decode one constraint value. A `\x01`-prefixed token carries a JSON
 *  encoding of a non-string value; a bare token stays a string (the
 *  hand-authored case). */
function decodeConstraintValue(raw: string): unknown {
  if (!raw.startsWith(TYPE_TAG)) return raw
  try {
    return JSON.parse(raw.slice(TYPE_TAG.length))
  } catch {
    // Malformed tag — fall back to the literal text so a corrupt
    // selector still produces a (string) constraint rather than throwing.
    return raw
  }
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

/**
 * Encode an args object as a query-string fragment for partition-scoped
 * selectors (`{itemId: "abc"}` → `itemId=abc`) — the inverse of
 * `parseSelector`'s constraint parsing. Keys sorted (deterministic);
 * URL-encoded so `&`/`=`/`?` in values don't break the parser. Empty
 * object → `""`.
 *
 * String values encode bare (`itemId=abc`) so they match hand-authored
 * selectors and bare-token constraints. Non-string values (number,
 * boolean, null) encode type-tagged (`\x01<json>`) so the selector
 * preserves the type distinction the partition key
 * (`hash(stableStringify(args))`) already makes — a write at `{uid:123}`
 * fires `uid=\x01123`, which does NOT match a placement bound to the
 * STRING partition `{uid:"123"}` (a different storage slot). `undefined`
 * values are dropped: an absent constraint imposes no requirement, the
 * subset semantics `matchesConstraints` relies on.
 */
export function encodeArgsForSelector(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  if (keys.length === 0) return ""
  const parts: string[] = []
  for (const k of keys) {
    const v = args[k]
    if (v === undefined) continue
    const encodedValue =
      typeof v === "string" ? v : `${TYPE_TAG}${JSON.stringify(v)}`
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(encodedValue)}`)
  }
  return parts.join("&")
}

/** Build the partition-scoped selector for a cell + args — bare
 *  `cell:<id>` when args are empty. The exact string a cell write fires
 *  (so a write's invalidation matches) and an inline cell records as its
 *  fp dep (so the fp folds a partitioned write's bump). */
export function buildCellSelector(cellId: string, args: Record<string, unknown>): string {
  const encoded = encodeArgsForSelector(args)
  return encoded ? `cell:${cellId}?${encoded}` : `cell:${cellId}`
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
  const ts = nextTs++
  let perName = byName.get(parsed.name)
  if (!perName) {
    perName = new Map()
    byName.set(parsed.name, perName)
  }
  const key = stableStringify(parsed.constraints)
  const existing = perName.get(key)
  if (existing) {
    // Same (name, constraints) pair — the newer ts supersedes the older
    // for every max-query, so overwrite in place instead of appending.
    existing.ts = ts
  } else {
    perName.set(key, { name: parsed.name, constraints: parsed.constraints, ts })
  }
  notifyWaiters()
}

// ─── Event bus for the segment driver ─────────────────────────────────

type Waiter = (ts: number) => void
const waiters = new Set<Waiter>()

function notifyWaiters(): void {
  if (waiters.size === 0) return
  const ts = nextTs - 1
  const list = [...waiters]
  waiters.clear()
  for (const w of list) w(ts)
}

/**
 * Registered bump waiters. The wake-arm release invariant's probe: a
 * parked connection holds at most one registration here; a wait that
 * exited through another arm must have released its own.
 */
export function _bumpWaiterCount(): number {
  return waiters.size
}

/**
 * Returns the current registry timestamp. Pair with `_waitForNextBump`
 * to wait for any future `refreshSelector` activity past this point.
 */
export function _currentTs(): number {
  return nextTs - 1
}

/**
 * Register `cb` for the next `refreshSelector` landing (any name, any
 * constraints) with a `ts > sinceTs`. If a newer bump has already
 * happened at call time, `cb` fires on the next microtask.
 *
 * One-shot, and DISPOSABLE: the returned function removes the waiter.
 * The segment driver's wake race arms several signals per park and
 * releases the losers when one fires — an undisposed waiter would sit
 * in this process-wide set until the next bump anywhere, accumulating
 * one closure (retaining its whole wake race) per idle wake on every
 * parked connection.
 */
export function _onNextBump(sinceTs: number, cb: (ts: number) => void): () => void {
  if (nextTs - 1 > sinceTs) {
    // Already past — fire on the next microtask unless disposed first.
    let disposed = false
    queueMicrotask(() => {
      if (!disposed) cb(nextTs - 1)
    })
    return () => {
      disposed = true
    }
  }
  waiters.add(cb)
  return () => {
    waiters.delete(cb)
  }
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
 *
 * Nested calls participate in the outer transaction — when an enclosing
 * tx is already active, this is a thin pass-through. Lets an app-level
 * action wrap multiple `cell.set` calls in one outer
 * `runInvalidationTransaction` and have all the resulting
 * `refreshSelector` bumps flush together at the outer commit, so the
 * segment driver wakes once and one segment ships carrying every
 * affected cell. Without nesting the inner `__cellWrite`s would each
 * commit at their own boundary and the writes would arrive as separate
 * segments.
 */
export async function runInvalidationTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) return await fn()
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
    const perName = byName.get(label)
    if (!perName) continue
    for (const entry of perName.values()) {
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
  constraints: Record<string, unknown>,
): boolean {
  for (const k in constraints) {
    if (!varyInputs) return false
    const v = (varyInputs as Record<string, unknown>)[k]
    if (v == null) return false
    const c = constraints[k]
    if (typeof c === "string") {
      // Bare (hand-authored or string-partition) constraint — match
      // any constraint value whose string form is equal. Keeps
      // `cart_id=1234` matching a string constraint `"1234"`.
      if (String(v) !== c) return false
    } else {
      // Type-tagged constraint — match type-exactly, the same identity
      // the partition key uses. A string constraint `"123"` does NOT satisfy a
      // number constraint `123`.
      if (stableStringify(v) !== stableStringify(c)) return false
    }
  }
  return true
}

// ─── Test / debug ─────────────────────────────────────────────────────

/** Test/debug: snapshot of registry state. `entries` counts stored
 *  (compacted) entries — one per (name, constraints) pair, not one per
 *  bump. */
export function _registryStats(): { entries: number; nextTs: number; byName: number } {
  let entries = 0
  for (const perName of byName.values()) entries += perName.size
  return { entries, nextTs, byName: byName.size }
}

/** Test-only: wipe all entries and reset `ts`. */
export function _clearInvalidationRegistry(): void {
  byName.clear()
  nextTs = 1
  mintEpoch()
}

// ─── Epoch ────────────────────────────────────────────────────────────

/** The registry timeline's identity. `_currentTs()` is a logical
 *  counter, so a timestamp is only comparable WITHIN one registry
 *  lifetime — a restart (or a registry clear) starts a new timeline at
 *  1. The epoch names the lifetime: a client-held catch-up anchor
 *  (the attach statement's `since`, see segmented-response's live
 *  catch-up) is honored only when its epoch matches, otherwise the
 *  server falls back to the full initial render. Re-minted on every
 *  clear. */
let epoch = ""
function mintEpoch(): void {
  epoch = Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, "0")
}
mintEpoch()

export function _registryEpoch(): string {
  return epoch
}
