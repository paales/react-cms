"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { PLANE_PX } from "./constants.ts"

/**
 * The world camera: a full-viewport surface panning an absolutely
 * positioned plane. Position lives in a ref and is applied straight to
 * the plane's transform — panning never re-renders React, so the
 * server-rendered chunks underneath stay untouched while the user
 * moves. WASD pans via a rAF integrator; pointer drag pans one-to-one
 * (mouse and touch both, via pointer capture). The camera starts
 * centered on the plane's midpoint — chunk 0,0's center.
 */
export function WorldCamera({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const planeRef = useRef<HTMLDivElement>(null)
  // Camera position in plane coordinates (the point at viewport center).
  const pos = useRef({ x: PLANE_PX / 2, y: PLANE_PX / 2 })

  useEffect(() => {
    const viewport = viewportRef.current
    const plane = planeRef.current
    if (!viewport || !plane) return

    const apply = () => {
      const vw = viewport.clientWidth
      const vh = viewport.clientHeight
      plane.style.transform = `translate3d(${vw / 2 - pos.current.x}px, ${vh / 2 - pos.current.y}px, 0)`
    }
    apply()

    // ── WASD — velocity integrated per frame ──
    const held = new Set<string>()
    const SPEED = 480 // px/s
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
        pos.current.x += dx * norm * SPEED * dt
        pos.current.y += dy * norm * SPEED * dt
        apply()
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

    // ── Pointer drag — one-to-one, mouse + touch ──
    let dragging = false
    let lastPointer = { x: 0, y: 0 }
    const onPointerDown = (e: PointerEvent) => {
      dragging = true
      lastPointer = { x: e.clientX, y: e.clientY }
      viewport.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      pos.current.x -= e.clientX - lastPointer.x
      pos.current.y -= e.clientY - lastPointer.y
      lastPointer = { x: e.clientX, y: e.clientY }
      apply()
    }
    const onPointerUp = (e: PointerEvent) => {
      dragging = false
      viewport.releasePointerCapture(e.pointerId)
    }
    viewport.addEventListener("pointerdown", onPointerDown)
    viewport.addEventListener("pointermove", onPointerMove)
    viewport.addEventListener("pointerup", onPointerUp)
    viewport.addEventListener("pointercancel", onPointerUp)

    const onResize = () => apply()
    window.addEventListener("resize", onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("resize", onResize)
      viewport.removeEventListener("pointerdown", onPointerDown)
      viewport.removeEventListener("pointermove", onPointerMove)
      viewport.removeEventListener("pointerup", onPointerUp)
      viewport.removeEventListener("pointercancel", onPointerUp)
    }
  }, [])

  return (
    <div ref={viewportRef} className="viewport" data-testid="world-viewport">
      <div ref={planeRef} className="plane" data-testid="world-plane">
        {children}
      </div>
    </div>
  )
}
