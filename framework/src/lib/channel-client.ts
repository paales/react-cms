/**
 * ChannelClient — the client transport for the channel's upstream role
 * ([[channel-protocol]]; design: docs/notes/channel-design.md). One
 * module owning everything between a producer's statement and the
 * envelope on the wire:
 *
 *   - **Envelope assembly + seq.** Each flush collects at most one
 *     frame per registered producer, wraps them in one
 *     `{connection, seq, frames}` envelope, and hands it to the active
 *     channel transport ([[channel-transport]]) — the default fetch
 *     transport POSTs it fire-and-forget (`keepalive: true`, so an
 *     in-flight envelope survives a page unload). `seq` is
 *     per-connection monotonic, restarting at establishment.
 *   - **Coalescing + serialization.** Flushes coalesce per animation
 *     frame and serialize — one envelope in flight; a flush requested
 *     mid-flight re-fires when it lands. Producers therefore batch
 *     naturally: everything stated within one frame rides one POST.
 *   - **The failure signal.** A non-`204` answer (connection gone,
 *     attach-binding mismatch) or a network failure clears the
 *     published connection id and hands each carried frame back to
 *     its producer (`deliveryFailed`) — the producer re-owns the
 *     statements, which pend for the next establishment (the
 *     heartbeat's reattach loop). A flush with NO connection open
 *     calls `collect(null)`: the producer keeps (or, lossy class,
 *     drops) its pending statements.
 *   - **Connection lifecycle.** The heartbeat establishes the
 *     connection id here when its live fire's subscription is proven
 *     open, and closes it when the connection settles;
 *     `<html data-parton-live>` rides the same two moments (the
 *     liveness marker specs and tooling wait on). Establishment
 *     listeners let producers arm connection-scoped work (the
 *     visibility controller's full-set sync).
 *   - **Detach.** `pagehide` sends a final `detach` frame via a
 *     keepalive fetch — the explicit close. Best-effort by nature;
 *     the server's keepalive timeout remains the backstop.
 *   - **Delivery acks.** The transport tracks the delivery seqs the
 *     stream's emissions carry (`seq` entries) and the seqs the merge
 *     layer COMMITS (the browser entry's lane/segment commit hooks),
 *     and acks the highest contiguously committed value upstream via
 *     an internal producer. The ack is a PASSENGER, never a driver:
 *     a watermark advance marks the producer dirty and any envelope
 *     other frames justify carries the current value for free —
 *     except the ESTABLISHMENT ack (every connection opens with one
 *     cumulative ack of the watermark as applied at establishment —
 *     the attach-confirm + duplex proof whose delivery outcome
 *     settles the degrade state at boot), the connection's FIRST
 *     committed delivery (the prompt duplex proof the degrade
 *     machinery times) and the unacked count crossing
 *     `ACK_FLUSH_THRESHOLD`, which request the same rAF-coalesced
 *     flush every statement rides (no timers).
 *   - **The reliable class + retransmit.** Frames from producers
 *     declaring `reliable: true` are buffered per envelope (with the
 *     envelope's seq) until the downstream `applied` marker covers
 *     them, and retransmitted — original seqs, in order, ahead of new
 *     flushes — when the next connection establishes. The envelope seq
 *     is PAGE-LIFETIME monotonic for exactly this reason. The url
 *     producer is the first reliable-class source (visible/detach
 *     statements re-seed; acks are connection-scoped and cumulative;
 *     telemetry is LOSSY — dropped, never redelivered) — though in
 *     practice its buffered frames retire at the next ATTACH rather
 *     than retransmit (the attach's own request line restates the
 *     URL — see the navigation section below).
 *   - **Bounded re-establishment.** A torn connection RE-ESTABLISHES;
 *     it never permanently degrades. A single transient failure — a
 *     failed first-ack envelope, or an attach that never established —
 *     re-attaches with backoff (pending records latch and ride it). Two
 *     blocked-path signatures each accrue a consecutive-failure counter
 *     (`/__parton/live` never establishing; `/__parton/channel`'s first
 *     ack never landing); a run of EITHER past `CHANNEL_FAILURE_LIMIT`
 *     falls to the document-nav fallback (`_channelIsDegraded`) — and
 *     even that stays RECOVERABLE: a later successful attach / delivered
 *     ack clears it and restores channel navigation. Our own supersede
 *     is never a failure signal.
 */

import { type ChannelFrame, UNACKED_DELIVERY_WINDOW, type UrlFrame } from "./channel-protocol.ts"
import { fetchTransport, getChannelTransport } from "./channel-transport.ts"
import {
  TAG_CONNECTION_ID,
  TAG_DELIVERY_SEQ,
  TAG_DRAIN,
  TAG_MUX_LIVE,
  TAG_SEQ_VOID,
  TAG_UPSTREAM_APPLIED,
} from "./fp-trailer-marker.ts"
import { getNavigation } from "../runtime/navigation-api.ts"
import {
  _bindChannelUpstream,
  _channelEstablishListeners,
  _channelProducers,
  _resetChannelRegistry,
  type ChannelProducer,
  registerChannelProducer,
} from "./channel-registry.ts"
import { _getLiveConnectionId, _setLiveConnectionId } from "./partial-client-state.ts"

// Re-export the eager producer-facing surface so callers that already
// hold a channel-client handle (the test suites, internal producers)
// keep their import site. Producers that must stay OUT of the
// transport's static closure (visibility, telemetry) import these from
// `channel-registry.ts` directly.
export {
  onChannelEstablished,
  registerChannelProducer,
  type ChannelProducer,
} from "./channel-registry.ts"

// PAGE-LIFETIME monotonic envelope seq — never restarted at
// establishment, so retransmitted reliable envelopes keep their
// original seqs across reattaches and the server's `applied` marker
// names one unambiguous timeline (seeded per attach from
// `_channelAppliedWatermark`).
let envelopeSeq = 0
let rafScheduled = false
let inFlight = false
let reflushPending = false

// ─── Delivery tracking (per established connection) ─────────────────
//
// Delivery seqs are PER-CONNECTION: the server mints them at emission
// and the client records them at COMMIT — the merge-layer moment the
// bytes become the page (a decoded-but-dropped payload is never
// recorded, so its seq stalls the watermark and the server never
// treats it as held). The ack is cumulative: the highest CONTIGUOUSLY
// committed seq. Lanes commit concurrently across partons, so commits
// can land out of order — the out-of-order set fills the gaps until
// the contiguous frontier catches up.

/** One delivery announcement off the wire: the per-connection seq plus
 *  the navigation point it was rendered as-of (the consumed
 *  url-statement envelope seq; `0` = the attach's own request state).
 *  Two optional flags extend the lane form: `live` — the announcement
 *  was a `muxlive` frame (a PRODUCER lane: seq + as-of arrive while
 *  the body still streams, so the consumer commits progressively and
 *  the `muxend` comes at producer resolve); `nav` — the FRAME url
 *  statement seq whose consume spawned the lane (the frame fire's
 *  milestone correlation). */
export interface WireDelivery {
  seq: number
  asOf: number
  live?: boolean
  nav?: number
}

/** Per-parton FIFO of lane deliveries read off the wire (`seq`
 *  entries precede their lane's `muxend`; a producer lane's `muxlive`
 *  announcement arrives mid-body). Successive lanes for one parton
 *  commit in arrival order (the browser entry chains them), so the
 *  queue head always names the delivery of the payload being
 *  committed. */
const pendingLaneSeqs = new Map<string, WireDelivery[]>()
/** One-shot wakes for a producer announcement landing on an open lane
 *  body — the lane handler races the trailer against this while it
 *  waits to learn whether the body is a producer stream. Disposal is
 *  explicit (the handler releases its waiter when the race settles),
 *  never a reaction on a promise that outlives the race. */
const laneProducerWaiters = new Map<string, Set<() => void>>()

/** Register a one-shot wake for `partonId`'s next producer
 *  announcement. Returns the disposer. */
export function _onLaneProducerAnnounce(partonId: string, wake: () => void): () => void {
  let waiters = laneProducerWaiters.get(partonId)
  if (!waiters) {
    waiters = new Set()
    laneProducerWaiters.set(partonId, waiters)
  }
  waiters.add(wake)
  return () => {
    const set = laneProducerWaiters.get(partonId)
    if (!set) return
    set.delete(wake)
    if (set.size === 0) laneProducerWaiters.delete(partonId)
  }
}

// ─── Action consequence gates ────────────────────────────────────────
//
// An action POST on an attached page names its connection
// (`x-parton-conn`); the response carries the delivery seqs the
// action's invalidation consequences will ride (reserved server-side
// inside the action's transaction — `_reserveActionConsequences`).
// The optimistic overlay must hold until the committed watermark
// covers them: cleared at the returnValue alone, a consequence lane
// delayed behind window coalescing would flash the STALE
// server-authoritative value exactly when the delay is longest. A
// gate resolves when the contiguous watermark passes its max seq
// (voided seqs count — the `seqvoid` entry), and every gate releases
// when the connection ends (its seqs are dead; the reattach's
// whole-tree render is the catch-up — over-fetch, never frozen).

interface ConsequenceGate {
  max: number
  resolve: () => void
  promise: Promise<void>
}

const consequenceGates = new Set<ConsequenceGate>()

/** Register an action response's consequence seqs. Called by the
 *  action transport (the browser entry's server callback) the moment
 *  the response headers are in hand — strictly before the action's
 *  returned promise resolves, so an overlay awaiting the write can
 *  always observe its own gate. */
export function _registerActionConsequences(seqs: readonly number[]): void {
  if (seqs.length === 0) return
  const max = Math.max(...seqs)
  // The inverse ordering race: the consequence lane committed before
  // the POST resolved — the watermark already covers it, no gate.
  if (deliveredWatermark >= max) return
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  const gate: ConsequenceGate = { max, resolve, promise }
  consequenceGates.add(gate)
}

/** Every outstanding consequence gate as one promise — the overlay's
 *  clear point awaits it after the write POST resolves. Resolved
 *  immediately when nothing is outstanding (no channel, no
 *  reservations): unchanged behavior. */
export function _awaitActionConsequences(): Promise<void> {
  if (consequenceGates.size === 0) return Promise.resolve()
  return Promise.all([...consequenceGates].map((g) => g.promise)).then(() => undefined)
}

function sweepConsequenceGates(): void {
  if (consequenceGates.size === 0) return
  for (const gate of [...consequenceGates]) {
    if (deliveredWatermark >= gate.max) {
      consequenceGates.delete(gate)
      gate.resolve()
    }
  }
}

function releaseAllConsequenceGates(): void {
  for (const gate of [...consequenceGates]) gate.resolve()
  consequenceGates.clear()
}
/** Highest contiguously committed delivery seq — the ack value. */
let deliveredWatermark = 0
/** Committed seqs past a gap in the contiguous frontier. */
const deliveredOutOfOrder = new Set<number>()
/** The watermark value last carried on a collected ack frame. */
let lastAckCollected = 0
/** Unacked-commit count at which the transport DRIVES a flush for the
 *  ack's own sake — half the server's backpressure window, so a client
 *  under sustained lane traffic acks once per threshold crossing and
 *  the window always keeps 2× headroom. Below the threshold the ack is
 *  a PASSENGER: the watermark rides whatever envelope other statements
 *  justify, because every envelope costs the browser's full Cookie
 *  header (~3.5–4.5KB under a commerce cookie jar — [[channel]]'s cost
 *  section) and no consumer of the ack needs per-commit resolution:
 *  the mirror's hot layer is the OPTIMISTIC skip-set, and the window
 *  only needs freeing well before it fills. */
const ACK_FLUSH_THRESHOLD = UNACKED_DELIVERY_WINDOW / 2
/** An ack frame for the CURRENT connection has been delivered (its
 *  envelope answered 204). Until it has, an ack-carrying envelope's
 *  failure means the connection never acked once — the degrade
 *  signal. */
let ackDeliveredOnConnection = false
/** The ESTABLISHMENT ack is owed — armed by `_channelEstablished`, so
 *  the connection's first flush contributes one cumulative ack of the
 *  delivery watermark as applied at establishment (0 on a catch-up
 *  boot: nothing delivered on this connection yet — a true statement).
 *  The connection's opening upstream statement: an envelope can address
 *  the connection only because the client heard its `conn` handshake,
 *  so the arrival confirms the attach round-trip and proves the duplex
 *  (`firstAckReceived` server-side — the never-acked deadline stands
 *  down at establishment instead of timing the first delivery), and
 *  the envelope's DELIVERY OUTCOME settles the client's degrade state
 *  at establishment: a blocked `/__parton/channel` fails this first
 *  ack-carrying envelope — the first-ack failure signature — rather
 *  than staying undiscovered until the first real statement. Consumed
 *  at collect; re-armed per establishment (each connection settles its
 *  own state, across reattaches and the transport handover alike). */
let establishmentAckDue = false
/** As-of-dropped delivery seqs awaiting report to the server: the
 *  client received these deliveries but did NOT hold them — the content
 *  rendered as-of a navigation point it had already left, so its as-of
 *  guard (`_channelDeliveryCommittable`) dropped it at arrival. The seq
 *  still advances the contiguous watermark (a permanent gap would wedge
 *  the window), but the server must not treat it as a holding: the ack
 *  producer reports the seqs within the acked range so the server evicts
 *  their optimistic mirror promotions. Reset per connection. */
const asOfDroppedSeqs = new Set<number>()
/** Parton ids whose COMMITTED content the client destroyed and hasn't
 *  yet reported — pool-cap eviction, cull-park eviction, page prune, a
 *  displayed cull pair regressed to its skeleton. The next ack frame
 *  carries them as its `evicted` statement so the server revokes the
 *  ids' mirror credit (optimistic override + acked layer) and re-ships
 *  instead of confirming a ghost. Cleared per establishment: the
 *  attach's manifest restates the client's holdings wholesale, which
 *  IS the eviction evidence — a pending report is redundant on a fresh
 *  connection. */
const evictedContentIds = new Set<string>()

/** Report a parton id whose committed content was destroyed
 *  client-side — the loss statement's one entry point (the destruction
 *  sites in `partial-client-state.ts` reach it through the
 *  content-loss listener; the cull pair's regression detector calls it
 *  via the visibility controller). Cadence follows the ack's passenger
 *  policy: an OFF-SCREEN loss (pool cap, cull-park LRU, page prune —
 *  the default) has no urgency — nothing will confirm the ghost before
 *  the id's next flip-in (whose `cached` statement carries the truth
 *  anyway) or the reconcile, so the report rides the next driven
 *  envelope (a flip, a threshold ack). A DISPLAYED loss
 *  (`drive: true` — the cull pair's regression detector: the user is
 *  looking at the regressed skeleton) drives its own flush so the
 *  server's revocation + in-view re-lane land within one RTT. Inert
 *  during SSR: the server-side merge maps never advertise, so a loss
 *  there states nothing. */
export function _reportContentEvicted(id: string, opts?: { drive?: boolean }): void {
  if (typeof document === "undefined") return
  evictedContentIds.add(id)
  if (opts?.drive === true) scheduleChannelFlush()
}

// The content-loss listener is wired eagerly in `channel-registry.ts`
// (before this transport loads). The registry's `_reportContentEvicted`
// queues losses and replays them into the impl bound below.

// ─── Reliable-class buffer + upstream watermark ──────────────────────

/** Reliable frames awaiting the server's `applied` marker, keyed by
 *  the envelope seq that carried them (ascending). Only frames from
 *  `reliable: true` producers enter; loss-tolerant co-riders of the
 *  same envelope self-heal and must not replay. */
let retransmitBuffer: Array<{ seq: number; frames: ChannelFrame[] }> = []
/** Highest upstream envelope seq the server has stated applied (the
 *  downstream `applied` marker) — what prunes the buffer and what the
 *  next attach statement presents as its `applied` watermark. */
let appliedWatermark = 0
/** Establishment found survivors in the buffer — the next flush sends
 *  them (original seqs, in order) before collecting producers. */
let retransmitPending = false

// ─── Bounded re-establishment + document-nav fallback ────────────────
//
// The connection is "just" HTTP: a torn one RE-ESTABLISHES, it never
// permanently degrades. Two blocked-path signatures each accrue a
// consecutive-failure counter; a run of EITHER past
// `CHANNEL_FAILURE_LIMIT` falls to the document-nav fallback — and even
// that stays RECOVERABLE (a later successful attach / delivered ack
// clears it and restores channel navigation):
//
//   - ESTABLISHMENT failures — an attach that settled without ever
//     establishing (conn never arrived / the POST errored), not our own
//     supersede: a blocked `/__parton/live`. Reset on establishment.
//   - FIRST-ACK failures — the connection established and delivered, but
//     the envelope carrying its first ack couldn't land: a blocked
//     `/__parton/channel`. Reset on a delivered ack (the duplex proof).

/** Consecutive attach-establishment failures — reset the moment an
 *  attach establishes. */
let establishFailures = 0
/** Consecutive first-ack-delivery failures — reset the moment an ack
 *  envelope lands (the full duplex is proven). */
let firstAckFailures = 0
/** A run of EITHER counter past this falls to document-nav mode. Small:
 *  one transient stumble must re-establish, a genuinely blocked path
 *  must fall back promptly. */
const CHANNEL_FAILURE_LIMIT = 3
/** The flush that failed carried this connection's FIRST ack — read by
 *  the close arbitration (which the same flush triggers by pulling the
 *  stream down) to count it as a first-ack failure, not a benign abort. */
let firstAckFailedThisConnection = false

/** The channel has fallen to the document-nav fallback: enough
 *  consecutive failures of either signature to conclude the transport is
 *  blocked. RECOVERABLE — a proven-working connection clears it. The
 *  navigate listener stands down while it holds; the heartbeat keeps
 *  probing so recovery can happen. */
let documentNavMode = false

/** Whether the channel is in document-nav fallback mode — the navigate
 *  listener's cue to stand down (links become document loads). Not
 *  sticky: cleared by a proven-working connection. */
export function _channelIsDegraded(): boolean {
  return documentNavMode
}

/** Recompute the fallback state from the two failure counters and sync
 *  the presence-only `data-parton-degraded` marker (the explicit signal
 *  specs and tooling wait on). Entering: enough consecutive failures of
 *  either signature. Leaving: a counter reset dropped both below the
 *  limit — the channel works again, channel navigation resumes. */
function refreshDocumentNavMode(): void {
  const fallback =
    establishFailures >= CHANNEL_FAILURE_LIMIT || firstAckFailures >= CHANNEL_FAILURE_LIMIT
  if (fallback === documentNavMode) return
  documentNavMode = fallback
  // Falling to document-nav settles any in-flight transport handover:
  // the swap's outcome is decided (no connection), so held action
  // POSTs proceed unattached rather than waiting on an establishment
  // that is no longer coming.
  if (fallback) releaseHandoverWaiters()
  if (typeof document !== "undefined") {
    if (fallback) document.documentElement.setAttribute("data-parton-degraded", "")
    else document.documentElement.removeAttribute("data-parton-degraded")
  }
}

/** The upstream-applied watermark last heard from the server — the
 *  attach statement's `applied` field (see [[channel-protocol]]). */
export function _channelAppliedWatermark(): number {
  return appliedWatermark
}

// ─── Window navigation over the channel ──────────────────────────────
//
// A window navigation or batched selector refetch is a `url` frame:
// the client states its URL (with any one-shot `?__force=` overlay),
// the server's driver answers with a payload segment in stream order,
// and the caller's milestones resolve at that segment's commit/settle
// — never at a fetch lifecycle, because there is no fetch. The pieces:
//
//   - **The navigation point.** `navPoint` is the envelope seq the next
//     url frame ships with, reserved AT STATEMENT TIME (`envelopeSeq +
//     1` — flushes serialize, so the reservation is exact) because the
//     client's URL advances at click time, ahead of the stream: from
//     this instant, any delivery rendered as-of an older navigation
//     must not commit (`_channelDeliveryCommittable`).
//   - **The producer.** RELIABLE class: url frames ride the retransmit
//     buffer until the `applied` marker covers them. One pending frame,
//     newest-wins — a statement superseded before its flush was a
//     navigation the client already navigated past, and the covering
//     segment for the newest statement resolves every older fire's
//     milestones too (their content IS the newest URL's render).
//   - **Attach-with-intent.** A statement firing with NO connection
//     established latches exactly like any other and REQUESTS an
//     immediate attach (`_requestAttachNow` — the heartbeat's fire):
//     first interaction never waits, it rides the attach it triggers.
//     The attach subsume folds the pending window statement into the
//     statement's `url` (with its `?__force=` overlay), re-anchors the
//     pending records at navigation point 0, and the attach's first
//     covering segment resolves them through the ordinary as-of path.
//   - **The attach subsumes.** The statement's `url` IS the client's
//     URL statement, so an attach fire retires the navigation point,
//     drops buffered url frames, and re-anchors any still-pending
//     records — a fresh connection opens with as-of 0 on both sides.
//   - **Document-nav fallback.** A single failure re-establishes (the
//     records latch and ride the next attach). Only a RUN of failures —
//     `CHANNEL_FAILURE_LIMIT` consecutive first-ack failures OR attach
//     non-establishments — falls to document-nav mode (a genuinely
//     blocked `/__parton/*` path). While it holds, the navigate listener
//     stands down (links and form posts are browser-native document
//     loads — SSR renders, a plain website) and pending interaction
//     records complete as ONE document navigation carrying their target
//     state. It is RECOVERABLE: a later successful attach / delivered
//     ack clears it and restores channel navigation.

/** An abort rejection every consumer's `instanceof Error &&
 *  name === "AbortError"` check recognizes across realms (a
 *  DOMException is not an Error subclass in every environment). */
function abortError(): Error {
  const err = new Error("navigation superseded")
  err.name = "AbortError"
  return err
}

interface PendingNavRecord {
  /** The navigation point this record's statement set — a committed
   *  segment rendered as-of ≥ this resolves the record. */
  navSeq: number
  /** The stated URL (path + search, may carry a `?__force=` overlay)
   *  — what the attach subsume folds into the statement's `url`. */
  url: string
  /** The caller's commit-mode wish (`streaming: true` = progressive /
   *  raw). A covering segment commits in transition mode when any
   *  covered record asked for it. */
  streaming: boolean
  streamingResolved: boolean
  settled: boolean
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

let navPoint = 0
let pendingNavFrame: UrlFrame | null = null
let pendingNavRecords: PendingNavRecord[] = []
/** One-shot claim the navigate-event listener sets when it routes a
 *  window navigation through the channel — the heartbeat's deferred
 *  abort check consumes it and keeps the stream (the navigation rides
 *  it; tearing it would strand the nav segment). Explicit
 *  producer-written signal, set synchronously during the event
 *  dispatch, read in the same task's microtask. */
let windowNavClaim = false
/** The heartbeat's registered live-stream aborter — the escape hatch
 *  the envelope-failure path pulls (`_channelAbortLiveStream`) so the
 *  stream reopens on the current state instead of idling on the old
 *  one for the keepalive. */
let liveStreamAbort: (() => void) | null = null
/** The heartbeat's registered attach requester — how a pre-establishment
 *  statement triggers the attach it will ride (`_requestAttachNow`).
 *  `null` when no heartbeat owns the page (a custom bootstrap without
 *  one): statements latch and ride whatever establishment ever comes. */
let attachRequester: (() => void) | null = null
/** The current attach fire established a connection — the degrade
 *  arbitration's real signal, reset at each `_channelConnectionClosed`. */
let establishedSinceClose = false

/** Whether window navigations / selector refetches ride the channel
 *  as immediate statements right now: a connection is established and
 *  the page is not degraded. Pre-establishment statements still latch
 *  (attach-with-intent); only DEGRADED pages answer `null` from the
 *  navigate fns — the caller's cue for a document navigation. */
export function _channelNavAvailable(): boolean {
  return !documentNavMode && _getLiveConnectionId() !== null
}

export function _registerAttachRequester(requester: (() => void) | null): void {
  attachRequester = requester
}

/** Request an immediate attach fire (the pre-establishment statement's
 *  ride). `true` when a requester is registered — the statement will
 *  ride the attach it just triggered; `false` when no heartbeat owns
 *  the page (the statement stays latched for whatever comes). */
export function _requestAttachNow(): boolean {
  if (attachRequester === null) return false
  attachRequester()
  return true
}

/** Schedule a re-attach after a transient failure: immediate on the
 *  first consecutive failure, exponential backoff (capped) after. The
 *  bound (`CHANNEL_FAILURE_LIMIT`) caps how many fast retries happen
 *  before document-nav mode takes over — past it the heartbeat's own
 *  interval is the (paced) recovery probe — so this never becomes a
 *  tight loop. `fire()` is idempotent (a stream in flight makes it a
 *  no-op), so a stray timer can never double-attach. */
let reattachTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_BASE_MS = 250
const RECONNECT_CAP_MS = 10_000
function scheduleReattach(): void {
  if (reattachTimer !== null) return
  const attempt = Math.max(establishFailures, firstAckFailures)
  const delay =
    attempt <= 1 ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 2), RECONNECT_CAP_MS)
  if (delay === 0 || typeof setTimeout === "undefined") {
    _requestAttachNow()
    return
  }
  reattachTimer = setTimeout(() => {
    reattachTimer = null
    _requestAttachNow()
  }, delay)
}

/** Retry cadence after an EXPLICIT drain refusal (`x-parton-drain` on
 *  the attach response — the server is deploy-draining). Short and
 *  fixed: the refusal means "come back, elsewhere or in a moment" —
 *  either the deployment's proxy routes the next attempt to a
 *  surviving process, or the draining process exits within its own
 *  deadline and the retry lands on its replacement. Never exponential
 *  (this is not a broken path) and naturally bounded: once the process
 *  exits, a failed attempt is an ordinary transient on the standard
 *  arbitration. */
const DRAIN_RETRY_MS = 500

function scheduleDrainRetry(): void {
  if (reattachTimer !== null) return
  if (typeof setTimeout === "undefined") {
    _requestAttachNow()
    return
  }
  reattachTimer = setTimeout(() => {
    reattachTimer = null
    _requestAttachNow()
  }, DRAIN_RETRY_MS)
}

/** The client's navigation point — the envelope seq of its latest url
 *  statement on the open connection (`0` = none since attach). */
export function _channelNavPoint(): number {
  return navPoint
}

export function _channelClaimWindowNav(): void {
  windowNavClaim = true
}

export function _channelConsumeWindowNavClaim(): boolean {
  const claimed = windowNavClaim
  windowNavClaim = false
  return claimed
}

export function _registerLiveStreamAbort(abort: (() => void) | null): void {
  liveStreamAbort = abort
}

export function _channelAbortLiveStream(): void {
  liveStreamAbort?.()
}

/** Set by the transport handover — the NEXT connection close re-fires
 *  the attach even with no pending interaction: a deliberate close whose
 *  sole purpose is to re-establish on the adopted transport, so nothing
 *  else would trigger the settle's re-fire. One-shot, consumed in
 *  `_channelConnectionClosed`. */
let reattachOnClose = false

/** Arm the one-shot reattach-on-close for a close the client KNOWS is
 *  coming (dev HMR: `rsc:update` announced a server-code edit, and the
 *  server detaches every held drive whose module graph the edit
 *  orphaned — `lib/connection-session.ts`). Without the arm that close
 *  looks benign and the re-establishment waits out the heartbeat
 *  interval; armed, the settle re-fires the attach immediately and the
 *  fresh graph's catch-up delivers the new code. No-op with no
 *  established connection — the caller's navigation statement requests
 *  its own attach in that case. */
export function _channelArmReattachOnClose(): void {
  if (_getLiveConnectionId() !== null) reattachOnClose = true
}

// ─── The transport handover (fetch → WebSocket) ──────────────────────
//
// The auto-upgrade swaps the transport UNDER the channel with no gap
// and no tear (`armTransportUpgrade`, browser entry). Once a throwaway
// probe proves the socket (`probeWebSocketTransport`), the handover is
// two ordinary moves, sequenced so nothing is ever torn or rolled back:
//
//   1. `_channelBeginTransportHandover` — the commit point. States the
//      old connection's `atPark` detach: the server winds the held
//      stream down at its next FULL PARK — everything in flight is
//      served first (open lanes drain and commit, latched statements
//      get their covering renders), and the close tears nothing on
//      either side. The connection id stays PUBLISHED for the whole
//      wind-down, so statements and actions keep riding the old
//      connection until the moment it actually closes; the one-shot
//      reattach flag makes that close re-fire the heartbeat.
//   2. That fire is a NORMAL attach on the just-installed WebSocket
//      transport: its statement folds pending intent and presents the
//      manifest AT FIRE TIME — strictly after every one of the old
//      stream's commits landed (`finished` awaits the lane chains) —
//      so the new connection's whole-tree first segment can never
//      roll the page back behind content the old connection
//      delivered. The statement also names the closed connection
//      (`handoverFrom`), and the new session inherits its ephemeral
//      cell storage server-side — connection-scoped state survives
//      the pipe swap.

/** The handover's only unpublished window is open: the old connection
 *  CLOSED (its park-exit settle consumed the one-shot reattach flag)
 *  and the replacing attach has not established yet. Action POSTs wait
 *  it out (`_channelHandoverSettled`) so their connection affinity —
 *  the `x-parton-conn` binding that routes cell writes into the
 *  connection's ephemeral storage — is never silently dropped into
 *  unattached semantics by a swap the user never asked for. */
let handoverInFlight = false
let handoverWaiters: Array<() => void> = []

/** The connection the next attach REPLACES — captured at the handover
 *  commit, consumed (one-shot) by the attach transport into the
 *  statement's `handoverFrom` continuity link. */
let handoverFromId: string | null = null

function releaseHandoverWaiters(): void {
  handoverInFlight = false
  const waiters = handoverWaiters
  handoverWaiters = []
  for (const resolve of waiters) resolve()
}

/**
 * Resolves when no committed handover is in flight: immediately in the
 * steady state, else at the adopted connection's establishment (or the
 * degrade fallback — whichever settles the swap). The action transport
 * awaits this before capturing its connection binding; everything else
 * (url/frame/cookie statements) latches through the window on its own
 * machinery and needs no wait.
 */
export function _channelHandoverSettled(): Promise<void> {
  if (!handoverInFlight) return Promise.resolve()
  return new Promise<void>((resolve) => {
    handoverWaiters.push(resolve)
  })
}

// The upgrade's quiesce gate: the handover COMMITS only while no
// interaction is in flight — an unsettled navigation / refetch record
// means a covering render is mid-stream on the held connection, and
// swapping the transport under it would punt the interaction through
// the re-statement path (a full extra render) for no reason. The
// signal is the record machinery itself — a record's settle is an
// exact milestone, never a timer — and a page that never goes idle
// simply keeps its fetch connection (the upgrade is opportunistic).

let idleWaiters: Array<() => void> = []

function channelInteractionPending(): boolean {
  return pendingNavRecords.some((r) => !r.settled) || pendingFrameNavRecords.some((r) => !r.settled)
}

function maybeReleaseIdleWaiters(): void {
  if (idleWaiters.length === 0) return
  if (channelInteractionPending()) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve()
}

/** Resolves when no navigation / refetch interaction is in flight —
 *  immediately in the steady state, else at the next moment the last
 *  pending record retires (settle, abort, document-nav completion). */
export function _channelIdle(): Promise<void> {
  if (!channelInteractionPending()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    idleWaiters.push(resolve)
  })
}

/**
 * Commit the transport handover: the probe CONFIRMED the socket while
 * the old connection is still established. Arms the one-shot reattach
 * and states the old connection's `atPark` detach on the fetch
 * transport — the graceful server-side wind-down: the drive exits at
 * its next full park, so open lanes drain and commit, latched
 * statements get their covering renders, and the stream closes with
 * nothing to tear. The id stays PUBLISHED until that close, so the
 * old connection keeps serving statements and actions for the whole
 * wind-down; the close's settle re-fires the heartbeat, whose attach
 * rides the caller's just-installed transport and names the closed
 * connection (`handoverFrom`, consumed via `_takeHandoverFrom`). A
 * detach the server never took (`false` — the connection is already
 * gone, or the POST path just broke) falls back to aborting the held
 * stream: its settle still re-fires. Returns `false` when no
 * connection is established — the re-fire is requested directly.
 */
export function _channelBeginTransportHandover(): boolean {
  const connection = _getLiveConnectionId()
  reattachOnClose = true
  if (connection === null) {
    // Nothing established (the connection settled between the upgrade
    // gate and the confirm). No stream to wind down — request the fire
    // directly.
    _requestAttachNow()
    return false
  }
  handoverFromId = connection
  void fetchTransport
    .send({ connection, seq: ++envelopeSeq, frames: [{ kind: "detach", atPark: true }] })
    .then((delivered) => {
      if (!delivered) _channelAbortLiveStream()
    })
  return true
}

/** Consume (one-shot) the connection the next attach replaces — the
 *  statement's `handoverFrom` continuity link. `null` outside a
 *  handover. */
export function _takeHandoverFrom(): string | null {
  const id = handoverFromId
  handoverFromId = null
  return id
}

// ─── Cookie changes over the channel ─────────────────────────────────
//
// A client cookie WRITE (`navigate(url, {cookies})`) no longer TEARS the
// held connection. `document.cookie` is written client-side, then each
// change is stated as a `cookie` frame the server applies to the
// connection's cookie overlay — the held stream's `cookie()` readers
// re-lane against the new value, no reattach. RELIABLE class (the change
// must reach the server), but the buffered frames RETIRE at the next
// attach rather than retransmit: the attach's own `Cookie` header
// restates the jar, so a replayed delta is redundant (retired in
// `_channelNavSubsumedByAttach`).

/** Unsent cookie deltas, newest value per name (`null` = delete). */
let pendingCookies = new Map<string, string | null>()

/**
 * State one-or-more client cookie changes on the channel — the tear's
 * replacement. `document.cookie` is already written (the browser ships
 * the new jar on the next request); this states the changes to the OPEN
 * connection so its held renders reflect them without a reattach. With
 * no connection open the deltas LATCH: a fetch attach retires them (its
 * own `Cookie` header restates the jar — the subsume's clear), while a
 * handover-adopted WS connection flushes them as frames (its jar froze
 * at the upgrade handshake). Values are the wire form (URL-encoded,
 * `null` = delete) — exactly what the raw `Cookie` header would carry —
 * so the overlay and a later reattach's header agree.
 */
export function _channelCookieChange(changes: Record<string, string | null>): void {
  for (const name of Object.keys(changes)) {
    pendingCookies.set(name, changes[name])
  }
  scheduleChannelFlush()
}

/** The cookie producer — RELIABLE class. One frame per changed name;
 *  `collect(null)` keeps the pending deltas latched (they ride the next
 *  connection, though the subsume retires them — the attach header
 *  restates the jar). */
const cookieProducer: ChannelProducer = {
  reliable: true,
  collect(connection: string | null): ChannelFrame[] | null {
    if (pendingCookies.size === 0 || connection === null) return null
    const frames: ChannelFrame[] = []
    for (const [name, value] of pendingCookies) {
      frames.push({ kind: "cookie", name, value })
    }
    pendingCookies.clear()
    return frames
  },
  deliveryFailed(): void {
    // Reliable class — the retransmit buffer owns redelivery; a torn
    // connection reattaches and the attach's Cookie header restates
    // the jar.
  },
}

/** A server-initiated url push (a `url` trailer) applies only when the
 *  client hasn't navigated past the state the push was rendered as-of:
 *  client-wins-at-higher-envelope-seq. `asOf` is the delivery's wire
 *  as-of on the live stream, or the navigation point captured at issue
 *  time for a discrete response (the client-local as-of of a request
 *  it issued itself); `undefined` — a caller with no correlation —
 *  applies unconditionally. */
export function _serverUrlPushApplies(asOf: number | undefined): boolean {
  return asOf === undefined || asOf >= navPoint
}

/** The as-of commit guard for seq'd deliveries on the live stream —
 *  the stale-commit decision: commit iff the delivery was rendered
 *  as-of the client's current navigation point or later. A document
 *  navigation unloads the page, so no cross-page staleness class
 *  exists beyond this. */
export function _channelDeliveryCommittable(asOf: number): boolean {
  return asOf >= navPoint
}

/**
 * State a window navigation / selector refetch on the channel. Returns
 * the fire's `{streaming, finished}` milestones, or `null` on a
 * DEGRADED page — the caller's cue for a document navigation. With no
 * connection established the statement latches all the same and
 * requests an immediate attach: it rides the attach it triggers
 * (attach-with-intent — first interaction never waits). With
 * `record: false` the statement is fire-and-forget (a silent URL-only
 * sync — no milestones to keep).
 */
export function _channelNavigate(init: {
  url: string
  intent: UrlFrame["intent"]
  streaming?: boolean
  signal?: AbortSignal
  record?: boolean
}): { streaming: Promise<void>; finished: Promise<void> } | null {
  if (documentNavMode) return null
  // Reserve the statement's envelope seq: flushes serialize and only
  // collect-flushes mint, so the next envelope is exactly
  // `envelopeSeq + 1` — and the navigation point must advance NOW
  // (click time), before any flush, or a pre-nav delivery landing in
  // the reservation window would still commit.
  navPoint = envelopeSeq + 1
  pendingNavFrame = {
    kind: "url",
    url: init.url,
    intent: init.intent,
    ...(init.streaming === true ? { streaming: true } : {}),
  }
  if (_getLiveConnectionId() !== null) {
    scheduleChannelFlush()
  } else if (!_requestAttachNow()) {
    // No heartbeat owns the page — the statement stays latched for
    // whatever establishment ever comes; the fire itself is a no-op.
    return { streaming: Promise.resolve(), finished: Promise.resolve() }
  }
  if (init.record === false) return { streaming: Promise.resolve(), finished: Promise.resolve() }
  let resolveStreaming!: () => void
  let rejectStreaming!: (err: unknown) => void
  let resolveFinished!: () => void
  let rejectFinished!: (err: unknown) => void
  const streaming = new Promise<void>((res, rej) => {
    resolveStreaming = res
    rejectStreaming = rej
  })
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res
    rejectFinished = rej
  })
  streaming.catch(() => {})
  finished.catch(() => {})
  const record: PendingNavRecord = {
    navSeq: navPoint,
    url: init.url,
    streaming: init.streaming === true,
    streamingResolved: false,
    settled: false,
    resolveStreaming,
    rejectStreaming,
    resolveFinished,
    rejectFinished,
  }
  pendingNavRecords.push(record)
  // Remember the commit-mode wish for this navigation point — the forced
  // lanes it spawns commit after the covering segment retires the
  // record, so the wish must outlive it.
  navStreamingByPoint.set(record.navSeq, record.streaming)
  if (init.signal) {
    const onAbort = (): void => {
      if (record.settled) return
      record.settled = true
      pendingNavRecords = pendingNavRecords.filter((r) => r !== record)
      const err = abortError()
      if (!record.streamingResolved) record.rejectStreaming(err)
      record.rejectFinished(err)
      maybeReleaseIdleWaiters()
    }
    if (init.signal.aborted) onAbort()
    else init.signal.addEventListener("abort", onAbort, { once: true })
  }
  return { streaming, finished }
}

/** The commit-mode wish per navigation point, kept for the connection's
 *  lifetime (not just while the record is pending): a selector nav's
 *  forced lanes commit AFTER the covering whole-tree segment settles —
 *  which retires the record — so the lane handler needs the wish to
 *  outlive the record. Reset per connection. */
const navStreamingByPoint = new Map<number, boolean>()

/** True when the newest navigation at or below `asOf` asked for
 *  STREAMING (progressive) commit — the signal a forced lane consults
 *  to flash its body's Suspense fallbacks (matching the segment path)
 *  instead of swapping atomically. Persists past the record's settle. */
export function _channelNavPrefersStreaming(asOf: number): boolean {
  let bestSeq = -1
  let streaming = false
  for (const [seq, wish] of navStreamingByPoint) {
    if (seq <= asOf && seq > bestSeq) {
      bestSeq = seq
      streaming = wish
    }
  }
  return bestSeq >= 0 && streaming
}

/** True when an UNSETTLED navigation/refetch fire covers `asOf` — the
 *  delivery is (part of) the content servicing an in-flight user
 *  statement, window or frame scope. The merge layer's lane commits
 *  consult this for the flush-quantum exemption: interactive content
 *  notifies immediately, while steady-state streaming lanes (no fire
 *  awaiting them) coalesce per animation frame. Reads the pending
 *  records, so a settled fire's later lanes batch again. */
export function _channelNavInFlightCovering(asOf: number): boolean {
  for (const record of pendingNavRecords) {
    if (!record.settled && record.navSeq <= asOf) return true
  }
  for (const record of pendingFrameNavRecords) {
    if (!record.settled && record.seq <= asOf) return true
  }
  return false
}

/** True when a covering commit should land as a TRANSITION (atomic
 *  swap) rather than a progressive `setPayloadRaw`. The NEWEST unsettled
 *  navigation at or below `asOf` decides: that statement is what the
 *  client is now displaying, so its commit-mode wish (`streaming: false`
 *  → transition) is the one that matters. Consulting the newest — not
 *  "any covered pending record" — is load-bearing: an on-mount `defer`
 *  force (`streaming: false`) whose page was navigated AWAY from before
 *  its own segment ran leaves an unsettled record behind (it is retired
 *  only at a covering segment's settle, one step after the next nav's
 *  commit-mode is read). Counting that superseded record would drag the
 *  next window navigation — a `streaming: true` statement — into a
 *  withholding transition, so its destination stops streaming. Reads
 *  the pending records (retired at settle), so a landed navigation no
 *  longer shapes a later segment's mode. No covered navigation → the
 *  live stream's default raw commit. */
export function _channelNavPrefersTransition(asOf: number): boolean {
  let bestSeq = -1
  let streaming = true
  for (const record of pendingNavRecords) {
    if (record.settled) continue
    if (record.navSeq > asOf || record.navSeq <= bestSeq) continue
    bestSeq = record.navSeq
    streaming = record.streaming
  }
  return bestSeq >= 0 && !streaming
}

/** A payload segment rendered as-of `asOf` COMMITTED on the live
 *  stream — resolve the `streaming` milestone of every record it
 *  covers (their content is this render). The as-of spans BOTH url
 *  scopes (it advances at every consume, window and frame alike), so
 *  a whole-tree segment covers frame records too: its render read the
 *  consumed session frame URLs. */
export function _channelNavSegmentCommitted(asOf: number): void {
  for (const record of pendingNavRecords) {
    if (record.settled || record.streamingResolved) continue
    if (record.navSeq > asOf) continue
    record.streamingResolved = true
    record.resolveStreaming()
  }
  for (const record of pendingFrameNavRecords) {
    if (record.settled || record.streamingResolved) continue
    if (record.seq > asOf) continue
    record.streamingResolved = true
    record.resolveStreaming()
  }
}

/** A covering payload segment SETTLED (its trailers resolved — the
 *  render fully drained) — resolve `finished` and retire the records. */
export function _channelNavSegmentSettled(asOf: number): void {
  const remaining: PendingNavRecord[] = []
  for (const record of pendingNavRecords) {
    if (record.settled) continue
    if (record.navSeq > asOf) {
      remaining.push(record)
      continue
    }
    record.settled = true
    if (!record.streamingResolved) {
      record.streamingResolved = true
      record.resolveStreaming()
    }
    record.resolveFinished()
  }
  pendingNavRecords = remaining
  const remainingFrames: PendingFrameNavRecord[] = []
  for (const record of pendingFrameNavRecords) {
    if (record.settled) continue
    if (record.seq > asOf) {
      remainingFrames.push(record)
      continue
    }
    record.settled = true
    if (!record.streamingResolved) {
      record.streamingResolved = true
      record.resolveStreaming()
    }
    record.resolveFinished()
  }
  pendingFrameNavRecords = remainingFrames
  pruneFrameSeqKeys()
  maybeReleaseIdleWaiters()
}

/** The folded intent an attach fire carries — what
 *  `_channelNavSubsumedByAttach` hands the attach transport. */
export interface AttachIntent {
  /** The pending window statement's URL (with its one-shot `__force`
   *  overlay), or `null` when no statement is pending — the attach
   *  states the current location. */
  url: string | null
  /** Pending FRAME statements, newest per key — the statement's
   *  `frames` field. */
  frames: UrlFrame[]
}

/**
 * The attach subsumes the URL timeline: the statement's `url` IS the
 * client's URL statement, so buffered url frames retire (never
 * retransmitted — their navigation is already the attach URL), the
 * navigation point resets (the new connection's deliveries open as-of
 * 0 on both sides), and every pending record — window and frame alike
 * — re-anchors at navigation point 0: the attach's first covering
 * segment resolves them through the ordinary as-of path (`streaming`
 * at its commit, `finished` at its settle; a catch-up boot's
 * lanes-open moment covers both). Pending statements FOLD INTO the
 * returned intent: the window statement becomes the attach `url`
 * (with its `__force` overlay), frame statements become the
 * statement's `frames`. Called by the browser entry at attach fire,
 * before the POST.
 */
export function _channelNavSubsumedByAttach(): AttachIntent {
  navPoint = 0
  const url = pendingNavFrame?.url ?? null
  pendingNavFrame = null
  const frames = [...pendingFrameFrames.values()]
  pendingFrameFrames.clear()
  // Cancel co-riders are moot: the superseded renders died with the
  // connection the attach replaces.
  pendingCancelScopes.clear()
  // Cookie deltas are restated by the attach's own `Cookie` header
  // (document.cookie is already written), so a pending or buffered one
  // is redundant — retire it.
  pendingCookies.clear()
  if (retransmitBuffer.length > 0) {
    retransmitBuffer = retransmitBuffer
      .map((entry) => ({
        seq: entry.seq,
        frames: entry.frames.filter(
          (f) => f.kind !== "url" && f.kind !== "cancel" && f.kind !== "cookie",
        ),
      }))
      .filter((entry) => entry.frames.length > 0)
  }
  // Re-anchor pending records at the fresh timeline's origin: the
  // attach carries their statements (the url field / the frames
  // intent), so its first covering segment — as-of 0 — resolves them.
  pendingNavRecords = pendingNavRecords.map((r) => (r.settled ? r : { ...r, navSeq: 0 }))
  pendingFrameNavRecords = pendingFrameNavRecords.map((r) => (r.settled ? r : { ...r, seq: 0 }))
  frameSeqKeys.clear()
  return { url, frames }
}

/** The url producer — RELIABLE class (see the module header). One
 *  pending frame, newest-wins. `collect(null)` — the flush found no
 *  connection — keeps the statement latched: it rides the next attach
 *  (the subsume folds it into the statement's `url`). */
const urlProducer: ChannelProducer = {
  reliable: true,
  collect(connection: string | null): ChannelFrame | null {
    if (pendingNavFrame === null || connection === null) return null
    const frame = pendingNavFrame
    pendingNavFrame = null
    return frame
  },
  deliveryFailed(): void {
    // Reliable class — the retransmit buffer owns redelivery; the
    // pending-record recovery rides the connection-loss paths.
  },
}

// ─── Frame navigation over the channel ───────────────────────────────
//
// A frame navigate/reload/traverse is a FRAME-scoped `url` statement:
// the endpoint writes the session frame URL (the same store a
// document's `?__frame=` param writes through), the driver lanes the
// frame's targets on the HELD stream, and the fire's milestones
// resolve off the covering lane's `nav=<seq>` correlation flag —
// `streaming` at its commit, `finished` at its settle (a whole-tree
// segment whose as-of covers the statement resolves them too: its
// render reflects the consumed frame URL). A newer statement for the
// same frame ships `cancel` + `url` in ONE envelope, and the server
// aborts the superseded in-flight render directly. Pre-establishment
// statements ride the attach they trigger as the statement's `frames`
// intent; DEGRADED pages carry the frame move as a document
// navigation's `__frame`/`__frameUrl` params.

interface PendingFrameNavRecord {
  /** Dotted frame key — the statement's scope. */
  key: string
  /** Top-level frame name — the cancel scope. */
  topLabel: string
  /** The statement's envelope seq — a covering lane flagged
   *  `nav >= seq` (same key) or a whole-tree segment with
   *  `asOf >= seq` resolves the record. */
  seq: number
  /** The stated frame URL — what a degraded document navigation
   *  carries as its `__frameUrl` param. */
  url: string
  streaming: boolean
  streamingResolved: boolean
  settled: boolean
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

/** Unsent frame statements, newest per frame key. */
let pendingFrameFrames = new Map<string, UrlFrame>()
/** Cancel co-riders for the next flush — scopes whose in-flight
 *  render a newer statement supersedes. Emitted BEFORE the url frames
 *  in the producer's contribution (cancel-then-url in one envelope). */
let pendingCancelScopes = new Set<string>()
let pendingFrameNavRecords: PendingFrameNavRecord[] = []
/** Statement seq → frame key, for the covering-lane correlation (the
 *  wire flag carries only the seq). Pruned as records retire. */
const frameSeqKeys = new Map<number, string>()

/**
 * State a frame navigation on the channel. Returns the fire's
 * `{streaming, finished}` milestones, or `null` on a DEGRADED page —
 * the caller's cue for a document navigation carrying the frame move
 * as `__frame`/`__frameUrl` document params. With no connection the
 * statement latches and requests an immediate attach; the attach
 * subsume ships it as the statement's `frames` intent.
 */
export function _channelFrameNavigate(init: {
  path: readonly string[]
  url: string
  intent: UrlFrame["intent"]
  streaming?: boolean
  signal?: AbortSignal
}): { streaming: Promise<void>; finished: Promise<void> } | null {
  if (documentNavMode) return null
  const key = init.path.join(".")
  const topLabel = init.path[0]
  // Reserve the statement's envelope seq — flushes serialize and only
  // collect-flushes mint, so the next envelope is exactly
  // `envelopeSeq + 1`. Statements batched into the same flush share
  // the seq; each record still correlates through its own key.
  const seq = envelopeSeq + 1
  // A prior unsettled statement for this frame is superseded — its
  // in-flight render on the server is moot. The cancel rides the SAME
  // envelope, ahead of the url frame.
  if (pendingFrameNavRecords.some((r) => r.key === key && !r.settled)) {
    pendingCancelScopes.add(topLabel)
  }
  pendingFrameFrames.set(key, {
    kind: "url",
    url: init.url,
    intent: init.intent,
    frame: [...init.path],
  })
  frameSeqKeys.set(seq, key)
  let latchedOnly = false
  if (_getLiveConnectionId() !== null) {
    scheduleChannelFlush()
  } else if (!_requestAttachNow()) {
    latchedOnly = true
  }
  if (latchedOnly) {
    return { streaming: Promise.resolve(), finished: Promise.resolve() }
  }
  let resolveStreaming!: () => void
  let rejectStreaming!: (err: unknown) => void
  let resolveFinished!: () => void
  let rejectFinished!: (err: unknown) => void
  const streaming = new Promise<void>((res, rej) => {
    resolveStreaming = res
    rejectStreaming = rej
  })
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res
    rejectFinished = rej
  })
  streaming.catch(() => {})
  finished.catch(() => {})
  const record: PendingFrameNavRecord = {
    key,
    topLabel,
    seq,
    url: init.url,
    streaming: init.streaming === true,
    streamingResolved: false,
    settled: false,
    resolveStreaming,
    rejectStreaming,
    resolveFinished,
    rejectFinished,
  }
  pendingFrameNavRecords.push(record)
  if (init.signal) {
    const onAbort = (): void => {
      if (record.settled) return
      record.settled = true
      pendingFrameNavRecords = pendingFrameNavRecords.filter((r) => r !== record)
      pruneFrameSeqKeys()
      const err = abortError()
      if (!record.streamingResolved) record.rejectStreaming(err)
      record.rejectFinished(err)
      maybeReleaseIdleWaiters()
    }
    if (init.signal.aborted) onAbort()
    else init.signal.addEventListener("abort", onAbort, { once: true })
  }
  return { streaming, finished }
}

function pruneFrameSeqKeys(): void {
  for (const [seq, key] of [...frameSeqKeys]) {
    if (!pendingFrameNavRecords.some((r) => r.key === key && r.seq <= seq)) {
      frameSeqKeys.delete(seq)
    }
  }
}

/** A lane flagged `nav=<navSeq>` COMMITTED — the covering render for
 *  its statement's frame. Resolve `streaming` for every record of
 *  that frame the statement covers. */
export function _channelFrameLaneCommitted(navSeq: number): void {
  const key = frameSeqKeys.get(navSeq)
  if (key === undefined) return
  for (const record of pendingFrameNavRecords) {
    if (record.settled || record.streamingResolved) continue
    if (record.key !== key || record.seq > navSeq) continue
    record.streamingResolved = true
    record.resolveStreaming()
  }
}

/** A `nav=<navSeq>`-flagged lane SETTLED (its body closed and its fp
 *  trailer applied) — resolve `finished` and retire the covered
 *  records. */
export function _channelFrameLaneSettled(navSeq: number): void {
  const key = frameSeqKeys.get(navSeq)
  if (key === undefined) return
  const remaining: PendingFrameNavRecord[] = []
  for (const record of pendingFrameNavRecords) {
    if (record.settled) continue
    if (record.key !== key || record.seq > navSeq) {
      remaining.push(record)
      continue
    }
    record.settled = true
    if (!record.streamingResolved) {
      record.streamingResolved = true
      record.resolveStreaming()
    }
    record.resolveFinished()
  }
  pendingFrameNavRecords = remaining
  pruneFrameSeqKeys()
  maybeReleaseIdleWaiters()
}

/** The frame-navigation producer — RELIABLE class. One url frame per
 *  frame key (newest statement wins pre-flush), each superseding
 *  statement's cancel ORDERED AHEAD of the urls in its contribution.
 *  `collect(null)` keeps every pending statement latched — it rides
 *  the next attach as the statement's `frames` intent. */
const frameNavProducer: ChannelProducer = {
  reliable: true,
  collect(connection: string | null): ChannelFrame[] | null {
    if (pendingFrameFrames.size === 0 && pendingCancelScopes.size === 0) {
      return null
    }
    if (connection === null) return null
    const frames: ChannelFrame[] = []
    for (const scope of pendingCancelScopes) {
      frames.push({ kind: "cancel", scope })
    }
    pendingCancelScopes.clear()
    for (const frame of pendingFrameFrames.values()) frames.push(frame)
    pendingFrameFrames.clear()
    return frames
  },
  deliveryFailed(): void {
    // Reliable class — the retransmit buffer owns redelivery; the
    // pending-record recovery rides the connection-loss paths.
  },
}

/**
 * Complete the pending interaction records as ONE document navigation
 * — the degraded page's answer. The target is the latest window
 * statement's URL (or the current location), carrying each pending
 * frame statement as `__frame`/`__frameUrl` document params (the SSR
 * render writes them into the session and renders the frame state).
 * The records resolve as no-ops — the page is leaving; a document load
 * is their completion.
 */
function documentNavForPendingRecords(): void {
  const windowRecords = pendingNavRecords
  const frameRecords = pendingFrameNavRecords
  pendingNavRecords = []
  pendingFrameNavRecords = []
  frameSeqKeys.clear()
  pendingNavFrame = null
  pendingFrameFrames.clear()
  pendingCancelScopes.clear()
  if (typeof window !== "undefined") {
    const latestWindow = windowRecords.filter((r) => !r.settled).at(-1)
    const target = new URL(
      latestWindow?.url ?? window.location.pathname + window.location.search,
      window.location.origin,
    )
    target.searchParams.delete("__force")
    const latestByKey = new Map<string, PendingFrameNavRecord>()
    for (const r of frameRecords) {
      if (!r.settled) latestByKey.set(r.key, r)
    }
    for (const [key, r] of latestByKey) {
      target.searchParams.append("__frame", key)
      target.searchParams.append("__frameUrl", r.url)
    }
    // Degraded is already set, so the navigate listener stands down
    // and the browser performs a full document load.
    getNavigation()?.navigate(target.href, { history: "replace" })
  }
  for (const r of [...windowRecords, ...frameRecords]) {
    if (r.settled) continue
    r.settled = true
    if (!r.streamingResolved) r.resolveStreaming()
    r.resolveFinished()
  }
  maybeReleaseIdleWaiters()
}

/**
 * Wire-entry hook for the segmented-stream reader (`splitSegments`'
 * `onEntry`): the browser entry hands every trailer ENTRY here as it
 * is read. Three tags are the transport's:
 *
 *   - `conn` — the server-minted connection id, the establishment
 *     handshake. Receiving it proves the session is open (the driver
 *     mints ids only at session open), so producers can address the
 *     connection immediately, even while the first segment's render
 *     is still draining.
 *   - `seq` (lane form, `<parton-id>\n<seq>`) — a lane delivery's seq,
 *     queued per parton until the browser entry's commit hook consumes
 *     it. The segment form (no newline) is fetch-local — the browser
 *     entry parses it via `_segmentDelivery` and consumes it within
 *     its own stream's loop.
 *   - `applied` — the server's cumulative upstream-applied watermark:
 *     prunes the reliable-envelope buffer and seeds the next attach.
 *
 * Entries of other tags pass through untouched — their consumers read
 * the segment's trailer map.
 */
export function _channelWireEntry(tag: string, body: Uint8Array): void {
  if (tag === TAG_DELIVERY_SEQ || tag === TAG_MUX_LIVE) {
    const text = new TextDecoder().decode(body)
    const nl = text.indexOf("\n")
    if (nl < 0) return // segment form — fetch-local, see above
    const partonId = text.slice(0, nl)
    const delivery = parseDeliveryBody(text.slice(nl + 1))
    if (delivery === null) return
    if (tag === TAG_MUX_LIVE) delivery.live = true
    let queue = pendingLaneSeqs.get(partonId)
    if (!queue) {
      queue = []
      pendingLaneSeqs.set(partonId, queue)
    }
    queue.push(delivery)
    // A producer announcement arrives MID-BODY — wake the lane
    // handler that is already decoding this parton so it can switch
    // to the progressive commit path instead of waiting for a drain
    // that only comes at producer resolve.
    if (tag === TAG_MUX_LIVE) {
      const waiters = laneProducerWaiters.get(partonId)
      if (waiters) {
        laneProducerWaiters.delete(partonId)
        for (const wake of [...waiters]) wake()
      }
    }
    return
  }
  if (tag === TAG_SEQ_VOID) {
    // Assigned-but-never-emitted delivery seqs (an action's
    // consequence reservation whose lane was skipped) — count each
    // PROCESSED so the contiguous watermark passes them and the
    // consequence gates they anchored release.
    const text = new TextDecoder().decode(body)
    for (const token of text.split(" ")) {
      const seq = Number(token)
      if (Number.isFinite(seq) && seq > 0) commitDelivery(seq)
    }
    return
  }
  if (tag === TAG_UPSTREAM_APPLIED) {
    const applied = Number(new TextDecoder().decode(body))
    if (!Number.isFinite(applied) || applied <= appliedWatermark) return
    appliedWatermark = applied
    if (retransmitBuffer.length > 0) {
      retransmitBuffer = retransmitBuffer.filter((e) => e.seq > applied)
    }
    return
  }
  if (tag === TAG_DRAIN) {
    // The server stated it is DRAINING (deploy shutdown): the held
    // stream will serve everything in flight and close cleanly at its
    // next full park. Arm the one-shot reattach-on-close — the same
    // flag the transport handover uses — so the settle re-fires the
    // attach IMMEDIATELY (through the deployment's proxy it lands on a
    // surviving process; the fire-time manifest presents holdings the
    // wound-down stream fully served) instead of waiting out the
    // heartbeat interval. The explicit frame is the signal: a closed
    // socket alone never means drain. Action POSTs hold through the
    // close→establish gap on the handover machinery
    // (`_channelHandoverSettled`), so an in-flight write is never
    // silently dropped to unattached semantics.
    reattachOnClose = true
    return
  }
  if (tag !== TAG_CONNECTION_ID) return
  _channelEstablished(new TextDecoder().decode(body))
}

/** Parse a `<seq> <asof>[ nav=<n>]` delivery body. `null` when
 *  malformed. Unknown trailing tokens are ignored — the body grows by
 *  adding flags. */
function parseDeliveryBody(text: string): WireDelivery | null {
  const tokens = text.split(" ").filter(Boolean)
  const seq = Number(tokens[0])
  if (!Number.isFinite(seq)) return null
  const asOfRaw = tokens.length > 1 ? Number(tokens[1]) : 0
  const delivery: WireDelivery = {
    seq,
    asOf: Number.isFinite(asOfRaw) ? asOfRaw : 0,
  }
  for (const token of tokens.slice(2)) {
    if (token.startsWith("nav=")) {
      const nav = Number(token.slice(4))
      if (Number.isFinite(nav)) delivery.nav = nav
    }
  }
  return delivery
}

/** Parse a payload segment's delivery off a wire entry — the segment
 *  form of the `seq` tag (`<seq> <asof>`, no parton-id prefix). `null`
 *  for every other entry. The browser entry keeps the value FETCH-LOCAL
 *  and records it via `_segmentDeliveryCommitted` when the segment's
 *  payload commits (or consumes it via the stale-drop paths). */
export function _segmentDelivery(tag: string, body: Uint8Array): WireDelivery | null {
  if (tag !== TAG_DELIVERY_SEQ) return null
  const text = new TextDecoder().decode(body)
  if (text.includes("\n")) return null // lane form — queued above
  return parseDeliveryBody(text)
}

/** Record a committed delivery. A contiguous-frontier advance leaves
 *  the ack producer dirty and nothing more — a PASSENGER: any flush
 *  other frames justify (visibility statements, detach, future kinds)
 *  collects the current watermark for free. Exactly two advances drive
 *  a flush of their own, on the normal rAF-coalesced path (no timers):
 *  the connection's FIRST committed delivery — the prompt duplex proof
 *  both sides' degrade machinery times — and the unacked count
 *  crossing `ACK_FLUSH_THRESHOLD`. */
function commitDelivery(seq: number): void {
  if (seq <= deliveredWatermark) return
  if (seq === deliveredWatermark + 1) {
    deliveredWatermark = seq
    while (deliveredOutOfOrder.delete(deliveredWatermark + 1)) {
      deliveredWatermark += 1
    }
    sweepConsequenceGates()
    if (lastAckCollected === 0 || deliveredWatermark - lastAckCollected >= ACK_FLUSH_THRESHOLD) {
      scheduleChannelFlush()
    }
    return
  }
  deliveredOutOfOrder.add(seq)
}

/** A payload segment on the live stream committed — record the seq its
 *  `seq` entry announced (the browser entry held it fetch-locally). */
export function _segmentDeliveryCommitted(seq: number): void {
  commitDelivery(seq)
}

/** Peek the delivery the NEXT commit for `partonId` would consume —
 *  the merge layer's as-of guard reads it after a lane's decode (the
 *  `seq` entry precedes the lane's `muxend`, so it is queued by then).
 *  `null` when the lane carried no delivery (no session). */
export function _lanePendingDelivery(partonId: string): WireDelivery | null {
  return pendingLaneSeqs.get(partonId)?.[0] ?? null
}

/** A lane payload for `partonId` committed — consume the queue head
 *  minted when its `seq` entry was read. No-op when no seq is queued
 *  (a stream without deliveries: no session, or an older server). */
export function _laneDeliveryCommitted(partonId: string): void {
  const delivery = consumeLaneDelivery(partonId)
  if (delivery !== null) commitDelivery(delivery.seq)
}

/** A lane payload for `partonId` was decoded but NOT committed (stale
 *  page guard on a DYING stream, torn decode). Consume the queue head
 *  WITHOUT recording: attribution for later lanes stays aligned, and
 *  the watermark stalls at the dropped seq — the server never treats
 *  the drop as held. Only for streams whose life ends with the drop;
 *  a drop on a CONTINUING stream is the as-of drop below. */
export function _laneDeliveryDropped(partonId: string): void {
  consumeLaneDelivery(partonId)
}

/** A lane payload for `partonId` was dropped by the AS-OF guard — it
 *  predates the client's navigation point on a stream that lives on.
 *  Consume the queue head and count the delivery PROCESSED: the
 *  watermark advances (a permanent gap would wedge the window and
 *  force a reconnect on every raced navigation). The as-of drop itself
 *  is reported to the server separately (`_reportAsOfDrop`) so it evicts
 *  the delivery's optimistic mirror promotions; a torn/dying-stream drop
 *  is NOT reported (it self-heals on reattach) — hence the two calls at
 *  the drop site rather than a fold here. */
export function _laneDeliveryDroppedStale(partonId: string): void {
  const delivery = consumeLaneDelivery(partonId)
  if (delivery !== null) commitDelivery(delivery.seq)
}

function consumeLaneDelivery(partonId: string): WireDelivery | null {
  const queue = pendingLaneSeqs.get(partonId)
  const delivery = queue?.shift() ?? null
  if (queue !== undefined && queue.length === 0) pendingLaneSeqs.delete(partonId)
  return delivery
}

/** A payload segment was dropped by the as-of guard (or arrived torn
 *  under a supersede) on a continuing stream — consume its delivery as
 *  PROCESSED so the watermark stays contiguous. A genuine as-of drop is
 *  reported separately (`_reportAsOfDrop`) so the server evicts its
 *  mirror promotions; a torn-supersede drop is not (the server aborted
 *  that render — it promoted nothing to evict). */
export function _segmentDeliveryDroppedStale(seq: number): void {
  commitDelivery(seq)
}

/** Report a delivery the AS-OF guard dropped on a CONTINUING stream —
 *  the client received it but had navigated past its as-of, so it holds
 *  none of its content. The next ack carries the seq (once the watermark
 *  covers it) so the server evicts the delivery's optimistic mirror
 *  promotions and never folds them into the acked layer. Only for
 *  genuine as-of drops — never a torn/dying-stream drop (those self-heal
 *  on the reattach's whole-tree render). Schedules a flush so the report
 *  rides promptly rather than waiting for the next passenger. */
export function _reportAsOfDrop(seq: number): void {
  asOfDroppedSeqs.add(seq)
  scheduleChannelFlush()
}

// ─── Warm intent (preload) ───────────────────────────────────────────

/** The single pending warm target — newest-wins (the latest hover). */
let pendingWarm: string | null = null

/**
 * State a warm intent: the client expects to visit `url`
 * (`useNavigation().preload`). LOSSY class — advisory: with no
 * connection established the statement drops (a preload must never
 * trigger an attach; the navigation itself will), and a failed
 * envelope drops it too. Returns whether the statement was taken.
 */
export function _channelWarm(url: string): boolean {
  if (documentNavMode || _getLiveConnectionId() === null) return false
  pendingWarm = url
  scheduleChannelFlush()
  return true
}

/** The warm producer — LOSSY class, the telemetry contract: one
 *  pending statement, newest-wins, dropped at every failure point. */
const warmProducer: ChannelProducer = {
  collect(connection: string | null): ChannelFrame | null {
    if (connection === null) {
      pendingWarm = null
      return null
    }
    if (pendingWarm === null) return null
    const frame: ChannelFrame = { kind: "warm", url: pendingWarm }
    pendingWarm = null
    return frame
  },
  deliveryFailed(): void {
    // Dropped. Lossy class: the hover is already history; no re-queue.
  },
}

/** The transport's own ack producer — cumulative committed delivery
 *  seq, contributed whenever the watermark advanced past the last
 *  collected value, and ONCE per establishment regardless (the
 *  establishment ack — `establishmentAckDue`). A passenger on whatever
 *  envelope flushes (the two advances that drive one live at
 *  `commitDelivery`; the establishment ack's flush is driven by
 *  `_channelEstablished`). Loss-tolerant: a lost ack is subsumed by
 *  the next one; a failed FIRST ack is the degrade signal (handled in
 *  `flush`, which sees the whole envelope's fate). */
const ackProducer: ChannelProducer = {
  collect(connection: string | null): ChannelFrame | null {
    if (connection === null) return null
    // Report as-of drops within the acked range — deliveries the client
    // received but did not hold. Only those the cumulative watermark
    // covers: a drop past the contiguous frontier isn't acked yet, so
    // the server has no settled record to evict against; it rides the
    // ack that finally covers it. The server evicts each seq's
    // optimistic promotions instead of folding them.
    const dropped: number[] = []
    for (const seq of asOfDroppedSeqs) {
      if (seq <= deliveredWatermark) dropped.push(seq)
    }
    // Pending loss statements ride the same frame — an eviction with
    // no new commits still justifies one (the ghost credit it revokes
    // would otherwise confirm on the next covering render).
    const evicted = [...evictedContentIds]
    if (
      !establishmentAckDue &&
      deliveredWatermark <= lastAckCollected &&
      dropped.length === 0 &&
      evicted.length === 0
    ) {
      return null
    }
    establishmentAckDue = false
    lastAckCollected = deliveredWatermark
    for (const seq of dropped) asOfDroppedSeqs.delete(seq)
    evictedContentIds.clear()
    return {
      kind: "ack",
      delivered: deliveredWatermark,
      ...(dropped.length > 0 ? { dropped } : {}),
      ...(evicted.length > 0 ? { evicted } : {}),
    }
  },
  deliveryFailed(): void {
    // Per-connection ack state resets at the next establishment; the
    // degrade decision lives in the flush's failure path. A carried
    // `evicted` statement needs no re-own either: a failed envelope
    // clears the published id, and the reattach's manifest restates
    // the client's holdings wholesale — the same eviction evidence.
  },
}

/**
 * Publish an established live connection. Called from the wire entry
 * above when the stream's `conn` handshake arrives; from here
 * producers address the connection with envelopes. Sets the
 * `data-parton-live` liveness marker and resets the per-connection
 * DELIVERY tracking (delivery seqs restart with the session; the
 * acked mirror layer resets with the connection — the attach manifest
 * is the durable evidence). The ENVELOPE seq is page-lifetime and
 * deliberately not reset — retransmitted reliable envelopes keep
 * their original seqs; establishment is their natural retransmit
 * point.
 */
export function _channelEstablished(connection: string): void {
  // Any establishment settles an in-flight transport handover — the
  // waiters (action POSTs holding for their connection binding) run
  // with the fresh id published below.
  releaseHandoverWaiters()
  pendingLaneSeqs.clear()
  laneProducerWaiters.clear()
  deliveredOutOfOrder.clear()
  deliveredWatermark = 0
  lastAckCollected = 0
  asOfDroppedSeqs.clear()
  // Pending loss statements retire: the attach manifest just restated
  // the client's holdings wholesale, and the new session's mirror
  // seeds from it — the eviction evidence, stated completely.
  evictedContentIds.clear()
  navStreamingByPoint.clear()
  ackDeliveredOnConnection = false
  // The establishment ack — the connection's opening upstream
  // statement (see `establishmentAckDue`). Collected by the flush
  // driven below; the envelope's fate settles the degrade state at
  // establishment on every connection, catch-up boots included.
  establishmentAckDue = true
  establishedSinceClose = true
  // A successful attach clears the establishment-failure streak and any
  // pending backoff timer; document-nav mode lifts here UNLESS a
  // first-ack-failure streak is still holding it (that clears on a
  // delivered ack — the full duplex proof).
  establishFailures = 0
  if (reattachTimer !== null) {
    clearTimeout(reattachTimer)
    reattachTimer = null
  }
  refreshDocumentNavMode()
  // Consequence gates anchor on the PREVIOUS connection's delivery
  // seqs — dead numbers now. Release them: the fresh connection's
  // whole-tree render is the catch-up (over-fetch, never a frozen
  // overlay).
  releaseAllConsequenceGates()
  retransmitPending = retransmitBuffer.length > 0
  _setLiveConnectionId(connection)
  if (typeof document !== "undefined") {
    // Presence-only: the marker says "a live push channel is
    // established", never WHICH connection — the id is the envelope
    // credential and stays out of the DOM.
    document.documentElement.setAttribute("data-parton-live", "")
  }
  for (const cb of [..._channelEstablishListeners()]) cb(connection)
  // Every establishment flushes: the establishment ack is owed, and
  // statements that latched while no connection existed (and weren't
  // folded into this attach — they landed after its subsume, or the
  // attach was a handover adoption, which folds nothing) ride the same
  // envelope, after any retransmit survivors replay.
  scheduleChannelFlush()
}

/** The live connection settled (keepalive elapsed, abort, error) —
 *  clear the published id and the liveness marker, then arbitrate.
 *  Failures are BOUNDED, never sticky: a single stumble re-establishes.
 *  Two blocked-path signatures each accrue a consecutive-failure
 *  counter, and a run of EITHER past `CHANNEL_FAILURE_LIMIT` falls to
 *  the (recoverable) document-nav mode:
 *
 *    - ESTABLISHMENT failure — the fire settled without EVER
 *      establishing and it wasn't our own supersede (conn never
 *      arrived / the POST errored): a blocked `/__parton/live`.
 *    - FIRST-ACK failure — the connection established and delivered but
 *      the envelope carrying its first ack couldn't land: a blocked
 *      `/__parton/channel`. The failing flush flagged it and pulled
 *      this stream down, so its settle counts it here.
 *
 *  Under the bound a failure re-attaches with backoff; pending nav /
 *  refetch records LATCH and ride the next attach (never flushed to a
 *  document navigation on a single stumble). Our own supersede that did
 *  NOT first-ack-fail is never a failure. The heartbeat calls this when
 *  its fire's `finished` settles; fires are strictly sequential, so the
 *  settling connection's id is the current one. */
export function _channelConnectionClosed(opts?: {
  aborted?: boolean
  drainRefused?: boolean
}): void {
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-parton-live")
  }
  _setLiveConnectionId(null)
  const established = establishedSinceClose
  establishedSinceClose = false
  // One-shot: a transport-upgrade handover requested this close re-fire
  // unconditionally (no pending interaction triggers it). Consume it
  // here so it can never leak into a later close. From this moment to
  // the adopted connection's establishment the id is unpublished — the
  // handover's only window — so action POSTs hold for it
  // (`_channelHandoverSettled`).
  const forceReattach = reattachOnClose
  reattachOnClose = false
  if (forceReattach) handoverInFlight = true
  const firstAckFailed = firstAckFailedThisConnection
  firstAckFailedThisConnection = false
  // The connection's delivery seqs are dead — a gate anchored on them
  // can never pass. Release: the reattach's whole-tree render carries
  // the consequences (over-fetch, never a frozen overlay).
  releaseAllConsequenceGates()

  // An EXPLICIT drain refusal (`x-parton-drain` on the attach response
  // — the server is deploy-draining): retry promptly on a short fixed
  // cadence and NEVER count it toward the degrade bound — the path is
  // not broken, the process is leaving. Pending interaction records
  // stay latched and ride the retry's attach (the ordinary subsume).
  if (opts?.drainRefused === true) {
    scheduleDrainRetry()
    return
  }

  const establishmentFailed = !established && opts?.aborted !== true
  const pendingInteraction =
    pendingNavRecords.some((r) => !r.settled) || pendingFrameNavRecords.some((r) => !r.settled)

  // What COUNTS toward the document-nav bound (each counter has its own
  // reset — establishment / delivered-ack — so the establish→ack-fail
  // loop of an upstream-only block still accrues):
  //   - an establishment failure that STRANDED a real interaction (a
  //     blocked path under a navigation — master's caller 2). An
  //     idle-heartbeat non-establishment is a benign transient (a
  //     saturated server, a keepalive race) — NOT counted, so a slow
  //     server can never false-trip the fallback; the interval retries.
  //   - a first-ack failure on any connection (a delivered-but-unackable
  //     connection is a genuine blocked upstream, not a load blip).
  const countsToward = (establishmentFailed && pendingInteraction) || firstAckFailed
  if (establishmentFailed && pendingInteraction) establishFailures += 1
  if (firstAckFailed) firstAckFailures += 1
  refreshDocumentNavMode()

  if (documentNavMode) {
    // The bound is reached — a genuinely blocked path. Pending
    // interactions complete as ONE document navigation; the heartbeat's
    // interval keeps probing (its fire is no longer degrade-gated), so
    // a later successful attach lifts the mode and restores channel
    // navigation. RECOVERABLE.
    if (pendingInteraction) documentNavForPendingRecords()
    return
  }
  if (countsToward) {
    // Transient failure under the bound: re-attach with backoff (the
    // counter grew, so this can't tight-loop). Pending records LATCH
    // and ride the next attach (folded by `_channelNavSubsumedByAttach`
    // at fire) — never document-navved on a single stumble.
    scheduleReattach()
    return
  }
  // Not counted — a benign idle non-establishment, a normal keepalive
  // close, our own supersede, or a transport-upgrade handover. Re-ride a
  // pending interaction (or the upgrade's requested re-attach)
  // immediately; otherwise the heartbeat's interval reopens on its own
  // (a background non-establishment retries there — no fast loop while
  // the counter stays put).
  if (pendingInteraction || forceReattach) _requestAttachNow()
}

/** Request an envelope flush. Coalesced per animation frame (the
 *  producers' statement cadence) and inert during SSR — same guard
 *  the visibility controller's dispatch always had. */
export function scheduleChannelFlush(): void {
  if (rafScheduled || typeof requestAnimationFrame === "undefined") return
  rafScheduled = true
  requestAnimationFrame(() => {
    rafScheduled = false
    void flush()
  })
}

async function flush(): Promise<void> {
  // Serialize: one envelope in flight. A flush requested meanwhile
  // re-fires when it lands (the `finally` below), so no statement is
  // stranded behind a consumed rAF.
  if (inFlight) {
    reflushPending = true
    return
  }
  const connection = _getLiveConnectionId()

  // Retransmit-first: a fresh establishment replays the reliable
  // buffer's survivors — original seqs, in order — before any new
  // envelope, so the server sees the page-lifetime seq timeline in
  // order. A failure mid-replay keeps the rest buffered for the next
  // establishment; the frames' producers are never handed back
  // (`reliable` — the buffer owns redelivery).
  if (retransmitPending && connection !== null) {
    inFlight = true
    try {
      for (const entry of [...retransmitBuffer]) {
        if (_getLiveConnectionId() !== connection) return
        const ok = await getChannelTransport().send({
          connection,
          seq: entry.seq,
          frames: entry.frames,
        })
        if (!ok) {
          if (_getLiveConnectionId() === connection) _setLiveConnectionId(null)
          return
        }
      }
      retransmitPending = false
    } finally {
      inFlight = false
      reflushPending = false
    }
    // Collect whatever producers accumulated while replaying — on
    // failure too: the fallback cue (`collect(null)`) must reach
    // them, or statements strand until their next delta.
    scheduleChannelFlush()
    return
  }

  const carried: Array<{ producer: ChannelProducer; frame: ChannelFrame }> = []
  for (const producer of [..._channelProducers()]) {
    const contributed = producer.collect(connection)
    if (contributed === null) continue
    // A producer's array contribution stays in ITS order within the
    // envelope — the frame-navigation producer's cancel-then-url pair
    // relies on it.
    for (const frame of Array.isArray(contributed) ? contributed : [contributed]) {
      carried.push({ producer, frame })
    }
  }
  if (connection === null || carried.length === 0) return
  const carriesAck = carried.some((c) => c.frame.kind === "ack")
  inFlight = true
  try {
    const seq = ++envelopeSeq
    // Reliable frames enter the buffer BEFORE the POST — a failed (or
    // silently lost) envelope must leave them retransmittable. Only
    // the reliable frames: loss-tolerant co-riders self-heal and must
    // not replay.
    const reliableFrames = carried.filter((c) => c.producer.reliable === true).map((c) => c.frame)
    if (reliableFrames.length > 0) {
      retransmitBuffer.push({ seq, frames: reliableFrames })
    }
    const delivered = await getChannelTransport().send({
      connection,
      seq,
      frames: carried.map((c) => c.frame),
    })
    if (!delivered) {
      // The server's explicit "connection not open" signal (or the
      // POST never reached it). Clear the published id so producers'
      // re-owned statements — and everything after them — pend for
      // the next establishment. Reliable frames stay in the buffer;
      // their producers are not handed back.
      //
      // A failure for a connection that is NO LONGER the current one
      // (the transport handover closed it while this envelope was in
      // flight) is moot beyond the handbacks: the new connection
      // re-acks and re-covers everything, so it must neither pull the
      // NEW stream down nor count toward the degrade bound.
      const stillCurrent = _getLiveConnectionId() === connection
      if (stillCurrent) _setLiveConnectionId(null)
      for (const { producer, frame } of carried) {
        if (producer.reliable !== true) producer.deliveryFailed(frame)
      }
      // The envelope carried this connection's FIRST ack and it never
      // got through: the client committed deliveries the server will
      // never learn about (a blocked `/__parton/channel` POST path).
      // NOT a sticky degrade — flag it and pull the now-unackable
      // stream down; its settle counts a first-ack failure and
      // arbitrates re-establishment vs the recoverable document-nav
      // fallback through the bound (`_channelConnectionClosed`).
      if (stillCurrent && carriesAck && !ackDeliveredOnConnection) {
        firstAckFailedThisConnection = true
        _channelAbortLiveStream()
      } else if (
        stillCurrent &&
        (pendingNavRecords.length > 0 || pendingFrameNavRecords.length > 0)
      ) {
        // Pending navigations — window and frame alike — can't reach
        // the server on this connection anymore. Abort the held
        // stream (it still renders the state the page just left);
        // its settle re-attaches with the statements folded in
        // (`_channelConnectionClosed` → `_requestAttachNow`).
        _channelAbortLiveStream()
      }
    } else if (carriesAck) {
      // The first ack landed — the full duplex is proven. Clear the
      // first-ack-failure streak; document-nav mode lifts if that was
      // what held it.
      ackDeliveredOnConnection = true
      if (firstAckFailures > 0) {
        firstAckFailures = 0
        refreshDocumentNavMode()
      }
    }
  } finally {
    inFlight = false
    if (reflushPending) {
      reflushPending = false
      scheduleChannelFlush()
    }
  }
}

/** Send the explicit close for the open connection (if any) and clear
 *  the published id — a bfcache restore re-establishes via the
 *  heartbeat's next fire. The keepalive fetch is the one transport
 *  that survives the unload in progress. */
function sendDetach(): void {
  const connection = _getLiveConnectionId()
  if (connection === null) return
  _setLiveConnectionId(null)
  void getChannelTransport().send({
    connection,
    seq: ++envelopeSeq,
    frames: [{ kind: "detach" }],
  })
}

if (typeof window !== "undefined") {
  // `pagehide` covers tab close, cross-origin navigation, and bfcache
  // entry — every way the page stops being able to consume the held
  // stream. Same-origin soft navigations never fire it.
  window.addEventListener("pagehide", sendDetach)
}

// The transport's own producers — the ack passenger, the window url
// statement source, the frame-navigation source, the warm-intent
// source, and the cookie-delta source — ride the same producer contract
// every external statement source uses.
registerChannelProducer(ackProducer)
registerChannelProducer(urlProducer)
registerChannelProducer(frameNavProducer)
registerChannelProducer(warmProducer)
registerChannelProducer(cookieProducer)

// Bind the live upstream into the registry: producer statements made
// before this transport loaded (a hydration-time content loss, an early
// flush request) replay through here, in order.
_bindChannelUpstream({
  scheduleFlush: scheduleChannelFlush,
  reportContentEvicted: _reportContentEvicted,
  awaitActionConsequences: _awaitActionConsequences,
})

/** Test-only: reset the transport's module state (seq, in-flight
 *  serialization, registrations, delivery tracking, buffer, degrade,
 *  navigation, frame navigation, consequence gates). */
export function _resetChannelClient(): void {
  _resetChannelRegistry()
  registerChannelProducer(ackProducer)
  registerChannelProducer(urlProducer)
  registerChannelProducer(frameNavProducer)
  registerChannelProducer(warmProducer)
  registerChannelProducer(cookieProducer)
  envelopeSeq = 0
  rafScheduled = false
  inFlight = false
  reflushPending = false
  pendingLaneSeqs.clear()
  laneProducerWaiters.clear()
  deliveredOutOfOrder.clear()
  deliveredWatermark = 0
  lastAckCollected = 0
  asOfDroppedSeqs.clear()
  evictedContentIds.clear()
  navStreamingByPoint.clear()
  ackDeliveredOnConnection = false
  establishmentAckDue = false
  retransmitBuffer = []
  appliedWatermark = 0
  retransmitPending = false
  establishFailures = 0
  firstAckFailures = 0
  firstAckFailedThisConnection = false
  documentNavMode = false
  if (reattachTimer !== null) {
    clearTimeout(reattachTimer)
    reattachTimer = null
  }
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-parton-degraded")
  }
  navPoint = 0
  pendingNavFrame = null
  pendingNavRecords = []
  pendingFrameFrames = new Map()
  pendingCancelScopes = new Set()
  pendingCookies = new Map()
  handoverInFlight = false
  handoverWaiters = []
  handoverFromId = null
  idleWaiters = []
  reattachOnClose = false
  pendingFrameNavRecords = []
  frameSeqKeys.clear()
  consequenceGates.clear()
  windowNavClaim = false
  liveStreamAbort = null
  attachRequester = null
  establishedSinceClose = false
  pendingWarm = null
  _setLiveConnectionId(null)
}
