"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

/**
 * The scroller's client half — reports the camera to the server from a
 * single observer over the page-partons, with no per-page sentinel and
 * no shadow list of items: the live DOM sections ARE the source of
 * truth.
 *
 * One IntersectionObserver watches every `<section data-page>`; a
 * MutationObserver re-syncs its target set as pages mount/unmount when
 * the ring shifts. (A React 19.2 Fragment ref + `observeUsing` would be
 * the no-wrapper way to do this, but it can't: the framework substitutes
 * partials outside the fragment's React-child range, so `observeUsing`
 * traverses to zero host nodes. A plain block container is layout-neutral
 * for the stacked page sections, so it scopes the DOM query without
 * affecting layout.)
 *
 * From the intersecting set it writes two things, each to its own scope:
 *
 *   visible set → FRAME url (`useNavigation("browse")`). The driver:
 *     a refetch re-renders the frame against the new band, fp-skipping
 *     pages whose zone didn't change. Ephemeral — never on the page url.
 *   anchor (most-prominent page) → PAGE url as `?page=` via a raw
 *     `replaceState`. A sharable bookmark shadow; deliberately NOT the
 *     framework's navigate, which would re-commit the page (and park the
 *     frame's content). Only read server-side on a cold load.
 */
export function BrowseScroller({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [frameNav] = useNavigation("browse").navigate()
  const frameNavRef = useRef(frameNav)
  frameNavRef.current = frameNav

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Cold-start: a deep-linked `?page=N` rendered the band centered on
    // N, but the viewport is still at the top. Scroll N into view before
    // observing, so the camera reports N — not the top of the band.
    const initialAnchor = Number(new URL(window.location.href).searchParams.get("page") || "1")
    if (initialAnchor > 1) {
      container.querySelector(`[data-page="${initialAnchor}"]`)?.scrollIntoView({ block: "start" })
    }

    const ratios = new Map<number, number>()
    let lastBand = ""
    let raf = 0

    const report = () => {
      raf = 0
      const visible = [...ratios.entries()]
        .filter(([, r]) => r > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p)
      if (visible.length === 0) return

      const anchor = visible[0]
      const band = `${Math.min(...visible)}-${Math.max(...visible)}`
      if (band !== lastBand) {
        lastBand = band
        // Driver: the visible set on the frame url. No selector — refetch
        // the whole frame; unchanged-zone pages fp-skip.
        void frameNavRef.current(`/magento/browse?visible=${visible.join(",")}`, {
          history: "replace",
        }).finished.catch(ignoreAbort)
      }

      // Effect: the anchor on the page url. A raw replaceState — a pure
      // bookmark shadow, no framework re-commit.
      const pageUrl = new URL(window.location.href)
      if (pageUrl.searchParams.get("page") !== String(anchor)) {
        pageUrl.searchParams.set("page", String(anchor))
        window.history.replaceState(window.history.state, "", pageUrl)
      }
    }

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(report)
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const raw = (entry.target as HTMLElement).dataset?.page
          const page = raw ? Number(raw) : NaN
          if (!Number.isFinite(page)) continue
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            ratios.set(page, entry.intersectionRatio)
          } else {
            ratios.delete(page)
          }
        }
        schedule()
      },
      { threshold: [0, 0.01, 0.25, 0.5, 1], rootMargin: "100px 0px" },
    )

    // Keep the observer's target set in sync with the live sections —
    // pages mount (reserved→ring, new runway) and unmount (cull-back) as
    // the ring shifts.
    const observed = new Set<Element>()
    const sync = () => {
      const live = new Set<Element>(container.querySelectorAll("[data-page]"))
      for (const el of live) {
        if (!observed.has(el)) {
          io.observe(el)
          observed.add(el)
        }
      }
      for (const el of observed) {
        if (!live.has(el)) {
          io.unobserve(el)
          observed.delete(el)
          const raw = (el as HTMLElement).dataset?.page
          const page = raw ? Number(raw) : NaN
          if (Number.isFinite(page)) ratios.delete(page)
          schedule()
        }
      }
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(container, { childList: true, subtree: true })

    return () => {
      if (raf) cancelAnimationFrame(raf)
      mo.disconnect()
      io.disconnect()
    }
  }, [])

  return <div ref={containerRef}>{children}</div>
}

function ignoreAbort(err: unknown) {
  if ((err as { name?: string })?.name !== "AbortError") throw err
}
