"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
  // Per-tab identity. Generated in an effect (not during render) so the
  // server-render pass — which has no `sessionStorage` — doesn't throw,
  // and so two tabs of the same browser get distinct ids.
  const [identity, setIdentity] = useState<Identity | null>(null)
  useEffect(() => {
    let uid = sessionStorage.getItem("cursor-uid")
    if (!uid) {
      uid = Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem("cursor-uid", uid)
    }
    setIdentity({ uid, color: colorFor(uid) })
  }, [])
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
    if (inFlight.current || !pending.current || !identity) return
    const p = pending.current
    pending.current = null
    inFlight.current = true
    void moveCursor(identity.uid, p.x, p.y, identity.color).finally(() => {
      inFlight.current = false
      if (pending.current) flush()
    })
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
        Move your mouse here, then open this page in a second tab (or another
        browser) — each viewer sees every other viewer's cursor. Yours is your
        real cursor; the coloured arrows are everyone else.
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
