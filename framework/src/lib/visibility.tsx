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
 * SELF-REFETCHES the partons whose visibility changed, by id, carrying the
 * full visible set as `?visible=` so each re-rendered parton's `visible()`
 * reads its own bit. fp-skip prunes the rest. Refetches serialize: one in
 * flight, re-firing with the latest set when it changes.
 */

import React, { useEffect, useRef } from "react"
import { _windowNav } from "./partial-client.tsx"
import type { VisibleOptions } from "./current-parton.ts"

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
let rafScheduled = false
let inFlight = false

/** Report a cullable parton's viewport state. Idempotent per state; only a
 *  real flip schedules a refetch. */
export function reportVisible(id: string, isInView: boolean): void {
  if (inView.has(id) === isInView) return
  if (isInView) inView.add(id)
  else inView.delete(id)
  changed.add(id)
  schedule()
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
  // Serialize: one refetch in flight. Newer flips accumulate in `changed`
  // and fire when it lands (the `finally` re-checks).
  if (inFlight || changed.size === 0) return
  // Culling is a POST-SETTLE operation. A refetch fired while a page
  // navigation is still committing supersedes it and tears the route swap —
  // the old route stays visible and the new one never lands (the IO fires as
  // the new route's cold partons mount, i.e. mid-navigation). Defer until the
  // in-flight navigation finishes, then re-flush. `navigation.transition` is
  // the real signal (non-null only while a navigation is committing), so this
  // doesn't guess.
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
