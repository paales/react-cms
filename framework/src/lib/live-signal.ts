"use client"

/**
 * Client-side signal that tracks whether the current rendered page
 * has any "live" partials — partials whose vary declared a finite
 * `expiresAt` or that read a cell. The server emits this state as
 * a per-segment trailer entry (`live: "0" | "1"`); the trailer
 * handler updates the signal here; `<LivePageHeartbeat>` subscribes.
 *
 * Lifecycle:
 *   - cold page load → trailer arrives → signal flips to `1` (or
 *     stays `0` if nothing on the page is live) → heartbeat checks
 *     state and opens or stays dormant.
 *   - streaming response segment lands → trailer updates the
 *     signal → if it dropped to `0`, heartbeat closes; if it rose
 *     to `1` while dormant, heartbeat wakes.
 *   - server action response → trailer arrives, same logic.
 *
 * Module-scope state is intentional: every page in this tab shares
 * one heartbeat lifetime; the signal is a tab-wide value.
 */

type Listener = (live: boolean) => void

let current = false
const listeners = new Set<Listener>()

/** Current liveness — `true` if the last-received trailer carried
 *  `live: "1"`. Defaults to `false` before any trailer has been
 *  processed. */
export function getLiveSignal(): boolean {
  return current
}

/** Update the signal. Notifies subscribers on a value transition;
 *  same-value calls are a no-op. */
export function setLiveSignal(value: boolean): void {
  if (value === current) return
  current = value
  for (const l of listeners) l(value)
}

/** Subscribe to transitions. Returns an unsubscribe function. The
 *  listener is called with the new value, NOT the initial value —
 *  callers that need the initial state read `getLiveSignal()`. */
export function subscribeLiveSignal(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Scan the document for the SSR-embedded liveness comment
 * (`<!--parton-live:0|1-->`) and seed the signal. Called once
 * during the browser entry's startup — pairs with the SSR-side
 * emission in `wrapSsrStreamWithFpTrailer`.
 *
 * The comment lives AFTER `</html>` (alongside the fp-trailer
 * comment). On streaming HTML responses the parser may not have
 * reached it yet at hydration time, so the function probes both
 * `document.childNodes` and `document.documentElement.childNodes`
 * (browsers vary on placement). If the comment hasn't arrived
 * yet, the caller can defer to the `load` event.
 */
export function applyLiveStateFromDocument(): void {
  if (typeof document === "undefined") return
  const tag = "parton-live:"
  const candidates: Node[] = []
  for (const c of document.childNodes) candidates.push(c)
  if (document.documentElement) {
    for (const c of document.documentElement.childNodes) candidates.push(c)
  }
  for (const node of candidates) {
    if (node.nodeType !== 8 /* COMMENT_NODE */) continue
    const text = (node as Comment).data
    if (!text.startsWith(tag)) continue
    setLiveSignal(text.slice(tag.length) === "1")
    return
  }
}
