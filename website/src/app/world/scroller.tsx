"use client"

import { useEffect, useRef, type ReactNode } from "react"
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
 */
export function WorldScroller({ children }: { children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    if (!("scrollInitialTarget" in document.documentElement.style)) {
      scroller.scrollTo(
        CENTER_PX - scroller.clientWidth / 2,
        CENTER_PX - scroller.clientHeight / 2,
      )
    }

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
      <div className="plane" data-testid="world-plane">
        <div className="center-anchor" aria-hidden />
        {children}
      </div>
    </div>
  )
}
