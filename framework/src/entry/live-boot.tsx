/**
 * The live layer — the late-loaded half of a parton app's browser
 * entry. The hydration shell (`./browser.tsx`) hydrates the SSR
 * document immediately, then imports THIS module once from a post-commit
 * `useEffect` and calls `installLiveLayer(host)`. That single call:
 *
 *   - selects the boot channel transport and arms the WS auto-upgrade,
 *   - installs the attach transport (`window.__rsc_live_attach` — the
 *     channel's opening statement and the page's one held stream),
 *   - installs the server-action callback,
 *   - installs the Navigation API intercept (client-side navigation)
 *     and publishes the page-interactive marker,
 *   - installs the live page heartbeat (which fires the first attach).
 *
 * Everything interactive rides the channel: the attach POST opens the
 * stream, `url` frames move it, lanes and navigation segments come down
 * it. The only GETs a page makes are document loads.
 *
 * Splitting the whole cluster (channel transport, fp-trailer split,
 * frame navigation, segment trailers, heartbeat) behind this dynamic
 * import keeps ~24 KiB of live machinery out of first paint — the
 * document hydrates and is legible before any of it loads. The import
 * fires post-commit, before any user click, so the intercept is in
 * place for the steady state; a load failure degrades to plain document
 * navigations (page functional, never a broken paint).
 */
import {
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser"
import {
  _channelAbortLiveStream,
  _channelAppliedWatermark,
  _channelBeginTransportHandover,
  _channelClaimWindowNav,
  _channelDeliveryCommittable,
  _channelFrameLaneCommitted,
  _channelFrameLaneSettled,
  _channelArmReattachOnClose,
  _channelHandoverSettled,
  _channelIdle,
  _channelIsDegraded,
  _channelNavAvailable,
  _channelNavigate,
  _channelNavInFlightCovering,
  _channelUrlStatementPoint,
  _channelNavPrefersStreaming,
  _channelNavPrefersTransition,
  _channelNavSegmentCommitted,
  _channelNavSegmentSettled,
  _channelNavSubsumedByAttach,
  _channelWireEntry,
  _laneDeliveryCommitted,
  _laneDeliveryDropped,
  _laneDeliveryDroppedStale,
  _lanePendingDelivery,
  _onLaneProducerAnnounce,
  _registerActionConsequences,
  _reportAsOfDrop,
  _segmentDelivery,
  _segmentDeliveryCommitted,
  _segmentDeliveryDroppedStale,
  _takeHandoverFrom,
  onChannelEstablished,
  type WireDelivery,
} from "../lib/channel-client.ts"
import { ATTACH_ENDPOINT, type AttachStatement, type UrlFrame } from "../lib/channel-protocol.ts"
import {
  fetchTransport,
  getChannelTransport,
  isTransportForced,
  probeWebSocketTransport,
  selectChannelTransport,
  setChannelTransport,
  WebSocketTransport,
} from "../lib/channel-transport.ts"
import { type FpUpdatesPayload, TAG_CONNECTION_ID } from "../lib/fp-trailer-marker.ts"
import { type DemuxedLane, splitAtFpTrailer, splitSegments } from "../lib/fp-trailer-split.ts"
import { installLivePageHeartbeat } from "../lib/live-page-heartbeat.tsx"
import { markPageInteractive } from "../lib/page-interactive.ts"
import {
  _applyFpUpdates,
  _commitPartonLane,
  _commitPartonLaneProgressive,
  getCachedPartialIds,
} from "../lib/partial-client.tsx"
import { _collectFramePaths, _readFramesSnapshot } from "../lib/frame-context.tsx"
import { _dispatchFrameRefetch } from "../lib/frame-client.tsx"
import { isFrameworkInPlaceInfo, isFrameworkSilentInfo } from "../lib/silent-info.ts"
import {
  _documentCatchupAnchor,
  _getLiveConnectionId,
  getAllCachedPartialTokens,
} from "../lib/partial-client-state.ts"
import { _visibleSetIds } from "../lib/visibility.tsx"
import { applyStandardTrailers } from "../lib/segment-trailers-client.ts"
import { getNavigation } from "../runtime/navigation-api.ts"
import { NavigationError } from "../runtime/navigation-error.ts"
import { createRscRenderRequest } from "../runtime/request.tsx"
import type { ReactNode } from "react"
import type { RscPayload } from "./rsc.tsx"

/**
 * The hydration shell's hooks into React's committed tree. The live
 * layer drives the page through these — a whole-tree segment commits by
 * calling `setPayload` (transition) or `setPayloadRaw` (progressive);
 * the navigate listener stamps pending view-transition types for the
 * next commit.
 */
export interface LiveHost {
  /** Commit a whole-tree payload inside a transition (draining any
   *  pending view-transition types). */
  setPayload: (v: RscPayload) => void
  /** Commit a whole-tree payload progressively (raw setState). */
  setPayloadRaw: (v: RscPayload) => void
  /** Stamp the view-transition types for the next commit (set
   *  synchronously by the navigate-event handler). */
  setPendingTransitionTypes: (types: string[]) => void
}

/** Delay after the fetch connection first establishes before the WS
 *  attach fires — long enough that first content already rendered over
 *  fetch (the upgrade costs the user nothing), short enough that the
 *  socket takes over promptly. */
const UPGRADE_PROBE_DELAY_MS = 600
/** Backoff base between failed re-attempts (scaled by the count). */
const UPGRADE_REPROBE_MS = 2_000
/** Total WS attempts before giving up for the page's lifetime — bounded
 *  so a blocked endpoint is never hammered. Small: a same-origin socket
 *  that works confirms on the FIRST attempt (the cold-handler race is
 *  fixed server-side), so the retry is only for a genuine transient
 *  blip — the next document navigation re-arms anyway. */
const MAX_UPGRADE_PROBES = 2
/** Backstop on the old connection's graceful wind-down: if its stream
 *  hasn't settled this long after the `atPark` detach (a connection
 *  that never parks — an unbounded producer, a wedged loader), escalate
 *  to the abrupt abort so the handover completes. A liveness bound, not
 *  a signal: a normally-active connection parks within its current
 *  lanes' loader time. */
const HANDOVER_DRAIN_TIMEOUT_MS = 10_000

/** The upgrade committed: the NEXT attach fire installs the WebSocket
 *  transport before opening. Set together with the handover's `atPark`
 *  detach, consumed by the attach transport — so the transport flips
 *  exactly at the fire that replaces the wound-down connection, never
 *  under an envelope addressed to the old one. */
let upgradeToWebSocketOnNextFire = false

/** The boot transport + WS auto-upgrade are armed once per page
 *  lifetime — they register a page-scoped `onChannelEstablished`
 *  listener with no unregister, so a StrictMode install/teardown/
 *  reinstall cycle (dev) must not re-arm them. The rest of the layer
 *  (attach, callback, navigate intercept, heartbeat) installs and tears
 *  down per call. */
let bootTransportArmed = false

/**
 * Auto-upgrade the live channel from fetch to WebSocket where the socket
 * works — the socket.io-shaped default, built on the framework's own
 * re-attach machinery rather than an in-place socket swap.
 *
 * Boot rides fetch (instant, universal). Once the fetch connection
 * establishes AND the channel is idle (no navigation / refetch in
 * flight — the quiesce gate, `_channelIdle`), a BACKGROUND probe opens
 * a speculative WS attach on a throwaway socket
 * (`probeWebSocketTransport`). The probe presents the manifest and the
 * retained document anchor, so an anchor-honoring server opens its
 * session straight into a parked lanes region: `conn` — the real
 * establishment signal, not a bare `onopen` — arrives with near-zero
 * server work, and closing the probe socket tears no render.
 *
 * Confirmed → the handover, two ordinary moves with no gap and no tear:
 *
 *   1. `_channelBeginTransportHandover` states the old connection's
 *      `atPark` detach: the server winds the held stream down at its
 *      next FULL PARK — everything in flight is served first (open
 *      lanes drain and commit, latched statements get their covering
 *      renders) and the close tears nothing. The connection id stays
 *      published for the whole wind-down, so the page keeps its full
 *      transport until the very close.
 *   2. That close re-fires the heartbeat (the one-shot reattach flag),
 *      and the fire is a NORMAL attach on the WebSocket transport
 *      (installed by the one-shot flip above): its statement folds
 *      pending intent and presents the manifest AT FIRE TIME —
 *      strictly after every one of the old stream's commits landed —
 *      so the new connection's first segment can never roll the page
 *      back. The statement names the closed connection
 *      (`handoverFrom`) and the new session inherits its ephemeral
 *      cell storage. From there every attach, lane, and envelope
 *      rides the socket.
 *
 * A blocked/absent endpoint fails the probe and everything stays on
 * fetch, transparently — bounded backed-off re-probes, then it gives up
 * for the page lifetime. A confirmed-then-failed socket falls back to
 * fetch through the fire path itself: an attach that settles without
 * establishing on an unforced WebSocket transport reverts to fetch
 * before re-attaching (`consumeLiveStream`'s settle guard).
 *
 * The probe is CAPABILITY-GATED: it fires only when the server ADVERTISED
 * it serves the socket. `partonChannelServer` (the Vite plugin registering
 * the `/__parton/ws` upgrade handler) sets `PARTON_WS_AVAILABLE`, which
 * `renderHTML` reflects into the bootstrap as `self.__partonWsAvailable`.
 * No flag → no plugin → no handler; probing would open a doomed socket the
 * host leaves hanging (close 1006) and log a console error. This is the
 * no-heuristic rule: the server that serves the socket advertises it; the
 * client never probes an unadvertised endpoint.
 *
 * Stands down entirely when the endpoint is unadvertised, when a
 * `?transport=` force pins the transport (the user's explicit choice — a
 * forced `ws` boots WS directly, no probe), or when no `WebSocket` global
 * exists.
 */
function armTransportUpgrade(): void {
  if (isTransportForced()) return
  if (typeof WebSocket === "undefined") return
  // The capability gate: probe only an endpoint the server advertised.
  if (!(window as unknown as { __partonWsAvailable?: number }).__partonWsAvailable) return

  let upgraded = false
  let probing = false
  let probes = 0
  let armed = false

  const tryUpgrade = async (): Promise<void> => {
    if (upgraded || probing) return
    // Only ever upgrade FROM the default fetch transport.
    if (getChannelTransport() !== fetchTransport) return
    probing = true
    // The quiesce gate: commit only while no navigation / refetch is in
    // flight — a swap under a mid-stream covering render would punt the
    // interaction through the close-race path for no reason. The wait
    // is the record machinery's own settle milestones; a page that
    // never idles keeps fetch.
    await _channelIdle()
    if (upgraded || getChannelTransport() !== fetchTransport) {
      probing = false
      return
    }
    probes += 1
    let confirmed = false
    try {
      confirmed = await probeWebSocketTransport({
        url: window.location.pathname + window.location.search,
        // The manifest + the retained document anchor keep the probe's
        // throwaway session near-free server-side (see the doc above).
        cached: getAllCachedPartialTokens(),
        since: _documentCatchupAnchor(),
        visible: _visibleSetIds() ?? null,
        applied: _channelAppliedWatermark(),
      })
    } finally {
      probing = false
    }
    if (!confirmed) {
      if (probes < MAX_UPGRADE_PROBES) {
        // Backed-off re-probe — never hammer a blocked endpoint.
        setTimeout(() => void tryUpgrade(), UPGRADE_REPROBE_MS * probes)
      }
      return
    }
    upgraded = true
    // Flip at the REPLACING fire, then wind the old connection down.
    upgradeToWebSocketOnNextFire = true
    _channelBeginTransportHandover()
    // The wind-down backstop — see HANDOVER_DRAIN_TIMEOUT_MS.
    setTimeout(() => {
      if (getChannelTransport() === fetchTransport && upgradeToWebSocketOnNextFire) {
        _channelAbortLiveStream()
      }
    }, HANDOVER_DRAIN_TIMEOUT_MS)
  }

  // Probe once the FETCH connection is up (first content already
  // delivered — no penalty). Arm on the FIRST establishment only; the
  // probe and its bounded retry own the rest, so later
  // re-establishments (keepalive, navigation) don't re-trigger it.
  onChannelEstablished(() => {
    if (armed) return
    if (getChannelTransport() !== fetchTransport) return
    armed = true
    setTimeout(() => void tryUpgrade(), UPGRADE_PROBE_DELAY_MS)
  })
}

/** The page opted out of the interactive transport entirely (specs
 *  asserting document-shaped behavior set it): no heartbeat, no
 *  channel, no interception — every navigation is a document load. */
function heartbeatDisabled(): boolean {
  return (
    (window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled ===
    true
  )
}

/**
 * Install the whole live layer. Called once from the hydration shell's
 * post-commit effect. Returns a teardown fn (a dev full-reload dispose
 * calls it; in the steady state the layer lives for the page lifetime).
 */
export function installLiveLayer(host: LiveHost): () => void {
  if (!bootTransportArmed) {
    bootTransportArmed = true
    // Pick the BOOT transport before anything fires — fetch by default
    // (instant, universal, no handshake wait), or a `?transport=` force.
    // See [[channel-transport]].
    selectChannelTransport()
    // Then arm the auto-upgrade: an unforced page boots on fetch and,
    // once that connection is up, probes WebSocket in the background and
    // promotes to it where the socket works. A forced page stands this
    // down.
    armTransportUpgrade()
  }

  // The CURRENT attach fire's generation. A superseded fire's stream
  // keeps draining (the cooperative abort releases it only at a
  // settled boundary), but nothing it carries may act anymore: its
  // late `conn` entry must not hijack establishment away from the
  // newer fire, its lane seqs must not pollute the per-parton queues,
  // and its payloads must not commit — their content is the state the
  // page superseded.
  let liveFireGen = 0

  /**
   * Consume one attach stream: open the downstream (the transport's
   * POST/socket, or the handover's adopted pre-opened body) and decode
   * the held segmented response — the `conn` handshake, payload
   * segments (whole-tree renders, navigation segments, reconciles),
   * and per-parton lanes. Returns synchronously with
   * `{streaming, finished}` promises: `streaming` resolves when the
   * first segment commits (or the lanes region opens on a catch-up
   * boot — the current tree IS the state); `finished` when the
   * connection fully drains (keepalive close, abort, error) AND every
   * lane commit it carried has landed — the heartbeat's settle signal,
   * so the next fire's establishment (which resets the per-connection
   * delivery tracking) can never race a prior stream's tail commits.
   *
   * Commit arbitration for seq'd deliveries is the AS-OF guard alone:
   * commit iff the delivery was rendered as-of the client's current
   * navigation point or later (`_channelDeliveryCommittable`). A
   * document navigation unloads the page — no cross-page staleness
   * class exists.
   *
   * Settling WITHOUT ever seeing `conn` on an UNFORCED WebSocket
   * transport reverts the transport to fetch before the settle
   * propagates — the auto-upgrade's fallback: a socket that stops
   * establishing hands the page back to the universal transport, and
   * the close arbitration's re-attach rides it.
   */
  function consumeLiveStream(
    statement: AttachStatement,
    signal?: AbortSignal,
  ): { streaming: Promise<void>; finished: Promise<void> } {
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
    // Most callers chain off `finished`. Pre-attach a no-op on
    // `streaming` so unconsumed rejections don't surface as
    // unhandledrejection — `streaming` rejecting always implies
    // `finished` will reject too, where the caller is listening.
    streaming.catch(() => {})

    const gen = ++liveFireGen
    // Whether this fire's stream carried the `conn` handshake — the
    // settle guard's real signal for "the transport established".
    let sawConn = false
    // Every lane-commit chain this stream spawned; the settle awaits
    // them so `finished` means "content landed", not just "bytes read".
    const allLaneChains: Array<Promise<void>> = []
    void (async () => {
      let streamingResolved = false
      try {
        // Open the downstream through the active channel transport
        // ([[channel-transport]]) — the default fetch transport POSTs
        // the statement to `/__parton/live` and hands back the held
        // body, mapping network / HTTP failures to typed
        // NavigationErrors (AbortError stays untouched, a normal
        // lifecycle signal). `signal` is deliberately NOT wired to the
        // request — aborting it mid-read tears a partially-committed
        // Flight tree — it goes to `splitSegments` below, which aborts
        // cooperatively at a SEGMENT BOUNDARY.
        const { body } = await getChannelTransport().open(statement, signal)
        // Decode + commit one per-parton lane. The body carries the
        // lane's Flight payload plus its own fp trailer; decode fully
        // (the lane closed at its `muxend`, so all bytes are here),
        // then hand the subtree to the framework's cache-commit path —
        // which swaps it in place via a template re-render, no
        // whole-payload setPayload involved.
        const handleLane = async (lane: DemuxedLane): Promise<void> => {
          // Whether this handler has consumed its body's queue head
          // (committed or dropped) — the catch must consume exactly
          // once to keep per-parton seq attribution aligned.
          let consumed = false
          try {
            const { mainStream, trailer } = splitAtFpTrailer(lane.body)
            const node = await createFromReadableStream<ReactNode>(mainStream)
            // Learn the body's shape before deciding the commit moment:
            // a NORMAL lane's delivery entry precedes its muxend (the
            // trailer resolves right after the root here), while a
            // PRODUCER lane announces mid-body (`muxlive`) and its
            // trailer only resolves at producer resolve — waiting on it
            // would gate the initial content on an unbounded await. Race
            // the trailer against the producer announcement.
            let delivery = _lanePendingDelivery(lane.partonId)
            // A VOIDED delivery: the server announced the seq, then tore
            // or cancelled the body before it could complete (the
            // `seqvoid` entry named it). The bytes are truncated —
            // committing them would swap torn content over live content.
            // Consume processed (the void already advanced the
            // watermark; the double-count is a no-op) and drop the body.
            if (delivery !== null && delivery.voided === true) {
              consumed = true
              _laneDeliveryDroppedStale(lane.partonId)
              return
            }
            // A streaming-preferred forced lane (a selector nav whose
            // caller opted into progressive commit) commits like a
            // PRODUCER lane: root-ready, so the body's Suspense fallbacks
            // flash while it streams — matching the whole-tree segment's
            // streaming commit, which a fp-skipping ancestor would
            // otherwise deny the forced subtree. It is never a producer
            // (no mid-body `muxlive`), so it need not wait to disambiguate.
            if (
              delivery !== null &&
              delivery.live !== true &&
              _channelNavPrefersStreaming(delivery.asOf)
            ) {
              if (!_channelDeliveryCommittable(delivery.asOf)) {
                consumed = true
                _reportAsOfDrop(delivery.seq)
                _laneDeliveryDroppedStale(lane.partonId)
                return
              }
              const nav = delivery.nav
              // A streaming-preferred forced lane services a user fire —
              // its first commit is exempt from the lane flush quantum.
              _commitPartonLaneProgressive(lane.partonId, node, { urgent: true })
              consumed = true
              _laneDeliveryCommitted(lane.partonId)
              if (nav !== undefined) _channelFrameLaneCommitted(nav)
              const fp = (await trailer) as FpUpdatesPayload | null
              if (fp) _applyFpUpdates(fp)
              if (nav !== undefined) _channelFrameLaneSettled(nav)
              return
            }
            if (delivery === null || delivery.live !== true) {
              await new Promise<void>((resolve) => {
                const dispose = _onLaneProducerAnnounce(lane.partonId, () => resolve())
                trailer.then(
                  () => {
                    dispose()
                    resolve()
                  },
                  () => {
                    dispose()
                    resolve()
                  },
                )
              })
              delivery = _lanePendingDelivery(lane.partonId)
            }
            if (delivery !== null && delivery.voided === true) {
              // Voided mid-wait (see the early guard) — drop, never
              // commit a truncated body.
              consumed = true
              _laneDeliveryDroppedStale(lane.partonId)
              return
            }
            if (delivery !== null && delivery.live === true) {
              // PRODUCER lane: commit progressively at root-ready — the
              // body keeps streaming until the producer resolves, and
              // the committed tree's Suspense fallback holds the
              // producer's place. The as-of guard runs NOW (seq + as-of
              // arrived with the announcement).
              if (!_channelDeliveryCommittable(delivery.asOf)) {
                consumed = true
                // Received but not held — report the drop so the server
                // evicts its optimistic mirror promotions.
                _reportAsOfDrop(delivery.seq)
                _laneDeliveryDroppedStale(lane.partonId)
                return
              }
              const nav = delivery.nav
              // The body is STILL STREAMING — a one-shot walk would stop
              // at the first pending Flight row and cache nothing. The
              // progressive commit walks what has resolved and re-walks
              // as the remaining rows land. The first commit is urgent
              // when a user fire awaits it (a frame nav opening this
              // producer); the token re-walks ride the flush quantum
              // either way.
              _commitPartonLaneProgressive(lane.partonId, node, {
                urgent: nav !== undefined || _channelNavInFlightCovering(delivery.asOf),
              })
              consumed = true
              _laneDeliveryCommitted(lane.partonId)
              if (nav !== undefined) _channelFrameLaneCommitted(nav)
              // The fp trailer lands at the body's close — producer
              // resolve, or a clean cancel/region close (null then).
              const fp = (await trailer) as FpUpdatesPayload | null
              if (fp) _applyFpUpdates(fp)
              if (nav !== undefined) _channelFrameLaneSettled(nav)
              return
            }
            const fp = (await trailer) as FpUpdatesPayload | null
            delivery = _lanePendingDelivery(lane.partonId)
            if (delivery === null) {
              // Unannounced body: a `cancel` statement closed it
              // mid-render (the server writes the muxend so this decode
              // settles and the id can reopen, but no delivery — the
              // content belongs to a superseded statement). Committing
              // it would swap torn content — pending-forever rows —
              // over the page. Nothing to consume: no seq was ever
              // queued.
              consumed = true
              return
            }
            if (delivery.voided === true) {
              // Voided while the trailer resolved — drop, never commit
              // a truncated body.
              consumed = true
              _laneDeliveryDroppedStale(lane.partonId)
              return
            }
            // As-of guard: a lane rendered before the client's
            // navigation point is content of a state the client left —
            // consume it PROCESSED (the watermark advances) and report
            // the drop so the server evicts its mirror promotions; the
            // stream lives on.
            if (!_channelDeliveryCommittable(delivery.asOf)) {
              consumed = true
              _reportAsOfDrop(delivery.seq)
              _laneDeliveryDroppedStale(lane.partonId)
              return
            }
            const nav = delivery.nav
            // Urgent (immediate notify) when a user fire awaits this
            // content — a frame nav's lane, an unsettled covering
            // statement; steady-state streaming lanes coalesce their
            // template re-render per animation frame instead.
            _commitPartonLane(node, fp, lane.partonId, {
              urgent: nav !== undefined || _channelNavInFlightCovering(delivery.asOf),
            })
            // COMMIT is the recording moment — the cache walk above is
            // synchronous, so the subtree is the page's state now. The
            // transport advances its contiguous watermark and acks.
            consumed = true
            _laneDeliveryCommitted(lane.partonId)
            if (nav !== undefined) {
              _channelFrameLaneCommitted(nav)
              _channelFrameLaneSettled(nav)
            }
          } catch (err) {
            // Torn decode (connection died mid-lane, a navigation tear
            // ended the region over this body, or a cancelled producer
            // body closed before its root row) — keep the per-parton
            // seq queue aligned without recording a commit that never
            // happened. A cancelled/torn PRODUCER body's delivery was
            // ANNOUNCED (its seq is on the wire), so it consumes
            // PROCESSED — the stream lives on and a permanent gap
            // would wedge the watermark; an un-announced normal body
            // stall-drops (a nav-torn lane queued no seq at all, so
            // that consume is a no-op).
            if (!consumed) {
              const head = _lanePendingDelivery(lane.partonId)
              if (head !== null && head.live === true) {
                _laneDeliveryDroppedStale(lane.partonId)
              } else {
                _laneDeliveryDropped(lane.partonId)
              }
            }
            throw err
          }
        }
        // A live stream's payload segments carry deliveries (`seq`
        // entries — seq + as-of — ahead of their Flight rows).
        // FETCH-LOCAL pending slot: only this stream's own commits may
        // consume it.
        let pendingSegmentDelivery: WireDelivery | null = null
        const onWireEntry = (tag: string, body: Uint8Array): void => {
          // This fire's own establishment record — read even for a
          // superseded fire (the settle guard below is per-fire).
          if (tag === TAG_CONNECTION_ID) sawConn = true
          // A superseded fire's entries are dead — see `liveFireGen`.
          if (gen !== liveFireGen) return
          // The transport's entries — `conn` handshake, lane-form
          // delivery seqs, the upstream-applied watermark.
          _channelWireEntry(tag, body)
          const delivery = _segmentDelivery(tag, body)
          if (delivery !== null) pendingSegmentDelivery = delivery
        }
        // Consume the fetch-local slot. A function boundary — the slot
        // is written from the wire-entry closure above, which
        // straight-line flow analysis can't see.
        const takeSegmentDelivery = (): WireDelivery | null => {
          const delivery = pendingSegmentDelivery
          pendingSegmentDelivery = null
          return delivery
        }
        try {
          // `onWireEntry` watches the entries for the `conn`
          // handshake — the server-minted connection id, established
          // with the channel transport the moment it is read.
          for await (const segment of splitSegments(body, signal, onWireEntry)) {
            // A superseded fire only DRAINS from here — the cooperative
            // abort needs the splitter moving, but nothing may commit.
            if (gen !== liveFireGen) {
              if (segment.kind === "lanes") {
                for await (const lane of segment.lanes) {
                  await new Response(lane.body).arrayBuffer().catch(() => {})
                }
              } else {
                await new Response(segment.body).arrayBuffer().catch(() => {})
              }
              continue
            }
            if (segment.kind === "lanes") {
              // The subscription is established the moment the lanes
              // region opens. On a catch-up boot (attach anchor honored)
              // this is the FIRST segment — there is no whole-route
              // payload to commit, the client's current tree IS the
              // state — so `streaming` must resolve here, and any
              // records the attach subsumed (re-anchored at navigation
              // point 0) resolve through the same coverage: the
              // catch-up IS their covering statement.
              if (!streamingResolved) {
                streamingResolved = true
                resolveStreaming()
                _channelNavSegmentCommitted(0)
                _channelNavSegmentSettled(0)
              }
              // Per-parton live updates. Lanes for DIFFERENT partons
              // commit concurrently (a slow lane's decode must not
              // gate a fast one — that's the point of the wire
              // format); successive lanes for the SAME parton chain
              // sequentially so commits land in server render order.
              // A torn lane rejects only its own decode — swallowed,
              // nothing was committed for it.
              const laneChains = new Map<string, Promise<void>>()
              for await (const lane of segment.lanes) {
                const prev = laneChains.get(lane.partonId) ?? Promise.resolve()
                const chained = prev.then(() => handleLane(lane)).catch(() => {})
                laneChains.set(lane.partonId, chained)
                allLaneChains.push(chained)
              }
              continue
            }
            let payload: RscPayload
            try {
              payload = await createFromReadableStream<RscPayload>(segment.body)
            } catch (err) {
              // A truncated payload on the live stream: the server's
              // mid-render navigation supersede aborted this segment
              // (a newer url frame made it moot). Its as-of predates
              // the navigation point by construction — consume the
              // delivery PROCESSED and keep reading; the covering
              // segment follows. Any other decode failure propagates.
              const torn = takeSegmentDelivery()
              if (torn !== null && !_channelDeliveryCommittable(torn.asOf)) {
                _segmentDeliveryDroppedStale(torn.seq)
                // The truncated render still COVERED every statement at
                // or below its as-of — those fires were superseded by
                // the newer statement that aborted it, and their
                // milestones must resolve now, not starve until an
                // unrelated later segment (the stuck-traverse class).
                _channelNavSegmentSettled(torn.asOf)
                continue
              }
              throw err
            }
            const delivery = takeSegmentDelivery()
            // The as-of guard: a segment rendered before the client's
            // navigation point is a state the client left. Consume it
            // PROCESSED (the stream lives on) and report the drop so the
            // server evicts its mirror promotions; dropped commits skip
            // trailers too — they would register fingerprints for a
            // stale tree.
            if (delivery !== null && !_channelDeliveryCommittable(delivery.asOf)) {
              _reportAsOfDrop(delivery.seq)
              _segmentDeliveryDroppedStale(delivery.seq)
              // A dropped covering segment still resolves the fires it
              // covered: any record at or below its as-of was superseded
              // by the statement that moved the navigation point — the
              // newest statement's own segment follows (or is this
              // stream's next). Without this, a fire whose segment gets
              // as-of-dropped starves its `finished` (measured: minutes-
              // stuck traverse transitions under rapid back/forward).
              _channelNavSegmentSettled(delivery.asOf)
              continue
            }
            segment.trailers
              .then((trailers) => {
                // Server url pushes gate on the as-of (client-wins —
                // see applyStandardTrailers): the wire as-of of the
                // delivery on the live stream.
                applyStandardTrailers(trailers, {
                  urlAsOf: delivery !== null ? delivery.asOf : 0,
                })
                // Trailers resolve at the segment's `settled` — the
                // covering navigation fires' `finished` milestone.
                if (delivery !== null) {
                  _channelNavSegmentSettled(delivery.asOf)
                }
              })
              .catch(() => {})
            // Commit mode: the live stream commits raw by default
            // (progressive), except when a covering navigation fire
            // asked for the atomic swap.
            const preferTransition =
              delivery !== null && _channelNavPrefersTransition(delivery.asOf)
            if (preferTransition) {
              host.setPayload(payload)
            } else {
              host.setPayloadRaw(payload)
            }
            // COMMIT is the recording moment for the segment's delivery
            // seq — React has been handed the payload; the transport
            // advances its watermark and acks, and covering navigation
            // fires resolve their `streaming` milestone.
            if (delivery !== null) {
              _segmentDeliveryCommitted(delivery.seq)
              _channelNavSegmentCommitted(delivery.asOf)
            }
            // First segment landed and React has been told to render it.
            if (!streamingResolved) {
              streamingResolved = true
              resolveStreaming()
            }
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
          throw new NavigationError({
            kind: "decode",
            url: ATTACH_ENDPOINT,
            cause: err,
          })
        }
        if (!streamingResolved) {
          streamingResolved = true
          resolveStreaming()
        }
        // The stream fully drained — wait for its lane commits to land
        // before settling, so the next fire's establishment can't race
        // this stream's tail commits (chains always settle once the
        // source ended: their bodies end or error with it).
        await Promise.allSettled(allLaneChains)
        revertWebSocketIfNeverEstablished()
        resolveFinished()
      } catch (err) {
        if (!streamingResolved) rejectStreaming(err)
        await Promise.allSettled(allLaneChains)
        revertWebSocketIfNeverEstablished()
        rejectFinished(err)
      }
    })()

    /** The auto-upgrade's fallback (see the doc above): a fire that
     *  settles without EVER establishing while the CURRENT transport is
     *  an unforced WebSocket reverts to fetch, so the close
     *  arbitration's re-attach rides the universal transport instead of
     *  hammering a socket that stopped answering. A superseded fire
     *  keeps its opinion to itself. */
    function revertWebSocketIfNeverEstablished(): void {
      if (sawConn || gen !== liveFireGen) return
      if (isTransportForced()) return
      if (getChannelTransport() instanceof WebSocketTransport) setChannelTransport()
    }

    return { streaming, finished }
  }

  /**
   * The attach transport — the heartbeat's fire. Subsumes the
   * channel's URL timeline (pending statements FOLD INTO the
   * statement: the window statement becomes its `url`, frame
   * statements its `frames` — attach-with-intent), assembles the full
   * statement (uncapped manifest, anchor, seed, watermark, and — on
   * the fire replacing a handover's wound-down connection — the
   * `handoverFrom` continuity link), and consumes the held stream.
   * The transport-upgrade's one-shot flip lands here, so the WebSocket
   * transport installs exactly at the fire that replaces the old
   * connection.
   */
  function fireAttach(
    halves: {
      since: { epoch: string; ts: number } | null
      visible: string[] | null
      applied: number
    },
    signal?: AbortSignal,
  ): { streaming: Promise<void>; finished: Promise<void> } {
    if (upgradeToWebSocketOnNextFire) {
      upgradeToWebSocketOnNextFire = false
      setChannelTransport(new WebSocketTransport())
    }
    const handoverFrom = _takeHandoverFrom()
    const intent = _channelNavSubsumedByAttach()
    const statement: AttachStatement = {
      // The statement's URL: the pending window statement's (with its
      // one-shot `__force` overlay) — the client's history work is
      // done by fire time, so it equals the location plus the overlay
      // — or the current location.
      url: intent.url ?? window.location.pathname + window.location.search,
      // The FULL manifest — the body has no request line to protect;
      // the client pool bounds it structurally.
      cached: getAllCachedPartialTokens(),
      // The handover's replacing attach presents the retained document
      // anchor: the client's holdings are CURRENT (the wound-down
      // connection served everything before closing — this fire is its
      // settle), so a whole-tree first segment would only re-ship what
      // the manifest already covers — and re-ship DEFER partons as
      // their fallbacks, remounting activation triggers the client
      // already fired. Anchored, the new connection opens straight
      // into lanes: everything bumped since the document re-lanes and
      // fp-skips against the fire-time manifest — over-fetch, never
      // stale, zero client-state disruption. The server still refuses
      // a stale anchor (epoch change, frames intent) and falls back to
      // the whole-tree segment.
      since: halves.since ?? (handoverFrom !== null ? _documentCatchupAnchor() : null),
      visible: halves.visible,
      applied: halves.applied,
      ...(intent.frames.length > 0 ? { frames: intent.frames } : {}),
      ...(handoverFrom !== null ? { handoverFrom } : {}),
    }
    return consumeLiveStream(statement, signal)
  }
  ;(window as Window & { __rsc_live_attach?: typeof fireAttach }).__rsc_live_attach = fireAttach

  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet()
    // A committed transport handover in flight settles first (the
    // adopted connection's establishment — normally milliseconds):
    // capturing the binding mid-swap would silently drop the action to
    // unattached semantics, routing its cell writes into a throwaway
    // storage instead of the connection's. Immediate in steady state.
    await _channelHandoverSettled()
    // The URL-statement point at action fire — the as-of this
    // response's server url push is gated on (client-wins: a push the
    // client has stated past — recorded nav OR sync mirror — is a
    // stale suggestion). Captured from the same timeline the gate
    // reads (`_serverUrlPushApplies`).
    const actionIssueNavPoint = _channelUrlStatementPoint()
    // An attached, healthy page names its live connection on the
    // action POST (`x-parton-conn`) — an explicit client statement,
    // never inferred — so the server can reserve the delivery seqs
    // the action's invalidation consequences will ride on that
    // connection. The response's `x-parton-consequences` header
    // carries them back; the optimistic overlay holds until the
    // committed watermark covers them.
    const consequenceConn = _channelNavAvailable() ? _getLiveConnectionId() : null
    // The cached-partial manifest rides the request as the
    // `x-parton-cached` header ONLY when there is no live connection to
    // consult. An attached POST omits it: the server already knows this
    // connection's holdings from its session mirror (what it has
    // delivered), which the action adopts — so re-sending the capped
    // manifest would be redundant. Degraded / pre-establishment pages
    // (`consequenceConn === null`) carry it — there is no mirror.
    const actionHeaders: Record<string, string> = {}
    if (consequenceConn !== null) {
      actionHeaders["x-parton-conn"] = consequenceConn
    } else {
      const cachedIds = getCachedPartialIds()
      if (cachedIds.length > 0) {
        actionHeaders["x-parton-cached"] = cachedIds.join(",")
      }
    }
    const renderRequest = createRscRenderRequest(
      window.location.href,
      {
        id,
        body: await encodeReply(args, { temporaryReferences }),
      },
      Object.keys(actionHeaders).length > 0 ? actionHeaders : undefined,
    )
    const response = await fetch(renderRequest)
    if (!response.ok || !response.body) {
      throw new NavigationError({
        kind: "http",
        url: renderRequest.url,
        status: response.status,
      })
    }
    // Register the consequence gate BEFORE the payload decode — the
    // action's returned promise must never resolve ahead of its own
    // gate's registration, or the overlay's clear point could miss it.
    const consequences = response.headers.get("x-parton-consequences")
    if (consequences) {
      const seqs = consequences
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
      _registerActionConsequences(seqs)
    }
    // Same segmented-Flight decode as the live path. Actions produce a
    // single segment — but the splitter is what lets us pick the
    // trailers off the wire. Without it the url-trailer emitted by
    // `getServerNavigation().navigate(...)` inside an action body
    // never reaches the client and the URL never updates.
    let firstPayload: RscPayload | undefined
    for await (const segment of splitSegments(response.body)) {
      // Action POSTs are one-shot — never lanes.
      if (segment.kind !== "payload") continue
      const payload = await createFromReadableStream<RscPayload>(segment.body, {
        temporaryReferences,
      })
      if (!firstPayload) firstPayload = payload
      segment.trailers
        .then((trailers) => applyStandardTrailers(trailers, { urlAsOf: actionIssueNavPoint }))
        .catch(() => {})
      // A deferred-only action returns `root: null` (no re-render): the
      // already-open streaming connection carries the update instead.
      // Committing a null root would blank the page, so skip the commit
      // — `returnValue` is still captured below and trailers (e.g. a
      // `url` push) still apply. A null root is never committable, so
      // this guard is safe for every action, not just deferred ones.
      if (payload.root != null) host.setPayload(payload)
    }
    if (!firstPayload) {
      throw new NavigationError({
        kind: "decode",
        url: renderRequest.url,
        cause: new Error("Action response had no segments"),
      })
    }
    const { ok, data } = firstPayload.returnValue!
    if (!ok) throw data
    return data
  })

  const offNavigation = listenNavigation(host, (url, types, signal, intent, inPlace) => {
    host.setPendingTransitionTypes(types ?? [])
    const target = new URL(url, window.location.origin)
    // The statement: the client's URL moved. Pre-establishment it
    // latches and rides the attach it triggers; only a DEGRADED
    // page answers null — and degraded pages never intercept, so
    // the null branch is unreachable here.
    const routed = _channelNavigate({
      // A full window navigation STREAMS — the React-default reveal.
      // The destination's Suspense boundaries are newly introduced,
      // so the segment commits root-ready (`setPayloadRaw`): each new
      // boundary shows its fallback immediately, then its content
      // streams in as the nav segment's Flight continuation resolves,
      // exactly as a `startTransition` into a fresh tree behaves. The
      // atomic swap (`streaming: false`) is for navs that REPLACE
      // existing content, where a fallback flash reads as a flicker:
      // selector refetches (`enqueueRefetch`/`refetch.ts`) — and the
      // IN-PLACE navigation (`FrameworkInPlaceInfo` — a scroller's
      // window statement), which by definition describes the position
      // the user already occupies: its segment re-ships the same
      // surface, so a root-ready commit re-suspends the mounted
      // boundaries and hides live content behind fallbacks for the
      // frames until their rows resolve (measured: the visible span
      // blinking to skeletons at a page transition).
      url: target.pathname + target.search,
      intent: intent ?? "push",
      streaming: inPlace !== true,
      signal,
    })
    return routed ? routed.finished : Promise.resolve()
  })
  // The navigate listener above is now intercepting, and this call
  // runs post-hydration (the shell imports this module from its
  // root-level post-commit effect, so every child's hydration handlers
  // are attached). Both "safe to interact" conditions hold; publish
  // the signal.
  markPageInteractive()

  const stopHeartbeat = installLivePageHeartbeat()

  return () => {
    offNavigation()
    stopHeartbeat()
    delete (window as Window & { __rsc_live_attach?: typeof fireAttach }).__rsc_live_attach
  }
}

/** A code edit was announced before the live connection established;
 *  its renav is deferred to the establishment milestone (see below). */
let hmrRenavAwaitingEstablish = false

/** Arm the reattach + state the silent renav — the attached delivery
 *  path: the arm makes the edit's server-side detach close re-fire the
 *  attach immediately, and the fresh graph's catch-up delivers the new
 *  code; the renav covers the case where the reattach's render already
 *  sees the new code. */
function fireHmrRenav(): void {
  // Server-side, the edit bumped the code-version fp term
  // (lib/code-version.ts) — every fp this page advertises now honestly
  // mismatches — and DETACHED every held drive the edit orphaned
  // (lib/connection-session.ts), so the coming close is expected.
  _channelArmReattachOnClose()
  const routed = _channelNavigate({
    url: window.location.pathname + window.location.search,
    intent: "silent",
    streaming: true,
  })
  routed?.finished.catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return
    console.error(err)
  })
}

/**
 * Dev HMR: handle a server-code edit's `rsc:update`. The hydration shell
 * catches the event in the ALWAYS-LOADED initial chunk and defers here
 * (awaiting this module's import first), so an edit that fires before the
 * live layer's module graph has finished loading is never lost. Called
 * only in dev (`import.meta.hot` is undefined in prod; the shell's
 * registration is stripped there).
 *
 * If the connection is already established, the renav fires now — the
 * reliable attached path. If NOT (the boot attach is still in flight —
 * the live layer loads lazily, so an early edit can land in that
 * window), firing now races the boot attach: the reattach arm is a
 * no-op with no connection, and the latched renav can be subsumed by
 * the in-flight attach's own same-URL statement, whose render may
 * predate the server's edit. So defer to the establishment MILESTONE —
 * a real signal, not a timed guess — and fire the renav then, when the
 * arm takes and the render provably post-dates the edit.
 */
export function handleRscUpdate(): void {
  if (_getLiveConnectionId() !== null) {
    fireHmrRenav()
    return
  }
  hmrRenavAwaitingEstablish = true
}

// Registered once (dev): the deferred renav for an edit announced before
// establishment fires on the next `conn` handshake. A microtask defers
// it past the establishment handler's own synchronous finalisation (the
// delivery-tracking reset, the published connection id) so the renav
// states its url against a fully-settled connection.
if (import.meta.hot) {
  onChannelEstablished(() => {
    if (!hmrRenavAwaitingEstablish) return
    hmrRenavAwaitingEstablish = false
    queueMicrotask(fireHmrRenav)
  })
}

function listenNavigation(
  host: LiveHost,
  onNavigation: (
    url: string,
    transitionTypes?: string[],
    signal?: AbortSignal,
    intent?: UrlFrame["intent"],
    /** The nav carried the `FrameworkInPlaceInfo` brand — it replaces
     *  the current surface in place, so its commit mode is the atomic
     *  swap, never the streaming reveal. */
    inPlace?: boolean,
  ) => Promise<void>,
) {
  const nav = getNavigation()
  if (!nav) return () => {}

  // Map a NavigateEvent to a directional transition type. `push` is
  // always treated as forward; `traverse` looks up the destination
  // entry's index in `nav.entries()` (NavigationDestination only
  // exposes `key`, not `index`) and compares to the current entry's
  // index to discriminate forward vs back; `replace` carries no
  // direction signal.
  const directionFor = (event: NavigateEvent): string[] => {
    if (event.navigationType === "push") return ["forward"]
    if (event.navigationType === "traverse") {
      const destKey = event.destination.key
      const entries = nav.entries()
      const destIdx = entries.findIndex((e) => e.key === destKey)
      const curIdx = nav.currentEntry?.index ?? -1
      if (destIdx >= 0 && curIdx >= 0) {
        if (destIdx > curIdx) return ["forward"]
        if (destIdx < curIdx) return ["back"]
      }
    }
    return []
  }

  const handler = (event: NavigateEvent) => {
    if (!event.canIntercept) return
    if (event.hashChange || event.downloadRequest !== null) return
    // `formMethod` isn't on TS 6's NavigateEvent type but is in the
    // spec (and runtime). Reach it via a narrow cast to avoid a type
    // error without broadening `event`'s type everywhere else.
    if ((event as { formMethod?: string | null }).formMethod === "POST") return
    // `window.location.reload()` fires a navigate event with
    // `navigationType: "reload"` that the browser *can* intercept as
    // same-document. Intercepting defeats the whole point of a reload
    // (it re-runs against the existing module state). Pass it through
    // so the browser does a real cross-document reload.
    if (event.navigationType === "reload") return

    // Framework-internal URL syncs stamp a branded `info` payload on
    // their `navigation.navigate(...)` call. Two variants:
    //   - window-silent: caller updated the URL only (or will dispatch
    //     its own targeted refetch).
    //   - frame:         caller pushed a frame-state entry; the frame
    //     subtree refetch runs in `frameNavigateImpl` after commit.
    // In both cases we call `event.intercept()` with no handler to
    // declare the navigation as same-document and avoid a page load —
    // silent URL work is pure client state, so this branch intercepts
    // on DEGRADED pages too.
    //
    // `focusReset: "manual"` opts out of the Navigation API's default
    // post-commit focus reset to <body>. Without it, any input driving
    // a live refetch (the search input typing into `selector: ".…"`,
    // a filter that updates a frame URL, etc.) loses focus on every
    // keystroke.
    //
    // `scroll: "manual"` opts out of the default post-commit scroll. A
    // framework-silent nav is a URL-only sync (a bookmarkable `?page=` /
    // `?q=` the caller updates without a refetch); the default
    // `"after-transition"` would scroll a push/replace to the top, yanking
    // the viewport out from under whatever the user is doing.
    if (isFrameworkSilentInfo(event.info)) {
      // A window-silent URL sync states its URL on the channel
      // (fire-and-forget, intent "silent"): the held connection's
      // request state must follow silent moves too — match gates read
      // the page URL. The claim is UNCONDITIONAL on establishment (only
      // document-nav mode stands it down): a silent nav that lands
      // while the boot attach is still catching up must NOT tear it —
      // the statement latches and rides that very attach (its url is
      // subsumed / ships on establishment as a nav segment). The
      // `_channelNavigate` send self-guards: established → the url
      // frame; pre-establishment → it latches and requests the attach.
      // A selector nav's own refetch statement (dispatched by the
      // initiator right after this event) replaces the pending frame
      // pre-flush, so exactly one url frame ships either way.
      if (event.info.mode === "window" && !_channelIsDegraded()) {
        const dest = new URL(event.destination.url)
        if (!dest.searchParams.has("__frame")) {
          _channelClaimWindowNav()
          _channelNavigate({
            url: dest.pathname + dest.search,
            intent: "silent",
            record: false,
          })
        }
      }
      // A FRAME nav with explicit history (push/replace) stamps a
      // browser entry for an UNCHANGED window URL; its refetch is a
      // frame url statement on the held stream (dispatched by the
      // initiator right after this event) — claim so the boot attach
      // it rides isn't torn (unconditional on establishment; only
      // document-nav mode stands it down).
      if (event.info.mode === "frame" && !_channelIsDegraded()) {
        _channelClaimWindowNav()
      }
      event.intercept({ focusReset: "manual", scroll: "manual" })
      return
    }

    // A DEGRADED page (or one that opted out of the transport) does
    // not intercept: links, traverses and form posts are
    // browser-native document navigations — SSR renders, a plain
    // website.
    if (_channelIsDegraded() || heartbeatDisabled()) return

    // Browser back/forward. Two axes need handling on a traverse:
    //   1. Page URL changed (e.g. /frames-demo?product=beta → /frames-demo)
    //      — a window url statement; the navigation segment re-renders
    //      the tree.
    //   2. Frame snapshots differ between destination and current
    //      — each differing frame needs its server session updated
    //      AND its subtree re-rendered. This fires when the user has
    //      done explicit `history: "push"` / `"replace"` frame navs
    //      (which create browser entries). The default `history:
    //      "auto"` on frames uses `updateCurrentEntry`, which doesn't
    //      create entries, so drawer-shaped frames never show up here.
    //
    // Both axes ride one envelope: the window statement latches
    // navigation-first server-side, the frame statements lane on the
    // reopened region.
    if (event.navigationType === "traverse") {
      const destPaths = _collectFramePaths(_readFramesSnapshot(event.destination.getState?.()))
      const currentPaths = _collectFramePaths(
        _readFramesSnapshot(nav.currentEntry?.getState() ?? null),
      )
      const names = new Set([...Object.keys(destPaths), ...Object.keys(currentPaths)])
      // Each diff entry carries the dotted frame path and the destination URL.
      const diffs: Array<{ key: string; url: string }> = []
      for (const name of names) {
        const dest = destPaths[name]?.url
        const cur = currentPaths[name]?.url
        if (dest && dest !== cur) diffs.push({ key: name, url: dest })
      }
      const urlChanged = event.destination.url !== window.location.href
      if (urlChanged) {
        // Route through `onNavigation` so the framework's transition-
        // type detection runs (forward / back). Frame diffs dispatch
        // their own frame statements alongside — the same rAF flush
        // coalesces window + frame frames into one envelope. Intent
        // "replace": the history move already happened.
        const types = directionFor(event)
        _channelClaimWindowNav()
        event.intercept({
          handler: () =>
            swallowNavigationAbort(async () => {
              const jobs: Array<Promise<unknown>> = [
                onNavigation(
                  event.destination.url,
                  types,
                  event.signal,
                  "replace",
                  isFrameworkInPlaceInfo(event.info),
                ),
              ]
              for (const d of diffs) {
                // The traverse's own signal: a superseding traverse
                // aborts the frame-diff refetches too, so a torn frame
                // lane can't hold this handler's promise open forever.
                jobs.push(
                  _dispatchFrameRefetch(d.key.split("."), d.url, undefined, event.signal).finished,
                )
              }
              await Promise.all(jobs)
            }),
        })
        return
      }
      if (diffs.length > 0) {
        // A pure frame traverse (window URL unchanged): the per-frame
        // statements ride the held stream — keep it.
        _channelClaimWindowNav()
        event.intercept({
          handler: () =>
            swallowNavigationAbort(() =>
              Promise.all(
                diffs.map((d) => _dispatchFrameRefetch(d.key.split("."), d.url).finished),
              ).then(() => undefined),
            ),
        })
        return
      }
    }

    // The everything-else window navigation: a `url` statement. The
    // claim (set synchronously, during this dispatch) tells the
    // heartbeat's deferred abort check to keep the held stream — the
    // navigation's segment arrives ON it. Pre-establishment the
    // statement latches and rides the attach it triggers. The intent
    // mirrors the browser's own history semantic; a traverse's history
    // move already happened, so it states "replace".
    _channelClaimWindowNav()
    event.intercept({
      handler: () =>
        swallowNavigationAbort(() =>
          onNavigation(
            event.destination.url,
            directionFor(event),
            event.signal,
            event.navigationType === "push" ? "push" : "replace",
            isFrameworkInPlaceInfo(event.info),
          ),
        ),
      // An in-place nav (a scroller's window statement) describes the
      // position the user already occupies. The DEFAULT
      // ("after-transition") owes the page a scroll-to-top that
      // Chrome defers while a scroll gesture is live and pays the
      // moment the gesture stops — a teleport out of exactly the
      // position the nav described. Same for focus.
      ...(isFrameworkInPlaceInfo(event.info)
        ? { scroll: "manual" as const, focusReset: "manual" as const }
        : {}),
    })
  }

  nav.addEventListener("navigate", handler)
  return () => nav.removeEventListener("navigate", handler)
}

// Wrap a navigate-intercept handler so AbortError (newer navigation
// supersedes an in-flight one) doesn't surface as an unhandled rejection.
async function swallowNavigationAbort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return
    throw err
  }
}
