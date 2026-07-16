"use client"

import { useEffect, useRef } from "react"
import { useNavigation, type Navigate } from "@parton/framework/client"

/**
 * Tracks which page partials are currently visible.
 * When scrolling up and a page leaves the viewport,
 * silently updates ?pages= to the highest visible page.
 *
 * The URL update is bookmarkable but does NOT trigger a refetch —
 * `navigate(url, { silent: true })` replaces the URL without
 * any server round-trip.
 */
const visiblePages = new Set<number>()

function silentlyUpdatePages(navigate: Navigate, currentUrl: string | null | undefined) {
  if (visiblePages.size === 0 || currentUrl == null) return
  const maxVisible = Math.max(...visiblePages)
  const current = Number(new URL(currentUrl).searchParams.get("pages")) || 1
  if (maxVisible >= current) return

  // Scrolling up — update URL for bookmarking/refresh without
  // triggering a refetch.
  navigate(
    (url) => {
      url.searchParams.set("pages", String(maxVisible))
      return url
    },
    { history: "replace", silent: true },
  )
}

/**
 * Invisible sentinel placed at the top of each page partial.
 * Tracks visibility so ?pages= stays in sync with scroll position.
 */
export function PageSentinel({ page }: { page: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        visiblePages.add(page)
        return
      }
      // Only trigger the silent URL update when a page that *was* visible
      // leaves the viewport. Without this guard, a newly mounted page that
      // has not yet been scrolled to fires an initial "not intersecting"
      // event, which yanks the URL back down and races with LoadMore
      // bumping it up again — causing the URL to flip between N and N+1
      // on pageload.
      if (!visiblePages.has(page)) return
      visiblePages.delete(page)
      silentlyUpdatePages(navigate, nav.currentEntry?.url)
    })

    observer.observe(el)
    return () => {
      observer.disconnect()
      visiblePages.delete(page)
    }
  }, [page, navigate, nav])

  return <div ref={ref} className="h-0" />
}

/**
 * Sentinel element that triggers loading the next page of results
 * when it enters the viewport via IntersectionObserver.
 *
 * Updates the URL — the moved `?pages=` re-renders exactly the new
 * page partial (its match gate flips in) and the sentinel (a tracked
 * read); loaded pages fp-skip. The spinner reads
 * `committed && !finished` for "in flight".
 */
export function LoadMore({ nextPage }: { nextPage: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const triggered = useRef(false)
  const nav = useNavigation()
  const [navigate, { committed, finished }] = nav.navigate()
  const pending = committed && !finished

  useEffect(() => {
    triggered.current = false
  }, [nextPage])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Don't auto-paginate while the search overlay is active. The
        // sentinel is geometrically behind the <dialog> but still
        // "intersecting" the viewport — IntersectionObserver checks
        // geometry, not occlusion. Auto-firing here would race with
        // the user's keystroke dispatches into the search stages.
        const currentUrl = nav.currentEntry?.url
        if (currentUrl != null && new URL(currentUrl).searchParams.has("search")) return

        if (entry.isIntersecting && !triggered.current) {
          triggered.current = true
          // Plain navigate: the moved `?pages=` flips the next page's
          // match gate (it renders) and moves the load-more sentinel's
          // tracked read; every already-loaded page fp-skips.
          navigate(
            (url) => {
              url.searchParams.set("pages", String(nextPage))
              return url
            },
            { history: "replace" },
          )
        }
      },
      { rootMargin: "200px" },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [nextPage, navigate, nav])

  return (
    <div ref={ref} className="p-8 text-center">
      {pending && (
        <span className="inline-block size-6 animate-spin rounded-full border-[3px] border-muted border-t-primary" />
      )}
    </div>
  )
}
