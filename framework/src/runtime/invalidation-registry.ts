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
 * invalidation shifts the partial's fp on the next render. Version-
 * stamp model — the client's `?cached=` is the source of truth for
 * what fp it has. The one per-connection structure here is the
 * inverted wake index (below): live connections subscribe their route
 * snapshots under the same (name, constraintsKey) keys the store
 * uses, and a commit delivers the touched parton ids to exactly the
 * subset-matching subscriptions instead of waking every held driver
 * into a relevance scan.
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
/** Live entry count across every name — the sweep trigger's input,
 *  maintained incrementally (insert / restore / evict / clear). */
let entryCount = 0

// ─── The cell-row ts bridge (persistence of cell-backed entries) ──────
//
// `cell:` entries are the one entry class with a durable twin: every
// committed bump stamps its `ts` onto the stored cell row (via the
// bridge, registered by `cell-write.ts`), and a query that misses a
// `cell:` entry re-seeds it from the row BEFORE reading — so hot
// entries are a cache over storage: evictable, restorable, lossless.
// A fold can never observe ts=0 for state with a persisted history,
// which is the loss rule's requirement for evicting anything at all.
// Non-cell entries (tags, app selectors) have no durable twin; they
// are unbacked — never evicted, gone on restart (cold re-record).

/** The persistence seam between the registry and cell storage. Keyed
 *  by the entry address the registry already uses: `name` is the
 *  `cell:<id>` selector name, `constraintsKey` is
 *  `stableStringify(constraints)` (whose hash IS the storage
 *  partition key — the selector encoding round-trips partition args
 *  losslessly under `stableStringify`). */
export interface InvalidationTsBridge {
  /** Cheap negative guard: whether the cell behind `name` has ANY
   *  ts-stamped row in the caller's scope. */
  hasAny(name: string): boolean
  /** The persisted ts of the row at `constraintsKey`, `undefined` when
   *  the row is absent or ts-unknown. */
  readTs(name: string, constraintsKey: string): number | undefined
  /** Stamp a committed bump's ts onto the backing row (no-op when no
   *  row exists — a bump without storage stays unbacked). */
  stamp(name: string, constraintsKey: string, ts: number): void
}

let tsBridge: InvalidationTsBridge | null = null

/** Register the cell-row persistence bridge. Framework-internal —
 *  called once at module init by `cell-write.ts`. */
export function _setInvalidationTsBridge(bridge: InvalidationTsBridge | null): void {
  tsBridge = bridge
}

const CELL_NAME_PREFIX = "cell:"

/**
 * Seat the monotonic bump counter at or above `ts` — called when a
 * persistent storage adapter (carrying stamped rows from an earlier
 * process) becomes live. Restored timestamps must read as PAST events:
 * below every cursor a live connection could anchor, superseded by
 * every future bump. Raising the floor before any entry is restored
 * makes both hold by construction.
 */
export function _raiseInvalidationTsFloor(ts: number): void {
  if (ts >= nextTs) nextTs = ts + 1
}

/** Seed a restored entry from its persisted row ts. No bump delivery
 *  (nothing changed — the entry is re-materializing), no stamp (the
 *  row already carries the ts). */
function seedRestoredEntry(name: string, constraintsKey: string, ts: number): void {
  let constraints: Record<string, unknown>
  try {
    constraints = JSON.parse(constraintsKey) as Record<string, unknown>
  } catch {
    return // Unparseable key — leave unrestored (fold treats as unbacked).
  }
  let perName = byName.get(name)
  if (!perName) {
    perName = new Map()
    byName.set(name, perName)
  }
  if (perName.has(constraintsKey)) return
  perName.set(constraintsKey, { name, constraints, ts })
  entryCount++
  // Backstop only — the storage-singleton floor raise runs first in
  // every supported order (the bridge consults the singleton before
  // any restore can hit).
  _raiseInvalidationTsFloor(ts)
}

/**
 * Restore pass for one `cell:` label ahead of a query's ts read: every
 * probe key without a live entry is checked against storage and
 * re-seeded from the row's persisted ts. Runs BEFORE the read so no
 * consumer — the fp fold on the fp-skip path included — can observe a
 * missing entry for persisted history. For over-cap surfaces
 * (`probes === null`, enumeration impossible) the per-name evicted
 * floor stands in: folding `max(result, floor)` can never fall below
 * a lost entry's ts — over-fetch, never stale.
 */
function restoreCellEntries(name: string, probes: readonly string[]): void {
  if (!tsBridge!.hasAny(name)) return
  const perName = byName.get(name)
  for (const key of probes) {
    if (perName?.has(key)) continue
    const ts = tsBridge!.readTs(name, key)
    if (ts !== undefined) seedRestoredEntry(name, key, ts)
  }
}

/** Max evicted ts per name — the un-enumerable-surface fallback above.
 *  O(names with evictions); reset with the registry. */
const evictedFloorByName = new Map<string, number>()

interface InvalidationTransaction {
  pending: ParsedSelector[]
}

const transactionContext = new AsyncLocalStorage<InvalidationTransaction>()

// ─── The bridge tap (cross-process doorbell) ──────────────────────────
//
// A multi-process deployment forwards committed bumps between the
// processes sharing one store. The registry's side of that seam is two
// hooks (the public surface — origin ids, wire encoding, transports —
// lives in `invalidation-bridge.ts`):
//
//   - OUTBOUND: every locally committed entry is collected and handed
//     to the tap as one batch per synchronous commit section — one
//     `refreshSelector` call, one transaction flush (so an `atomic()`
//     is exactly one batch), one driver tick. `commitOne` runs strictly
//     after the value writes landed (the write pipeline's
//     publish-after-commit ordering; `atomic()` flushes its overlay
//     before the transaction commits), so a batch handed to the tap is
//     always re-readable from the store by every receiver.
//   - INBOUND: `_applyInboundInvalidations` commits remotely produced
//     bumps through the SAME `commitOne` — fresh LOCAL ts (timestamps
//     are process-local timelines; see the epoch), same wake-index /
//     deadline-wheel / delivery fan-out — with two suppressions:
//     no row stamp (the writer's commit already stamped the row with
//     ITS authoritative ts; overwriting it with a foreign-timeline
//     value would break the writer's evict verification and inject
//     this process's timeline into every peer's restore path), and no
//     re-publish (a forwarded bump forwarded again would ping-pong
//     between two bridged processes regardless of origin ids — the
//     origin id only suppresses transport-level echo of one's OWN
//     bumps).
//
// The inbound entry is therefore UNBACKED by construction (its ts
// never matches the row's) — evict-exempt, bounded like every entry by
// live (name × constraints) cardinality. Restore-from-row stays the
// query-time freshness path for selectors no doorbell has materialized
// here yet.

let bridgeTap: ((batch: readonly ParsedSelector[]) => void) | null = null
let applyingInbound = false
/** Locally committed selectors awaiting the tap — drained by
 *  `flushBridgeTap` at the end of each synchronous commit section. */
let outboundBatch: ParsedSelector[] = []

/** Register the outbound bump tap. Framework-internal — installed by
 *  `setInvalidationBridge` in `invalidation-bridge.ts`. */
export function _setInvalidationBridgeTap(
  tap: ((batch: readonly ParsedSelector[]) => void) | null,
): void {
  bridgeTap = tap
  if (tap === null) outboundBatch = []
}

function flushBridgeTap(): void {
  if (outboundBatch.length === 0) return
  const batch = outboundBatch
  outboundBatch = []
  if (bridgeTap === null) return
  try {
    bridgeTap(batch)
  } catch {
    // A broken bridge must never take the local commit down with it.
  }
}

/** Commit remotely produced bumps into the local registry — the
 *  inbound half of the bridge seam. Same commit path as a local bump
 *  (wake index, deadline gating, sweep), minus the row stamp and the
 *  re-publish (see the bridge-tap contract above). Idempotent in the
 *  doorbell sense: a duplicate or late batch advances the entries' ts
 *  again, which triggers a re-read + fp compare downstream — wasted
 *  re-render at worst, never wrongness. */
export function _applyInboundInvalidations(selectors: readonly ParsedSelector[]): void {
  applyingInbound = true
  try {
    for (const p of selectors) commitOne(p)
  } finally {
    applyingInbound = false
  }
}

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
    const encodedValue = typeof v === "string" ? v : `${TYPE_TAG}${JSON.stringify(v)}`
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
    flushBridgeTap()
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
    entryCount++
  }
  // Persist the committed ts with the cell row (when one backs this
  // selector) — the write path's half of the eviction/restore
  // contract: row ts ≡ entry ts, so evicting the entry loses nothing.
  // Stamping at COMMIT time (not at storage-write time) is what keeps
  // an atomic batch coherent: the overlay flushes values first, then
  // each selector's single committed ts lands on its row. An INBOUND
  // bridge bump never stamps: the writer's own commit stamped the row
  // with its authoritative ts (bridge-tap contract above).
  if (tsBridge !== null && !applyingInbound && parsed.name.startsWith(CELL_NAME_PREFIX)) {
    tsBridge.stamp(parsed.name, key, ts)
  }
  if (bridgeTap !== null && !applyingInbound) outboundBatch.push(parsed)
  deliverBump(parsed.name, key, parsed.constraints)
  maybeSweepEntries()
}

// ─── Eviction (backed entries only) ───────────────────────────────────
//
// With the ts riding the row, a hot `cell:` entry is a cache over
// storage — dropping it is cache shrink, not loss: the next query that
// could match it restores the identical ts from the row (the restore
// pass above), so folds are indistinguishable across an evict/restore
// cycle. The loss rule gates the whole thing: an entry WITHOUT a
// backing row at the same ts is not restorable and MUST NOT be
// evicted — restorability is verified at evict time, never assumed.
// Wake-index subscriptions are untouched (a separate structure keyed
// the same way); a future bump re-creates the entry via `commitOne`
// and delivers as usual.

/** Default cap on live registry entries. The pool audit measured
 *  pulse-style cells at up to ~65k entries (one per partition under
 *  one name); the cap sits at that scale so normal worlds never sweep
 *  while a leak or an unbounded-partition cell gets trimmed back to
 *  its storage-backed floor. */
const DEFAULT_ENTRY_CAP = 65_536
let entryCap = DEFAULT_ENTRY_CAP
/** Growth backoff after a sweep that could not reach its target
 *  (mostly-unbacked population): don't rescan until the count grows
 *  past this. */
let sweepRetryAt = 0

/** Test/tuning: override the entry cap. `null` restores the default. */
export function _setInvalidationEntryCap(cap: number | null): void {
  entryCap = cap ?? DEFAULT_ENTRY_CAP
  sweepRetryAt = 0
}

/**
 * Evict one entry, verifying restorability first: the entry must be a
 * `cell:` entry whose backing row carries EXACTLY the entry's ts (a
 * row stamped by an older bump, a ts-unknown legacy/loader row, or no
 * row at all all refuse — evicting any of those would lose "when did
 * this last change"). Returns whether the entry was evicted.
 */
export function _evictInvalidationEntry(name: string, constraintsKey: string): boolean {
  const perName = byName.get(name)
  const entry = perName?.get(constraintsKey)
  if (!entry) return false
  if (tsBridge === null || !name.startsWith(CELL_NAME_PREFIX)) return false
  if (tsBridge.readTs(name, constraintsKey) !== entry.ts) return false
  perName!.delete(constraintsKey)
  if (perName!.size === 0) byName.delete(name)
  entryCount--
  const floor = evictedFloorByName.get(name)
  if (floor === undefined || entry.ts > floor) evictedFloorByName.set(name, entry.ts)
  return true
}

/**
 * Bounded-cardinality sweep: when the live entry count exceeds the
 * cap, evict verified-backed entries (insertion order — no recency
 * bookkeeping; correctness doesn't need it, the restore pass makes
 * any eviction order lossless) down to a low watermark (cap − ⅛cap,
 * so a population hovering at the cap doesn't rescan per insert).
 * Unbacked entries are exempt from the cap by the loss rule — a
 * mostly-unbacked population over the cap backs off and retries after
 * growth instead of rescanning on every bump.
 *
 * Runs from `commitOne` only — never from a restore — so a query's
 * restore pass can't have its own seeds swept out from under its
 * read.
 */
function maybeSweepEntries(): void {
  if (entryCount <= entryCap || entryCount < sweepRetryAt) return
  if (tsBridge === null) return
  const target = entryCap - (entryCap >> 3)
  outer: for (const [name, perName] of byName) {
    if (!name.startsWith(CELL_NAME_PREFIX)) continue
    for (const [key, entry] of perName) {
      if (entryCount <= target) break outer
      if (tsBridge.readTs(name, key) !== entry.ts) continue
      perName.delete(key)
      entryCount--
      const floor = evictedFloorByName.get(name)
      if (floor === undefined || entry.ts > floor) evictedFloorByName.set(name, entry.ts)
    }
    if (perName.size === 0) byName.delete(name)
  }
  sweepRetryAt = entryCount > target ? entryCount + (entryCap >> 6) + 1 : 0
}

// ─── The inverted wake index (bump → subscribed connections) ──────────
//
// The registry's wake side is KEYED like its storage side: a live
// connection registers each route snapshot under exactly the
// (name, constraintsKey) map keys a matching entry could be stored
// under (`constraintProbeKeys` — the same enumeration the query
// probes), so a commit delivers the touched parton ids to precisely
// the subset-matching subscriptions in map lookups. A bump nothing
// subscribed to touches no connection at all — the parked drivers
// never wake, which is what makes N held connections free under
// irrelevant bump traffic (the old shape woke every driver into a
// per-route relevance scan per bump).
//
// Surfaces past `PROBE_SUBSET_CAP` can't be key-registered; they land
// in the subscription's scan set, checked per bump only against those
// entries (the delivery twin of the query's linear fallback).

/**
 * Per-connection state the delivery gate reads live — closures over
 * the connection session, supplied at subscription open so this module
 * stays ignorant of session shape.
 */
export interface WakeSubscriberContext {
  /** The connection's current measured visible set (`null` before any
   *  measurement — parks nothing, every delivery wakes). */
  visible(): ReadonlySet<string> | null
  /** True when `id` holds an assigned consequence delivery seq (an
   *  action's reservation) — a parked delivery still wakes so the
   *  driver can void the seq promptly instead of wedging the client's
   *  ack watermark until an unrelated wake. */
  hasAssignedSeq(id: string): boolean
}

/** One registered route snapshot, as the delivery path needs it. */
export interface WakeSubscriptionEntryInit {
  /** The snapshot's refetch labels — the bump NAMES that can touch it. */
  labels: readonly string[]
  /** The snapshot's compiled constraint surface (match params ∪ bound
   *  cell args). `query.probes === null` → over-cap, scan fallback. */
  query: CompiledSurfaceQuery
  /** The id's lane carrier as of registration — the nearest addressable
   *  snapshot whose lane would ship this id's update. `null` = nothing
   *  can carry it (delivery records, never wakes). Drain-time
   *  escalation stays authoritative for WHAT lanes; this copy only
   *  decides WAKING. */
  carrier: string | null
  /** Ids whose absence from the visible set parks the carrier (its own
   *  id when cull-gated, plus cull-gated ancestors) — a parked
   *  delivery records without waking; the flip-in revalidation is the
   *  parked parton's catch-up. `null` = never parked. */
  carrierParkGates: readonly string[] | null
}

interface WakeSubscriptionEntry extends WakeSubscriptionEntryInit {
  /** The (name, constraintsKey) index addresses this entry registered
   *  under — walked for removal. `null` for scan entries. */
  keys: ReadonlyArray<readonly [string, string]> | null
}

export interface WakeSubscription {
  /** Parton ids bumps have delivered since the last drain — deduped
   *  across bumps by construction (coalescing is intrinsic; each lane
   *  renders current state). */
  readonly pending: Set<string>
  /** Wake listeners, disposer-registered per park (the flipWakes
   *  shape — the wake-arm release invariant). */
  readonly wakes: Set<() => void>
  readonly context: WakeSubscriberContext
  /** id → registered entry (keyed and scan entries alike). */
  readonly entries: Map<string, WakeSubscriptionEntry>
  /** The over-cap fallback: entries whose surface couldn't be
   *  key-registered, matched per bump by the linear predicate. */
  readonly scanEntries: Map<string, WakeSubscriptionEntry>
}

/** name → constraintsKey → subscription → (parton id → entry). */
const wakeIndex = new Map<
  string,
  Map<string, Map<WakeSubscription, Map<string, WakeSubscriptionEntry>>>
>()
/** Subscriptions holding at least one scan entry. */
const scanSubscribers = new Set<WakeSubscription>()
/** Every open subscription — the wake-arm probe's denominator. */
const openSubscriptions = new Set<WakeSubscription>()

export function _openWakeSubscription(context: WakeSubscriberContext): WakeSubscription {
  const sub: WakeSubscription = {
    pending: new Set(),
    wakes: new Set(),
    context,
    entries: new Map(),
    scanEntries: new Map(),
  }
  openSubscriptions.add(sub)
  return sub
}

/** Close a subscription: every index registration is removed, so no
 *  future bump can deliver to (or retain) the connection. */
export function _closeWakeSubscription(sub: WakeSubscription): void {
  for (const id of [...sub.entries.keys()]) _removeWakeSubscriptionEntry(sub, id)
  openSubscriptions.delete(sub)
  scanSubscribers.delete(sub)
  sub.pending.clear()
  sub.wakes.clear()
}

/**
 * Register (or replace) the subscription's entry for one parton id.
 * Keyed registration inserts the id under every `labels × probes`
 * address; an over-cap surface (`probes === null`) lands in the scan
 * set instead. Replacing removes the prior registration first, so a
 * re-registered snapshot with a changed surface can't keep matching
 * its old partition.
 */
export function _setWakeSubscriptionEntry(
  sub: WakeSubscription,
  id: string,
  init: WakeSubscriptionEntryInit,
): void {
  _removeWakeSubscriptionEntry(sub, id)
  const probes = init.query.probes
  if (probes === null) {
    sub.scanEntries.set(id, { ...init, keys: null })
    sub.entries.set(id, sub.scanEntries.get(id)!)
    scanSubscribers.add(sub)
    return
  }
  const keys: Array<readonly [string, string]> = []
  const entry: WakeSubscriptionEntry = { ...init, keys }
  for (const label of init.labels) {
    for (const key of probes) {
      let perName = wakeIndex.get(label)
      if (!perName) {
        perName = new Map()
        wakeIndex.set(label, perName)
      }
      let perKey = perName.get(key)
      if (!perKey) {
        perKey = new Map()
        perName.set(key, perKey)
      }
      let ids = perKey.get(sub)
      if (!ids) {
        ids = new Map()
        perKey.set(sub, ids)
      }
      ids.set(id, entry)
      keys.push([label, key])
    }
  }
  sub.entries.set(id, entry)
}

export function _removeWakeSubscriptionEntry(sub: WakeSubscription, id: string): void {
  const entry = sub.entries.get(id)
  if (!entry) return
  sub.entries.delete(id)
  if (entry.keys === null) {
    sub.scanEntries.delete(id)
    if (sub.scanEntries.size === 0) scanSubscribers.delete(sub)
    return
  }
  for (const [name, key] of entry.keys) {
    const perName = wakeIndex.get(name)
    const perKey = perName?.get(key)
    const ids = perKey?.get(sub)
    if (!ids) continue
    ids.delete(id)
    if (ids.size === 0) {
      perKey!.delete(sub)
      if (perKey!.size === 0) {
        perName!.delete(key)
        if (perName!.size === 0) wakeIndex.delete(name)
      }
    }
  }
}

/** Drain the subscription's delivered ids — the bump wake's worklist.
 *  Synchronous with the caller's cursor advance, so no bump can land
 *  between the take and the covering `_currentTs()` read. */
export function _takeWakeSubscriptionPending(sub: WakeSubscription): string[] {
  const ids = [...sub.pending]
  sub.pending.clear()
  return ids
}

/** Drop the pending set without draining — a whole-tree segment
 *  (navigation, reconcile) just covered everything delivered so far. */
export function _clearWakeSubscriptionPending(sub: WakeSubscription): void {
  sub.pending.clear()
}

/** Seed one id into the pending set WITHOUT firing wakes — the sync
 *  path's catch-up for a record registered after its bump landed (the
 *  caller is awake; its next wait entry consumes the latch). */
export function _seedWakeSubscriptionPending(sub: WakeSubscription, id: string): void {
  sub.pending.add(id)
}

/**
 * Registered wake listeners across every open subscription. The
 * wake-arm release invariant's probe: a parked connection holds at
 * most one listener; a wait that exited through another arm must have
 * released its own.
 */
export function _wakeSubscriptionArmCount(): number {
  let count = 0
  for (const sub of openSubscriptions) count += sub.wakes.size
  return count
}

/** Test/debug: index shape. `registrations` counts (name, key, sub, id)
 *  leaf entries. */
export function _wakeIndexStats(): {
  names: number
  keys: number
  registrations: number
  scanEntries: number
  subscriptions: number
} {
  let keys = 0
  let registrations = 0
  for (const perName of wakeIndex.values()) {
    keys += perName.size
    for (const perKey of perName.values()) {
      for (const ids of perKey.values()) registrations += ids.size
    }
  }
  let scanEntries = 0
  for (const sub of scanSubscribers) scanEntries += sub.scanEntries.size
  return {
    names: wakeIndex.size,
    keys,
    registrations,
    scanEntries,
    subscriptions: openSubscriptions.size,
  }
}

/**
 * Commit-time delivery: push the bump's matched parton ids into every
 * subset-matching subscription's pending set and wake the ones the
 * delivery is actionable for. The keyed lookup is exact by the
 * probe-key equivalence (an entry key is hit iff `matchesConstraints`
 * would accept it); scan entries run the predicate itself.
 */
function deliverBump(name: string, constraintsKey: string, constraints: Record<string, unknown>) {
  const perKey = wakeIndex.get(name)?.get(constraintsKey)
  if (perKey !== undefined) {
    for (const [sub, ids] of perKey) {
      let wake = false
      for (const [id, entry] of ids) {
        sub.pending.add(id)
        if (!wake) wake = deliveryWakes(sub, entry)
      }
      if (wake) fireSubscriptionWakes(sub)
    }
  }
  for (const sub of scanSubscribers) {
    let wake = false
    for (const [id, entry] of sub.scanEntries) {
      if (!entry.labels.includes(name)) continue
      if (!matchesConstraints(entry.query.surface, constraints)) continue
      sub.pending.add(id)
      if (!wake) wake = deliveryWakes(sub, entry)
    }
    if (wake) fireSubscriptionWakes(sub)
  }
}

/**
 * Whether a delivery should wake its subscription's driver. Parked
 * carriers don't (their pending ids drain park-checked at the next
 * real wake; the flip-in revalidation is their catch-up — staleness-
 * free because the in-state fp folds every bump that landed while
 * parked), UNLESS the carrier holds an assigned consequence seq the
 * driver must void promptly. Carrier-less entries never wake — the
 * drain would drop them at escalation anyway.
 */
function deliveryWakes(sub: WakeSubscription, entry: WakeSubscriptionEntry): boolean {
  if (entry.carrier === null) return false
  const gates = entry.carrierParkGates
  if (gates === null) return true
  const visible = sub.context.visible()
  if (visible === null) return true
  for (const gate of gates) {
    if (!visible.has(gate)) return sub.context.hasAssignedSeq(entry.carrier)
  }
  return true
}

function fireSubscriptionWakes(sub: WakeSubscription): void {
  for (const wake of [...sub.wakes]) wake()
}

/**
 * Timer-sourced delivery into a subscription — the deadline wheel's
 * firing path (`segment-relevance.ts`). Pushes the due parton ids into
 * the SAME pending set bump deliveries use and applies the SAME
 * park gating (`deliveryWakes` — a parked carrier's delivery records
 * silently; an assigned consequence seq wakes even parked), so the
 * drain path downstream is one code path for both event sources. An id
 * without a registered entry records without waking — the drain drops
 * it at escalation if its snapshot is gone.
 */
export function _deliverToWakeSubscription(sub: WakeSubscription, ids: Iterable<string>): void {
  let wake = false
  for (const id of ids) {
    sub.pending.add(id)
    if (wake) continue
    const entry = sub.entries.get(id)
    if (entry !== undefined) wake = deliveryWakes(sub, entry)
  }
  if (wake) fireSubscriptionWakes(sub)
}

/** Returns the current registry timestamp — the bump cursor every
 *  catch-up anchor and covered-record probe compares against. */
export function _currentTs(): number {
  return nextTs - 1
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
    flushBridgeTap()
    return result
  } catch (err) {
    // Discard tx.pending — it's local to this scope and not visible
    // outside.
    throw err
  }
}

/**
 * The active transaction's queued (un-flushed) bumps, or `[]` outside
 * a transaction. The action-consequence reservation reads this INSIDE
 * the action's transaction — after the body queued its bumps, before
 * the commit flushes them and wakes the segment drivers — so a
 * consequence lane's delivery seq is assigned strictly BEFORE any
 * driver could race a mint for the same render (see
 * `_reserveActionConsequences` in `../lib/segmented-response.ts`).
 */
export function _pendingInvalidationSelectors(): readonly ParsedSelector[] {
  return transactionContext.getStore()?.pending ?? []
}

/**
 * True iff `constraints` are a subset of `surface` — the same
 * predicate `queryMatchingTs` applies per entry, exposed for callers
 * that match PENDING selectors (no registry entry, no ts, yet).
 */
export function _selectorMatchesSurface(
  constraints: Record<string, unknown>,
  surface: Record<string, unknown> | null | undefined,
): boolean {
  return matchesConstraints(surface, constraints)
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
  flushBridgeTap()
}

// ─── Queries ──────────────────────────────────────────────────────────

/**
 * Cap on the non-null surface keys eligible for keyed probes. Each key
 * contributes up to two candidate encodings besides absence, so the
 * probe-key product grows as 3^k; past the cap the enumeration would
 * rival the linear scan it replaces, so the query falls back to
 * scanning (`probes: null`). Real constraint surfaces are partition
 * keys (`{cx, cy}`, `{cart_id}`) — comfortably under it.
 */
const PROBE_SUBSET_CAP = 6

/**
 * A constraint surface pre-compiled for repeated registry queries. The
 * per-bump wake filter runs the same surface against the registry on
 * every `refreshSelector` for every held connection, so the probe-key
 * enumeration is hoisted out of the query (`segment-relevance.ts`
 * memoizes one of these per snapshot).
 */
export interface CompiledSurfaceQuery {
  /** The raw surface — the linear-scan fallback's input, and what
   *  `_selectorMatchesSurface` matches pending selectors against. */
  surface: Record<string, unknown> | null | undefined
  /** Exact per-name map keys an entry can be stored under and still
   *  match `surface` (see `constraintProbeKeys`); `null` → the surface
   *  is too wide, the query linear-scans instead. */
  probes: readonly string[] | null
}

/** Pre-compile `surface` for `_queryCompiledMatchingTs`. */
export function _compileSurfaceQuery(
  surface: Record<string, unknown> | null | undefined,
): CompiledSurfaceQuery {
  return { surface, probes: constraintProbeKeys(surface) }
}

/**
 * The exact per-name map keys (`stableStringify(entry.constraints)`)
 * an entry can be stored under and still satisfy `matchesConstraints`
 * against `surface` — the keyed inverse of that predicate, so a query
 * probes the per-name map directly instead of scanning every entry.
 *
 * Per surface key `k` with value `v`, the constraint values that match
 * collapse to at most two canonical entry-key fragments:
 *
 *   - the string-loose branch: a string constraint equal to
 *     `String(v)`, whose fragment is
 *     `JSON.stringify(k) + ":" + JSON.stringify(String(v))`;
 *   - the type-exact branch (non-string constraints): any value whose
 *     `stableStringify` equals `stableStringify(v)` — every such value
 *     yields the SAME fragment, `JSON.stringify(k) + ":" +
 *     stableStringify(v)`, because `stableStringify` is compositional
 *     (an object's encoding embeds each value's own encoding at its
 *     sorted key position). For string `v` this branch is empty: a
 *     string's encoding is `"`-quoted, which no non-string value's
 *     encoding ever is.
 *
 * A key whose surface value is `null`/`undefined` satisfies NO
 * constraint (`matchesConstraints` rejects `v == null`), so it only
 * ever appears absent. An entry matches iff its constrained keys are a
 * subset of the surface's, so the probe set is the fragment product
 * over every subset — `"{}"` (the bare-name entry) included. Fragments
 * are emitted in sorted-key order, matching how `stableStringify`
 * built the entry keys.
 *
 * Returns `null` when more than `PROBE_SUBSET_CAP` keys are eligible —
 * the product would explode instead of saving work.
 */
function constraintProbeKeys(
  surface: Record<string, unknown> | null | undefined,
): readonly string[] | null {
  let combos: string[] = [""]
  if (surface) {
    const keys = Object.keys(surface).sort()
    let eligible = 0
    for (const k of keys) {
      const v = surface[k]
      if (v == null) continue
      if (++eligible > PROBE_SUBSET_CAP) return null
      const kEnc = JSON.stringify(k)
      const fragments =
        typeof v === "string"
          ? [`${kEnc}:${JSON.stringify(v)}`]
          : [`${kEnc}:${JSON.stringify(String(v))}`, `${kEnc}:${stableStringify(v)}`]
      const next: string[] = []
      for (const combo of combos) {
        next.push(combo)
        for (const f of fragments) next.push(combo === "" ? f : `${combo},${f}`)
      }
      combos = next
    }
  }
  return combos.map((c) => `{${c}}`)
}

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
  return _queryCompiledMatchingTs(labels, _compileSurfaceQuery(varyInputs))
}

/**
 * `queryMatchingTs` against a pre-compiled surface. Per label, picks
 * whichever exact strategy touches fewer entries: keyed probes into
 * the per-name map (each probe key can only be hit by an entry that
 * `matchesConstraints` would accept, and every accepting entry's key
 * is in the probe set — the same result by construction) or the linear
 * `matchesConstraints` scan.
 */
export function _queryCompiledMatchingTs(
  labels: readonly string[],
  query: CompiledSurfaceQuery,
): number {
  let max = 0
  for (const label of labels) {
    // Restore evicted/not-yet-restored `cell:` entries from their
    // stored rows BEFORE reading — the seam that makes eviction and
    // process restart invisible to every ts consumer (the fp-skip
    // fold included, whose body never runs). Over-cap surfaces can't
    // enumerate candidate keys; their queries fold the per-name
    // evicted floor instead (≥ any lost ts — over-fetch, never stale).
    if (tsBridge !== null && label.startsWith(CELL_NAME_PREFIX)) {
      if (query.probes !== null) {
        restoreCellEntries(label, query.probes)
      } else {
        const floor = evictedFloorByName.get(label)
        if (floor !== undefined && floor > max) max = floor
      }
    }
    const perName = byName.get(label)
    if (!perName) continue
    const probes = query.probes
    if (probes !== null && probes.length <= perName.size) {
      for (const key of probes) {
        const entry = perName.get(key)
        if (entry !== undefined && entry.ts > max) max = entry.ts
      }
    } else {
      for (const entry of perName.values()) {
        if (entry.ts <= max) continue
        if (matchesConstraints(query.surface, entry.constraints)) {
          max = entry.ts
        }
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

/** Test-only: wipe all entries and reset `ts`. Storage-stamped rows
 *  survive (they belong to the storage layer) — a follow-up query
 *  restores them, which is exactly the process-restart simulation the
 *  restart-equivalence tests lean on. */
export function _clearInvalidationRegistry(): void {
  byName.clear()
  nextTs = 1
  entryCount = 0
  sweepRetryAt = 0
  evictedFloorByName.clear()
  outboundBatch = []
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
