"use client"

import { useEffect } from "react"
import { useNavigation } from "./partial-client.tsx"
import { getNavigation } from "../runtime/navigation-api.ts"

/** Default interval between periodic re-fires. While a streaming
 *  connection is already open, the interval tick is a no-op. */
const DEFAULT_INTERVAL_MS = 5_000

interface Props {
  intervalMs?: number
}

/**
 * Opt-in client component that holds a `?streaming=1` long-poll
 * connection to the current URL open. Mount it once near the app's
 * React root (typically from `entry.browser.tsx`):
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
 *      heartbeat's first request carries only cold fps; if a
 *      parton's cold fp drifted from warm, the server doesn't
 *      fp-skip and re-renders it. For partons with time-dependent
 *      content (`new Date()`) that's a visible flash.
 *
 * (1) is satisfied by being inside a useEffect. (2) is satisfied
 * by waiting on `document.readyState === "complete"` or a
 * `load` listener.
 *
 * Behaviour:
 *   - Mount → fire one `reload({streaming: true})`. Batches with
 *     any in-tick client-side activator fires (when-mounted,
 *     when-visible) via `enqueueRefetch`'s per-microtask coalescer.
 *   - Every `intervalMs` (default 5s), re-fires IF no stream is
 *     currently open. While a stream is open the tick is a no-op.
 *     When the server's keepalive elapses, the next tick reopens.
 *   - On any `navigate`, aborts the in-flight stream; the next
 *     interval tick opens a fresh connection on the now-current URL.
 *     Every page change is a partial change here, so the stream is
 *     always reopened for the new URL — there is no "same page" to
 *     keep it for. The abort is cooperative: the transport
 *     (`splitSegments`) holds it until the in-flight segment's render
 *     has settled, so it never closes a body mid-render (which would
 *     reject the committed payload's pending references —
 *     "Connection closed." — and tear the visible page). See
 *     `docs/internals/streaming.md`.
 *
 * Actions complete with one-shot responses and call
 * `refreshSelector` inside their bodies. The already-open stream
 * wakes on the bump and emits the next segment. There's never
 * more than one streaming connection per page lifetime.
 */
export function LivePageHeartbeat({ intervalMs = DEFAULT_INTERVAL_MS }: Props = {}) {
  const [reload] = useNavigation().reload()

  useEffect(() => {
    // When `window.__partonHeartbeatDisabled` is set, the heartbeat
    // holds no connection and never fires. e2e specs that assert on
    // deterministic RSC traffic or interaction state set it (via
    // `page.addInitScript`) so the periodic streaming connection
    // doesn't add background requests they'd otherwise observe.
    if ((window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled) {
      return
    }
    let alive = true
    let inFlight: AbortController | null = null

    const fire = () => {
      if (!alive) return
      if (inFlight) return
      inFlight = new AbortController()
      const { finished } = reload({ streaming: true, signal: inFlight.signal })
      finished
        .catch(() => {
          // Network error / abort. Clear the in-flight slot so the
          // next interval tick can reopen.
        })
        .finally(() => {
          inFlight = null
        })
    }

    // Defer the initial fire until BOTH have happened:
    //   1. React's first commit (we're here, that's done).
    //   2. The browser `load` event (or already complete).
    // (2) is what populates the warm-fp drift corrections from the
    // SSR HTML comment after `</html>` — only the trailing-comment
    // listener can fill those in. Firing before (2) means the
    // heartbeat's first request carries only cold fps in `?cached=`,
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
      // Every navigation reopens the stream for the now-current URL: in
      // this framework all page changes are partial, so there is no
      // "same page" to keep the old stream for. The abort is safe — it's
      // cooperative in the transport (`splitSegments` holds it until the
      // in-flight segment's render has settled), so it never tears a
      // mid-render body. The next interval tick reopens on the new URL.
      if (inFlight) inFlight.abort()
    }
    nav?.addEventListener("navigate", onNavigate as EventListener)

    return () => {
      alive = false
      if (timer) clearInterval(timer)
      window.removeEventListener("load", startCadence)
      nav?.removeEventListener("navigate", onNavigate as EventListener)
      if (inFlight) inFlight.abort()
    }
  }, [reload, intervalMs])

  return null
}
