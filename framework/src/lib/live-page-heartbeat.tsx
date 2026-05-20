"use client"

import { useEffect } from "react"
import { useNavigation } from "./partial-client.tsx"
import { getLiveSignal, subscribeLiveSignal, setLiveSignal } from "./live-signal.ts"
import { getNavigation } from "../runtime/navigation-api.ts"

/** Delay between successive long-poll reopens while live. Long
 *  enough that:
 *    - networkidle-style test sync primitives can settle when the
 *      page just became non-live (the signal flips after the
 *      delay, before the next reopen);
 *    - a rapid close → reopen cycle doesn't pin a CPU;
 *    - server-driven liveness changes are picked up promptly. */
const REOPEN_DELAY_MS = 1000

/**
 * Auto-injected sibling of `<PartialsClient>` that keeps a streaming
 * connection open to the server, full-page-scoped, whenever the
 * current page has live content.
 *
 * Liveness is server-driven. Each rendered response emits a
 * `live` trailer entry derived from the route's snapshot set:
 * `"1"` if any partial declared a finite `expiresAt` (time-based
 * reactivity) or read a cell, `"0"` otherwise. The client's
 * trailer handler updates `liveSignal`; this component subscribes.
 *
 * Lifecycle:
 *   - Mount → read `getLiveSignal()`. If `true`, open the
 *     long-poll loop. If `false`, stay dormant.
 *   - Subscribe to `liveSignal`. On a `false → true` transition,
 *     wake the loop. On a `true → false` transition, the loop
 *     exits at the next close (the open connection finishes,
 *     `getLiveSignal()` is now false, so no reopen).
 *   - Unmount → cancel the in-flight fetch via `AbortSignal` and
 *     break the loop.
 *
 * Why full-page: the segment driver's fp-skip cascade collapses
 * unchanged partials to zero wire bytes, so a "full-page reload"
 * while idle is essentially free. Narrowing the heartbeat with a
 * selector would add invalidation-routing complexity for no
 * measurable win — the top-down RSC render is the optimization.
 */
export function LivePageHeartbeat() {
  const [reload] = useNavigation().reload()

  useEffect(() => {
    let alive = true
    let inLoop = false
    let controller: AbortController | null = null

    const runLoop = async () => {
      if (inLoop) return
      inLoop = true
      try {
        while (alive && getLiveSignal()) {
          controller = new AbortController()
          try {
            const { finished } = reload({
              streaming: true,
              signal: controller.signal,
            })
            await finished
          } catch {
            // Network error or abort. Same continuation policy:
            // re-check `alive` + signal, then either reopen or exit.
          }
          controller = null
          if (!alive) break
          await new Promise((r) => setTimeout(r, REOPEN_DELAY_MS))
        }
      } finally {
        inLoop = false
      }
    }

    // Initial check: open immediately if the SSR/initial trailer
    // already flipped the signal.
    void runLoop()

    // Subscribe so transitions in either direction take effect
    // promptly:
    //  - `false → true` (e.g. an action result added a live
    //    partial): wake the loop without remounting.
    //  - `true → false` (e.g. navigated to a non-live page):
    //    abort the in-flight reload so the loop exits at its
    //    next signal check, freeing the network for tests that
    //    wait on `networkidle` and avoiding a 20s idle hold-open.
    const unsub = subscribeLiveSignal((live) => {
      if (live) {
        void runLoop()
      } else if (controller) {
        controller.abort()
      }
    })

    // Any user-driven navigation invalidates the in-flight connection —
    // the request was for the old URL and its trailer no longer
    // applies. Drop the signal optimistically and abort; the new
    // page's response trailer will set the signal back up if the
    // destination is also live.
    const nav = getNavigation()
    const onNavigate = () => {
      if (controller) controller.abort()
      setLiveSignal(false)
    }
    nav?.addEventListener("navigate", onNavigate)

    return () => {
      alive = false
      unsub()
      nav?.removeEventListener("navigate", onNavigate)
      if (controller) controller.abort()
    }
  }, [reload])

  return null
}
