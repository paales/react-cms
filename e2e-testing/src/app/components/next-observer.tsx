"use client"

import { useEffect, useRef } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"

/**
 * Sentinel rendered as the content of the singleton `<Partial selector="#next">`
 * at the bottom of the infinite-scroll list.
 *
 * On intersection it widens the active range by one: bumps `?end=N+1`
 * in the URL (for bookmarkable resume after browser back-nav) and
 * dispatches a targeted refetch for the new page partial and this
 * `next` slot in a single `navigate` call.
 *
 * The server response brings page-N+1 fresh and re-renders this slot
 * with `currentEnd={N+1}` — the new instance's effect re-arms the
 * observer for page-N+2.
 */
export function NextObserver({ currentEnd }: { currentEnd: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigation()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Single-fire IntersectionObserver. Disconnects itself on the
    // first intersecting event so this observer can't re-fire. After
    // the partial refetch lands, the component re-renders with a new
    // `currentEnd` — the effect cleanup runs and a fresh observer is
    // attached for the next page. The `overflow-anchor: none` style
    // below ensures the sentinel scrolls out of view as content is
    // inserted above it, so the new observer's first event is
    // not-intersecting and we don't get a runaway.
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      observer.disconnect()
      const nextEnd = currentEnd + 1
      const url = new URL(window.location.href)
      url.searchParams.set("end", String(nextEnd))
      void nav.navigate(url.toString(), {
        history: "replace",
        selector: `#page-${nextEnd} #next`,
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [currentEnd, nav])

  return (
    <div
      ref={ref}
      data-testid="next-observer"
      data-current-end={currentEnd}
      style={{
        padding: "2rem",
        textAlign: "center",
        color: "#666",
        fontSize: "0.85rem",
      }}
    >
      Loading more…
    </div>
  )
}
