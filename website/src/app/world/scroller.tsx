"use client"

import { useEffect, useRef, type ReactNode } from "react"
// Deep path: `"use client"` modules import framework client symbols
// directly, never through the server barrel.
import { reportTelemetry } from "@parton/framework/lib/telemetry.ts"
import { CENTER_PX } from "./constants.ts"

/**
 * The world scroller — a real overflow scroller over the 32768px
 * plane, so culling rides the same IntersectionObserver mechanics as
 * any scrolled page. Native input (wheel, touch pan, scrollbar) works
 * untouched; WASD integrates velocity into scrollLeft/Top per frame;
 * desktop mouse-drag pans one-to-one. The initial position — centered
 * on chunk 0,0 — is CSS (`scroll-initial-target` on the center
 * anchor); the effect only backfills it where the property isn't
 * supported.
 *
 * The scroller is also the world's telemetry producer: every scroll
 * event states viewport box, position, and velocity through
 * `reportTelemetry` (the channel's lossy class — newest-wins, rides
 * envelopes other statements justify, adds no traffic of its own).
 * Server-side, the warm projector (./warm.ts) turns the statements
 * into predictive chunk warming.
 *
 * `chunkPx` follows the page's selected geometry: it drives the
 * plane's `--chunk` CSS variable (chunk box size + major grid lines)
 * and a `data-chunk` hook for density-specific type. The default
 * geometry passes nothing — the plane renders exactly the 512 world.
 */
export function WorldScroller({ children, chunkPx }: { children: ReactNode; chunkPx?: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    if (!("scrollInitialTarget" in document.documentElement.style)) {
      scroller.scrollTo(CENTER_PX - scroller.clientWidth / 2, CENTER_PX - scroller.clientHeight / 2)
    }

    // ── Telemetry — position + velocity from consecutive scroll events ──
    // Velocity is the finite difference between successive scroll
    // events (native scrolling fires them per frame). The report is a
    // module-variable write; the transport coalesces and sends only
    // when an envelope fires anyway.
    let lastScrollT = 0
    let lastScrollX = 0
    let lastScrollY = 0
    const onScroll = () => {
      const now = performance.now()
      const x = scroller.scrollLeft
      const y = scroller.scrollTop
      if (lastScrollT !== 0 && now > lastScrollT) {
        const dt = (now - lastScrollT) / 1000
        reportTelemetry({
          viewport: { w: scroller.clientWidth, h: scroller.clientHeight },
          scroll: { x, y, vx: (x - lastScrollX) / dt, vy: (y - lastScrollY) / dt },
          at: now,
        })
      }
      lastScrollT = now
      lastScrollX = x
      lastScrollY = y
    }
    scroller.addEventListener("scroll", onScroll, { passive: true })

    // ── WASD — velocity integrated into scroll position ──
    const held = new Set<string>()
    const SPEED = 720 // px/s
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0
      last = now
      let dx = 0
      let dy = 0
      if (held.has("a")) dx -= 1
      if (held.has("d")) dx += 1
      if (held.has("w")) dy -= 1
      if (held.has("s")) dy += 1
      if (dx || dy) {
        const norm = dx && dy ? Math.SQRT1_2 : 1
        scroller.scrollLeft += dx * norm * SPEED * dt
        scroller.scrollTop += dy * norm * SPEED * dt
      }
      raf = requestAnimationFrame(tick)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === "w" || k === "a" || k === "s" || k === "d") held.add(k)
    }
    const onKeyUp = (e: KeyboardEvent) => held.delete(e.key.toLowerCase())
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    raf = requestAnimationFrame(tick)

    // ── Desktop mouse drag — touch pans natively via touch-action ──
    let dragging = false
    let lastPointer = { x: 0, y: 0 }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      // Interactive world content owns its clicks: a pan started on a
      // control would capture the pointer, and capture retargets the
      // click to the scroller — the control never fires (the auction
      // district's BID button). Pan starts on ground, never on controls.
      if (e.target instanceof Element && e.target.closest("button, a, input, select, textarea"))
        return
      dragging = true
      lastPointer = { x: e.clientX, y: e.clientY }
      scroller.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      scroller.scrollLeft -= e.clientX - lastPointer.x
      scroller.scrollTop -= e.clientY - lastPointer.y
      lastPointer = { x: e.clientX, y: e.clientY }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      scroller.releasePointerCapture(e.pointerId)
    }
    scroller.addEventListener("pointerdown", onPointerDown)
    scroller.addEventListener("pointermove", onPointerMove)
    scroller.addEventListener("pointerup", onPointerUp)
    scroller.addEventListener("pointercancel", onPointerUp)

    return () => {
      cancelAnimationFrame(raf)
      scroller.removeEventListener("scroll", onScroll)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      scroller.removeEventListener("pointerdown", onPointerDown)
      scroller.removeEventListener("pointermove", onPointerMove)
      scroller.removeEventListener("pointerup", onPointerUp)
      scroller.removeEventListener("pointercancel", onPointerUp)
    }
  }, [])

  return (
    <div ref={scrollerRef} className="scroller" data-testid="world-scroller">
      <div
        className="plane"
        data-testid="world-plane"
        {...(chunkPx === undefined
          ? {}
          : {
              "data-chunk": chunkPx,
              style: { "--chunk": `${chunkPx}px` } as React.CSSProperties,
            })}
      >
        <div className="center-anchor" aria-hidden />
        {children}
      </div>
    </div>
  )
}
