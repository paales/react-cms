"use client"

import { useCallback, useEffect, useRef } from "react"
import { useIsSSR } from "@parton/copies/hooks/use-is-ssr"
import type { ResolvedCell } from "@parton/framework"
import { moveCursor } from "../pages/cursors-actions.ts"
import type { CursorMap } from "../pages/cursors-state.ts"

/** Stable per-uid hue so each viewer keeps one colour across moves. */
function colorFor(uid: string): string {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) % 360
  return `hsl(${h} 80% 55%)`
}

interface Identity {
  uid: string
  color: string
}

let tabIdentity: Identity | undefined
/** Per-tab cursor identity, created once off the render path: a random uid
 *  persisted in sessionStorage (so a refresh keeps it and two tabs differ).
 *  Only read past hydration — see `useIsSSR` in CursorLayer. */
function getTabIdentity(): Identity {
  if (tabIdentity) return tabIdentity
  let uid = sessionStorage.getItem("cursor-uid")
  if (!uid) {
    uid = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem("cursor-uid", uid)
  }
  tabIdentity = { uid, color: colorFor(uid) }
  return tabIdentity
}

/**
 * Multiplayer cursor layer. Tracks the local pointer over the area and
 * writes it up via `moveCursor` (single-inflight + replace-coalesce, so
 * a 60 fps pointer stream self-throttles to one round-trip at a time and
 * only ever sends the latest position). Renders a dot for every OTHER
 * viewer from the shared `cursors` cell — which updates over the open
 * heartbeat stream as peers move. Your own cursor is your real OS
 * cursor; we don't draw it.
 */
export function CursorLayer({ cursors }: { cursors: ResolvedCell<CursorMap> }) {
  // Per-tab identity, resolved only past hydration (useIsSSR) so the SSR pass —
  // which has no `sessionStorage` — never touches it: null during SSR +
  // hydration, the created identity afterwards.
  const identity = useIsSSR() ? null : getTabIdentity()
  // Stamp ready only once `identity` has committed — this effect runs
  // after the re-render that sets it, so by the time the harness sees
  // the attribute, `onPointerMove`/`flush` close over a non-null
  // identity and a move can't silently no-op.
  useEffect(() => {
    if (identity) document.body.setAttribute("data-cursors-ready", "1")
  }, [identity])

  const areaRef = useRef<HTMLDivElement>(null)
  // Single-inflight coalescer: at most one moveCursor in flight; moves
  // during that window collapse to the latest pending position and flush
  // when the in-flight one resolves.
  const inFlight = useRef(false)
  const pending = useRef<{ x: number; y: number } | null>(null)

  const flush = useCallback(() => {
    if (!identity) return
    const id = identity
    // Inner pump drains the coalescer without `flush` referencing itself
    // (which would read the callback before its declaration completes).
    function pump() {
      if (inFlight.current || !pending.current) return
      const p = pending.current
      pending.current = null
      inFlight.current = true
      void moveCursor(id.uid, p.x, p.y, id.color).finally(() => {
        inFlight.current = false
        pump()
      })
    }
    pump()
  }, [identity])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = areaRef.current?.getBoundingClientRect()
      if (!rect) return
      pending.current = {
        x: Math.round(e.clientX - rect.left),
        y: Math.round(e.clientY - rect.top),
      }
      flush()
    },
    [flush],
  )

  const myUid = identity?.uid
  const others = Object.entries(cursors.value ?? {}).filter(([id]) => id !== myUid)

  return (
    <div
      ref={areaRef}
      data-testid="cursor-area"
      onPointerMove={onPointerMove}
      className="relative h-96 w-full overflow-hidden rounded-lg border bg-card"
    >
      <p className="pointer-events-none p-3 text-xs text-muted-foreground">
        Move your mouse here, then open this page in a second tab (or another browser) — each viewer
        sees every other viewer's cursor. Yours is your real cursor; the coloured arrows are
        everyone else.
      </p>
      {/* Stable count for the e2e harness — number of remote cursors. */}
      <span data-testid="remote-cursor-count" className="sr-only">
        {others.length}
      </span>
      {others.map(([id, c]) => (
        <div
          key={id}
          data-testid="remote-cursor"
          data-uid={id}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-[left,top] duration-75 ease-linear"
          style={{ left: c.x, top: c.y, color: c.color }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 2l6 16 2.2-6.2L18 9.8z" />
          </svg>
        </div>
      ))}
    </div>
  )
}
