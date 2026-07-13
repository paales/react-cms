/**
 * The invalidation bridge — the single seam through which committed
 * invalidation bumps cross a process boundary. Two callers, one shape
 * (the federation arc's design constraint): the same-trust broker bus
 * (N processes of one app over one shared store) and the cross-trust
 * capability-authorized channel attach (remoteCell — a host process
 * subscribing to a remote app's cell). The seam is transport-agnostic
 * on purpose: the framework exposes `setInvalidationBridge` (outbound)
 * and `deliverInvalidationBumps` (inbound); the transport — a TCP
 * broker, a Redis channel, a server-to-server channel attach — lives
 * with the deployment, never here.
 *
 * ── The consistency contract the seam embodies ───────────────────────
 *
 *  1. The shared store is the sole authority for values, per key.
 *     A batch carries selector strings ONLY — never a value, never a
 *     timestamp. The bus is a doorbell.
 *  2. Bumps are at-least-once, unordered notifications, published only
 *     after the write is visible in the store. The registry hands the
 *     tap a batch strictly after `commitOne` — which itself runs after
 *     the storage flush (`cell-write.ts` publish-after-commit;
 *     `atomic()` flushes its overlay before the transaction commits).
 *     Receivers treat every batch as idempotent: applying it advances
 *     local entry timestamps, downstream consumers re-read the store
 *     and fp-compare — a duplicate or late bump is a wasted re-render
 *     at worst, never wrongness.
 *  3. Fingerprints, caches, and invalidation TIMELINES are process-
 *     local. An inbound bump commits with a fresh LOCAL ts; the wire
 *     carries no ts because no other process's counter is meaningful
 *     here (the registry epoch already declares timelines
 *     non-comparable). The row's persisted ts stays the WRITER's stamp
 *     — an inbound apply never re-stamps (see the bridge-tap contract
 *     in `invalidation-registry.ts`).
 *  4. `atomic()` is one store commit plus one bump batch: the registry
 *     drains its outbound collection once per synchronous commit
 *     section, so a transaction's selectors arrive as a single
 *     `publish` call.
 *
 * ── Loopback ─────────────────────────────────────────────────────────
 *
 * Two explicit guards, no heuristics:
 *
 *  - The ORIGIN ID: every process mints one at module init and stamps
 *    it on every outbound batch. `deliverInvalidationBumps` drops a
 *    batch carrying this process's own origin — so a transport that
 *    echoes to all subscribers (a pub/sub channel, a naive broker)
 *    needs no self-exclusion logic.
 *  - The inbound-apply flag (registry-side): bumps committed by an
 *    inbound apply are never re-collected for publish, so two bridged
 *    processes cannot ping-pong a forwarded bump even though the
 *    forward would carry a new origin.
 */

import {
  _applyInboundInvalidations,
  _setInvalidationBridgeTap,
  encodeArgsForSelector,
  parseSelector,
  type ParsedSelector,
} from "./invalidation-registry.ts"

/**
 * One outbound commit section's bumps, wire-ready: `selectors` uses
 * the registry's selector grammar (`cell:<id>?<args>`, type-tagged
 * non-string constraint values — `encodeArgsForSelector` round-trips
 * them losslessly), so the batch is directly JSON-serializable and a
 * transport never touches framework types.
 */
export interface InvalidationBumpBatch {
  /** The publishing process's origin id — the loopback discriminator. */
  origin: string
  /** Committed selectors, publish-after-commit ordered as a WHOLE
   *  batch (no ordering between batches — receivers must not assume
   *  any). */
  selectors: string[]
}

/**
 * The outbound half a transport implements. `publish` is called
 * synchronously at the end of each commit section and MUST not throw
 * or block — IO belongs on a microtask/socket buffer inside the
 * transport. A lost batch degrades a peer to its next doorbell or its
 * query-time restore path; it never corrupts (the store is the truth).
 */
export interface InvalidationBridge {
  publish(batch: InvalidationBumpBatch): void
}

/** Process-lifetime origin id. Same minting posture as the registry
 *  epoch: random, unique per process lifetime, meaningless beyond
 *  identity. */
const ORIGIN = Math.floor(Math.random() * 0xffffffffffff)
  .toString(16)
  .padStart(12, "0")

let bridge: InvalidationBridge | null = null

/** This process's origin id — transports that address peers directly
 *  (rather than broadcast) can use it as their subscription identity. */
export function invalidationBridgeOrigin(): string {
  return ORIGIN
}

/**
 * Install (or remove, with `null`) the process's invalidation bridge.
 * With a bridge set, every committed bump batch — one per
 * `refreshSelector` call, transaction flush, or `atomic()` — is handed
 * to `bridge.publish` stamped with this process's origin. Without one,
 * the registry behaves exactly as before (the tap is absent, not
 * no-op'd).
 */
export function setInvalidationBridge(b: InvalidationBridge | null): void {
  bridge = b
  _setInvalidationBridgeTap(b === null ? null : publishBatch)
}

function publishBatch(batch: readonly ParsedSelector[]): void {
  const active = bridge
  if (active === null) return
  active.publish({ origin: ORIGIN, selectors: batch.map(selectorToString) })
}

/**
 * The inbound delivery function — a transport calls this with every
 * batch it receives. Drops this process's own batches (origin match);
 * everything else commits into the local registry through the same
 * path a local bump takes (fresh local ts, wake-index delivery, no row
 * stamp, no re-publish). Malformed selectors degrade per-selector to
 * a constraint-less name (the parser's posture) — a corrupt doorbell
 * over-wakes, it never throws into the transport.
 */
export function deliverInvalidationBumps(batch: InvalidationBumpBatch): void {
  if (batch.origin === ORIGIN) return
  _applyInboundInvalidations(batch.selectors.map(parseSelector))
}

/** `ParsedSelector` → the selector grammar string a batch carries —
 *  the exact inverse of `parseSelector` (type tags included). */
function selectorToString(p: ParsedSelector): string {
  const encoded = encodeArgsForSelector(p.constraints)
  return encoded ? `${p.name}?${encoded}` : p.name
}
