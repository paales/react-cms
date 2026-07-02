"use client"

/**
 * Read-tracked view culling — the client half of `visible()`.
 *
 * A parton that reads `visible()` ([[server-hooks]]) is CULLABLE: its
 * fingerprint folds its viewport state, so it re-renders when it enters or
 * leaves the viewport. The server marks such a boundary `cullable`; on the
 * client the boundary wraps its rendered children in a `<Fragment ref>`
 * and observes them with an IntersectionObserver via React 19.3's
 * `FragmentInstance.observeUsing` — no wrapper element, no `data-*` id
 * stamping. The boundary already knows its own id, so it reports
 * `{ id, inView }` straight from its closure.
 *
 * Reports funnel into a module-level controller (mirroring the refetch
 * batch / partial cache — client state lives at module scope, not in
 * context). The controller coalesces a frame's worth of reports and
 * delivers the flips over one of two transports:
 *
 *   - **Live connection open** (`_getLiveConnectionId()` non-null): a
 *     fire-and-forget POST to the framework's visibility endpoint
 *     ([[visibility-protocol]]), addressed to the connection by its
 *     explicit id. No response body — the server updates the connection
 *     session's visible set and renders the flipped partons as lane
 *     segments on the EXISTING stream, so flips never race the
 *     connection's own renders. A non-`204` answer (connection gone)
 *     falls the batch back to the reload path.
 *   - **No live connection**: SELF-REFETCH the flipped partons by id,
 *     carrying the full visible set as `?visible=` so each re-rendered
 *     parton's `visible()` reads its own bit. fp-skip prunes the rest.
 *
 * Both transports serialize: one dispatch in flight, re-firing with the
 * latest set when it changes.
 */

import React, { useEffect, useRef } from "react"
import { _windowNav } from "./partial-client.tsx"
import { _getLiveConnectionId, _setLiveConnectionId } from "./partial-client-state.ts"
import type { VisibleOptions } from "./current-parton.ts"
import { VISIBILITY_ENDPOINT, type VisibilityReport } from "./visibility-protocol.ts"

/** How far beyond the viewport a parton counts as "in view" — the runway,
 *  so a parton fills before it's literally on screen. Expressed as an
 *  IntersectionObserver `rootMargin`. */
const RUNWAY = "600px 0px"

/** Max flipped ids per culling reload. A fast scroll across a large
 *  cullable field (the website's chunk world) can flip hundreds of
 *  partons in one coalesced flush; unbatched, the `?partials=` list
 *  alone would blow the server's request-line limit. Remaining flips
 *  stay in `changed` and ride the next serialized flush. */
const FLUSH_BATCH = 48

/** Max flipped ids per report POST. The ids ride the JSON body (no
 *  request-line limit), so the cap is much higher than the reload
 *  path's — it only bounds how many concurrent lane renders one report
 *  can ask of the server. */
const POST_FLUSH_BATCH = 256

/** The subset of `FragmentInstance` (React 19.3) this module uses. The
 *  installed react-dom exposes these; `@types/react` may not type a
 *  Fragment `ref` yet, so we shape it locally and cast at the ref site. */
interface FragmentInstance {
  observeUsing(observer: IntersectionObserver): void
  unobserveUsing(observer: IntersectionObserver): void
  getClientRects(): DOMRect[]
}

// ─── Controller (module-level client state) ───────────────────────────

/** ids currently within the runway-expanded viewport. */
const inView = new Set<string>()
/** ids whose in/out state changed since the last flush — the refetch set. */
let changed = new Set<string>()
/** Whether ANY viewport report has landed yet. Gates the visible-set
 *  param/report: before the first report the correct wire state is
 *  "unmeasured" (no set at all — partons render their cold seed), never
 *  the empty set (which means "everything out"). */
let measured = false
/** Monotonic report sequence — the server applies a report's `visible`
 *  set only when newer than the last applied one, so two in-flight
 *  POSTs can't commit an older set over a newer one. */
let reportSeq = 0
let rafScheduled = false
let inFlight = false

/** Report a cullable parton's viewport state. Idempotent per state; only a
 *  real flip schedules a refetch. */
export function reportVisible(id: string, isInView: boolean): void {
  measured = true
  if (inView.has(id) === isInView) return
  if (isInView) inView.add(id)
  else inView.delete(id)
  changed.add(id)
  schedule()
}

/** The current visible set as a `?visible=` param value, or `undefined`
 *  before the first viewport report (the unmeasured state — send no
 *  param). The heartbeat seeds each `?live=1` fire with this so the
 *  connection session starts from the client's measured set and the
 *  whole-tree first segment already renders against it. */
export function _visibleSetParam(): string | undefined {
  if (!measured) return undefined
  return [...inView].join(",")
}

/** Push the full current visible set to a just-established live
 *  connection (`changed` empty — nothing to lane-render, just state
 *  sync). The heartbeat calls this when it publishes the connection id:
 *  flips that fired between the connection's `?visible=` seed and the
 *  id's publication rode the reload fallback, so the session's set may
 *  lag the client's — this closes that gap. Failure needs no handling:
 *  a failed sync means the connection is gone, which the heartbeat's
 *  own settle path already handles by clearing the id. */
export function _syncConnectionVisibility(connection: string): void {
  if (!measured) return
  void postVisibilityReport(connection, [])
}

/** A cullable boundary unmounted (scrolled out of the window entirely).
 *  Drop it from the set so `?visible=` doesn't carry a stale id — but
 *  don't refetch it (it's gone); the cleanup rides the next real flush. */
export function reportGone(id: string): void {
  inView.delete(id)
  changed.delete(id)
}

function schedule(): void {
  if (rafScheduled || typeof requestAnimationFrame === "undefined") return
  rafScheduled = true
  requestAnimationFrame(() => {
    rafScheduled = false
    void flush()
  })
}

async function flush(): Promise<void> {
  // Serialize: one dispatch in flight. Newer flips accumulate in `changed`
  // and fire when it lands (the `finally` re-checks).
  if (inFlight || changed.size === 0) return

  // Live connection open: deliver the flips as a fire-and-forget report
  // POST. The response carries no body — the flipped partons' bytes come
  // down the live stream as lane segments. No navigation-transition
  // deferral here: a report commits nothing client-side, so it cannot
  // supersede or tear a mid-flight route swap the way a reload can.
  const connection = _getLiveConnectionId()
  if (connection !== null) {
    const all = [...changed]
    const targets = all.slice(0, POST_FLUSH_BATCH)
    changed = new Set(all.slice(POST_FLUSH_BATCH))
    inFlight = true
    try {
      const delivered = await postVisibilityReport(connection, targets)
      if (!delivered) {
        // The server's explicit "connection not open" signal (or the
        // POST never reached it). Clear the published id so the batch —
        // and everything after it, until the heartbeat re-establishes —
        // rides the render-reload fallback.
        if (_getLiveConnectionId() === connection) _setLiveConnectionId(null)
        for (const id of targets) changed.add(id)
      }
    } finally {
      inFlight = false
      if (changed.size > 0) schedule()
    }
    return
  }

  // Reload fallback (no live connection): culling is a POST-SETTLE
  // operation. A refetch fired while a page navigation is still
  // committing supersedes it and tears the route swap — the old route
  // stays visible and the new one never lands (the IO fires as the new
  // route's cold partons mount, i.e. mid-navigation). Defer until the
  // in-flight navigation finishes, then re-flush. `navigation.transition`
  // is the real signal (non-null only while a navigation is committing),
  // so this doesn't guess.
  const transition = (
    window as unknown as { navigation?: { transition?: { finished: Promise<unknown> } | null } }
  ).navigation?.transition
  if (transition) {
    transition.finished.then(schedule, schedule)
    return
  }
  const all = [...changed]
  const targets = all.slice(0, FLUSH_BATCH)
  changed = new Set(all.slice(FLUSH_BATCH))
  inFlight = true
  try {
    await _windowNav().reload({
      selector: targets.map((id) => `#${id}`),
      params: { visible: [...inView].join(",") },
    }).finished
  } catch {
    // AbortError on supersede / NavigationError on a racing nav — both
    // benign here; the next flush re-fires with the current set.
  } finally {
    inFlight = false
    if (changed.size > 0) schedule()
  }
}

/** POST one visibility report to the framework endpoint. `true` iff the
 *  server applied it (`204`); `false` on any other answer or a network
 *  failure — the caller's fall-back-to-reload signal. */
async function postVisibilityReport(
  connection: string,
  changedIds: string[],
): Promise<boolean> {
  const report: VisibilityReport = {
    connection,
    seq: ++reportSeq,
    changed: changedIds,
    visible: [...inView],
  }
  try {
    const res = await fetch(VISIBILITY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      // Fire-and-forget: let an in-flight report survive a page unload.
      keepalive: true,
    })
    return res.status === 204
  } catch {
    return false
  }
}

// ─── Boundary observer ────────────────────────────────────────────────

/**
 * Wraps a cullable parton's children in a `<Fragment ref>` and observes
 * their viewport intersection, reporting to the controller under the
 * parton's own id. Rendered by `PartialErrorBoundary` only when the server
 * marked the parton cullable; non-cullable partons render their children
 * bare (no Fragment, no observer, zero cost).
 *
 * The Fragment is transparent (no DOM) and renders identically on server
 * and client, so it doesn't shift the hydrated tree; the ref attaches and
 * the observer starts only on the client, in an effect.
 */
export function VisibilityObserver({
  id,
  options,
  children,
}: {
  id: string
  options?: VisibleOptions
  children: React.ReactNode
}): React.ReactNode {
  const ref = useRef<FragmentInstance | null>(null)
  const rootMargin = options?.rootMargin ?? RUNWAY
  useEffect(() => {
    const inst = ref.current
    if (!inst || typeof inst.observeUsing !== "function") return
    // An IO callback batch contains only the nodes whose intersection
    // CHANGED — with many observed children (a fragment of chunk
    // subtrees), one leaving node must not read as "the whole parton
    // left". Track per-node state and report the aggregate.
    const nodeState = new Map<Element, boolean>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) nodeState.set(e.target, e.isIntersecting)
        for (const el of [...nodeState.keys()]) {
          if (!el.isConnected) nodeState.delete(el)
        }
        reportVisible(id, [...nodeState.values()].some(Boolean))
      },
      { rootMargin },
    )
    inst.observeUsing(io)
    return () => {
      try {
        inst.unobserveUsing(io)
      } catch {
        // unobserve after the fragment's nodes already left the tree
      }
      io.disconnect()
      reportGone(id)
    }
  }, [id, rootMargin])
  // `ref` on a Fragment yields a FragmentInstance (React 19.3). Built via
  // `createElement` so the ref prop isn't gated by the JSX intrinsic types
  // (the installed react-dom supports it even where `@types/react` doesn't).
  return React.createElement(React.Fragment, { ref } as never, children)
}
