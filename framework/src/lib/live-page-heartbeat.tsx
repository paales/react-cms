"use client"

import { useEffect } from "react"
import {
  _channelAppliedWatermark,
  _channelConnectionClosed,
  _channelConsumeWindowNavClaim,
  _registerAttachRequester,
  _registerLiveStreamAbort,
} from "./channel-client.ts"
import { _anyCullObservers } from "./cull-park.ts"
import { _takeLiveCatchupAnchor } from "./partial-client-state.ts"
import { _onFirstMeasurement, _visibilityMeasured, _visibleSetIds } from "./visibility.tsx"
import { getNavigation } from "../runtime/navigation-api.ts"

/** Default interval between periodic re-fires. While a streaming
 *  connection is already open, the interval tick is a no-op. */
const DEFAULT_INTERVAL_MS = 5_000

interface Props {
  intervalMs?: number
}

/** The attach transport the browser entry installs — POSTs the full
 *  client statement to `/__parton/live` and consumes the held
 *  segmented stream (see `../entry/browser.tsx`). */
type AttachTransport = (
  halves: {
    since: { epoch: string; ts: number } | null
    visible: string[] | null
    applied: number
  },
  signal?: AbortSignal,
) => { streaming: Promise<void>; finished: Promise<void> }

/**
 * Client component that holds the live connection open — each fire is
 * an ATTACH: a `POST /__parton/live` whose body carries the full
 * client statement (URL + manifest + catch-up anchor + viewport seed +
 * any pre-establishment intent; see `channel-protocol.ts`), answered
 * by the held segmented stream. Mounted once near the React root by
 * the framework's browser bootstrap (`../entry/browser.tsx`); an app
 * assembling its own bootstrap mounts it the same way:
 *
 *   <BrowserRoot />
 *   <LivePageHeartbeat />
 *
 * Why a component (not a top-level function): the first fire
 * needs to happen AFTER two distinct events:
 *   1. React's first commit, which is when
 *      `PartialErrorBoundary.render()` has populated
 *      `_currentPageFingerprints` with the cold fps. `useEffect`
 *      gives us that ordering for free — it runs post-commit.
 *   2. The browser `load` event, which is when the SSR HTML
 *      trailer comment after `</html>` has been parsed and its
 *      warm-fp drift corrections applied
 *      (`_applyFpTrailerFromDocument` registers a `load` listener
 *      that runs `tryApplyTrailerNow`). Without this, the
 *      attach's manifest carries only cold fps; if a
 *      parton's cold fp drifted from warm, the server doesn't
 *      fp-skip and re-renders it. For partons with time-dependent
 *      content (`new Date()`) that's a visible flash.
 *
 * (1) is satisfied by being inside a useEffect. (2) is satisfied
 * by waiting on `document.readyState === "complete"` or a
 * `load` listener. A pre-establishment INTERACTION jumps both
 * queues: the channel transport requests an immediate fire
 * (`_registerAttachRequester`) so the statement rides the attach it
 * triggered — a cold-manifest attach over-fetches, never waits.
 *
 * Behaviour:
 *   - Mount → one attach fire; the transport (channel-client)
 *     establishes on the stream's `conn` handshake.
 *   - Every `intervalMs` (default 5s), re-fires IF no stream is
 *     currently open. While a stream is open the tick is a no-op.
 *     When the server's keepalive elapses, the next tick reattaches —
 *     the transient-reconnect recovery loop.
 *   - Failures are BOUNDED, never sticky. A single failed attach
 *     re-establishes; only a run past the channel's failure bound falls
 *     to document-nav mode (links and form posts become document loads —
 *     fresh SSR renders). Even then the heartbeat KEEPS firing (its
 *     interval is the recovery probe): a later successful attach lifts
 *     the mode and restores channel navigation.
 *   - On a `navigate`, the deferred abort check consumes the
 *     channel's navigation claim: a CLAIMED navigation (the navigate
 *     listener stated it on the channel) KEEPS the stream — the
 *     navigation segment arrives on it. An unclaimed one aborts the
 *     in-flight stream; the next tick reattaches on the now-current
 *     state. The abort is cooperative: the transport
 *     (`splitSegments`) holds it until the in-flight segment's render
 *     has settled, so it never closes a body mid-render.
 *
 * Actions complete with one-shot responses and call
 * `refreshSelector` inside their bodies. The already-open stream
 * wakes on the bump and emits the next lanes. There's never
 * more than one streaming connection per page lifetime.
 */
export function LivePageHeartbeat({ intervalMs = DEFAULT_INTERVAL_MS }: Props = {}) {
  useEffect(() => {
    // When `window.__partonHeartbeatDisabled` is set, the heartbeat
    // holds no connection and never fires — the page opts out of the
    // interactive transport entirely (the navigate listener stands
    // down too; every navigation is a document load). e2e specs that
    // assert on document-shaped behavior set it via
    // `page.addInitScript`.
    if ((window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled) {
      return
    }
    let alive = true
    let inFlight: AbortController | null = null

    const fire = () => {
      if (!alive) return
      if (inFlight) return
      // No degrade gate: failures are BOUNDED, never sticky. Even in
      // document-nav mode (a run of failures fell back to document loads)
      // the heartbeat KEEPS firing — its interval is the recovery probe.
      // A later successful attach lifts the mode and restores channel
      // navigation (`_channelConnectionClosed` clears it on establish /
      // delivered ack).
      const attach = (window as Window & { __rsc_live_attach?: AttachTransport }).__rsc_live_attach
      if (!attach) return
      // A page with mounted viewport observers ALWAYS measures (the
      // IntersectionObserver fires an initial callback per target), so
      // wait for the first measurement rather than open an unmeasured
      // connection: an unmeasured first segment renders the whole route
      // against the cold seed — bytes the client already has — and the
      // measurement lands milliseconds later anyway. The waiter fires
      // exactly once, on the report that flips `measured`; pages with
      // no cullable partons have nothing to wait for.
      if (_anyCullObservers() && !_visibilityMeasured()) {
        _onFirstMeasurement(fire)
        return
      }
      inFlight = new AbortController()
      // Each fire is one connection — an ATTACH: a POST whose body
      // carries the full client statement (see `channel-protocol.ts`).
      // This component contributes the anchor + seed + watermark
      // halves; the transport folds in the URL statement, the uncapped
      // manifest, and any pre-establishment intent at fire time. The
      // SERVER mints the fire's connection id at session open and
      // ships it down as the stream's `conn` entry; the channel
      // transport establishes on receipt (setting the presence-only
      // `data-parton-live` marker), so envelopes can address the
      // session the moment the handshake arrives.
      //
      // The document's registry anchor (take-once): presenting it lets
      // the server open the connection straight into lanes — only what
      // bumped after the document rendered — instead of replaying the
      // whole route the document just delivered. Reattaches (anchor
      // consumed) present `since: null` and take the full initial
      // segment.
      const { finished } = attach(
        {
          since: _takeLiveCatchupAnchor(),
          visible: _visibleSetIds() ?? null,
          // The upstream watermark the client last heard applied — the
          // new session's `applied` gate seeds from it, keeping the
          // downstream marker on the page-lifetime envelope timeline.
          applied: _channelAppliedWatermark(),
        },
        inFlight.signal,
      )
      finished
        .then(
          () => false,
          // Our own supersede (the navigate abort, teardown) is never a
          // degrade signal — the transport's close arbitration needs to
          // know the difference.
          (err) => err instanceof Error && err.name === "AbortError",
        )
        .then((aborted) => {
          inFlight = null
          _channelConnectionClosed({ aborted })
        })
    }

    // A pre-establishment statement's ride: the channel transport
    // requests an immediate fire so the interaction rides the attach
    // it triggered. No-op while a fire is in flight (the statement
    // flushes on that fire's establishment instead).
    _registerAttachRequester(fire)

    // Defer the initial fire until BOTH have happened:
    //   1. React's first commit (we're here, that's done).
    //   2. The browser `load` event (or already complete).
    // (2) is what populates the warm-fp drift corrections from the
    // SSR HTML comment after `</html>` — only the trailing-comment
    // listener can fill those in. Firing before (2) means the
    // attach's manifest carries only cold fps,
    // and any parton whose cold fp drifted from warm gets re-
    // rendered. For partons with time-dependent content
    // (`new Date()`) that's a visible flash on first heartbeat.
    let timer: ReturnType<typeof setInterval> | null = null
    const startCadence = () => {
      if (!alive) return
      fire()
      timer = setInterval(fire, intervalMs)
    }
    if (typeof document === "undefined" || document.readyState === "complete") {
      startCadence()
    } else {
      window.addEventListener("load", startCadence, { once: true })
    }

    const nav = getNavigation()
    const onNavigate = () => {
      // A navigation the channel carries KEEPS the stream — the url
      // frame moves the server's request state and the nav segment
      // arrives on this very connection; tearing it would strand the
      // navigation. The router (the browser entry's navigate listener)
      // sets the claim synchronously during this same event dispatch,
      // and this listener registered FIRST (child effects run before
      // the parent's), so the check defers one microtask — after every
      // listener ran, before the intercept handler. Unclaimed
      // navigations (pre-establishment interactions racing an in-flight
      // attach on the old URL, frame session updates) abort as always:
      // the settle's arbitration reattaches on the now-current state.
      // The abort is cooperative — the transport (`splitSegments`)
      // holds it until the in-flight segment's render has settled, so
      // it never tears a mid-render body.
      queueMicrotask(() => {
        if (_channelConsumeWindowNavClaim()) return
        if (inFlight) inFlight.abort()
      })
    }
    nav?.addEventListener("navigate", onNavigate as EventListener)

    // The escape hatch the envelope-failure path pulls: abort the kept
    // stream so its settle re-attaches on the current state instead of
    // idling on the old one for the keepalive.
    _registerLiveStreamAbort(() => {
      if (inFlight) inFlight.abort()
    })

    return () => {
      alive = false
      if (timer) clearInterval(timer)
      window.removeEventListener("load", startCadence)
      nav?.removeEventListener("navigate", onNavigate as EventListener)
      _registerLiveStreamAbort(null)
      _registerAttachRequester(null)
      if (inFlight) inFlight.abort()
    }
  }, [intervalMs])

  return null
}
