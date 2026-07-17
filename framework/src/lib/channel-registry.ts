/**
 * ChannelRegistry — the channel's eager producer-facing surface.
 *
 * Producers (the visibility controller, telemetry, the transport's own
 * internal sources) register HERE, not against the channel transport
 * itself. The registry makes a producer's static closure independent
 * of the heavy channel transport (`channel-client.ts` — the envelope
 * assembly, the fetch/WS wire, the fp-trailer split): a producer that
 * imports only this module works identically whether the transport is
 * in the same chunk or loads later.
 *
 * This module is the stable seam across that boundary. It is tiny and
 * eager (in the hydration closure) and owns only the registration set
 * and a small pre-bind queue:
 *
 *   - `registerChannelProducer` / `onChannelEstablished` record the
 *     producer set and establishment listeners; the transport reads
 *     them back through `_channelProducers` / `_channelEstablishListeners`
 *     once it loads.
 *   - `scheduleChannelFlush` / `_reportContentEvicted` are called by
 *     producers (and the eager content-loss listener) at any time.
 *     Before the transport binds, these QUEUE — a flush request latches,
 *     evicted ids collect — and REPLAY in order the moment the transport
 *     calls `_bindChannelUpstream`. After binding they delegate straight
 *     through.
 *
 * The dependency is one-way: the transport imports the registry (to read
 * the producer set and to bind). The registry imports nothing heavy — so
 * a producer that imports only this module (visibility, telemetry) keeps
 * the transport out of its static closure.
 */

import type { ChannelFrame } from "./channel-protocol.ts"
import { _setContentLossListener } from "./partial-client-state.ts"

/** A source of upstream frames (the visibility controller is the
 *  first). Registered once at module scope; consulted on every
 *  envelope flush. */
export interface ChannelProducer {
  /** Contribute the producer's frames to the envelope being assembled
   *  — one frame for most producers; an ordered array where one
   *  statement is several frames (the frame-navigation producer's
   *  cancel-then-url pair). `connection` is the open connection's id,
   *  or `null` when none is established — the producer keeps its
   *  statements pending (or drops them, lossy class) and returns
   *  `null`. Called only when an envelope can
   *  actually fire (never while one is in flight), so the frames'
   *  content is always the producer's latest state. */
  collect(connection: string | null): ChannelFrame | ChannelFrame[] | null
  /** The envelope carrying this producer's frame was not applied —
   *  connection gone (`404`-equivalent) or the POST never reached the
   *  server. The transport has already cleared the published id; the
   *  producer re-owns the frame's statements, which pend for the next
   *  establishment. Never called for a `reliable` producer's frames —
   *  the transport's retransmit buffer owns their redelivery. */
  deliveryFailed(frame: ChannelFrame): void
  /** Declares this producer's frames RELIABLE-class: they must reach
   *  the server even across a torn connection, so the transport
   *  buffers them (keyed by envelope seq) until the downstream
   *  `applied` marker proves application, and retransmits survivors
   *  at the next establishment. Application idempotence is the frame
   *  kind's own contract (seq-ordered statement semantics). Absent /
   *  false: loss-tolerant — a failed envelope hands the frame back
   *  via `deliveryFailed`. */
  reliable?: boolean
}

const producers = new Set<ChannelProducer>()
const establishListeners = new Set<(connection: string) => void>()

export function registerChannelProducer(producer: ChannelProducer): void {
  producers.add(producer)
}

/** Run `cb` with the connection id every time a live connection is
 *  established — producers arm connection-scoped work here (e.g. the
 *  visibility controller's full-set sync at first measurement). */
export function onChannelEstablished(cb: (connection: string) => void): void {
  establishListeners.add(cb)
}

/** The transport reads the registered producer set on every flush. */
export function _channelProducers(): ReadonlySet<ChannelProducer> {
  return producers
}

/** The transport fans establishment out to these on every `conn`. */
export function _channelEstablishListeners(): ReadonlySet<(connection: string) => void> {
  return establishListeners
}

/** The live transport's upstream surface — the two producer-driven
 *  statements this registry brokers before the transport is loaded. */
export interface ChannelUpstream {
  scheduleFlush(): void
  reportContentEvicted(id: string, opts?: { drive?: boolean }): void
  /** Every outstanding action-consequence gate as one promise (see
   *  `_awaitActionConsequences`). */
  awaitActionConsequences(): Promise<void>
}

let upstream: ChannelUpstream | null = null
let flushQueued = false
const pendingEvicted: Array<{ id: string; drive: boolean }> = []

/** Request an envelope flush. Coalesced per animation frame (the
 *  producers' statement cadence) by the transport. Before the transport
 *  binds, the request latches and replays on binding — inert during SSR
 *  the same way (the transport's own guard no-ops there). */
export function scheduleChannelFlush(): void {
  if (upstream !== null) {
    upstream.scheduleFlush()
    return
  }
  flushQueued = true
}

/**
 * Report a parton id whose committed content was destroyed
 * client-side — the loss statement's one entry point (the destruction
 * sites in `partial-client-state.ts` reach it through the
 * content-loss listener wired below; the cull pair's regression
 * detector calls it via the visibility controller). Cadence follows
 * the ack's passenger policy: an OFF-SCREEN loss (pool cap, cull-park
 * LRU, page prune — the default) rides the next driven envelope; a
 * DISPLAYED loss (`drive: true` — the user is looking at the regressed
 * skeleton) drives its own flush. Inert during SSR: the server-side
 * merge maps never advertise, so a loss there states nothing. Losses
 * reported before the transport binds queue and replay on binding.
 */
export function _reportContentEvicted(id: string, opts?: { drive?: boolean }): void {
  if (typeof document === "undefined") return
  if (upstream !== null) {
    upstream.reportContentEvicted(id, opts)
    return
  }
  pendingEvicted.push({ id, drive: opts?.drive === true })
}

/**
 * Every outstanding action-consequence gate as one promise — the cell
 * optimistic overlay's clear point awaits it after a write POST
 * resolves (`cell-client`). Brokered so that eager write code can await
 * consequences without pulling the transport into its static closure.
 * Before the transport binds there is no connection and no reservation,
 * so no gate can exist: resolve immediately (unchanged behavior — the
 * "without a channel" path).
 */
export function _awaitActionConsequences(): Promise<void> {
  return upstream !== null ? upstream.awaitActionConsequences() : Promise.resolve()
}

/** The transport binds its live upstream here when the live layer
 *  loads; any statements made before it arrived replay in order. */
export function _bindChannelUpstream(bound: ChannelUpstream): void {
  upstream = bound
  for (const { id, drive } of pendingEvicted) {
    bound.reportContentEvicted(id, drive ? { drive: true } : undefined)
  }
  pendingEvicted.length = 0
  if (flushQueued) {
    flushQueued = false
    bound.scheduleFlush()
  }
}

/** Test-only: clear the registered producers, establishment listeners
 *  and the pre-bind queue. The bound upstream and the content-loss
 *  wiring stay put — the transport re-registers its internal producers
 *  as part of its own reset. */
export function _resetChannelRegistry(): void {
  producers.clear()
  establishListeners.clear()
  pendingEvicted.length = 0
  flushQueued = false
}

// The destruction sites in `partial-client-state.ts` reach the eviction
// report through this listener — wired eagerly (at registry load, well
// before the transport) so a hydration-time loss queues rather than
// vanishing. The listener seam breaks the cycle: `partial-client-state`
// stays free of any channel import.
_setContentLossListener(_reportContentEvicted)
