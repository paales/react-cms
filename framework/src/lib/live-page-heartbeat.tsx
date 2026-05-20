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
 * Why a component (not a top-level function): the heartbeat needs
 * to fire AFTER React's first commit so partial fingerprints from
 * `PartialErrorBoundary.render()` have populated
 * `_currentPageFingerprints`. A useEffect runs post-commit, which
 * gives us that ordering for free. Calling `startLivePageHeartbeat()`
 * synchronously after `hydrateRoot` runs ahead of React and the
 * first request goes out without `?cached=`, forcing a full re-
 * render on every page load.
 *
 * Behaviour:
 *   - Mount → fire one `reload({streaming: true})`. Batches with
 *     any in-tick client-side activator fires (when-stored,
 *     when-visible) via `enqueueRefetch`'s per-microtask coalescer.
 *   - Every `intervalMs` (default 5s), re-fires IF no stream is
 *     currently open. While a stream is open the tick is a no-op.
 *     When the server's keepalive elapses, the next tick reopens.
 *   - On `navigate` (URL change), aborts the in-flight stream.
 *     The framework's nav handler opens the new page's fetch;
 *     once that fetch commits, the next interval tick opens a
 *     fresh streaming connection on the new URL.
 *
 * Actions complete with one-shot responses and call
 * `refreshSelector` inside their bodies. The already-open stream
 * wakes on the bump and emits the next segment. There's never
 * more than one streaming connection per page lifetime.
 */
export function LivePageHeartbeat({ intervalMs = DEFAULT_INTERVAL_MS }: Props = {}) {
  const [reload] = useNavigation().reload()

  useEffect(() => {
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

    fire()
    const timer = setInterval(fire, intervalMs)

    const nav = getNavigation()
    const onNavigate = () => {
      if (inFlight) inFlight.abort()
    }
    nav?.addEventListener("navigate", onNavigate)

    return () => {
      alive = false
      clearInterval(timer)
      nav?.removeEventListener("navigate", onNavigate)
      if (inFlight) inFlight.abort()
    }
  }, [reload, intervalMs])

  return null
}
