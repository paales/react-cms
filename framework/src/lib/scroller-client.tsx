"use client"

/**
 * The scroller's client half — three framework-internal components
 * (placed by the scroller root/leaf specs, never by an app):
 *
 *  - `ScrollerLeafShell` — a culled leaf's emission: `n` generic
 *    skeleton cells (`.parton-skel`, styled by app CSS) in the one
 *    outer grid, so a slice streams in over exactly the cells it
 *    culls out to.
 *  - `ScrollerReservation` — the space outside the placed span, held
 *    with pure CSS arithmetic
 *    (`round(up, count / var(--scroller-cols)) * var(--scroller-row)`).
 *    When the viewport lands inside it, it SELF-MATERIALIZES a local
 *    skeleton band the same frame — structure is arithmetic under
 *    uniform rows, so no server is consulted to paint. Display only:
 *    the window statement belongs to the anchor sync.
 *  - `ScrollerAnchorSync` — THE one writer. On scroll settle it
 *    computes the item under the viewport center ARITHMETICALLY
 *    (wrapper rect + the grid's resolved row pitch and column count —
 *    no DOM interval markers), and states it through the anchor
 *    param: silently when the landing is inside the placed span
 *    (culling handles materialization), as an IN-PLACE navigation
 *    (`scroll: "manual"`) when it is inside a reservation (the span
 *    must move). The only DOM it consults is the wrapper (by its
 *    public `id=<name>`) plus one occlusion hit-test — an overlay
 *    covering the collection silences the writer entirely.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useNavigation } from "./use-navigation.tsx"

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

// ─── Leaf shell ────────────────────────────────────────────────────────

/** A culled leaf's skeleton cells. Receives the placement's cull
 *  props (`{o, n, aid?}`); the cells are grid items of the outer
 *  grid, sized by its `grid-auto-rows`, styled via `.parton-skel`.
 *  A boundary leaf's `aid` lands on the FIRST cell, so the public
 *  anchor id exists in the culled state too. */
export function ScrollerLeafShell({ n, aid }: { o: number; n: number; aid?: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} id={i === 0 ? aid : undefined} className="parton-skel" aria-hidden />
      ))}
    </>
  )
}

// ─── Shared geometry ───────────────────────────────────────────────────

/** The grid's resolved geometry — the truth for all client-side row
 *  math. `gridTemplateColumns` computes to a resolved px list, so the
 *  column count is its length; `gridAutoRows` computes to the
 *  resolved row pitch. */
function gridGeometry(gridEl: Element | null): { cols: number; rowH: number; gap: string } | null {
  if (!gridEl) return null
  const cs = getComputedStyle(gridEl)
  const cols = cs.gridTemplateColumns.split(" ").length
  const rowH = Number.parseFloat(cs.gridAutoRows)
  if (!(cols >= 1) || !(rowH > 0) || !Number.isFinite(rowH)) return null
  return { cols, rowH, gap: cs.columnGap }
}

// ─── Reservation ───────────────────────────────────────────────────────

interface Band {
  cells: number
  topPx: number
  template: string
  columnGap: string
  rowPx: number
}

export function ScrollerReservation({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<Band | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let intersecting = false
    let raf = 0

    const compute = () => {
      raf = 0
      if (!intersecting) return
      const gridEl = el.parentElement?.querySelector(":scope > .parton-scroller-grid") ?? null
      const geo = gridGeometry(gridEl)
      if (!geo) return
      const rect = el.getBoundingClientRect()
      const totalRows = Math.max(1, Math.ceil(count / geo.cols))
      const rowH = rect.height / totalRows
      if (!(rowH > 0)) return
      const vh = window.innerHeight
      const firstRow = Math.max(0, Math.floor((-rect.top - vh / 2) / rowH))
      const lastRow = Math.min(totalRows, Math.ceil((-rect.top + vh * 1.5) / rowH))
      if (lastRow <= firstRow) {
        setBand(null)
        return
      }
      setBand({
        cells: Math.max(0, Math.min((lastRow - firstRow) * geo.cols, count - firstRow * geo.cols)),
        topPx: firstRow * rowH,
        template: getComputedStyle(gridEl as Element).gridTemplateColumns,
        columnGap: geo.gap,
        rowPx: rowH,
      })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry.isIntersecting
        if (intersecting) schedule()
        else setBand(null)
      },
      { rootMargin: "50% 0px" },
    )
    io.observe(el)
    window.addEventListener("scroll", schedule, { passive: true, capture: true })
    window.addEventListener("resize", schedule)
    return () => {
      io.disconnect()
      window.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [count])

  return (
    <div
      ref={ref}
      className="parton-scroller-res"
      aria-hidden
      style={{
        position: "relative",
        overflow: "hidden",
        // A plain BLOCK spacer — deliberately not a grid item (a
        // fixed `grid-auto-rows` track would overflow; a row span
        // would cost tens of thousands of implicit tracks). Height is
        // pure CSS arithmetic on the app's variables — exact at every
        // breakpoint, before hydration, with zero JS.
        height: `calc(round(up, ${count} / var(--scroller-cols, 4)) * var(--scroller-row, 240px))`,
      }}
    >
      {band ? (
        <div
          style={{
            position: "absolute",
            top: band.topPx,
            left: 0,
            right: 0,
            display: "grid",
            gridTemplateColumns: band.template,
            columnGap: band.columnGap,
            gridAutoRows: band.rowPx,
          }}
        >
          {Array.from({ length: band.cells }, (_, i) => (
            <div key={i} className="parton-skel" />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ─── Anchor sync — the one writer ──────────────────────────────────────

export function ScrollerAnchorSync({
  name,
  param,
  step,
  start,
  end,
  total,
}: {
  name: string
  param: string
  step: number
  /** The placed span's item bounds — landings inside it write
   *  silently; landings outside it move the window (a real,
   *  in-place navigation). */
  start: number
  end: number
  total: number
}) {
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  // Deep-link / restore landing on client navs — before paint, by the
  // public anchor id. (Document loads use the streamed landing
  // script; running this again on hydration is idempotent.)
  useIsoLayoutEffect(() => {
    const url = nav.currentEntry?.url
    const page = url ? Number(new URL(url).searchParams.get(param) || "1") : 1
    if (page > 1) {
      document.getElementById(`${name}-p${page}`)?.scrollIntoView({ block: "start" })
    }
    // Mount-only: the landing is for the entry this mount belongs to.
  }, [])

  // The writer: item-under-center → anchor param, on scroll settle.
  useEffect(() => {
    const url0 = nav.currentEntry?.url
    let lastVal = url0 ? (new URL(url0).searchParams.get(param) ?? "") : ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      const wrapper = document.getElementById(name)
      if (!wrapper) return
      // Occlusion: state only what the user actually SEES. An overlay
      // covering the collection (dialog, drawer) hits itself, not the
      // wrapper's subtree, and the writer stands down.
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      if (!hit || !wrapper.contains(hit)) return
      const gridEl = wrapper.querySelector(":scope > .parton-scroller-grid")
      if (!gridEl) return
      // MEASURE where content exists, COMPUTE only where nothing
      // does. In-span, the index comes from layout: the hit's grid
      // cell, walked back to the nearest boundary id — correct under
      // any item heights or breakpoints. Inside a reservation there
      // is nothing to measure; row arithmetic on its own box is the
      // (self-correcting) estimate.
      let idx: number
      const res = hit.closest(".parton-scroller-res")
      if (res) {
        const geo = gridGeometry(gridEl)
        if (!geo) return
        const before =
          (res.compareDocumentPosition(gridEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        const base = before ? 0 : end
        const count = Math.max(1, before ? start : total - end)
        const r = res.getBoundingClientRect()
        const rowH = r.height / Math.max(1, Math.ceil(count / geo.cols))
        if (!(rowH > 0)) return
        const rows = Math.floor((window.innerHeight / 2 - r.top) / rowH)
        idx = base + Math.min(count - 1, Math.max(0, rows * geo.cols))
      } else {
        let cell: Element | null = hit
        while (cell && cell.parentElement !== gridEl) cell = cell.parentElement
        if (!cell) return
        const re = new RegExp(`^${CSS.escape(name)}-p(\\d+)$`)
        let steps = 0
        let hops = 0
        let el: Element | null = cell
        let baseIdx: number | null = null
        while (el && hops < step * 4 + 64) {
          const m = el.id ? re.exec(el.id) : null
          if (m) {
            baseIdx = (Number(m[1]) - 1) * step
            break
          }
          // Count only laid-out cells — scripts, holes, and parked
          // (display:none) DOM don't occupy grid positions.
          if ((el as HTMLElement).offsetParent !== null) steps++
          el = el.previousElementSibling
          hops++
        }
        if (baseIdx === null) return
        idx = Math.min(Math.max(total, 1) - 1, baseIdx + steps)
      }
      const page = Math.floor(idx / step) + 1
      const want = page > 1 ? String(page) : ""
      if (want === lastVal) return
      lastVal = want
      const inSpan = idx >= start && idx < end
      navigate(
        (url) => {
          if (want) url.searchParams.set(param, want)
          else url.searchParams.delete(param)
          return url
        },
        // In-span: a bookmarkability-only mirror — culling already
        // follows the viewport. Outside the span: the window must
        // move — a real refetch, IN-PLACE (this nav DESCRIBES where
        // the user already is; the browser's deferred default scroll
        // must never fire).
        inSpan ? { history: "replace", silent: true } : { history: "replace", scroll: "manual" },
      )
    }
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 250)
    }
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true })
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate, name, param, step, start, end, total])

  return null
}
