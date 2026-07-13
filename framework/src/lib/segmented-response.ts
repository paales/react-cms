/**
 * Server-side multi-segment response driver.
 *
 * Stays open for up to `KEEPALIVE_MS` of idle after each segment
 * when the request is a live subscription — `?live=1`, set by the
 * client's `<LivePageHeartbeat>` long-poll — or when a render called
 * `markConnectionLive()` (the chat's `ChunkSlot`). Within that window,
 * a `refreshSelector` the connection's wake subscription matches (the
 * inverted wake index — see `segment-relevance.ts` and
 * `invalidation-registry.ts`) delivers the touched parton ids and
 * wakes the driver, which renders them as lanes. A bump nothing on
 * the route registered never wakes the driver at all. If the window
 * elapses with no activity, the response closes.
 *
 * One-shot requests — every navigation, every targeted refetch
 * (including `reload({selector, streaming: true})`), action responses —
 * emit one segment and close. `?streaming=1` alone is a CLIENT commit-
 * mode flag (progressive reveal vs atomic swap); it does NOT hold the
 * connection open. Holding open is a server subscription concern,
 * gated only on `?live=1` / `markConnectionLive`, so a targeted
 * streaming refetch returns its segment and closes instead of parking
 * for the full keepalive.
 *
 * Wire shape per segment matches `wrapStreamWithFpTrailer` exactly —
 * one Flight document, optional fp-trailer entry, no other markers
 * within the segment. Segments are joined by `next`-tagged delimiters.
 *
 * Cached-fp bookkeeping between segments: after each render commits
 * its snapshot store, the driver promotes the per-segment emitted fps
 * into the request's `cachedFingerprints` so the next segment's
 * fp-skip path treats those fps as "client has these." Without this,
 * a tagged invalidation that only changed one partial would still
 * cause every OTHER partial to re-emit on every segment.
 */

import {
  _captureCommitHandle,
  _createConnectionLiveProbe,
  _getAttachStatement,
  _getCachedOverride,
  _runWithPinnedVisible,
  _runWithWarmRenderScope,
  _runWithWarmRequestScope,
  _setCachedOverride,
  _setConnectionSession,
  _setFoldExclusionIds,
  _setRequestEphemeralStorage,
  getRequest,
  getScope,
  setRequest,
} from "../runtime/context.ts"
import {
  _currentTs,
  _pendingInvalidationSelectors,
  _registryEpoch,
  _takeWakeSubscriptionPending,
} from "../runtime/invalidation-registry.ts"
import { getSessionId, SESSION_COOKIE } from "../runtime/session.ts"
import { UNACKED_DELIVERY_WINDOW as PROTOCOL_UNACKED_DELIVERY_WINDOW } from "./channel-protocol.ts"
import {
  _claimHandoverStorage,
  _closeConnectionSession,
  _openConnectionSession,
  _peekConnectionSession,
  _recordDelivery,
  type ConnectionSession,
  capOverrideSet,
  type PendingFlip,
  takeConnectionCookieChanges,
  takeConnectionFlips,
  takeConnectionFrameNavs,
  takeConnectionNavigation,
} from "./connection-session.ts"
import { getEphemeralCellStorage } from "../runtime/cell-storage.ts"
import { RenderCancelledError } from "../runtime/errors.ts"
import {
  _acquireBroadcastRoute,
  _broadcastEligible,
  _broadcastMarkProducer,
  _broadcastRouteShared,
  _broadcastSlotTtlMs,
  _claimBroadcastSlot,
  type BroadcastClaim,
  type BroadcastResult,
} from "./broadcast.ts"
import { renderToReadableStream } from "./flight-runtime.ts"
import { _recomputeSubtreeWarmFp, wrapStreamWithFpTrailer } from "./fp-trailer.ts"
import {
  buildMarker,
  type FpUpdatesPayload,
  TAG_CONNECTION_ID,
  TAG_DELIVERY_SEQ,
  TAG_LANES_OPEN,
  TAG_MUX_LIVE,
  TAG_NEXT_SEGMENT,
  TAG_SEGMENT_SETTLED,
  TAG_SEQ_VOID,
  TAG_UPSTREAM_APPLIED,
} from "./fp-trailer-marker.ts"
import { computeRouteKey, parseCachedTokens, partialFromSnapshot } from "./partial.tsx"
import type { PartialSnapshot } from "./partial-registry.ts"
import {
  _readRouteDescendants,
  _readSnapshotsForRoute,
  effectiveExpiresAt,
  enterRequestRegistry,
  lookupPartial,
} from "./partial-registry.ts"
import {
  enterPartialState,
  runWithPartialState,
  type PartialRequestState,
} from "./partial-request-state.ts"
import { muxEndFrame, muxFrame } from "./parton-mux.ts"
import {
  _assertWakeParity,
  _closeRouteWakeSubscription,
  _escalateToLaneCarriers,
  _hasCullGateDep,
  _openRouteWakeSubscription,
  _routeMatchingCookieIds,
  _routeMatchingSelectorIds,
  _syncRouteWakeSubscription,
  _wakeParityCheckEnabled,
  type RouteWakeSubscription,
} from "./segment-relevance.ts"
import { getSpecById } from "./spec-catalog.ts"
import { _getWarmProjector, type WarmCandidate } from "./warm-projection.ts"

/**
 * The explicit reason threaded through every driver-initiated cancel of
 * a Flight-backed stream — a torn/superseded lane or segment, a closed
 * connection's wind-down. React folds a stream-cancel reason into the
 * render-error channel, so the marker tells `reportServerRenderError`
 * the teardown is expected lifecycle; a reason-less cancel would log
 * React's "aborted by the server without a reason" stack on every
 * client disconnect.
 */
const DRIVER_CANCEL_REASON = new RenderCancelledError("segment driver wind-down")

/** How long the driver holds the response open after the last USEFUL
 *  segment before closing an otherwise-silent connection.
 *
 *  This is a BACKSTOP for an abandoned connection, not a routine
 *  liveness cycle. The common teardowns reap promptly and independently
 *  of this bound: `pagehide` sends a `detach` frame (→ `session.detached`
 *  → the drive loop exits at its next wake) and a torn held stream fires
 *  the response's `cancel()` (→ `demand.cancelled`, surfaced at the next
 *  lane enqueue). An ACTIVE page never reaches the deadline at all — every
 *  shipped lane re-anchors it, and the 30s reconcile heals drift on a
 *  connection wake traffic keeps alive. The only connection this timer
 *  closes is one that is genuinely GONE with its detach lost AND its
 *  cancel unfired (an abrupt crash / network-loss of an idle connection,
 *  no wake traffic to surface the tear) — so it can be long.
 *
 *  5 minutes: an idle-but-alive page (the heartbeat open over nothing
 *  live) holds its ONE stream instead of churning a close+reopen every
 *  ~20s for no benefit, while a leaked connection is still reaped within
 *  a bounded window rather than held for the page's life. */
const DEFAULT_KEEPALIVE_MS = 5 * 60_000

/** Active keepalive window. Mutable only through `_setKeepaliveMs`:
 *  the soak benchmark parks thousands of in-process connections for
 *  longer than the production window, and an idle connection closing
 *  mid-measurement would silently shrink the held set under it.
 *  Production code never changes this. */
let KEEPALIVE_MS = DEFAULT_KEEPALIVE_MS

/** Test/bench-visible keepalive override. Call with no argument to
 *  restore the default. */
export function _setKeepaliveMs(ms?: number): void {
  KEEPALIVE_MS = ms ?? DEFAULT_KEEPALIVE_MS
}

/**
 * Max delivery seqs in flight past the client's cumulative ack before
 * the driver stops OPENING lanes (dirty ids coalesce; the latest state
 * renders when an ack frees the window). One of the two lane-opening
 * gates — the other is the response stream's own `desiredSize`
 * pull-gate, which parks enqueues byte-wise; the window bounds what
 * the byte gate can't see: deliveries the kernel already swallowed but
 * the client never committed (a torn downstream, a frozen proxy
 * buffer).
 *
 * The default is the protocol's `UNACKED_DELIVERY_WINDOW` (64) because
 * both quantities it bounds stay inside the soak budget (bench/README
 * § soak — ~20KB/connection is the mirror's planning number): the
 * per-seq `pendingDeliveries` records are a few `(id,fp)` pairs each
 * (~100–200B), so a full window pends ~10KB. The client acks LAZILY —
 * the watermark is a passenger on envelopes other statements justify,
 * and self-drives a flush only when its unacked count crosses
 * `ACK_FLUSH_THRESHOLD` (half this window; [[channel-client]]) — so
 * under sustained lane traffic the unacked count saws between zero and
 * ~half the window plus one RTT of deliveries: 2× headroom by
 * construction. Only a client that stopped committing what the kernel
 * swallowed fills it.
 */
const DEFAULT_UNACKED_DELIVERY_WINDOW = PROTOCOL_UNACKED_DELIVERY_WINDOW

let UNACKED_DELIVERY_WINDOW = DEFAULT_UNACKED_DELIVERY_WINDOW

/** Test/bench-visible window override (the soak bench's in-process
 *  reader never acks; measuring held connections needs the window out
 *  of the way). Call with no argument to restore the default. */
export function _setUnackedDeliveryWindow(count?: number): void {
  UNACKED_DELIVERY_WINDOW = count ?? DEFAULT_UNACKED_DELIVERY_WINDOW
}

/**
 * How long after the connection's FIRST delivery-seq'd emission settles
 * the driver waits for the client's first `ack` before marking the
 * connection degraded (never-acked) and closing instead of holding.
 *
 * Why a deadline at all (the no-heuristics bar): the failure this
 * kills is a blocked `/__parton/*` POST path (ad-blocker, corporate
 * proxy) — an upstream that emits NO signal whatsoever, whose absence
 * only time can bound. And an ack-less envelope is not evidence of a
 * non-acking client: the ack piggybacks on the rAF-coalesced flush, so
 * any single envelope can legitimately predate the commit it would
 * have acked — counting them is a coincidence proxy. The deadline is
 * anchored at delivered-settle — the protocol milestone that STARTS
 * the client's ack obligation — so it measures exactly that obligation
 * window, never connection age.
 *
 * 5s is an order of magnitude above the worst legitimate first-ack
 * path (RTT + decode + one rAF), and equals the heartbeat cadence, so
 * a degraded connection closes before the client's next fire would
 * stack a second held stream.
 */
const DEFAULT_FIRST_ACK_DEADLINE_MS = 5_000

let FIRST_ACK_DEADLINE_MS = DEFAULT_FIRST_ACK_DEADLINE_MS

/** Test/bench-visible deadline override (the soak bench and the
 *  in-process rsc harness never ack — their held connections must not
 *  degrade under measurement). Call with no argument to restore. */
export function _setFirstAckDeadlineMs(ms?: number): void {
  FIRST_ACK_DEADLINE_MS = ms ?? DEFAULT_FIRST_ACK_DEADLINE_MS
}

/**
 * Cadence of the whole-tree reconcile a long-lived lanes connection
 * emits on its own stream — the scheduled backstop for lane-relevance
 * false-negatives (a dependency the label/constraint surface doesn't
 * capture misses its lane; the next full segment heals it). It is the
 * drift healer for any connection held past its cadence: an active page
 * holds indefinitely (wake traffic re-anchors the keepalive), and even
 * an idle page now holds for the full keepalive backstop (minutes, not
 * seconds), so the reopen-whole-tree path is too rare to rely on —
 * the reconcile carries the healing.
 *
 * Anchored at the last full segment (connection open, an honored
 * catch-up anchor, or the previous reconcile) and evaluated at wakes —
 * no standing timer: a connection quiet long enough to drift past the
 * cadence without a wake is closed by the keepalive first (and its
 * eventual reopen's first segment is whole-tree).
 *
 * 30s: the reconcile costs one whole-route fp-skip pass (~a warm tick)
 * and ~zero wire bytes when nothing was missed, so the bound is CPU
 * cadence, not bytes — 1/30Hz per held connection is negligible next
 * to the soak's wake-filter tax — while keeping drift-healing latency
 * tight regardless of how long the connection holds.
 */
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000

let RECONCILE_INTERVAL_MS = DEFAULT_RECONCILE_INTERVAL_MS

/** Test-visible reconcile-cadence override. Call with no argument to
 *  restore the default. */
export function _setReconcileIntervalMs(ms?: number): void {
  RECONCILE_INTERVAL_MS = ms ?? DEFAULT_RECONCILE_INTERVAL_MS
}

/**
 * Max parton renders one warm pass may run — the bound on speculative
 * work per telemetry statement (a pass runs at most once per
 * statement, at the park after it arrives). Each warm render costs
 * about one lane render's CPU while shipping ZERO bytes, so the cap
 * keeps a pass at roughly one wake's worth of lane work: speculation
 * may never crowd out the renders clients are actually waiting on. A
 * scroll that genuinely needs more warming states fresh telemetry as
 * it moves, and each new statement is a new pass.
 *
 * 8 covers the deepest honest projection in tree: the website world's
 * viewport sweeps at most ~2 chunk rows/columns per horizon at WASD
 * speed (~6 chunks), and projections beyond the cap are the ones most
 * likely to be superseded before they're reached.
 */
const DEFAULT_MAX_WARM_PER_PARK = 8

let MAX_WARM_PER_PARK = DEFAULT_MAX_WARM_PER_PARK

/** Test-visible warm-cap override. Call with no argument to restore
 *  the default. */
export function _setMaxWarmPerPark(count?: number): void {
  MAX_WARM_PER_PARK = count ?? DEFAULT_MAX_WARM_PER_PARK
}

/**
 * The response stream's demand signal — the real backpressure wake.
 * The driver stops pumping renderer output while the controller's
 * `desiredSize` sits at or below zero (the queue is at its high-water
 * mark: bytes enqueued now buffer server-side for as long as the
 * reader stalls) and resumes on the consumer's next `pull`. `cancel`
 * flips `cancelled`, releasing parked pumps — a torn consumer is the
 * explicit signal that no pull is ever coming.
 */
export interface SegmentedResponseDemand {
  cancelled: boolean
  /** Resolves on the response stream's next `pull` or on cancel. */
  pulled: () => Promise<void>
}

/**
 * Build the segmented response stream around the drive loop, wiring
 * the stream's own `pull` / `cancel` callbacks as the driver's demand
 * signal. The drive starts synchronously (inside the caller's request
 * ALS scope) but is not awaited from `start` — the streams machinery
 * only fires `pull` once `start` settles, and the pull callback IS
 * the demand wake.
 */
export function createSegmentedResponse(
  renderSegment: () => ReadableStream<Uint8Array>,
  onSegmentEnd?: () => void,
): ReadableStream<Uint8Array> {
  let pullWaiters: Array<() => void> = []
  const releasePulls = (): void => {
    const waiters = pullWaiters
    pullWaiters = []
    for (const resolve of waiters) resolve()
  }
  const demand: SegmentedResponseDemand = {
    cancelled: false,
    pulled: () =>
      new Promise<void>((resolve) => {
        pullWaiters.push(resolve)
      }),
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void driveSegmentedResponse(controller, renderSegment, onSegmentEnd, demand).then(
        () => {
          try {
            controller.close()
          } catch {}
        },
        (err) => {
          try {
            controller.error(err)
          } catch {}
        },
      )
    },
    pull() {
      releasePulls()
    },
    cancel() {
      demand.cancelled = true
      releasePulls()
    },
  })
}

/**
 * Run a render-emit loop on the provided response controller. Calls
 * `renderSegment()` once, pipes its bytes through to the controller,
 * checks `connectionLive`, and either closes or waits for the next
 * `refreshSelector` and loops.
 *
 * `renderSegment` is invoked once per segment and returns the Flight
 * stream (already wrapped with the fp-trailer). The driver pipes its
 * bytes to the controller; the caller is responsible for whatever
 * setup needs to happen between segments (e.g. updating cached fps
 * from the snapshot store via `onSegmentEnd`).
 *
 * The driver always emits at least one segment. Subsequent segments
 * are gated on `markConnectionLive` having been called during the
 * just-rendered segment.
 *
 * `demand` (when provided — `createSegmentedResponse` always does)
 * pull-gates every renderer-output enqueue; without it the driver
 * pumps at render pace, which is only safe for an in-process consumer
 * that reads as fast as the driver writes.
 */
export async function driveSegmentedResponse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  renderSegment: () => ReadableStream<Uint8Array>,
  onSegmentEnd?: () => void,
  demand?: SegmentedResponseDemand,
): Promise<void> {
  // Pre-encode the `next` delimiter and the `settled` milestone — same
  // bytes every time, so build each once.
  const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0)
  const settledMarker = buildMarker(TAG_SEGMENT_SETTLED, 0)

  // A live subscription gets a connection session — the per-connection
  // state slot channel envelopes address, under a SERVER-MINTED id.
  // Opened BEFORE the first segment renders so an envelope can land at
  // any point of the connection's lifetime, and so the first
  // whole-tree segment already reads the client's measured set (the
  // session seeds from the request's `?visible=` param). Closed when
  // the drive loop exits: an envelope for a closed session gets a
  // `404`, the client transport's explicit fall-back signal.
  const session = openLiveConnectionSession()
  // The connection's registration into the inverted wake index — the
  // structure a `refreshSelector` commit delivers touched parton ids
  // through, replacing the retired per-wake relevance filter. Opened
  // with the session and closed in the same finally: an index entry
  // outliving its connection would retain the whole drive.
  const subscription =
    session === null
      ? null
      : _openRouteWakeSubscription({
          visible: () => session.visible,
          hasAssignedSeq: (id) => session.assignedLaneSeqs.has(id),
        })
  try {
    await driveSegments()
  } finally {
    if (subscription !== null) _closeRouteWakeSubscription(subscription)
    if (session) {
      _setConnectionSession(null)
      _closeConnectionSession(session.id)
    }
  }

  async function driveSegments(): Promise<void> {
    const lastTs = _currentTs()

    // Live catch-up: the attach presents the document's registry
    // anchor (the statement's `since`, minted into the SSR trailing
    // comment). The document IS the page state as of that point, so
    // re-rendering the whole route here would only re-ship bytes the
    // client already holds — skip the initial segment entirely and
    // open straight into lanes anchored at the document's timestamp:
    // the first wake lanes exactly what bumped or expired after the
    // document rendered. Honored only when the anchor's epoch names
    // THIS registry timeline (a restart or clear starts a new one),
    // the route still has snapshots (an HMR dispose wipes them), and
    // the statement carries no intent (a `__force` overlay or a
    // frame statement needs the full render's covering pass);
    // otherwise fall through to the full initial render.
    const catchUpTs = liveCatchupTs()
    if (catchUpTs !== null && session !== null && subscription !== null) {
      installCatchupCachedOverride()
      linkOverrideToSession(session)
      controller.enqueue(buildMarker(TAG_LANES_OPEN, 0))
      enqueueConnectionId(controller, session.id)
      await driveLaneStream(
        controller,
        catchUpTs,
        settledMarker,
        session,
        subscription,
        demand,
        renderSegment,
      )
      return
    }

    // The server-minted connection id, ahead of the first segment's
    // Flight rows — an ENTRY, so the splitter surfaces it and keeps
    // the body flowing. Shipping it FIRST means the client transport
    // can address the session before the whole-tree render has even
    // drained; the id's existence proves the session is open (it was
    // minted at session open, above).
    if (session !== null) {
      enqueueConnectionId(controller, session.id)
    }

    // A live connection's payload segment is a DELIVERY: mint its
    // per-connection seq and ship it as an entry ahead of the Flight
    // rows, so the client holds the seq before the segment can
    // commit (commit time is when it records — and acks — it).
    // One-shot responses have no session and carry no seqs.
    let deliverySeq: number | null = null
    if (session !== null) {
      deliverySeq = ++session.deliverySeq
      controller.enqueue(segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq))
    }

    const flightStream = renderSegment()
    const reader = flightStream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          // Pull-gated: a chunk is only enqueued once the consumer
          // has room for it. Not reading the NEXT chunk until then
          // propagates the wait into the Flight stream itself
          // (whose renderer paces on its own desiredSize).
          await waitForDemand(controller, demand)
          controller.enqueue(value)
        }
      }
    } finally {
      reader.releaseLock()
    }

    // The render for this segment has fully drained — its body bytes and
    // the `fp`/`url` trailers are all on the wire. Emit the `settled`
    // milestone so the client knows the iteration is complete: from this
    // point the connection is parked (held open awaiting the next bump),
    // and an abort can cancel the reader WITHOUT tearing a mid-render
    // body. The client's cooperative abort gates on this marker — see
    // `SegmentIterator` in `fp-trailer-split.ts`.
    controller.enqueue(settledMarker)

    // The delivery is fully on the wire — the client's ack
    // obligation starts here (the never-acked degrade deadline's
    // anchor).
    if (session !== null && deliverySeq !== null) {
      session.firstDeliverySettledAt ??= Date.now()
    }

    if (onSegmentEnd) onSegmentEnd()

    // One-shot render (no connection session — an in-process drive
    // without an attach statement): one segment, close.
    if (session === null || subscription === null) return

    // The attach's connection: after the initial whole-tree segment,
    // the connection switches to per-parton lanes — each wake renders
    // only the partons the bump / expiresAt boundary actually
    // touched, and their payloads interleave as independent `mux`
    // frames, so one parton's slow Suspense boundary never
    // head-of-line-blocks another parton's next update. Relevance
    // false-negatives (a dependency the label/dep surface doesn't
    // capture) are reconciled by the next whole-tree render: the
    // keepalive close forces the heartbeat to reattach, and the
    // reattached connection's first segment is always whole-tree.
    //
    // Promote into the optimistic layer AND capture the same walk
    // as the delivery's holdings record — what this segment carried
    // becomes acked evidence when the client commits it.
    const tokens: Array<readonly [string, string, string]> = []
    promoteSnapshotsToCachedOverride(undefined, (id, mk, fp) => tokens.push([id, mk, fp]), session)
    // PartialRoot installed the override during this render; link it to
    // the session so the channel endpoint can evict client-reported drops.
    linkOverrideToSession(session)
    if (deliverySeq !== null) {
      _recordDelivery(session, deliverySeq, tokens, session.consumedNavSeq)
    }
    controller.enqueue(nextMarker)
    controller.enqueue(buildMarker(TAG_LANES_OPEN, 0))
    await driveLaneStream(
      controller,
      lastTs,
      settledMarker,
      session,
      subscription,
      demand,
      renderSegment,
    )
  }
}

/**
 * Park until the consumer can take another chunk. `desiredSize <= 0`
 * means the stream's queue is at or past its high-water mark; the
 * stream's `pull` callback resolves the wait — the real demand
 * signal, no timers. A cancelled demand or an errored stream
 * (`desiredSize === null`) falls through so the caller's enqueue
 * surfaces the teardown.
 */
async function waitForDemand(
  controller: ReadableStreamDefaultController<Uint8Array>,
  demand: SegmentedResponseDemand | undefined,
): Promise<void> {
  if (!demand) return
  while (!demand.cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) {
    await demand.pulled()
  }
}

/**
 * Resolve the attach's live catch-up anchor — the statement's `since`
 * (the document's registry anchor the heartbeat's first fire presents;
 * see [[channel-protocol]]'s `AttachStatement`). Returns the anchor
 * timestamp when it is honorable: the epoch names the CURRENT registry
 * timeline, the route still has snapshots to lane from, and the
 * statement carries no frame intent (an attach-with-intent frame
 * statement needs the full render as its covering pass — its targets
 * may not have route snapshots to lane from yet). `null` otherwise —
 * the caller falls through to the full initial render (over-fetch,
 * never stale). A `__force` overlay does NOT refuse the anchor: forced
 * targets lane EXPLICIT the moment the region opens, on either path.
 */
function liveCatchupTs(): number | null {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return null
  }
  const statement = _getAttachStatement()
  if (statement === null) return null
  if ((statement.frames?.length ?? 0) > 0) return null
  const since = statement.since ?? null
  if (since === null) return null
  if (since.epoch !== _registryEpoch()) return null
  const routeKey = computeRouteKey(request.url)
  if (_readSnapshotsForRoute(scope, routeKey).size === 0) return null
  return since.ts
}

/** Framework transport params — stripped before an effective-URL
 *  comparison, so a `?__force=` refetch of the current page reads as the
 *  SAME navigation, not a new one. Mirror of `TRANSPORT_PARAMS`
 *  (see CLAUDE.md § match); match never sees these either. */
const NAV_TRANSPORT_PARAMS = [
  "partials",
  "cached",
  "live",
  "streaming",
  "visible",
  "__frame",
  "__frameUrl",
  "__cullFlip",
  "__force",
] as const

/** The navigation-identifying part of a URL: pathname + app search
 *  params (transport params dropped, order-independent). Two statements
 *  with the same effective URL address the same page — a refetch, not a
 *  navigation. */
function effectiveNavUrl(url: string): string {
  const u = new URL(url, "http://parton.local")
  for (const p of NAV_TRANSPORT_PARAMS) u.searchParams.delete(p)
  u.searchParams.sort()
  const search = u.searchParams.toString()
  return search ? `${u.pathname}?${search}` : u.pathname
}

/** Whether two nav statements target the same page (ignoring transport
 *  params). A same-effective-URL statement arriving over an in-flight
 *  streaming nav is a refetch of the page being loaded, not a nav away
 *  — see `supersededBy` in `emitNavSegment`. */
function sameEffectiveNavUrl(a: string, b: string): boolean {
  try {
    return effectiveNavUrl(a) === effectiveNavUrl(b)
  } catch {
    return false
  }
}

/** The attach statement's one-shot `__force` overlay — the selector a
 *  pre-establishment refetch folded into the statement's URL. Read off
 *  the statement (the entry strips it from request state before any
 *  render); `null` when the statement carries none. */
function attachForceSelector(): string | null {
  const statement = _getAttachStatement()
  if (statement === null) return null
  try {
    return new URL(statement.url, "http://parton.local").searchParams.get("__force")
  } catch {
    return null
  }
}

/**
 * Install the connection's cached override from the attach statement's
 * manifest. On the full-render path PartialRoot does this during the
 * initial segment; the catch-up path skips that render, and without an
 * override the flip machinery would treat the client as holding
 * nothing — every flip-in would re-render and DROP the parked fiber
 * (drop-on-drift) instead of confirming it. The manifest is the
 * client's own attestation, so skips against it are truthful. Catch-up
 * requires an anchor, and the anchor rides only the attach body, so
 * the statement is always present here.
 */
function installCatchupCachedOverride(): void {
  const parsed = parseCachedTokens(_getAttachStatement()?.cached ?? null)
  _setCachedOverride({
    fingerprints: parsed.fingerprints,
    matchKeys: parsed.matchKeys,
    slots: parsed.slots,
  })
}

/** Link the connection's optimistic override — the object the driver's
 *  renders promote into (`_getCachedOverride()` in this request scope) —
 *  onto the session, so the channel endpoint (a SEPARATE request scope)
 *  can evict a client-reported dropped delivery's promotions from the
 *  very same object. Called once the driver has installed the override
 *  (the cold render's first promote, or the catch-up install). The
 *  override identity is stable for the connection's lifetime, so the
 *  link is a one-shot reference, not a per-segment refresh. */
function linkOverrideToSession(session: ConnectionSession): void {
  session.cachedOverride = _getCachedOverride()
}

/**
 * Open the connection session for the active request when it carries
 * an attach statement — the ONE live-subscription signal — under a
 * SERVER-MINTED connection id (never a client-chosen URL param — that
 * shape invites fixation and leaks the addressable token into access
 * logs; the id ships downstream as the stream's `conn` entry instead).
 * Seeds the visible set from the statement's `visible`, with `null` as
 * the pre-measurement state, and binds the attach's scope + session
 * identity (what every channel envelope must re-present — see
 * `handleChannelPost` in `connection-session.ts`). Every attach binds
 * its OWN request's identity, which makes it the explicit rebind
 * point: a session cookie minted mid-connection starts working the
 * moment the next attach presents it. The session is
 * stamped onto the request's ALS store so the cull gate and
 * `evalDepKeys` read it for the connection's whole lifetime. Returns
 * `null` for statement-less renders — no envelope can address those,
 * so no session is needed and the drive is one segment.
 */
function openLiveConnectionSession(): ConnectionSession | null {
  let request: Request
  try {
    request = getRequest()
  } catch {
    return null
  }
  const statement = _getAttachStatement()
  if (statement === null) return null
  const seed: ReadonlySet<string> | null =
    statement.visible === null ? null : new Set(statement.visible)
  const session = _openConnectionSession(crypto.randomUUID(), seed, {
    scope: getScope(),
    sessionId: getSessionId() ?? "",
    // The statement's upstream watermark — what the client last heard
    // applied — anchors the new session's `applied` marker on the
    // page-lifetime envelope timeline (see [[channel-protocol]]).
    applied: statement?.applied ?? 0,
  })
  // The route this connection renders — what an action's consequence
  // reservation resolves the route snapshots through (the driver isn't
  // on the stack there). Moved by the driver at a window-navigation
  // consume.
  session.routeKey = computeRouteKey(request.url)
  _setConnectionSession(session)
  // The transport handover's continuity link: the statement names the
  // connection this attach REPLACES, and the new session INHERITS its
  // ephemeral cell storage — connection-scoped state (deferred cells,
  // streaming logs) survives the pipe swap because the handover is the
  // same logical connection continuing on a new transport. The old
  // session is already closed by fire time (its park-exit is what
  // triggered this attach), so the claim goes through the handover
  // locker, which is binding-checked: only a claimant under the SAME
  // scope + session identity inherits, so a forged id gets nothing.
  if (statement.handoverFrom !== undefined) {
    const inherited = _claimHandoverStorage(
      statement.handoverFrom,
      getScope(),
      getSessionId() ?? "",
    )
    if (inherited !== null) {
      _setRequestEphemeralStorage(inherited)
    }
  }
  // Link the connection's ephemeral cell storage onto the session so an
  // ATTACHED action (a separate request scope) can bind it and write its
  // mutations where this driver's consequence lanes read. Force-creating
  // it here fixes its identity for the connection's lifetime (the driver
  // never clears it), so the one-shot link stays valid across every
  // segment and lane.
  session.ephemeralStorage = getEphemeralCellStorage()
  return session
}

/** Frame the server-minted connection id as a `conn` entry — the
 *  establishment handshake the client's channel transport keys every
 *  upstream envelope on. Emitted once per connection. */
function enqueueConnectionId(
  controller: ReadableStreamDefaultController<Uint8Array>,
  id: string,
): void {
  const body = new TextEncoder().encode(id)
  controller.enqueue(buildMarker(TAG_CONNECTION_ID, body.byteLength))
  controller.enqueue(body)
}

/** A payload segment's delivery-seq `seq` entry bytes — body is
 *  `<seq> <asof>` (the lane form prefixes the parton id; the client
 *  tells them apart by the newline). `asof` is the navigation point
 *  the segment renders as-of (`session.consumedNavSeq`). Emitted ahead
 *  of the segment's Flight rows so the client holds seq AND as-of
 *  before the commit-or-drop decision. */
function segmentDeliverySeqEntry(seq: number, asOf: number): Uint8Array {
  const body = new TextEncoder().encode(`${seq} ${asOf}`)
  const marker = buildMarker(TAG_DELIVERY_SEQ, body.byteLength)
  const out = new Uint8Array(marker.byteLength + body.byteLength)
  out.set(marker, 0)
  out.set(body, marker.byteLength)
  return out
}

/** A lane delivery's `seq` entry bytes —
 *  `<parton-id>\n<seq> <asof>[ nav=<n>]`, the mux frames' id-first
 *  shape, framed for the lanes region (one buffer: the lane driver's
 *  `enqueue` is all-or-nothing per chunk). Written immediately BEFORE
 *  the lane's `muxend`, so the client's per-parton seq queue holds the
 *  value before the lane body closes and its decode — then commit —
 *  can complete. As-of at drain equals as-of at render: a navigation
 *  tears open lanes before it applies, so no lane ever drains across a
 *  consume. `nav=<n>` flags a lane spawned by a FRAME url statement
 *  with that statement's seq — the client's correlation for the frame
 *  fire's milestones. */
function laneDeliverySeqEntry(
  partonId: string,
  seq: number,
  asOf: number,
  navSeq?: number,
): Uint8Array {
  return idFirstEntry(TAG_DELIVERY_SEQ, partonId, seq, asOf, navSeq)
}

/** A producer lane's early delivery announcement — the `muxlive`
 *  frame: same id-first body as the lane `seq` entry, written the
 *  moment the lane's render declares itself a producer
 *  (`markConnectionLive()`), so the client holds seq + as-of while the
 *  body is still streaming and can commit progressively. A producer
 *  lane writes NO drain-time `seq` entry — this announcement IS its
 *  delivery; `muxend` at producer resolve closes the body. */
function muxLiveEntry(partonId: string, seq: number, asOf: number, navSeq?: number): Uint8Array {
  return idFirstEntry(TAG_MUX_LIVE, partonId, seq, asOf, navSeq)
}

function idFirstEntry(
  tag: string,
  partonId: string,
  seq: number,
  asOf: number,
  navSeq?: number,
): Uint8Array {
  const flags = navSeq !== undefined ? ` nav=${navSeq}` : ""
  const body = new TextEncoder().encode(`${partonId}\n${seq} ${asOf}${flags}`)
  const marker = buildMarker(tag, body.byteLength)
  const out = new Uint8Array(marker.byteLength + body.byteLength)
  out.set(marker, 0)
  out.set(body, marker.byteLength)
  return out
}

/** A `seqvoid` entry — space-separated delivery seqs that were
 *  assigned ahead of a render (an action's consequence reservation)
 *  but whose lane was skipped. The client counts each PROCESSED so
 *  the contiguous ack watermark passes them. */
function seqVoidEntry(seqs: readonly number[]): Uint8Array {
  const body = new TextEncoder().encode(seqs.join(" "))
  const marker = buildMarker(TAG_SEQ_VOID, body.byteLength)
  const out = new Uint8Array(marker.byteLength + body.byteLength)
  out.set(marker, 0)
  out.set(body, marker.byteLength)
  return out
}

/** The `applied` marker bytes — the cumulative upstream-seq-applied
 *  announcement (body: decimal watermark). */
function upstreamAppliedEntry(applied: number): Uint8Array {
  const body = new TextEncoder().encode(String(applied))
  const marker = buildMarker(TAG_UPSTREAM_APPLIED, body.byteLength)
  const out = new Uint8Array(marker.byteLength + body.byteLength)
  out.set(marker, 0)
  out.set(body, marker.byteLength)
  return out
}

/** One open lane: a parton whose payload is currently rendering and
 *  framing onto the connection. */
interface LaneRuntime {
  /** A wake touched this parton while its lane was open. One lane per
   *  parton id keeps the wire unambiguous (the client keys open bodies
   *  by id), so the pump re-renders once the current payload drains
   *  instead of opening a second lane. */
  dirty: boolean
  done: Promise<void>
  /** Cancels the pump's CURRENT render reader — the navigation tear's
   *  reach into a pump parked on a suspended render (a read on a
   *  loader-blocked Flight stream has no other check point). Set per
   *  render iteration while its reader is held; `null` between. */
  abortRead: (() => void) | null
  /** A `cancel` statement named this lane's scope: the pump winds the
   *  CURRENT iteration down (closing the open body with a `muxend` so
   *  the client's decode settles and the same id can reopen) and
   *  exits — the superseding frame statement's covering lane renders
   *  fresh. */
  cancelled: boolean
  /** The current iteration's render declared itself a PRODUCER
   *  (`markConnectionLive()` inside the lane — see `muxLiveEntry`).
   *  Its body streams until the producer resolves; the drive-loop
   *  exit aborts producer reads (an unbounded await must not hold the
   *  wind-down). */
  producer: boolean
  /** The current iteration renders an EXPLICIT force whose content
   *  has not drained. A navigation tear catching it re-forces the id
   *  after the reopen — the force was never satisfied, and the torn
   *  body's replacement lanes as-of the new statement (a silent
   *  restatement must not lose a disjoint target's refetch). Cleared
   *  at drain; a `cancel` is a deliberate supersede and never
   *  re-forces. */
  forced: boolean
}

/**
 * Per-parton emit loop for a live subscription. Each wake renders only
 * the partons the delivery touched — bumps the wake index delivered
 * and due `expires()` boundaries the connection's deadline wheel
 * fired, one shared pending set — through the same
 * snapshot-reconstruction path a `?partials=` refetch uses — and frames
 * each render's bytes as an independent `mux` lane, interleaved as the
 * renders produce them. A fast parton's payload closes on the wire
 * while a slow sibling is still suspended; the slow sibling gates
 * nothing.
 *
 * Isolation: concurrent lane renders share one request context. That
 * is safe for the registry because every write is a complete snapshot
 * merged by id (the same invariant that lets `<Cache>` splice several
 * hole renders concurrently), and each wake re-enters a fresh registry
 * pass so descendant folds read the latest committed canonical rather
 * than the initial segment's memoized view. Each lane's
 * `wrapStreamWithFpTrailer` commits at its own flush and emits
 * `{from,to}` fp updates scoped to the LANE'S OWN SUBTREE — the only
 * snapshots this render could have moved. Ancestors' fold drift is not
 * healed here (an honest ancestor fold needs every descendant's
 * contribution, a route-wide pass) — it rides the next whole-tree
 * segment; until then the ancestor over-fetches on its next render,
 * never serves stale.
 *
 * The `settled` milestone is written at quiesce (every lane drained),
 * marking a safe abort point; mid-lane aborts are also safe client-side
 * because a torn lane rejects only its own un-committed decode.
 *
 * Delivery drains skip PARKED partons — ids whose own snapshot,
 * or a cullable ancestor's, is outside the session's measured visible
 * set (`isParkedOnConnection`). A parked parton's client copy is a
 * hidden Activity slot; streaming lanes at it burns render + wire on
 * pixels nobody sees, and on a world-sized route it never stops: every
 * parton the client EVER scrolled past keeps its snapshot, so without
 * the skip the connection lane-renders all of them at full invalidation
 * rate, forever. Staleness is impossible: the flip-in revalidation
 * re-renders the returning state fresh (its fp folds every bump that
 * landed while parked, so it can't false-skip).
 *
 * Navigation outranks every wake: a channel envelope's `url` frame
 * latches on the session, and the driver — at wait entry or preempting
 * whatever arm won — tears the open lanes, applies the URL to the
 * connection's request state (the `setRequest` seam server-side
 * navigation uses), and answers with one full payload segment for the
 * new state before reopening the lanes region (`handleNavigation`). A
 * newer frame landing mid-render supersedes the in-flight navigation
 * render (`emitNavSegment`'s abort seam — the shape the explicit
 * cancel frame kind will reuse).
 *
 * Visibility flips are the fourth wake: a channel envelope's `visible`
 * frame updates the connection session's set and queues each flipped
 * id with the frame's OWN statement about it, and the driver lanes
 * exactly the ids whose standing statement is an in-flip — with the
 * cull gate (and the fp fold's store-and-reread) reading the session's
 * CURRENT set. A
 * flipped id's fps are dropped from the cached override first: a
 * visibility fp CYCLES between the same two values (in ↔ out), so a
 * stale override entry would fp-skip a re-entry to a placeholder whose
 * client-side cache slot now holds the other state's body. Same rule as
 * an explicit `?partials=` target — a flip must re-render, never
 * match-and-skip.
 */
async function driveLaneStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  sinceTs: number,
  settledMarker: Uint8Array,
  session: ConnectionSession | null,
  subscription: RouteWakeSubscription,
  demand: SegmentedResponseDemand | undefined,
  renderFullSegment: () => ReadableStream<Uint8Array>,
): Promise<void> {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return
  }
  // Mutable: a consumed url frame moves the connection's request state,
  // and every per-wake read below (snapshots, registry re-entry) must
  // follow it to the new route.
  let routeKey = computeRouteKey(request.url)
  // This connection's refcount on its route's broadcast-slot space —
  // keyed by (scope, effective URL) so two viewers share a slot only
  // when their whole request-URL dimension is equal (the slot key is
  // what makes `search:`/`match:` deps viewer-independent). Moved at a
  // navigation consume; released with the subscription
  // (`_closeRouteWakeSubscription`), so the last subscriber's exit
  // drops the route's slots.
  subscription.broadcastRoute ??= _acquireBroadcastRoute(`${scope}|${effectiveNavUrl(request.url)}`)
  // Register the route's snapshots into the wake index — and their
  // declared `expires()` boundaries into the connection's deadline
  // wheel — before the first park. `coveredTs = sinceTs` — the
  // catch-up anchor on the catch-up path, the pre-initial-segment
  // cursor on the full path — so the sync's covered-record probe seeds
  // the pending set with exactly what bumped after the covering
  // render: the first wait entry's bump latch drains it as the
  // catch-up lanes.
  _syncRouteWakeSubscription(subscription, _readSnapshotsForRoute(scope, routeKey), sinceTs)
  const lanes = new Map<string, LaneRuntime>()
  const openLaneIds = new Set<string>()
  // Whether this connection's mirror holds a matchKey OTHER than the
  // canonical one for any id in `carrierId`'s subtree — the broadcast
  // consume guard: variant siblings (hidden Activity slots for a
  // connection's parked variants) are a PER-CONNECTION emission the
  // shared body cannot carry, so such a connection renders its own.
  const subtreeHasForeignVariant = (
    carrierId: string,
    all: ReadonlyMap<string, PartialSnapshot>,
    override: { matchKeys: Map<string, Set<string>> },
  ): boolean => {
    const foreign = (cid: string): boolean => {
      const mks = override.matchKeys.get(cid)
      if (!mks || mks.size === 0) return false
      const own = all.get(cid)?.matchKey
      for (const mk of mks) if (mk !== own) return true
      return false
    }
    if (foreign(carrierId)) return true
    const subtree = _readRouteDescendants(scope, routeKey).get(carrierId)
    if (subtree) {
      for (const did of subtree) if (foreign(did)) return true
    }
    return false
  }
  // Ids whose NEXT lane renders EXPLICIT (the lane state's
  // explicitIds) — a url statement's `__force` targets: fp-skip and
  // the defer gate both yield, exactly as for a discrete `?partials=`
  // target. Consumed at lane start (one-shot — the render satisfies
  // the force).
  const forcedLaneIds = new Set<string>()
  // Frame-nav correlation flags: id → the FRAME url statement's seq
  // whose consume spawned that id's next lane. One-shot — consumed at
  // the covering iteration; ships as the ` nav=<n>` token on its
  // delivery announcement (the client resolves the frame fire's
  // milestones off it).
  const laneNavSeqs = new Map<string, number>()
  let closed = false

  // ── Consequence-seq bookkeeping ──
  // An action's reservation (`_reserveActionConsequences`) assigns a
  // delivery seq to a consequence lane BEFORE the bump wakes this
  // driver; the pump takes an id's assignment at iteration start. A
  // skip path that drops the id must VOID the assignment instead —
  // an assigned seq that never reaches the wire would wedge the
  // client's contiguous ack watermark (and hold its overlay gates)
  // forever.
  const takeAssignedSeq = (id: string): number | null => {
    if (session === null) return null
    const seq = session.assignedLaneSeqs.get(id)
    if (seq === undefined) return null
    session.assignedLaneSeqs.delete(id)
    return seq
  }
  const voidAssigned = (id: string): void => {
    if (session === null) return
    const seq = session.assignedLaneSeqs.get(id)
    if (seq === undefined) return
    session.assignedLaneSeqs.delete(id)
    session.voidSeqs.add(seq)
  }
  // Flush pending voids as one `seqvoid` entry. Entries interleave
  // anywhere on the wire (payload segments and lanes region alike),
  // so any emission point serves.
  const announceVoidSeqs = (): void => {
    if (session === null || session.voidSeqs.size === 0) return
    const seqs = [...session.voidSeqs]
    session.voidSeqs.clear()
    enqueue(seqVoidEntry(seqs))
  }

  // Stop release for pumps parked at the demand gate when the wake
  // loop exits: flushing the waiters lets each parked pump re-check
  // `stopping` and wind down instead of holding the drive open for a
  // pull that may never come. Mid-lane winding down is client-safe —
  // a torn lane rejects only its own un-committed decode. A waiter
  // SET rather than one long-lived promise: each park's entry is
  // removed when it releases (the wake-arm release invariant — a
  // reaction on a promise that only settles at connection teardown
  // would accumulate per park for the connection's lifetime).
  let stopping = false
  const gateWaiters = new Set<() => void>()

  // Navigation lane tear. A consumed url frame ends the lanes region
  // with a `next` delimiter, and no mux frame may follow it — so every
  // open lane winds down FIRST: the flag turns each pump's next check
  // point into an exit (no muxend, no seq entry — the client's region
  // exit errors the torn body, rejecting only that lane's un-committed
  // decode; a PRODUCER body, whose earlier bytes may have committed
  // progressively, is closed cleanly there instead), `abortRead`
  // breaks pumps parked on a suspended render, and the gate release
  // frees pumps parked on demand. The torn lanes' content is obsolete
  // by definition — it renders the route the client just left.
  let tearingLanesForNav = false
  const tearLanesForNavigation = async (): Promise<void> => {
    if (lanes.size === 0) return
    tearingLanesForNav = true
    for (const runtime of lanes.values()) runtime.abortRead?.()
    for (const release of [...gateWaiters]) release()
    await Promise.allSettled([...lanes.values()].map((l) => l.done))
    tearingLanesForNav = false
  }

  // The cancel arm — a `cancel` statement's reach into the scope's
  // open lane renders, fired synchronously at envelope apply
  // (`cancelListeners`). Scope membership is the frame's narrowing:
  // the lane's parton belongs to the scope when its id or a label
  // matches the scope name, or its snapshot's frame path opens with
  // it (nested frames cancel with their root). The cancelled pump
  // winds its CURRENT iteration down — closing the open body with a
  // `muxend` so the client's decode settles and the same id can
  // reopen — and exits; the superseding statement's covering lane
  // renders fresh.
  const cancelScopeLanes = (cancelScope: string): void => {
    if (lanes.size === 0) return
    const snapshots = _readSnapshotsForRoute(scope, routeKey)
    for (const [id, runtime] of lanes) {
      const snap = snapshots.get(id)
      const inScope =
        id === cancelScope ||
        (snap?.labels.includes(cancelScope) ?? false) ||
        snap?.framePath[0] === cancelScope
      if (!inScope) continue
      runtime.cancelled = true
      runtime.forced = false
      runtime.abortRead?.()
    }
    for (const release of [...gateWaiters]) release()
  }

  // Lane-output demand gate. Parks while the consumer's queue is
  // full; the stream's pull releases it. Returns false when the lane
  // must wind down instead of enqueue: the consumer cancelled (the
  // explicit no-pull-is-coming signal — also marks the connection
  // closed so the wake loop exits at its next wake), or the wake
  // loop exited while this pump was parked with the queue still
  // full. A pump caught by `stopping` with room in the queue still
  // delivers — only a consumer that stopped pulling gets its lane
  // tail torn.
  const awaitDemand = async (runtime?: LaneRuntime): Promise<boolean> => {
    if (!demand) return runtime?.cancelled !== true
    while (
      !stopping &&
      !tearingLanesForNav &&
      runtime?.cancelled !== true &&
      !demand.cancelled &&
      controller.desiredSize !== null &&
      controller.desiredSize <= 0
    ) {
      await new Promise<void>((resolve) => {
        const release = (): void => {
          gateWaiters.delete(release)
          resolve()
        }
        gateWaiters.add(release)
        void demand.pulled().then(release)
      })
    }
    if (demand.cancelled) {
      closed = true
      return false
    }
    if (runtime?.cancelled === true) return false
    return !(stopping && controller.desiredSize !== null && controller.desiredSize <= 0)
  }

  // Lane-drained wake arm. A drained lane's fresh snapshot carries its
  // next `expiresAt`; the wake runs the driver's sync, which re-arms
  // the deadline wheel from the committed snapshot (the wheel consumed
  // the id's entry when it fired — only the fresh boundary re-inserts
  // it). A latch plus a DISPOSABLE listener
  // set (the flipWakes shape) rather than a promise: a promise
  // reaction only frees when its promise settles, so arming each
  // re-arm iteration with `.then` on a park-lived promise accretes
  // one reaction (retaining its whole wake race) per idle wake — the
  // wake-arm release invariant. A drain landing while the driver is
  // busy sets the latch, which the next wait entry (and the wait's
  // own re-arm loop) consumes without parking.
  let laneDrainedPending = false
  const laneDrainedWakes = new Set<() => void>()
  const noteLaneDrained = (): void => {
    laneDrainedPending = true
    for (const wake of [...laneDrainedWakes]) wake()
  }

  const enqueue = (bytes: Uint8Array): boolean => {
    if (closed) return false
    try {
      controller.enqueue(bytes)
      return true
    } catch {
      // The client tore the connection (navigate-away). Stop producing;
      // in-flight lane renders drain into the void and their commits
      // still land server-side (the registry stays warm for the
      // heartbeat's reopened connection).
      closed = true
      return false
    }
  }

  const startLane = (id: string): void => {
    const open = lanes.get(id)
    if (open) {
      open.dirty = true
      return
    }
    const runtime: LaneRuntime = {
      dirty: false,
      done: Promise.resolve(),
      abortRead: null,
      cancelled: false,
      producer: false,
      forced: false,
    }
    lanes.set(id, runtime)
    openLaneIds.add(id)
    runtime.done = pumpLane(id, runtime)
  }

  const pumpLane = async (id: string, runtime: LaneRuntime): Promise<void> => {
    // Lane renders bypass PartialRoot, so the request-state ALS the
    // spec wrapper's skip path consults never flows here on its own.
    // Enter a lane-scoped state backed by the connection's cached
    // override MAPS (live references — promotes and trailer heals
    // between renders are visible to every subsequent pass), so a
    // lane render can fp-skip like any other: an unchanged parton
    // answers with its placeholder (for a culling flip, the
    // confirmation that restores the parked copy with zero bytes)
    // instead of re-shipping identical bytes. No override (the
    // connection never carried `?cached=`) → no state → every lane
    // renders fresh, exactly as a cold client would be served.
    const laneOverride = _getCachedOverride()
    // A forced lane (a url statement's `__force` target) renders
    // EXPLICIT: `explicitForces` bypasses the fp-skip verdict and the
    // defer gate renders the body — the refetch contract on the lane
    // path. One-shot: the force is consumed here; re-lanes of the same
    // parton skip and defer as usual.
    const forced = forcedLaneIds.delete(id)
    runtime.forced = forced
    if (laneOverride || forced) {
      enterPartialState({
        requestedIds: null,
        isPartialRefetch: true,
        cachedFingerprints: laneOverride?.fingerprints ?? new Map(),
        cachedMatchKeys: laneOverride?.matchKeys ?? new Map(),
        // The mirror's ACKED layer — client-proven holdings the
        // verdict falls back to on an optimistic miss (an fp the
        // per-id cap evicted from the override but the client
        // verifiably committed).
        ackedFingerprints: session?.ackedFps ?? null,
        explicitIds: forced ? new Set([id]) : new Set(),
        seenIds: new Set(),
      })
    }
    try {
      while (!closed && !tearingLanesForNav && !runtime.cancelled) {
        runtime.dirty = false
        runtime.producer = false
        // The iteration's visibility MOMENT — the set the render, the
        // fp-skip verdict, the flush recompute, AND the drain promote
        // below all describe. Captured before the render and pinned via
        // the probe scope: a `visible` statement landing mid-iteration
        // must not retag this render's emitted fp with a state its rows
        // do not carry (the flush-alias member of fuzz class F6 — an
        // out-flip ships no covering lane, so an aliased heal would
        // stand as the connection's last word on the id). The statement
        // that landed gets its own resolution — an in-flip lanes, and a
        // wake on this open lane marks it dirty, so the NEXT iteration
        // re-captures the moved set.
        const pinnedVisible = session !== null ? session.visible : undefined
        const snap = lookupPartial(id)
        if (!snap) {
          // An assigned consequence seq for a parton that no longer
          // snapshots can never emit — void it.
          voidAssigned(id)
          break
        }
        // A consequence seq assigned ahead of this render (an action's
        // reservation) — the iteration's delivery seq. Taken at
        // ITERATION START so a write landing mid-render assigns a
        // FRESH seq for the next iteration (this render's content
        // predates it).
        const assignedSeq = takeAssignedSeq(id)
        // The frame-nav correlation flag for a lane this iteration
        // covers — one-shot, rides the delivery announcement.
        const navSeq = laneNavSeqs.get(id)
        laneNavSeqs.delete(id)
        // This render is one DELIVERY: the fps it establishes on the
        // client — subtree promotions at drain plus any trailer heals
        // during the flush — become acked holdings when the client
        // commits it. Captured per iteration.
        const carried: Array<readonly [string, string, string]> = []
        // The trailer heals this iteration's flush emitted, folded into
        // the mirror AFTER the drain promote establishes each rendered
        // id's slot (below) — so the warm `to` fp joins the slot holding
        // its cold `from` (the client's `_applyFpUpdates` rule) instead
        // of landing slotless and un-evictable by a later variant.
        const laneHeals: FpUpdatesPayload = {}
        // This render's OWN snapshot registrations, captured through
        // the probe scope. Rival same-drain renders can cover one id
        // (a cullable wrapper's flip-in lane and its addressable
        // child's own bump lane) and the canonical merge keeps the
        // LAST-registered — but the client commits lane bodies in
        // WIRE order. The trailer flush and the drain promote below
        // both read through this map so this delivery's heals and
        // holdings describe THIS render's emissions (fuzz class F7).
        const renderRegistrations = new Map<string, PartialSnapshot>()
        // Per-iteration producer attribution: the render runs inside a
        // nested probe scope so `markConnectionLive()` marks THIS lane
        // (lane renders share one request store — the store-level flag
        // can't attribute across concurrent pumps). The probe also pins
        // the iteration's visibility moment (`pinnedVisible` above) and
        // installs the registration capture.
        const probe = _createConnectionLiveProbe(
          pinnedVisible === undefined ? undefined : { visible: pinnedVisible },
          renderRegistrations,
        )
        // The seq announced on the wire this iteration — a producer
        // lane announces EARLY (`muxlive`, the moment the render marks
        // live) so the client commits progressively; a normal lane
        // announces at drain, just before its `muxend`.
        let announcedSeq: number | null = null
        let bufferUntilDrain =
          runtime.forced && navSeq === undefined && session?.consumedNavStreaming !== true
        const bufferedFrames: Uint8Array[] = []
        const flushBufferedFrames = async (): Promise<boolean> => {
          if (bufferedFrames.length === 0) {
            bufferUntilDrain = false
            return true
          }
          for (const frame of bufferedFrames) {
            if (!(await awaitDemand(runtime))) return false
            if (!enqueue(frame)) return false
          }
          bufferedFrames.length = 0
          bufferUntilDrain = false
          return true
        }
        // A window-force lane (a selector nav's `__force` target, not a
        // frame lane — those carry a `navSeq`) announces its delivery seq
        // EARLY: a plain seq entry before the body, so the client holds it
        // at root-ready and can commit progressively when the covering nav
        // asked for streaming (matching the whole-tree segment). It stays a
        // NORMAL (non-`muxlive`) delivery — the client buffers it by
        // default; only the streaming-preferred branch commits root-ready.
        // Frame lanes and producers keep their own `muxlive` announcement:
        // setting the seq here would suppress it (`maybeAnnounceProducer`
        // gates on `announcedSeq`).
        if (runtime.forced && navSeq === undefined && session?.consumedNavStreaming === true) {
          announcedSeq = assignedSeq ?? ++session.deliverySeq
          if (!enqueue(laneDeliverySeqEntry(id, announcedSeq, session.consumedNavSeq, navSeq)))
            return
        }
        let wroteBytes = false
        const maybeAnnounceProducer = async (): Promise<boolean> => {
          if (announcedSeq !== null || session === null) return true
          if (!wroteBytes || !probe.live()) return true
          runtime.producer = true
          if (bufferUntilDrain && !(await flushBufferedFrames())) return false
          announcedSeq = assignedSeq ?? ++session.deliverySeq
          return enqueue(muxLiveEntry(id, announcedSeq, session.consumedNavSeq, navSeq))
        }
        // ── Broadcast slot (render once, fan out — delivery-plane D2) ──
        // A viewer-independent lane (`_broadcastEligible` — the dep
        // record is the proof) renders ONCE per generation process-wide:
        // the first drainer publishes the encoded body into the route's
        // slot; every other connection consumes the bytes and pays only
        // framing. The publisher's render runs in a FRESH empty partial
        // state (never fp-skips, never touches any connection's mirror)
        // so the body is connection-neutral; everything per-connection —
        // the seq entry, the muxend, the promote, the delivery record,
        // and the fp-SKIP decision below — still happens per connection.
        const publishBroadcastBody = async (
          claim: Extract<BroadcastClaim, { role: "publish" }>,
        ): Promise<BroadcastResult> => {
          const failed: BroadcastResult = {
            ok: false,
            chunks: [],
            heals: {},
            resultSnap: null,
            gen: null,
            expiresAt: 0,
          }
          const chunks: Uint8Array[] = []
          const heals: FpUpdatesPayload = {}
          // The shared body's own registration capture — its flush
          // heals must describe ITS render too (the slot's heals fold
          // into every consumer's mirror as that connection's word on
          // the id), though a shared render's registrations are the
          // canonical winners in the common case.
          const bodyProbe = _createConnectionLiveProbe(undefined, new Map<string, unknown>())
          let ended: "drained" | "producer" | "torn"
          try {
            ended = await bodyProbe.run(() =>
              runWithPartialState(
                {
                  // Fresh empty partial state — the shared body must
                  // never fp-skip (a placeholder is a per-connection
                  // statement) and must never read or mutate a mirror.
                  requestedIds: null,
                  isPartialRefetch: true,
                  cachedFingerprints: new Map(),
                  cachedMatchKeys: new Map(),
                  ackedFingerprints: null,
                  explicitIds: new Set(),
                  seenIds: new Set(),
                },
                async () => {
                  const flight = renderToReadableStream(partialFromSnapshot(id, snap))
                  const wrapped = wrapStreamWithFpTrailer(flight, _captureCommitHandle(), {
                    incremental: false,
                    flushScopeId: id,
                    onUpdates: (updates) => {
                      Object.assign(heals, updates)
                    },
                  })
                  const reader = wrapped.getReader()
                  try {
                    while (true) {
                      const { done, value } = await reader.read()
                      if (done) return "drained" as const
                      if (bodyProbe.live()) {
                        await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                        return "producer" as const
                      }
                      if (tearingLanesForNav || runtime.cancelled || demand?.cancelled === true) {
                        await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                        return "torn" as const
                      }
                      if (value && value.byteLength > 0) chunks.push(value)
                    }
                  } finally {
                    reader.releaseLock()
                  }
                },
              ),
            )
          } catch {
            claim.abandon()
            return failed
          }
          if (ended === "producer") {
            // The body declared itself a PRODUCER mid-stream — it holds
            // its lane open until an unbounded await resolves, which a
            // buffered slot can never model. Remember the id so the
            // probe render never repeats; every connection renders its
            // own producer lane, exactly as today.
            const bKey = subscription.broadcastRoute?.key
            if (bKey !== undefined) _broadcastMarkProducer(bKey, id)
          }
          if (ended !== "drained") {
            claim.abandon()
            return failed
          }
          // Reading to done ran the wrap's flush: the render's snapshot
          // registrations are committed (the eager canonical publish)
          // and the heals are final. The generation is the recomputed
          // warm fp — the SAME value every consumer recomputes.
          const resultSnap = _readSnapshotsForRoute(scope, routeKey).get(id) ?? null
          const gen = _recomputeSubtreeWarmFp(scope, routeKey, id, request)
          const boundary = resultSnap ? effectiveExpiresAt(resultSnap) : undefined
          const expiresAt = Math.min(
            boundary !== undefined && Number.isFinite(boundary) ? boundary : Infinity,
            Date.now() + _broadcastSlotTtlMs(),
          )
          const result: BroadcastResult = {
            ok: resultSnap !== null && gen !== null,
            chunks,
            heals,
            resultSnap,
            gen,
            expiresAt,
          }
          claim.publish(result)
          return result
        }

        // `null` = no slot path for this lane — render your own body
        // (the normal iteration below). Every `null` is the over-render
        // direction: broadcast can only skip work, never substitute
        // bytes a per-connection verdict wouldn't have produced.
        const runBroadcastIteration = async (): Promise<"drained" | "torn" | "closed" | null> => {
          const bRoute = subscription.broadcastRoute
          if (bRoute === null || session === null) return null
          // Single-viewer routes take the ordinary per-connection render
          // untouched — byte-identical wire, no buffering. Broadcast
          // only engages where a second viewer exists to save a render.
          if (!_broadcastRouteShared(bRoute.key)) return null
          const all = _readSnapshotsForRoute(scope, routeKey)
          // The looked-up snapshot must BE the canonical one (not a
          // pending per-request overlay), or the generation recompute
          // below would describe a different object.
          if (all.get(id) !== snap) return null
          if (!_broadcastEligible(id, all, _readRouteDescendants(scope, routeKey))) return null
          // The generation: the fp a fresh render would emit right now
          // (dep values re-read, live invalidation ts, descendant fold).
          // Equal generations ⇒ equal bytes — fp-skip's own soundness
          // contract; a newer bump moves it, so an older slot can never
          // be served past a newer bump.
          const gen = _recomputeSubtreeWarmFp(scope, routeKey, id, request)
          if (gen === null) return null
          // The per-connection fp-SKIP decision, untouched and in its
          // usual place — BEFORE any body work: a connection whose
          // mirror holds the generation (and whose snapshot is inside
          // its declared freshness) takes the normal render, whose own
          // verdict ships the skip placeholder, never the body.
          const mirrorHolds =
            (laneOverride?.fingerprints.get(id)?.has(gen) ?? false) ||
            (session.ackedFps.get(id)?.has(gen) ?? false)
          const claimBoundary = effectiveExpiresAt(snap)
          const claimExpired = claimBoundary !== undefined && claimBoundary <= Date.now()
          if (mirrorHolds && !claimExpired) return null
          // Variant siblings are a per-connection emission: a mirror
          // holding OTHER matchKeys for any id in the subtree needs its
          // own render (the shared body carries no hidden Activity
          // siblings for this connection's parked variants).
          if (laneOverride !== null && subtreeHasForeignVariant(id, all, laneOverride)) return null
          const claim = _claimBroadcastSlot(bRoute.key, id, snap, gen, Date.now())
          if (claim === null) return null
          const res =
            claim.role === "publish" ? await publishBroadcastBody(claim) : await claim.result
          if (!res.ok) return null
          if (closed || tearingLanesForNav || runtime.cancelled) return "torn"
          // Consume-time validation — over-render, never wrong bytes:
          // the published snapshot must still be canonical, THIS
          // connection's recompute must equal the published generation,
          // and the body must be inside its declared freshness.
          if (res.resultSnap === null) return null
          if (_readSnapshotsForRoute(scope, routeKey).get(id) !== res.resultSnap) return null
          if (Date.now() >= res.expiresAt) return null
          if (_recomputeSubtreeWarmFp(scope, routeKey, id, request) !== res.gen) return null
          for (const bytes of res.chunks) {
            if (!(await awaitDemand(runtime)) || tearingLanesForNav || runtime.cancelled) {
              return runtime.cancelled || tearingLanesForNav ? "torn" : "closed"
            }
            if (!enqueue(muxFrame(id, bytes))) return "closed"
            wroteBytes = true
          }
          // The publisher's flush heals ride the shared result — folded
          // into THIS connection's mirror below exactly as its own
          // render's `onUpdates` would be.
          Object.assign(laneHeals, res.heals)
          return "drained"
        }

        const runIteration = async (): Promise<"drained" | "torn" | "closed"> => {
          const flight = renderToReadableStream(partialFromSnapshot(id, snap))
          // A lane is a single parton's render — its flush already fires
          // at that parton's completion, and lanes run concurrently (the
          // one-sink-per-request settle slot doesn't model that), so
          // settle-time emission is off here.
          const wrapped = wrapStreamWithFpTrailer(flight, _captureCommitHandle(), {
            incremental: false,
            // A lane's trailer heals only its own subtree — see
            // `flushScopeId`. Without the scope, every lane frame on a
            // many-parton route re-computes and re-ships the standing
            // drift of every route snapshot: O(route) hashing per
            // frame, and the same multi-KB fp payload duplicated onto
            // every frame of the stream.
            flushScopeId: id,
            // Stash this lane's warm heals; they fold into the mirror
            // (and this delivery's holdings) AFTER the drain promote
            // below, so each `to` joins the slot the promote just
            // established for its `from`. Folding here — before the
            // slot exists — would land `to` slotless, un-evictable by
            // a later sibling variant (the return-toggle stale-body
            // class). The fold still lands before the next lane's skip
            // check, so it tracks the same drift the client heals.
            onUpdates: (updates) => {
              Object.assign(laneHeals, updates)
            },
          })
          const reader = wrapped.getReader()
          // The navigation tear's / cancel's reach into a read parked on
          // a suspended render — cancelling settles the pending read so
          // the pump can observe the tear and wind down.
          runtime.abortRead = () => void reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (tearingLanesForNav || runtime.cancelled) {
                await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                return "torn"
              }
              if (value && value.byteLength > 0) {
                // Pull-gated: park before the enqueue while the consumer's
                // queue is full. Not reading the NEXT chunk until then
                // propagates the wait into the lane's Flight stream, so a
                // stalled reader holds at most one frame per lane
                // server-side instead of every wake's full payload.
                if (bufferUntilDrain) {
                  bufferedFrames.push(muxFrame(id, value))
                } else {
                  if (!(await awaitDemand(runtime)) || tearingLanesForNav || runtime.cancelled) {
                    await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                    return runtime.cancelled || tearingLanesForNav ? "torn" : "closed"
                  }
                  if (!enqueue(muxFrame(id, value))) {
                    await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                    return "closed"
                  }
                }
                wroteBytes = true
              }
              // Producer announcement — checked at every pump step so
              // the mark lands on the wire before the render's producer
              // await stalls the body.
              if (!(await maybeAnnounceProducer())) {
                await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
                return "closed"
              }
            }
          } finally {
            runtime.abortRead = null
            reader.releaseLock()
          }
          if (tearingLanesForNav || runtime.cancelled) return "torn"
          return "drained"
        }
        let outcome: "drained" | "torn" | "closed" | null = null
        // Forced lanes (explicit refetch targets, frame-nav covering
        // lanes) always render EXPLICIT — the refetch contract; only
        // plain deliveries (bumps, expiry, freed window) may broadcast.
        if (session !== null && !runtime.forced && navSeq === undefined) {
          outcome = await runBroadcastIteration()
        }
        if (outcome === null) {
          try {
            outcome = await probe.run(runIteration)
          } catch {
            // A cancelled suspended render can reject its reader instead
            // of resolving it done — same wind-down as an observed tear
            // (the assigned-seq void below must still run).
            outcome = "torn"
          }
        }
        if (outcome !== "drained") {
          // Torn. A CANCELLED iteration on a CONTINUING region closes
          // its open client body with a `muxend` — the decode settles
          // (a producer body's progressive commit keeps its fallback
          // until the covering render replaces it) and the same id can
          // reopen for the superseding statement's lane. A navigation
          // tear writes nothing: the region exit is what rejects (or,
          // for producer bodies, cleanly closes) those bodies. Either
          // way an assigned-but-unannounced consequence seq is voided —
          // the client's watermark must be able to pass it.
          if (runtime.cancelled && !tearingLanesForNav && wroteBytes && !closed) {
            enqueue(muxEndFrame(id))
          }
          if (assignedSeq !== null && announcedSeq === null) {
            session?.voidSeqs.add(assignedSeq)
          }
          return
        }
        if (!(await awaitDemand(runtime))) {
          if (runtime.cancelled && wroteBytes && !closed) {
            enqueue(muxEndFrame(id))
          }
          if (assignedSeq !== null && announcedSeq === null) {
            session?.voidSeqs.add(assignedSeq)
          }
          return
        }
        if (!(await flushBufferedFrames())) {
          if (assignedSeq !== null && announcedSeq === null) {
            session?.voidSeqs.add(assignedSeq)
          }
          return
        }
        // The delivery announcement precedes the `muxend` on the wire,
        // so the client's per-parton seq queue holds it before the lane
        // body closes — its decode, then commit, then ack all follow. A
        // producer lane announced at flag time (`muxlive`); its muxend
        // at producer resolve is the body's only remaining frame.
        let deliverySeq: number | null = announcedSeq
        if (session !== null && deliverySeq === null) {
          deliverySeq = assignedSeq ?? ++session.deliverySeq
          if (!enqueue(laneDeliverySeqEntry(id, deliverySeq, session.consumedNavSeq, navSeq)))
            return
        }
        if (!enqueue(muxEndFrame(id))) return
        // The delivery is fully on the wire — the connection's first
        // settled delivery anchors the never-acked degrade deadline.
        if (session !== null) session.firstDeliverySettledAt ??= Date.now()
        // The lane's snapshots just committed (the per-lane fp-trailer
        // wrap commits at flush). Promote the fresh emittedFps into the
        // request's cached override so this parton's next lane render —
        // and every other lane's descendants — fp-skip against them.
        // Scoped to the lane's subtree: only those snapshots are fresh
        // from this render; walking the whole route map per drain is
        // O(route) churn for entries the drain didn't touch. The same
        // walk records the delivery's holdings — one pass, no second
        // walk per drain. The parked check reads the iteration's PINNED
        // set: whether the render shipped a body is a render-time fact,
        // and a flip landing between render and drain must not move the
        // claim (the flip's own resolution covers the delta). The walk
        // reads snapshots through the render's OWN registrations: this
        // delivery carried THIS render's bytes, so its claims — and the
        // record a later drop report would revoke — must name this
        // body's fps, not a rival same-drain registration's (F7).
        promoteSnapshotsToCachedOverride(
          id,
          (tid, mk, fp) => carried.push([tid, mk, fp]),
          session,
          pinnedVisible,
          renderRegistrations,
        )
        // The flush's warm heals fold in NOW, after the slots exist: the
        // `to` fp joins the slot holding its `from` (dropping when the
        // slot fp-skipped away), then rides this delivery's holdings so
        // the acked layer folds it under the same matchKey.
        promoteFpUpdatesToCachedOverride(laneHeals, (tid, mk, fp) => carried.push([tid, mk, fp]))
        if (session !== null && deliverySeq !== null) {
          _recordDelivery(session, deliverySeq, carried, session.consumedNavSeq)
        }
        // The force is satisfied — its content drained.
        runtime.forced = false
        if (!runtime.dirty) return
      }
    } finally {
      lanes.delete(id)
      openLaneIds.delete(id)
      // No quiesce marker while tearing for a navigation: the torn
      // lanes' client bodies are still open (deliberately — the region
      // exit is what rejects them), so "every lane drained" would be a
      // false statement; the navigation segment's own `settled` follows.
      if (!closed && !tearingLanesForNav && lanes.size === 0) enqueue(settledMarker)
      noteLaneDrained()
    }
  }

  // In-flips whose ids had no route snapshot when their report arrived
  // — a report racing the render that first materializes its parton (a
  // chunk reported in-view while its bigChunk's flip-in lane is still
  // streaming). Deferred, never dropped: the client reports each flip
  // exactly once (the IntersectionObserver only fires on change), so a
  // dropped flip would leave that parton stale until the next
  // whole-tree reconciliation. Re-checked against fresh snapshots on
  // every subsequent wake — the materializing lane's own drain is a
  // wake — and resolved ids lane like any other flip. Each entry keeps
  // its statement's seq, so only a NEWER statement about the id can
  // supersede it (an explicit out-flip cancels the wait; a fresh
  // in-flip re-arms it with fresh cached tokens). Ids that never
  // materialize linger harmlessly until the connection closes.
  const deferredFlips = new Map<string, number>()

  // Keepalive anchored at the last USEFUL activity (a lane started, a
  // flip processed) — not re-armed per wake. Bump wakes whose touched
  // set comes up empty (all matches parked) loop without shipping a
  // byte, and a torn connection is only detectable at enqueue time —
  // re-arming per wake would let steady bump traffic hold a fully-
  // parked, possibly torn connection open FOREVER, each wake
  // re-scanning the route (the zombie-connection leak: every refresh
  // tears one, they accumulate, the server pegs). A healthy client's
  // connection closing idle is the normal contract — the heartbeat's
  // next tick reopens it.
  let idleDeadline = Date.now() + KEEPALIVE_MS

  let since = sinceTs

  // Region delimiters for the whole-tree reconcile below — the lanes
  // region ends with `next`, the payload segment flows, and `next` +
  // `lanes` reopens the region. Same bytes every time.
  const nextMarker = buildMarker(TAG_NEXT_SEGMENT, 0)
  const lanesMarker = buildMarker(TAG_LANES_OPEN, 0)

  // Ids whose lane opening the unacked delivery window deferred. The
  // dirty-on-drain shape generalized: while the window is exceeded,
  // touched ids coalesce here instead of opening lanes, and when an
  // ack frees the window they render their LATEST state. An ack
  // landing while the driver is busy needs no arm of its own — the
  // wait-entry check below re-reads the session's watermark against
  // this set (the latch), and an ack landing while parked fires the
  // session's flip wakes (a disposer-registered listener set, never a
  // long-lived promise reaction).
  const windowDirty = new Set<string>()
  const deliveryWindowExceeded = (): boolean =>
    session !== null && session.deliverySeq - session.ackedDeliverySeq >= UNACKED_DELIVERY_WINDOW

  // ── Predictive warming at park ──
  // One projection per telemetry statement: the statement is the
  // signal, so its envelope seq is the dedup key — re-parking on the
  // same statement re-projects nothing (same statement, same
  // projection), and a fresh statement is a fresh pass.
  let warmedTelemetrySeq = -1

  // Render the parked partons the viewport is projected to reach into
  // the server byte-cache, so their flip-in lanes replay warm bytes
  // instead of running cold bodies. Speculation with hard edges:
  //
  //   - runs only at the park point (the driver has nothing real to
  //     do) and NEVER extends the keepalive — warming is not
  //     client-evidenced activity;
  //   - skipped entirely while the unacked delivery window is
  //     exceeded: a client that isn't committing what the kernel
  //     already swallowed gets no speculative CPU spent on it;
  //   - bounded at MAX_WARM_PER_PARK renders (rationale at the
  //     constant) and preempted by any real statement landing
  //     mid-pass — flips outrank speculation;
  //   - byte-silent by construction: each render runs inside a nested
  //     warm scope (`_runWithWarmRenderScope`) that presents the
  //     target id as visible WITHOUT touching the connection's real
  //     session, carries no cached override (the client mirror stays
  //     untouched), and drains into the void — no controller, no
  //     delivery seq, no promote. The only durable effects are the
  //     byte-cache entry and the parton's re-registered content
  //     snapshot (truthful for every registry consumer; the next
  //     covering render re-registers the culled state) — stamped
  //     `warmed` so the client-mirror promote never claims its fp as
  //     a holding (see `PartialSnapshot.warmed`).
  //
  // The projection itself — geometry, horizon, velocity judgment — is
  // the app's (`registerWarmProjector`): only the app knows how a
  // scroll vector maps onto its partons' coordinates.
  // True while the session holds a telemetry statement the pass has
  // not consumed AND the gates that would let a pass run are open —
  // the warm pass's LATCH: a telemetry envelope's wake can fire while
  // the driver is busy (no armed listener to hear it), so the
  // wait-entry check below consumes the statement off the session
  // exactly like pendingFlips consumes a busy-window flip.
  const pendingWarmStatement = (): boolean =>
    session !== null &&
    session.telemetry !== null &&
    session.telemetry.seq !== warmedTelemetrySeq &&
    !deliveryWindowExceeded() &&
    _getWarmProjector() !== null

  // The preload-warm latch: a `warm` frame's stated target awaits its
  // park-point render. Same window discipline as the telemetry pass —
  // a window-skip keeps the slot, so the freeing ack's wake warms the
  // same statement; the consume below nulls it, so the latch can never
  // spin the wait-entry loop.
  const pendingPreloadWarm = (): boolean =>
    session !== null && session.pendingWarmUrl !== null && !deliveryWindowExceeded()

  // ONE byte-silent whole-tree render of the stated target — explicit
  // intent needs no projector: the route is named directly. The render
  // runs inside a nested request scope for the target URL
  // (`_runWithWarmRequestScope`) and drains into the void; the durable
  // effects are the caches it fills (`<Cache>` byte-cache entries,
  // loader caches) and the target route's registered snapshots — the
  // navigation statement that follows renders warm.
  const warmPreloadTarget = async (): Promise<void> => {
    if (session === null) return
    const warm = session.pendingWarmUrl
    if (warm === null || deliveryWindowExceeded()) return
    session.pendingWarmUrl = null
    try {
      await _runWithWarmRequestScope(warm.url, async () => {
        const reader = renderFullSegment().getReader()
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } finally {
          reader.releaseLock()
        }
      })
    } catch {
      // Speculative by definition: a failed warm render costs
      // nothing — the navigation renders cold, exactly as if the
      // statement never arrived.
    }
  }

  const warmProjectedPartons = async (): Promise<void> => {
    if (session === null) return
    const telemetry = session.telemetry
    if (telemetry === null || telemetry.seq === warmedTelemetrySeq) return
    // A window-skip deliberately records nothing: the freeing ack's
    // wake re-reaches this pass and the SAME statement projects then.
    if (deliveryWindowExceeded()) return
    const projector = _getWarmProjector()
    if (projector === null) return
    // The statement is consumed from here — projected, or judged not
    // projectable — so the latch above goes false in every path and
    // the wait-entry loop can never spin on one statement.
    warmedTelemetrySeq = telemetry.seq
    const snapshots = _readSnapshotsForRoute(scope, routeKey)
    if (snapshots.size === 0) return
    const candidates: WarmCandidate[] = []
    for (const [id, snap] of snapshots) {
      if (!isParkedOnConnection(id, snapshots, session)) continue
      candidates.push({ id, type: snap.type, props: snap.props })
    }
    if (candidates.length === 0) return
    const ids = projector(telemetry, candidates).slice(0, MAX_WARM_PER_PARK)
    for (const id of ids) {
      // Real statements outrank speculation: a flip landing mid-pass
      // ends it (the remaining projections were racing that flip
      // anyway), and a closing/detaching connection warms nothing.
      if (closed || session.detached || session.pendingFlips.size > 0) return
      const snap = snapshots.get(id)
      if (!snap) continue
      if (!isParkedOnConnection(id, snapshots, session)) continue
      const warmVisible = new Set(session.visible ?? [])
      warmVisible.add(id)
      try {
        await _runWithWarmRenderScope(warmVisible, async () => {
          // Fresh empty partial state: a warm render must never
          // fp-skip (a skipped body stores nothing) and must never
          // consult or mutate the connection's mirror layers.
          enterPartialState({
            requestedIds: null,
            isPartialRefetch: true,
            cachedFingerprints: new Map(),
            cachedMatchKeys: new Map(),
            ackedFingerprints: null,
            explicitIds: new Set(),
            seenIds: new Set(),
          })
          const reader = renderToReadableStream(partialFromSnapshot(id, snap)).getReader()
          try {
            while (true) {
              const { done } = await reader.read()
              if (done) break
            }
          } finally {
            reader.releaseLock()
          }
        })
      } catch {
        // Speculative by definition: a failed warm render costs
        // nothing — the flip-in lane renders cold, exactly as if the
        // pass never ran.
      }
    }
  }

  // Whole-tree reconcile anchor — the last full segment this
  // connection saw (its initial segment, an honored catch-up anchor's
  // document, or the previous reconcile). Evaluated at wakes; an idle
  // connection never reaches the cadence (the keepalive closes it
  // first) and its reopen's first segment is whole-tree anyway.
  let lastFullSegmentAt = Date.now()

  // Ship the cumulative upstream-applied watermark when it has moved —
  // the marker that prunes the client transport's retransmit buffer.
  // Every envelope apply fires the flip wakes, so the announcement
  // rides the very next wake's bytes.
  const announceUpstreamApplied = (): void => {
    if (session === null) return
    if (session.appliedSeq <= session.announcedAppliedSeq) return
    session.announcedAppliedSeq = session.appliedSeq
    enqueue(upstreamAppliedEntry(session.appliedSeq))
  }

  // The scheduled whole-tree reconcile: end the lanes region, flow one
  // full payload segment (rendered by the same renderer the segment
  // loop uses — fp-skip prunes it to placeholders when nothing was
  // missed), and reopen the lanes region. Only at quiesce (no open
  // lanes: a `next` delimiter would tear them client-side) and only
  // with room in the delivery window (the segment IS a delivery).
  //
  // The whole pass — render, trailer flush, drain promote — runs under
  // a PINNED visibility moment captured at render start
  // (`_runWithPinnedVisible`), the same discipline as a lane iteration:
  // a `visible` statement landing while the segment streams must not
  // retag emitted fps with a state the rows do not carry (the segment
  // member of fuzz class F6 — the statement's own flip resolution
  // covers the delta).
  const emitReconcileSegment = (): Promise<boolean> => {
    const pinnedVisible = session !== null ? session.visible : null
    return _runWithPinnedVisible(pinnedVisible, async () => {
      if (!enqueue(nextMarker)) return false
      let deliverySeq: number | null = null
      if (session !== null) {
        deliverySeq = ++session.deliverySeq
        if (!enqueue(segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq))) return false
      }
      const reader = renderFullSegment().getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            if (!(await awaitDemand())) {
              await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
              return false
            }
            if (!enqueue(value)) {
              await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
              return false
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      if (!(await awaitDemand())) return false
      if (!enqueue(settledMarker)) return false
      if (session !== null) session.firstDeliverySettledAt ??= Date.now()
      const tokens: Array<readonly [string, string, string]> = []
      promoteSnapshotsToCachedOverride(
        undefined,
        (id, mk, fp) => tokens.push([id, mk, fp]),
        session,
        pinnedVisible,
      )
      if (session !== null && deliverySeq !== null) {
        _recordDelivery(session, deliverySeq, tokens, session.consumedNavSeq)
      }
      if (!enqueue(nextMarker)) return false
      return enqueue(lanesMarker)
    })
  }

  // ── Navigation segments ──
  // A consumed url frame answers with one full payload segment for the
  // new request state, in stream order: `next` ends the lanes region
  // (open lanes torn first — see tearLanesForNavigation), the segment
  // flows with its delivery seq + as-of, `settled`, then `next` +
  // `lanes` reopens the region (the caller writes the reopen after the
  // LAST chained navigation). fp-skip applies as on any segment — a
  // navigation to a mostly-mirrored route ships placeholders.
  //
  // Mid-render supersede — the internal seam W5b's explicit cancel
  // frame reuses: a NEWER url frame latching while this segment
  // renders makes the render moot (the client's as-of guard will drop
  // the delivery), so the emitter aborts it — the read races a
  // nav-latch arm on the session's wake set (disposer-registered, one
  // per emission — the wake-arm release invariant), the reader is
  // cancelled (aborting the Flight render), and the caller consumes
  // the newer statement. Non-streaming navs buffer their Flight bytes
  // until drain, so a superseded delivery has only its early seq entry
  // on the wire; the next `next` delimiter closes an empty, stale
  // segment and the client consumes its processed-drop ack without
  // handing React a partial payload.
  // Runs under a PINNED visibility moment (`_runWithPinnedVisible`,
  // captured per attempt at render start) — the same discipline as a
  // lane iteration and the reconcile: a `visible` statement landing
  // while the navigation segment streams must not retag its emitted
  // fps with a state the rows do not carry (fuzz class F6's segment
  // member; the statement's own flip resolution covers the delta).
  const emitNavSegment = (): Promise<"done" | "superseded" | "closed"> => {
    const pinnedVisible = session !== null ? session.visible : null
    return _runWithPinnedVisible(pinnedVisible, () => emitNavSegmentPinned(pinnedVisible))
  }
  const emitNavSegmentPinned = async (
    pinnedVisible: ReadonlySet<string> | null,
  ): Promise<"done" | "superseded" | "closed"> => {
    if (!enqueue(nextMarker)) return "closed"
    let deliverySeq: number | null = null
    if (session !== null) {
      deliverySeq = ++session.deliverySeq
      if (!enqueue(segmentDeliverySeqEntry(deliverySeq, session.consumedNavSeq))) return "closed"
    }
    const consumedSeq = session?.consumedNavSeq ?? 0
    const bufferUntilDrain = session !== null && session.consumedNavStreaming !== true
    const bufferedSegment: Uint8Array[] = []
    const flushBufferedSegment = async (): Promise<boolean> => {
      if (!bufferUntilDrain || bufferedSegment.length === 0) return true
      for (const chunk of bufferedSegment) {
        if (!(await awaitDemand())) return false
        if (!enqueue(chunk)) return false
      }
      bufferedSegment.length = 0
      return true
    }
    const supersededBy = (): boolean => {
      if (session === null || session.pendingNav === null) return false
      if (session.pendingNav.seq <= consumedSeq) return false
      // A STREAMING nav has already committed a root-ready shell on the
      // client — its Suspense fallbacks are showing and its boundaries
      // resolve as the body streams. A pending statement to the SAME
      // effective URL is a REFETCH of the page being loaded (a defer /
      // on-mount activation firing off that fresh shell, a selector
      // force), not a navigation away. Aborting the in-flight stream for
      // it would close the client's committed shell with its Suspense
      // refs still pending, rejecting them ("Connection closed.") and
      // tearing the just-revealed partons. Let the stream DRAIN so its
      // boundaries commit progressively; the refetch's forces apply once
      // it consumes next. A DIFFERENT effective URL is a genuine
      // navigation-away and still supersedes (serve the new page fast).
      // Atomic navs never reach here with this carve-out — they buffer,
      // so a superseded atomic nav has no committed shell to tear.
      if (
        session.consumedNavStreaming === true &&
        sameEffectiveNavUrl(session.pendingNav.url, request.url)
      ) {
        return false
      }
      return true
    }
    const reader = renderFullSegment().getReader()
    let navArm: (() => void) | null = null
    const disposeArm = (): void => {
      if (session !== null && navArm !== null) session.flipWakes.delete(navArm)
      navArm = null
    }
    try {
      while (true) {
        if (supersededBy()) {
          await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
          return "superseded"
        }
        // Race the read against a nav latch: a suspended render (a
        // slow loader on the destination route) produces no bytes, so
        // without the arm a superseding url frame couldn't preempt
        // until the loader resolved.
        let notify: (() => void) | null = null
        const latched = new Promise<"nav">((resolve) => {
          notify = () => resolve("nav")
        })
        navArm = () => {
          if (supersededBy()) notify?.()
        }
        if (session !== null) session.flipWakes.add(navArm)
        const winner = await Promise.race([
          reader.read().then((r) => ({ kind: "read" as const, r })),
          latched.then(() => ({ kind: "nav" as const })),
        ])
        disposeArm()
        if (winner.kind === "nav") {
          await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
          return "superseded"
        }
        const { done, value } = winner.r
        if (done) break
        if (value && value.byteLength > 0) {
          if (bufferUntilDrain) {
            bufferedSegment.push(value)
          } else {
            if (!(await awaitDemand())) {
              await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
              return "closed"
            }
            if (!enqueue(value)) {
              await reader.cancel(DRIVER_CANCEL_REASON).catch(() => {})
              return "closed"
            }
          }
        }
      }
    } finally {
      disposeArm()
      reader.releaseLock()
    }
    if (supersededBy()) return "superseded"
    if (!(await flushBufferedSegment())) return "closed"
    if (!(await awaitDemand())) return "closed"
    if (!enqueue(settledMarker)) return "closed"
    if (session !== null) session.firstDeliverySettledAt ??= Date.now()
    const tokens: Array<readonly [string, string, string]> = []
    promoteSnapshotsToCachedOverride(
      undefined,
      (id, mk, fp) => tokens.push([id, mk, fp]),
      session,
      pinnedVisible,
    )
    if (session !== null && deliverySeq !== null) {
      _recordDelivery(session, deliverySeq, tokens, consumedSeq)
    }
    return "done"
  }

  // Consume every latched url frame (a chain when navigations
  // supersede mid-render) and land exactly one settled navigation
  // segment — the newest statement's. Applies each statement to the
  // connection's request state through the same seam a server-side
  // `getServerNavigation().navigate` uses (`setRequest` on the ALS
  // store), refreshes the route reads, and reopens the lanes region
  // after the final segment. The mirror SURVIVES the consume: the
  // client keeps its pre-navigation partons (parked), so the covering
  // segment fp-skips them — a phantom is evicted only when the client
  // explicitly reports the delivery dropped (`ack.dropped`). Returns
  // false when the connection closed under it.
  const handleNavigation = async (): Promise<boolean> => {
    if (session === null) return true
    // Explicit forces whose lanes this consume tears were never
    // satisfied — they re-lane after the reopen alongside the new
    // statement's own forces.
    const unfulfilledForces = [...lanes.entries()].filter(([, rt]) => rt.forced).map(([id]) => id)
    await tearLanesForNavigation()
    // The route is left behind: consequence seqs assigned for its
    // lanes can never emit (their client commits would be
    // as-of-dropped anyway) — void them so the watermark passes; the
    // same for frame-nav correlation flags whose covering lanes died
    // with the tear.
    for (const [, seq] of session.assignedLaneSeqs) session.voidSeqs.add(seq)
    session.assignedLaneSeqs.clear()
    laneNavSeqs.clear()
    // The union of the consumed statements' `__force` selectors — the
    // targets that lane after the region reopens. Superseded
    // statements' URLS are moot (the covering statement's stands),
    // but their FORCES are not: a silent restatement with a disjoint
    // target must not lose the earlier statement's refetch.
    // Resolve `__force` selectors (+ torn unfulfilled forces) to the
    // ids they hit on the current route: id match first, then label
    // fan-out — the same narrowing the reopened forced lanes take.
    const resolveForcedIds = (
      labels: ReadonlySet<string>,
      extra: readonly string[],
    ): Set<string> => {
      const snapshots = _readSnapshotsForRoute(scope, routeKey)
      const wanted = [...labels]
      const ids = new Set<string>()
      for (const id of extra) if (snapshots.has(id)) ids.add(id)
      for (const name of wanted) if (snapshots.has(name)) ids.add(name)
      for (const [id, snap] of snapshots) {
        if (ids.has(id)) continue
        if (snap.labels.some((l) => wanted.includes(l))) ids.add(id)
      }
      return ids
    }
    const forceLabels = new Set<string>()
    // Coverage anchors for the covering segment — captured immediately
    // BEFORE each render begins (the segment-0 `lastTs` discipline):
    // Flight renders lazily, so a write committing mid-stream after
    // its reader's row already rendered is NOT in the segment. Only
    // what was on the timeline / in the pending set when the render
    // started is provably covered; anything landing during the render
    // stays pending and lanes after the reopen (if the segment did
    // carry a late row, that lane fp-skips to a confirmation —
    // over-delivery, never stale). A superseded chain re-captures per
    // attempt; the last completed render's anchors stand.
    let coverTs = _currentTs()
    let coveredPending: string[] = []
    try {
      while (true) {
        const nav = takeConnectionNavigation(session)
        if (nav === null) break
        const current = new URL(request.url)
        const target = new URL(nav.url, current.origin)
        // `__force` is the statement's one-shot overlay, never part of
        // the request state: forced targets render as LANES below —
        // isolated snapshot renders, the same path a discrete
        // `?partials=` refetch takes. The whole-tree segment fp-skips
        // them (and their subtrees) via the fold exclusion below, so a
        // forced target's ancestor can answer with a placeholder while
        // the forced lane re-renders it fresh.
        for (const label of (target.searchParams.get("__force") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)) {
          forceLabels.add(label)
        }
        target.searchParams.delete("__force")
        setRequest(new Request(target, { headers: request.headers }))
        request = getRequest()
        routeKey = computeRouteKey(request.url)
        session.routeKey = routeKey
        session.consumedNavSeq = nav.seq
        session.consumedNavStreaming = nav.streaming === true
        // Exclude the forced targets (and their subtrees) from every
        // ancestor's descendant fold on THIS segment render: the force
        // re-lanes them independently, so their change must not move an
        // ancestor's fp — the ancestor fp-skips, the forced lane covers
        // the change (parent-valid, child-invalid).
        if (forceLabels.size > 0 || unfulfilledForces.length > 0) {
          _setFoldExclusionIds(resolveForcedIds(forceLabels, unfulfilledForces))
        }
        coverTs = _currentTs()
        coveredPending = [...subscription.sub.pending]
        const outcome = await emitNavSegment()
        if (outcome === "closed") return false
        if (outcome === "superseded") continue
      }
    } finally {
      // A later invalidation lane or reconcile on this connection folds
      // in full — the exclusion is one nav segment's concern only.
      _setFoldExclusionIds(null)
    }
    lastFullSegmentAt = Date.now()
    // The navigation segment was a whole-tree render of the new route
    // AS OF ITS RENDER START — the cursor advances to the pre-render
    // anchor and only the deliveries pending at that point are marked
    // covered. A delivery that landed mid-render stays in the pending
    // set and lanes on the reopened region; the subscription
    // re-registers against the new route's snapshots before then.
    since = coverTs
    for (const id of coveredPending) subscription.sub.pending.delete(id)
    _syncRouteWakeSubscription(subscription, _readSnapshotsForRoute(scope, routeKey), since)
    // Follow the connection to its new URL's slot space (releases the
    // old key; the old route's slots drop with their last subscriber).
    subscription.broadcastRoute?.move(`${scope}|${effectiveNavUrl(request.url)}`)
    if (!enqueue(nextMarker)) return false
    if (!enqueue(lanesMarker)) return false
    // The statement's forced targets lane on the reopened region:
    // rendered EXPLICIT (`forcedLaneIds` — the lane state's
    // explicitIds), so fp-skip and the defer gate both yield: a
    // refetch target must re-render, never match-and-skip.
    // Torn-but-unfulfilled forces re-lane alongside (their id must
    // still snapshot on the new route — a real route change
    // legitimately drops them).
    if (forceLabels.size > 0 || unfulfilledForces.length > 0) {
      const ids = resolveForcedIds(forceLabels, unfulfilledForces)
      if (ids.size > 0) {
        enterRequestRegistry(routeKey, "cache")
        for (const id of ids) {
          forcedLaneIds.add(id)
          startLane(id)
        }
      }
    }
    return true
  }

  // ── Frame navigation ──
  // Consume every latched FRAME url statement. The session frame URL
  // was written at the endpoint (the same store `?__frame=` writes
  // through); the driver's half is the RENDER: resolve the frame's
  // targets by its top-level name (id first, then label fan-out — the
  // same narrowing the discrete twin's `?partials=<frame[0]>` takes)
  // and lane them EXPLICIT on the OPEN region, each stamped with the
  // statement's seq (`nav=<n>` on its delivery announcement — the
  // client's milestone correlation). Frame content is a subtree, never
  // the whole route, so no region tear: window partons' lanes are
  // untouched — this is exactly the scoping the frame long-poll had.
  // A statement whose targets resolve to NOTHING (the frame never
  // rendered on this route) falls back to one whole-tree segment via
  // the reconcile machinery — its as-of covers the statement, so the
  // client's milestones resolve off the segment instead of a lane.
  const handleFrameNavs = async (): Promise<boolean> => {
    if (session === null) return true
    const navs = takeConnectionFrameNavs(session)
    if (navs.size === 0) return true
    // Identity refresh: a frame statement on an ANONYMOUS page mints
    // the session id at the endpoint (and rebinds the connection to
    // it), but this held request predates the mint — its renders
    // would read no session and miss the frame URL the endpoint just
    // wrote. Re-present the BOUND identity (the endpoint's checks
    // proved this client holds it) on the connection's request state.
    if (session.boundSessionId !== "" && getSessionId() !== session.boundSessionId) {
      const headers = new Headers(request.headers)
      const cookie = headers.get("cookie")
      const sid = `${SESSION_COOKIE}=${session.boundSessionId}`
      headers.set("cookie", cookie ? `${cookie}; ${sid}` : sid)
      setRequest(new Request(request.url, { headers }))
      request = getRequest()
    }
    const spawn: Array<{ id: string; navSeq: number }> = []
    let uncovered = false
    const snapshots = _readSnapshotsForRoute(scope, routeKey)
    for (const [key, nav] of navs) {
      session.consumedFrameNavSeqs.set(
        key,
        Math.max(session.consumedFrameNavSeqs.get(key) ?? 0, nav.seq),
      )
      // The as-of every subsequent emission carries — "the last url
      // statement the request state reflects" spans both scopes; a
      // frame consume advances it so covering renders are provably
      // post-consume. Window drop semantics are unaffected: the
      // client's navigation point only ever moves on WINDOW
      // statements, and the guard is `asOf >= navPoint`.
      session.consumedNavSeq = Math.max(session.consumedNavSeq, nav.seq)
      const top = key.split(".")[0]
      const ids = new Set<string>()
      if (snapshots.has(top)) ids.add(top)
      for (const [id, snap] of snapshots) {
        if (ids.has(id)) continue
        if (snap.labels.includes(top)) ids.add(id)
      }
      if (ids.size === 0) {
        uncovered = true
        continue
      }
      for (const id of ids) spawn.push({ id, navSeq: nav.seq })
    }
    // The uncovered fallback needs region delimiters (a whole-tree
    // segment cannot interleave with open lanes), so it runs FIRST —
    // before this statement's own lanes open.
    if (uncovered) {
      await tearLanesForNavigation()
      // Coverage anchors BEFORE the render begins (the cursor
      // discipline — see handleNavigation): a delivery landing while
      // the segment streams is not provably in it and stays pending.
      const coverTs = _currentTs()
      const coveredPending = [...subscription.sub.pending]
      if (!(await emitReconcileSegment())) return false
      lastFullSegmentAt = Date.now()
      since = coverTs
      for (const id of coveredPending) subscription.sub.pending.delete(id)
      _syncRouteWakeSubscription(subscription, _readSnapshotsForRoute(scope, routeKey), since)
    }
    if (spawn.length > 0) {
      enterRequestRegistry(routeKey, "cache")
      for (const { id, navSeq } of spawn) {
        const open = lanes.get(id)
        // A cancelled predecessor (the superseding statement's own
        // cancel, applied in the same envelope) is winding down — wait
        // it out so the covering lane opens a fresh body instead of
        // piggybacking a dirty flag on a pump that is exiting.
        if (open?.cancelled) {
          await open.done
        }
        forcedLaneIds.add(id)
        laneNavSeqs.set(id, navSeq)
        startLane(id)
      }
    }
    return true
  }

  // The cancel arm — registered for the drive's lifetime, disposed at
  // exit: a `cancel` statement's apply aborts its scope's open lane
  // renders synchronously (the same immediacy the window supersede
  // has through the nav-latch arm).
  const onCancelScope = (s: string): void => cancelScopeLanes(s)
  session?.cancelListeners.add(onCancelScope)

  // The attach statement's `__force` targets — a selector refetch that
  // fired pre-establishment and folded its overlay into the statement's
  // URL — lane EXPLICIT the moment the region opens, resolved against
  // the route's snapshots exactly like a consumed url statement's
  // (id first, then label fan-out). On the full path the whole-tree
  // initial segment has just rendered (fp-skip may have placeholdered
  // the targets — a whole-tree render cannot force a target whose
  // ancestor skips); on the catch-up path there was no segment at all.
  // Either way the forced lane is the covering render.
  {
    const force = attachForceSelector()
    if (force !== null && session !== null) {
      const snapshots = _readSnapshotsForRoute(scope, routeKey)
      const wanted = force
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const ids = new Set<string>()
      for (const name of wanted) {
        if (snapshots.has(name)) ids.add(name)
      }
      for (const [id, snap] of snapshots) {
        if (ids.has(id)) continue
        if (snap.labels.some((l) => wanted.includes(l))) ids.add(id)
      }
      if (ids.size > 0) {
        enterRequestRegistry(routeKey, "cache")
        for (const id of ids) {
          forcedLaneIds.add(id)
          startLane(id)
        }
      }
    }
  }

  // `session.detached` exits alongside `closed`: an explicit detach
  // frame fires the flip wakes, the parked wait returns, and the
  // condition winds the drive down — the stream closes now instead of
  // holding a goner for the keepalive window. A degraded session
  // (never-acked) exits the same way: the driver stops holding.
  while (!closed && session?.detached !== true && session?.degradedReason == null) {
    // The never-acked degrade deadline: armed only while the FIRST
    // ack is outstanding after the first delivery-seq'd emission
    // settled — the moment the client's ack obligation began (see
    // FIRST_ACK_DEADLINE_MS for why absence needs a deadline at all).
    const degradeAt =
      session !== null && !session.firstAckReceived && session.firstDeliverySettledAt !== null
        ? session.firstDeliverySettledAt + FIRST_ACK_DEADLINE_MS
        : null
    // A statement that landed while the driver was busy (rendering
    // lanes, or between the lanes hand-off and this loop) is already
    // queued on the session — consume it without parking on the wake
    // arms first; a drain that landed while busy is likewise latched,
    // and so is an ack that freed the delivery window (the windowDirty
    // entry check). Deferred flips deliberately do NOT short-circuit
    // the wait: they only re-resolve on a real wake, so an unknown id
    // can't busy-loop the driver.
    // Navigation FIRST: a latched url frame outranks every other
    // latch — the client already lives on the new URL, so old-route
    // work is moot. Flips queued for the old route then resolve
    // against the new routeKey and defer (no snapshot on the new
    // route) — harmless: deferred ids linger without arming a wake.
    const latchedWake = (): SegmentWake | null =>
      session !== null && session.pendingNav !== null
        ? "navigation"
        : session !== null && session.pendingFrameNavs.size > 0
          ? "frame-navigation"
          : session !== null && session.pendingFlips.size > 0
            ? "visibility"
            : session !== null && session.pendingCookieChanges.size > 0
              ? "cookie"
              : session !== null && session.pendingDropHeals.size > 0
                ? "drop-heal"
                : laneDrainedPending
                  ? "lane-drained"
                  : windowDirty.size > 0 && !deliveryWindowExceeded()
                    ? "window"
                    : null
    let wake: SegmentWake | null = latchedWake()
    while (wake === null && (pendingPreloadWarm() || pendingWarmStatement())) {
      // About to park with an unconsumed warm intent or telemetry
      // statement — the predictive warm point: no latched work, so
      // speculative renders crowd out nothing. Explicit intent
      // (a stated preload target) outranks scroll projection.
      // Statements that land while warming latch on the session; the
      // loop re-checks every latch, so a flip preempts further
      // passes and a fresh statement gets its own pass before the
      // park.
      if (pendingPreloadWarm()) await warmPreloadTarget()
      else await warmProjectedPartons()
      wake = latchedWake()
    }
    // The graceful wind-down's exit: an `atPark` detach (the transport
    // handover) closes the connection at its next FULL PARK — nothing
    // latched, no open lanes — so everything in flight was served and
    // the close tears nothing. Open lanes re-arm the check through the
    // lane-drained wake; latched statements get their covering renders
    // first (the loop below serves them and comes back here).
    if (wake === null && session !== null && session.windDownAtPark && lanes.size === 0) break
    if (wake === null) {
      // No await between the loop's final latch evaluations and the
      // wait's synchronous arm registration — an envelope can only
      // land at an await point, so no statement can slip between a
      // checked latch and an armed listener.
      wake = await waitForSegmentWake({
        laneDrained: {
          pending: () => laneDrainedPending,
          wakes: laneDrainedWakes,
        },
        // Time boundaries arrive through the same arm: the connection's
        // deadline wheel fires due `expires()` ids into the pending set
        // (park-gated like any delivery), so the bump arm IS the expiry
        // arm — no per-wake deadline derivation exists anymore.
        bump: {
          pending: () => subscription.sub.pending.size > 0,
          wakes: subscription.sub.wakes,
        },
        session,
        deadline: idleDeadline,
        degradeAt,
      })
    }
    if (wake === false) break
    if (wake === "degrade") {
      // The first delivery settled a full deadline ago and no ack —
      // no ack FRAME at all — ever arrived: the duplex is unproven
      // (a blocked `/__parton/*` POST path, a frozen downstream). A
      // half-working channel must degrade, never freeze liveness
      // behind an unacked window: note the reason on the session and
      // stop holding — the heartbeat's discrete reopens take over.
      if (session !== null) session.degradedReason = "never-acked"
      break
    }
    if (wake === "lane-drained") laneDrainedPending = false
    announceUpstreamApplied()
    announceVoidSeqs()
    // A latched navigation preempts everything below regardless of
    // which arm won the race (a url frame's wake fires the same flip
    // arms). Other latches survive the continue — the next wait entry
    // consumes them against the new route.
    if (session !== null && session.pendingNav !== null) {
      if (!(await handleNavigation())) break
      idleDeadline = Date.now() + KEEPALIVE_MS
      announceVoidSeqs()
      continue
    }
    // Latched FRAME navigations — after the window (a window move
    // outranks frame work: the frame targets resolve against the new
    // route), before flips.
    if (session !== null && session.pendingFrameNavs.size > 0) {
      if (!(await handleFrameNavs())) break
      idleDeadline = Date.now() + KEEPALIVE_MS
      announceVoidSeqs()
      continue
    }
    const snapshots = _readSnapshotsForRoute(scope, routeKey)
    if (snapshots.size === 0) break
    // Follow the route's registered state while awake: lanes and
    // segments that committed since the last wake may have added,
    // replaced, or dropped snapshots, and the subscription must cover
    // them before the next park (a pointer-diff — unchanged snapshot
    // objects cost one map read each).
    _syncRouteWakeSubscription(subscription, snapshots, since)
    // The reconcile backstop — heals lane-relevance false-negatives
    // the label/constraint surface didn't capture, the correctness
    // role the keepalive reopen cycle plays for connections that
    // close idle. Deliberately does NOT extend the keepalive: it is
    // server-scheduled, not client-evidenced activity.
    if (
      Date.now() - lastFullSegmentAt >= RECONCILE_INTERVAL_MS &&
      lanes.size === 0 &&
      !deliveryWindowExceeded()
    ) {
      // Coverage anchors BEFORE the render begins (the cursor
      // discipline — see handleNavigation): the reconcile covers what
      // was on the timeline / pending at its render start; a delivery
      // landing mid-stream stays pending and lanes on this same wake's
      // drain below (fp-skipping when the segment did carry it).
      const coverTs = _currentTs()
      const coveredPending = [...subscription.sub.pending]
      if (!(await emitReconcileSegment())) break
      lastFullSegmentAt = Date.now()
      since = coverTs
      for (const id of coveredPending) subscription.sub.pending.delete(id)
      // The reconcile's render may also have re-registered snapshots —
      // re-cover them before the drain.
      _syncRouteWakeSubscription(subscription, _readSnapshotsForRoute(scope, routeKey), since)
    }
    const touched: string[] = []
    // Resolve flips. Each flip resolves against its OWN report's
    // statement (`PendingFlip.inView` — the id's presence in that
    // report's `visible` snapshot), never against the session's
    // CURRENT set: a mid-scroll burst legitimately dips the latest
    // snapshot while an earlier in-flip is still pending (old chunks
    // exit before new skeletons mount and testify), the client
    // reports each flip exactly once, and resolving the in-flip
    // against the dip would drop it forever — parking the world until
    // the heartbeat's keepalive reopen reseeds `?visible=`. Per id
    // the statement with the highest seq wins, so only an explicit
    // later out-flip cancels a pending in-flip. The worklist merges
    // deferred ids first (they have waited at least one wake already;
    // reports are ordered viewport-first, and this keeps that order
    // within each group), then the wake's fresh statements.
    //
    // Only in-flips lane: a cull-out is complete on the client the
    // moment it happens (the pair swaps to its inline skeleton — no
    // server bytes exist for a culled state), so an out-flip's entire
    // server-side effect is the session-set update the report already
    // applied. An in-flip's lane may fp-skip: a skip is the zero-byte
    // confirmation that the client's parked copy is current, and a
    // moved fp re-renders the body as usual. The verdict must be
    // against the client's ACTUAL holdings, so a DIRECT flip swaps
    // its statement's cached tokens into the override first (the
    // additive override alone drifts from the client — prunes,
    // evictions, slot overwrites — and confirming a phantom copy
    // blanks the parton). A DEFERRED flip carries no tokens: they are
    // stale by lane time, while the materializing render's
    // just-promoted fps are exactly what the client's slot received.
    const directFlips =
      wake === "visibility" && session !== null ? takeConnectionFlips(session) : null
    const worklist = new Map<string, PendingFlip>()
    for (const [id, seq] of deferredFlips) worklist.set(id, { inView: true, seq })
    if (directFlips) {
      for (const [id, flip] of directFlips) {
        const prior = worklist.get(id)
        if (prior !== undefined && flip.seq < prior.seq) continue
        worklist.set(id, flip)
      }
    }
    const override = _getCachedOverride()
    for (const [id, flip] of worklist) {
      if (!flip.inView) {
        // The id's standing statement is an out-flip — nothing to
        // lane, and any deferred in-flip it superseded is cancelled.
        deferredFlips.delete(id)
        continue
      }
      // The set learns the statement before the lane renders: the
      // lane's cull gate reads the session set, the lane ships the
      // in-state, and the client's pair re-primes its controller from
      // that emission — so the connection's knowledge for this id IS
      // "in view", even when the latest snapshot dipped below it
      // (mid-swap nodes drop out of a snapshot without testimony;
      // only `changed` testifies). Replaced, never mutated in place,
      // so a render holding the old reference keeps a consistent
      // view; the next report still replaces the set wholesale.
      if (session !== null && session.visible !== null && !session.visible.has(id)) {
        session.visible = new Set(session.visible).add(id)
      }
      if (!snapshots.has(id)) {
        deferredFlips.set(id, flip.seq)
        continue
      }
      deferredFlips.delete(id)
      if (flip.cached !== undefined && override) {
        applyReportedCached(id, flip.cached, override, session?.ackedFps, session?.ackedSlots)
        // The statement testifies the client's holdings for the
        // FLIPPED id only — its DESCENDANTS' optimistic entries are
        // exactly as untrustworthy at flip time (the class the swap
        // exists for): a lane that drained onto the wire and was torn
        // client-side by a navigation consume was promoted here while
        // its drop report is still in flight (acks are lazy), and the
        // flip lane rendering the subtree next would fp-skip such a
        // descendant to a confirm of bytes the client dropped. Strip
        // the subtree's optimistic skip evidence; the ACKED layer —
        // client-proven commits — remains the verdict's floor, so an
        // unacked-but-committed descendant costs one over-render,
        // never a phantom confirm. matchKeys stay: they drive parked
        // variant-sibling emission, not skip verdicts.
        const subtree = _readRouteDescendants(scope, routeKey).get(id)
        if (subtree) {
          for (const did of subtree) {
            if (did === id) continue
            override.fingerprints.delete(did)
            override.slots.delete(did)
          }
        }
      }
      // A consumed in-flip makes any ANCESTOR's open lane stale
      // mid-flight: that lane's current render read a visible set
      // without this id, so its emission carries the id as a culled
      // pair — and under burst backpressure it can COMMIT after the
      // id's own flip lane materialized content, regressing the
      // subtree client-side. Dirty the ancestor: pumpLane's dirty
      // loop re-renders it after the stale body drains, against the
      // session set that now holds the id, so the connection's last
      // word on the ancestor reflects the flip (the same coalescing
      // startLane uses for a wake on an open lane).
      const flippedSnap = snapshots.get(id)
      if (flippedSnap) {
        for (const ancestorId of flippedSnap.parentPath) {
          if (ancestorId === id) continue
          const openAncestor = lanes.get(ancestorId)
          if (openAncestor) openAncestor.dirty = true
        }
      }
      if (!touched.includes(id)) touched.push(id)
    }
    // Cookie deltas — a client cookie change stated over the channel
    // (shares the flip-wake arm, so drain regardless of which wake
    // won). Lane exactly the snapshots reading `cookie:<name>`: their
    // fp folds the overlay through `parseCookies`, so a changed value
    // re-renders and an unchanged one fp-skips to the confirmation.
    // Parked partons don't lane (their catch-up is the flip-in
    // revalidation, whose fp folds the change too) — the bump-wake
    // skip.
    if (session !== null && session.pendingCookieChanges.size > 0) {
      const changedCookies = takeConnectionCookieChanges(session)
      for (const id of _routeMatchingCookieIds(snapshots, changedCookies)) {
        if (isParkedOnConnection(id, snapshots, session)) continue
        if (!touched.includes(id)) touched.push(id)
      }
    }
    // Drop-report heals — ids from deliveries the client reported
    // DROPPED (`pendingDropHeals`, queued by the ack apply alongside
    // `revokeDroppedDelivery`). Each id that still snapshots unparked
    // lanes FORCED: the covering render that phantom-confirmed the
    // dropped content fired synchronously at the consume — before the
    // report could arrive — and its drain promote re-claimed the fp
    // AFTER the revocation, so only an explicit render (fp-skip and
    // the defer gate yield) reliably re-ships what the client actually
    // lost. Parked or route-departed ids drop here — their credit is
    // revoked, so the flip-in revalidation / return navigation's
    // covering render re-renders them anyway. Drained regardless of
    // which arm won (the report's wake shares the flip arm), like
    // cookies.
    if (session !== null && session.pendingDropHeals.size > 0) {
      const heals = [...session.pendingDropHeals]
      session.pendingDropHeals.clear()
      for (const id of _escalateToLaneCarriers(
        heals.filter((h) => snapshots.has(h)),
        snapshots,
      )) {
        if (isParkedOnConnection(id, snapshots, session)) continue
        forcedLaneIds.add(id)
        if (!touched.includes(id)) touched.push(id)
      }
    }
    // The delivery-plane drain — ONE pending set carries both event
    // sources (bumps delivered by the inverted wake index at commit
    // time; due `expires()` boundaries fired by the connection's
    // deadline wheel), so any wake that finds deliveries services them
    // in the same pass. The drain maps the delivered ids onto lane
    // carriers against CURRENT snapshots (an id whose snapshot
    // vanished drops at escalation) and park-checks each carrier —
    // drain-time state stays authoritative, delivery-time gating only
    // decided WAKING. Parked partons don't lane (see the parked-skip
    // note above); their catch-up is the flip-in revalidation. A
    // parked skip voids the id's assigned consequence seq — the lane
    // it was reserved for is not coming.
    if (_wakeParityCheckEnabled()) {
      _assertWakeParity(
        snapshots,
        since,
        subscription.sub.pending,
        (id) => isParkedOnConnection(id, snapshots, session),
        {
          now: Date.now(),
          // An expected id is legitimately undelivered when it is still
          // armed in the wheel (fires ≤ one slot late), its lane is
          // open (the in-flight render services it; the drain's sync
          // re-arms the wheel from the fresh snapshot), it is deferred
          // behind the unacked window, this wake's flip/cookie
          // worklist already carries it — or an ANCESTOR's lane is the
          // in-flight/queued service (a flipped-in ancestor's lane
          // re-renders the id inside its subtree; the covering-segment
          // consume of a then-parked id's bump relies on exactly that
          // catch-up).
          covered: (id) => {
            if (
              subscription.wheel.slotOf.has(id) ||
              openLaneIds.has(id) ||
              windowDirty.has(id) ||
              touched.includes(id)
            ) {
              return true
            }
            const parentPath = snapshots.get(id)?.parentPath
            if (!parentPath) return false
            return parentPath.some((a) => a !== id && (touched.includes(a) || openLaneIds.has(a)))
          },
        },
      )
    }
    if (subscription.sub.pending.size > 0) {
      const delivered = _takeWakeSubscriptionPending(subscription.sub)
      since = _currentTs()
      const matched = delivered.filter((id) => snapshots.has(id))
      for (const id of _escalateToLaneCarriers(matched, snapshots)) {
        if (isParkedOnConnection(id, snapshots, session)) {
          voidAssigned(id)
          continue
        }
        if (!touched.includes(id)) touched.push(id)
      }
      // Backstop for assignments this drain didn't touch (the
      // snapshot's constraint surface changed between the action's
      // reservation and this wake): an assignment neither laned nor
      // coalesced would pend — and hold the client's gate — forever.
      if (session !== null && session.assignedLaneSeqs.size > 0) {
        for (const id of [...session.assignedLaneSeqs.keys()]) {
          if (touched.includes(id)) continue
          if (openLaneIds.has(id)) continue
          if (windowDirty.has(id)) continue
          voidAssigned(id)
        }
      }
    }
    // The unacked delivery window — the second lane-opening gate (the
    // first is the response stream's own desiredSize pull-gate, which
    // parks enqueues byte-wise). Exceeded: touched ids coalesce into
    // the dirty set instead of opening lanes. Coalescing intermediate
    // states is CORRECT here — cells carry state, not events, so when
    // the window frees, ONE render of the latest state supersedes
    // every intermediate the gate skipped; nothing is dropped, the
    // ids stay dirty until they lane. A gated wake is not useful
    // activity: the keepalive keeps counting down, so a client that
    // never frees the window can't hold the connection open.
    if (deliveryWindowExceeded()) {
      for (const id of touched) windowDirty.add(id)
      continue
    }
    if (windowDirty.size > 0) {
      // The window freed — the coalesced ids render their LATEST
      // state, ahead of this wake's fresh touches (they have waited
      // longest). Ids that parked while gated stay skipped like on
      // any wake; a flip-in in the dirty set is never parked (the
      // set learned it at consume time above).
      const freed = [...windowDirty]
      windowDirty.clear()
      for (let i = freed.length - 1; i >= 0; i--) {
        const id = freed[i]
        if (isParkedOnConnection(id, snapshots, session)) {
          voidAssigned(id)
          continue
        }
        if (!touched.includes(id)) touched.unshift(id)
      }
    }
    announceVoidSeqs()
    if (touched.length === 0) continue
    idleDeadline = Date.now() + KEEPALIVE_MS
    // Fresh registry pass per wake: descendant folds and lookups read
    // the canonical store as of NOW (with every prior lane's commit
    // applied) instead of the initial segment's memoized fold base.
    enterRequestRegistry(routeKey, "cache")
    // A touched id lanes on its OWN even when a touched ANCESTOR's
    // lane re-renders it inside its subtree. Collapsing into the
    // ancestor is NOT sound: a direct flip-in's verdict runs against
    // the client's stated tokens, and an earlier lane's flush heal may
    // have retagged them PAST the descendant's parked-era bump (the
    // flush recompute folds live invalidation timestamps — a bump
    // landing between a render and its flush advances the heal beyond
    // what the rows carry), so the ancestor can CONFIRM while the
    // descendant's change never shipped. The descendant's own lane is
    // the guaranteed carrier. The cost is the rival-registration
    // bookkeeping drift ledgered as F7
    // (docs/notes/convergence-fuzzing.md) — fp-only, never content.
    for (const id of touched) startLane(id)
  }
  // Release demand-parked pumps before waiting the lanes out — the
  // loop's exit is the signal that no further demand is worth
  // waiting for. Producer lanes get their reads aborted too: their
  // bodies stream until a producer resolves — an unbounded await that
  // must not hold the wind-down (normal renders are loader-bounded
  // and drain out). A transport handover never reaches this with open
  // lanes: its `atPark` exit fires only at a full park.
  session?.cancelListeners.delete(onCancelScope)
  stopping = true
  for (const runtime of lanes.values()) {
    if (runtime.producer) {
      runtime.cancelled = true
      runtime.abortRead?.()
    }
  }
  for (const release of [...gateWaiters]) release()
  await Promise.allSettled([...lanes.values()].map((l) => l.done))
}

const IDLE_TIMEOUT = Symbol("idle-timeout")
const BUMP_WAKE = Symbol("bump-wake")
const LANE_DRAINED_WAKE = Symbol("lane-drained-wake")
const VISIBILITY_WAKE = Symbol("visibility-wake")
const DEGRADE_WAKE = Symbol("degrade-wake")

/** Which arm woke a segment/lane wait. `false` closes the stream.
 *  `"window"`, `"navigation"`, `"frame-navigation"` and `"drop-heal"`
 *  are minted only by the lane driver's wait-entry latch (an ack freed
 *  the delivery window / a url frame or drop report latched while the
 *  driver was busy); the wait itself never returns them — a url
 *  frame's / ack's wake fires the flip arms, and the loop's latch
 *  checks preempt regardless of the winning arm. `"degrade"` is the
 *  never-acked deadline. */
type SegmentWake =
  | false
  | "bump"
  | "lane-drained"
  | "visibility"
  | "cookie"
  | "drop-heal"
  | "window"
  | "navigation"
  | "frame-navigation"
  | "degrade"

interface SegmentWakeOptions {
  /** The connection's delivery arm: `pending` is the entry latch (ids
   *  delivered while the driver was busy, or recorded silently for
   *  parked carriers — by the wake index's bump commits AND by the
   *  deadline wheel's slot firings, which share the pending set),
   *  `wakes` the disposable listener set an actionable delivery
   *  fires. Same latch + listener shape as `laneDrained` — the
   *  wake-arm release invariant. */
  bump?: { pending: () => boolean; wakes: Set<() => void> }
  /** Extra wake arm: fires when a lane drains, so the driver's next
   *  iteration re-syncs the wake subscription against the drained
   *  parton's FRESH snapshot — which re-arms the deadline wheel with
   *  its next boundary. Without it, a parton whose only cadence is
   *  its own `expires()` would starve after its first lane (the
   *  wheel entry is consumed at fire; only the fresh snapshot's sync
   *  re-inserts it). A disposable listener set + the driver's latch
   *  (never a promise: a `.then` reaction on a park-lived promise
   *  can't be released, and the irrelevant-bump re-arm loop would
   *  accrete one per idle wake); the wait registers per race
   *  iteration and releases with the other arms, re-checking
   *  `pending` at each re-arm so a drain that raced a losing arm is
   *  consumed, not starved. */
  laneDrained?: { pending: () => boolean; wakes: Set<() => void> }
  /** The live connection's session (per-parton driver only): the
   *  visibility wake arm registers on the session's `flipWakes` for
   *  the park's duration — the caller drains the flipped ids via
   *  `takeConnectionFlips`. */
  session?: ConnectionSession | null
  /** Absolute idle deadline (ms epoch) overriding the default
   *  now+KEEPALIVE_MS anchor. The lane driver passes its
   *  activity-anchored deadline so a run of wakes that ship nothing
   *  can't extend the connection's life — see the zombie-connection
   *  note in `driveLaneStream`. */
  deadline?: number
  /** Absolute never-acked degrade deadline (ms epoch), or null when
   *  the obligation isn't running (no delivery settled yet, or the
   *  first ack already arrived). A timer arm with a disposer, like
   *  the keepalive — anchored at delivered-settle by the caller, see
   *  `FIRST_ACK_DEADLINE_MS`. */
  degradeAt?: number | null
}

/**
 * Wait for a reason to emit the next segment, or for the keepalive to
 * elapse. Races the arms:
 *   - the delivery arm — the inverted wake index delivered parton ids
 *     this connection registered (a `refreshSelector` matching a
 *     rendered partial's labels + constraint args), or the
 *     connection's deadline wheel fired due `expires()` boundaries
 *     into the same pending set. A bump nothing on the route
 *     subscribes to never reaches this park at all — no wake, no
 *     filter pass — which is what makes N held connections free under
 *     N peers' irrelevant mutations; a due boundary costs one
 *     grid-aligned timer firing on ITS connection, never a scan. A
 *     delivery whose carrier is parked records silently (the entry
 *     latch consumes it at the next real wake's wait entry).
 *   - the keepalive cap, measured from the last useful activity.
 *   - optionally, a lane draining (per-parton driver only).
 *   - optionally, a channel statement landing on the connection
 *     session (per-parton driver only).
 *
 * Every arm registers against one deferred with an explicit release —
 * the wake-arm release invariant: a reaction only frees when its
 * promise settles, so arming a park on long-lived shared state (the
 * subscription's wake set, the session's flip wakes, the lane
 * driver's drain wakes) without releasing the losers would grow the
 * heap by one full wake race per wake, for as long as the connection
 * holds.
 *
 * Returns the arm that fired, or `false` to close the stream (the
 * client's heartbeat reopens on its next tick).
 */
async function waitForSegmentWake(options?: SegmentWakeOptions): Promise<SegmentWake> {
  const keepaliveDeadline = options?.deadline ?? Date.now() + KEEPALIVE_MS
  // Entry latches — a signal that landed while the driver was busy
  // (or, for deliveries, was recorded silently for a parked carrier)
  // is consumed here instead of parking past it.
  if (options?.laneDrained?.pending()) return "lane-drained"
  if (options?.bump?.pending()) return "bump"
  const keepaliveRemaining = keepaliveDeadline - Date.now()
  if (keepaliveRemaining <= 0) return false
  let settle!: (value: symbol | number) => void
  const woke = new Promise<symbol | number>((resolve) => {
    settle = resolve
  })
  const disposers: Array<() => void> = []
  const bumpWakes = options?.bump?.wakes
  if (bumpWakes) {
    const onBump = (): void => settle(BUMP_WAKE)
    bumpWakes.add(onBump)
    disposers.push(() => bumpWakes.delete(onBump))
  }
  const kaTimer = setTimeout(() => settle(IDLE_TIMEOUT), keepaliveRemaining)
  disposers.push(() => clearTimeout(kaTimer))
  const laneDrainedWakes = options?.laneDrained?.wakes
  if (laneDrainedWakes) {
    const onDrain = (): void => settle(LANE_DRAINED_WAKE)
    laneDrainedWakes.add(onDrain)
    disposers.push(() => laneDrainedWakes.delete(onDrain))
  }
  if (options?.degradeAt != null) {
    const dgTimer = setTimeout(
      () => settle(DEGRADE_WAKE),
      Math.max(0, options.degradeAt - Date.now()),
    )
    disposers.push(() => clearTimeout(dgTimer))
  }
  const flipWakes = options?.session?.flipWakes
  if (flipWakes) {
    const onFlip = (): void => settle(VISIBILITY_WAKE)
    flipWakes.add(onFlip)
    disposers.push(() => flipWakes.delete(onFlip))
  }
  let result: symbol | number
  try {
    result = await woke
  } finally {
    for (const dispose of disposers) dispose()
  }
  if (result === IDLE_TIMEOUT) return false
  if (result === BUMP_WAKE) return "bump"
  if (result === LANE_DRAINED_WAKE) return "lane-drained"
  if (result === VISIBILITY_WAKE) return "visibility"
  return "degrade"
}

/**
 * True iff `id`'s own snapshot, or a cullable ancestor's, sits outside
 * the connection's measured visible set — the parton is PARKED: its
 * client copy is a hidden Activity slot (cull-to-park), so lanes at it
 * ship bytes nobody sees. Reads the same two signals the cull gate
 * reads: the snapshot's recorded `visible:<id>?seed=…` dep marks the
 * parton cullable, and the session's current set is its viewport
 * state. `visible: null` (no report yet) parks nothing — the seed
 * state is authoritative until the client measures. Skipping is
 * staleness-free: every bump that lands while parked moves the
 * in-state fp, so the flip-in revalidation's skip check can only miss
 * (re-render fresh), never false-match.
 *
 * `visibleOverride` substitutes the session's live set — a lane
 * drain's pinned visibility moment (see `pumpLane`), so the promote's
 * parked check describes the same state the render read. `undefined`
 * (absent) reads the live set.
 */
function isParkedOnConnection(
  id: string,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  session: ConnectionSession | null,
  visibleOverride?: ReadonlySet<string> | null,
): boolean {
  const visible = visibleOverride !== undefined ? visibleOverride : session?.visible
  if (visible == null) return false
  const snap = snapshots.get(id)
  if (!snap) return false
  if (_hasCullGateDep(snap.deps, id) && !visible.has(id)) return true
  for (const ancestorId of snap.parentPath) {
    if (ancestorId === id) continue
    const ancestor = snapshots.get(ancestorId)
    if (!ancestor) continue
    if (_hasCullGateDep(ancestor.deps, ancestorId) && !visible.has(ancestorId)) return true
  }
  return false
}

/**
 * Read the just-committed snapshots for the current route and append
 * each `(id, matchKey, fp)` tuple into the request-scoped cached
 * override Maps. PartialRoot's next render reads from those Maps
 * directly (same identity), so the override IS the next render's
 * `state.cachedFingerprints` / `state.cachedMatchKeys` — no URL
 * rewrite, no parse round-trip.
 *
 * Snapshots without an `emittedFp` (non-addressable specs, e.g.
 * layout wrappers with no selector) or without a `matchKey` are
 * skipped: they have no client-visible wire identity to track.
 *
 * Why the override carrier even exists: the previous shape
 * `rewriteCachedFromSnapshots` did `new URL(req.url)` +
 * `url.searchParams.set("cached", […].join(","))` + `url.toString()` +
 * `new Request(...)` + `setRequest(...)` per segment, and the next
 * segment's PartialRoot re-parsed `?cached=` back into Maps. Per-tick
 * profiling showed that round-trip dominating the streaming CPU
 * profile (~7% total + URL parse cost). The carrier collapses it to
 * one map mutation per snapshot.
 */
/** Replace the mirror's entries for `id` with the client's reported
 *  holdings — `id:matchKey:fp` tokens, parsed right-to-left like
 *  `parseCachedTokens` (ids may contain colons; matchKeys never do).
 *  Replaces EVERY layer for the id: the flip statement is the client's
 *  own attestation of what it holds, so it supersedes both the
 *  optimistic skip-set and the acked layer — an acked fp the client
 *  has since evicted must not confirm a phantom copy (acks report what
 *  the client gained, never what it evicted; this statement is the
 *  eviction evidence). */
function applyReportedCached(
  id: string,
  tokens: readonly string[],
  override: {
    fingerprints: Map<string, Set<string>>
    matchKeys: Map<string, Set<string>>
    slots: Map<string, Map<string, Set<string>>>
  },
  ackedFps?: Map<string, Set<string>>,
  ackedSlots?: Map<string, Map<string, Set<string>>>,
): void {
  const fps = new Set<string>()
  const mks = new Set<string>()
  const idSlots = new Map<string, Set<string>>()
  for (const token of tokens) {
    const fpIdx = token.lastIndexOf(":")
    if (fpIdx <= 0) continue
    const fp = token.slice(fpIdx + 1)
    const rest = token.slice(0, fpIdx)
    const mkIdx = rest.lastIndexOf(":")
    if (mkIdx <= 0) continue
    const mk = rest.slice(mkIdx + 1)
    fps.add(fp)
    mks.add(mk)
    let slot = idSlots.get(mk)
    if (!slot) {
      slot = new Set()
      idSlots.set(mk, slot)
    }
    slot.add(fp)
  }
  override.fingerprints.set(id, fps)
  override.matchKeys.set(id, mks)
  override.slots.set(id, idSlots)
  // The stated tokens are client-attested holdings — the acked layer's
  // truth class — so they REPLACE its entry rather than clearing it.
  // The acked SLOT index must follow: the ack fold's per-(id,matchKey)
  // dedup keys on it, and a stale slot lets a later delivery whose fp
  // VALUE the old slot already holds (cold fps collide across route
  // buckets — a dep-less first-in-bucket fp is byte-identical across
  // request states) skip the eviction of these stated fps, stranding
  // a foreign-state fp in the acked layer where it can confirm a copy
  // the client's slot has since overwritten.
  ackedFps?.set(id, new Set(fps))
  ackedSlots?.set(id, new Map([...idSlots].map(([mk, slot]) => [mk, new Set(slot)])))
}

/**
 * Promote one `(id, matchKey, fp)` into the override with the
 * client's SLOT semantics: the client keeps one content per
 * `(id, matchKey)` (`cacheStore` overwrites evict the slot's prior
 * fps), so a fresh fp for a slot EVICTS that slot's other fps from
 * the verdict set — an A→B→A content cycle must re-render at each
 * step, never fp-skip against a slot the client overwrote. An fp
 * folds its matchKey, so it belongs to exactly one slot and the
 * flat-set surgery is exact. A re-promotion of an fp the slot already
 * holds is a no-op (the same content re-rendered).
 */
function promoteSlotFpToOverride(
  override: {
    fingerprints: Map<string, Set<string>>
    matchKeys: Map<string, Set<string>>
    slots: Map<string, Map<string, Set<string>>>
  },
  id: string,
  matchKey: string,
  fp: string,
): void {
  let idSlots = override.slots.get(id)
  if (!idSlots) {
    idSlots = new Map()
    override.slots.set(id, idSlots)
  }
  let slot = idSlots.get(matchKey)
  if (!slot) {
    slot = new Set()
    idSlots.set(matchKey, slot)
  }
  let fpSet = override.fingerprints.get(id)
  if (!fpSet) {
    fpSet = new Set()
    override.fingerprints.set(id, fpSet)
  }
  if (!slot.has(fp)) {
    // Fresh content for the slot: the client's commit evicted every
    // prior fp the slot advertised — mirror the eviction.
    for (const old of slot) fpSet.delete(old)
    slot.clear()
    slot.add(fp)
  }
  fpSet.add(fp)
  capOverrideSet(fpSet)
  let mkSet = override.matchKeys.get(id)
  if (!mkSet) {
    mkSet = new Set()
    override.matchKeys.set(id, mkSet)
  }
  mkSet.add(matchKey)
  capOverrideSet(mkSet)
}

/** Fold a trailer's `{from, to}` warm-fp entries into the live
 *  connection's cached override — the exact server-side mirror of the
 *  client's `_applyFpUpdates`: `to` joins the SLOT still holding `from`
 *  (the same content, warmed — kept alongside `from`, evicted with it
 *  when a sibling variant later overwrites the slot). A heal whose
 *  `from` no slot holds is superseded and DROPPED — never added
 *  slotlessly, which would strand it past the slot's eviction and let a
 *  return-toggle fp-skip against a phantom. `onToken` records the join
 *  under its resolved matchKey so the acked layer folds it the same
 *  way. */
function promoteFpUpdatesToCachedOverride(
  updates: FpUpdatesPayload,
  onToken?: (id: string, matchKey: string, fp: string) => void,
): void {
  const override = _getCachedOverride()
  if (!override) return
  for (const [id, entry] of Object.entries(updates)) {
    const idSlots = override.slots.get(id)
    if (!idSlots) continue
    for (const [mk, slot] of idSlots) {
      if (!slot.has(entry.from)) continue
      slot.add(entry.to)
      capOverrideSet(slot)
      let fpSet = override.fingerprints.get(id)
      if (!fpSet) {
        fpSet = new Set()
        override.fingerprints.set(id, fpSet)
      }
      fpSet.add(entry.to)
      capOverrideSet(fpSet)
      onToken?.(id, mk, entry.to)
      break
    }
  }
}

export function promoteSnapshotsToCachedOverride(
  withinId?: string,
  // The delivery-record sink: the lane/segment drivers capture the
  // promoted `(id, matchKey, fp)` triples as the emission's holdings
  // in the SAME walk (no second pass per drain) — see
  // `_recordDelivery`.
  onToken?: (id: string, matchKey: string, fp: string) => void,
  // The live connection's session — when provided, snapshots PARKED on
  // this connection (own or ancestor cull gate outside the session's
  // visible set) are not claimed: the render carried at most their
  // culled pair/skeleton, never body bytes (see the promote's
  // shipped-only discipline below).
  session?: ConnectionSession | null,
  // A lane drain's pinned visibility moment — the set the render read
  // (see `pumpLane`); the parked check reads it instead of the live
  // session set, so the claim describes what the render SHIPPED.
  pinnedVisible?: ReadonlySet<string> | null,
  // The render's OWN registration map (the lane probe's per-iteration
  // capture). When provided, the scoped walk resolves each id's
  // snapshot through it first: a rival same-drain render of a covered
  // id can win the canonical merge, and claiming the rival's fp here
  // would credit this delivery with bytes it did not carry — the
  // client's commit of this body establishes THIS render's fps, and a
  // drop report against this delivery must revoke exactly those (fuzz
  // class F7). Ids this render did not register fall back to
  // canonical (a broadcast-consumed body renders nothing of its own —
  // consume-time validation pins canonical to the published render).
  renderRegistrations?: ReadonlyMap<string, PartialSnapshot> | null,
): void {
  let request: Request
  let scope: string
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    return
  }
  const override = _getCachedOverride()
  if (!override) return
  const routeKey = computeRouteKey(request.url)
  const snapshots = _readSnapshotsForRoute(scope, routeKey)
  if (snapshots.size === 0) return

  const promote = (id: string, snap: PartialSnapshot): void => {
    if (!snap.emittedFp || !snap.matchKey) return
    // A WARM-registered snapshot's bytes never reached any client —
    // claiming its fp as a holding would let a later lane confirm
    // content the client doesn't have (see `PartialSnapshot.warmed`).
    // The id's next real emission re-registers and promotes normally.
    if (snap.warmed) return
    // A MATCH-MISSED snapshot didn't render on this request either —
    // the segment carried at most its parked keepalive hole, never its
    // body — so nothing about it may be claimed here (the F2
    // discipline, applied to the promote). Its fps are already in the
    // mirror from the render that actually shipped them; re-claiming
    // is the over-claim channel that lets a SUPERSEDED navigation's
    // aborted render leak: the abort left its never-shipped emittedFp
    // in the registry, and a whole-route promote under a request that
    // parks the id would tag the client with bytes it never received —
    // a return navigation then fp-skips to a phantom confirm.
    // Framed snapshots gate on their frame's URL, not the page's —
    // evaluating the page request would be a different gate, so they
    // keep promoting (the conservative, current-behavior direction).
    if (
      snap.framePath.length === 0 &&
      getSpecById(snap.type)?.match?.evaluate(request).matched === false
    ) {
      return
    }
    // A PARKED snapshot is the cull-gate twin of the match-miss: the
    // render carried its culled pair (or nothing, inside a culled
    // ancestor), never its body. Its registry emittedFp can belong to
    // a render whose bytes never shipped — a lane torn by a navigation
    // consume registers its rows before the tear — so claiming it here
    // would let the id's next lane fp-skip to a phantom confirm of
    // content the client never received. Its real holdings entered the
    // mirror when it actually shipped; the flip-in revalidation is its
    // catch-up.
    if (session != null && isParkedOnConnection(id, snapshots, session, pinnedVisible)) return
    promoteSlotFpToOverride(override, id, snap.matchKey, snap.emittedFp)
    onToken?.(id, snap.matchKey, snap.emittedFp)
  }

  // `withinId` scopes the walk to one parton's subtree — a lane drain
  // promotes only the snapshots its render just committed. The route's
  // parent→children index resolves the subtree directly; filtering the
  // whole bucket by `parentPath` here was O(route) per lane drain, a
  // standing tax at world density (hundreds of cadences over a
  // thousands-strong bucket). Each id resolves through the render's
  // own registrations first (see the parameter note above); own
  // entries also extend the membership, so an id the render carried
  // is claimed even when a rival registration moved its canonical
  // placement out of this subtree's index.
  if (withinId !== undefined) {
    const own = renderRegistrations ?? null
    const ids = new Set<string>([withinId])
    const subtree = _readRouteDescendants(scope, routeKey).get(withinId)
    if (subtree) for (const id of subtree) ids.add(id)
    if (own) {
      for (const [rid, rsnap] of own) {
        if (rid === withinId || rsnap.parentPath.includes(withinId)) ids.add(rid)
      }
    }
    for (const id of ids) {
      const snap = own?.get(id) ?? snapshots.get(id)
      if (snap) promote(id, snap)
    }
    return
  }
  for (const [id, snap] of snapshots) promote(id, snap)
}

/**
 * Reserve the delivery seqs an action's invalidation consequences will
 * ride on the connection the action request NAMED (`x-parton-conn` —
 * an explicit client statement, never inferred). Returns the reserved
 * seqs for the response's consequence header, or `null` when there is
 * nothing to reserve (no such connection, a binding mismatch, no
 * relevant pending bump).
 *
 * MUST run inside the action's invalidation transaction, AFTER the
 * body queued its bumps and BEFORE the commit flushes them: the flush
 * is what wakes the segment drivers, so assigning here is strictly
 * ordered before any driver could mint the same lanes' seqs — the
 * pump takes an id's assignment at iteration start
 * (`assignedLaneSeqs`), and every skip path voids it (`voidSeqs` → the
 * `seqvoid` entry) so the client's contiguous watermark can always
 * pass a reservation. The client's optimistic overlay holds until its
 * committed watermark covers the returned seqs — never cleared at the
 * POST's return value alone (under window coalescing the consequence
 * lane can trail the response by the whole backpressure window, which
 * is exactly when a returnValue-cleared overlay would flash stale).
 *
 * Binding checks mirror the channel endpoint's: the request's scope
 * and session identity must match the attach's — a mismatched header
 * reserves nothing (the action itself is unaffected).
 */
export function _reserveActionConsequences(connectionId: string): number[] | null {
  const session = _peekConnectionSession(connectionId)
  if (!session) return null
  if (getScope() !== session.scope) return null
  if ((getSessionId() ?? "") !== session.boundSessionId) return null
  if (session.routeKey === null) return null
  const selectors = _pendingInvalidationSelectors()
  if (selectors.length === 0) return null
  const snapshots = _readSnapshotsForRoute(session.scope, session.routeKey)
  if (snapshots.size === 0) return null
  const seqs: number[] = []
  for (const id of _routeMatchingSelectorIds(snapshots, selectors)) {
    // Parked partons never lane (the flip-in revalidation is their
    // catch-up) — reserving for one would wedge the watermark.
    if (isParkedOnConnection(id, snapshots, session)) continue
    // An unconsumed prior reservation is reused: one render of the
    // latest state covers both writes (cells carry state, not
    // events), and the earlier action's gate holds on the same seq.
    let seq = session.assignedLaneSeqs.get(id)
    if (seq === undefined) {
      seq = ++session.deliverySeq
      session.assignedLaneSeqs.set(id, seq)
    }
    seqs.push(seq)
  }
  return seqs.length > 0 ? seqs : null
}

/**
 * Promote each snapshot's `emittedFp` into the request state's
 * `cachedFingerprints` map. Call this between segments so the next
 * render's fp-skip path treats just-emitted partials as cached.
 *
 * Snapshots without an `emittedFp` (non-addressable specs) are
 * skipped — there's no client identity to track.
 */
export function promoteEmittedFpsToCached(
  state: PartialRequestState,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
): void {
  for (const [id, snap] of snapshots) {
    const fp = snap.emittedFp
    if (!fp) continue
    // Warm-registered snapshots never shipped — same rule as the
    // override promote above.
    if (snap.warmed) continue
    let set = state.cachedFingerprints.get(id)
    if (!set) {
      set = new Set()
      state.cachedFingerprints.set(id, set)
    }
    set.add(fp)
  }
}
