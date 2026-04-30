"use client"

import { useEffect } from "react"
import { getNavigation } from "@react-cms/framework/framework/navigation-api.ts"

/**
 * Save and restore window.scrollY across navigations using the
 * Navigation API's per-entry state.
 *
 * Save flow:
 *  - A scroll listener tracks `lastScrollY` synchronously and
 *    debounce-persists it via updateCurrentEntry.
 *  - On a push/traverse navigate event we also persist (so a forward
 *    navigation has the outgoing entry's scroll). For "replace"
 *    navigations (history:"replace" bumping ?end=N), we save on
 *    `navigatesuccess`, because updateCurrentEntry called inside the
 *    navigate handler is overwritten by the navigation's own commit.
 *  - We persist `lastScrollY` rather than the live `window.scrollY`
 *    because programmatic scrolls (e.g. an `<a>` click that auto-
 *    scrolls the link into view) can reset scroll to 0 immediately
 *    before the navigate event fires.
 *
 * Restore flow:
 *  - On mount, read the saved scrollY from the current entry's state.
 *  - Set scrollRestoration = "manual" so the browser doesn't fight us.
 *  - Use a rAF retry loop because async / streamed content can grow
 *    the document after the first paint.
 *
 * Caveat: in the current app shell (root.tsx returns either BarePage
 * or the default layout depending on URL), navigating away from /bare
 * and back doesn't appear to remount BarePage on every visit, so the
 * mount-time restore doesn't fire on browser back. Save still works.
 * Open question: whether to fix at the router level so each route
 * mount is real, or move the restore logic to a navigate-event hook
 * that runs without requiring a remount.
 */
export function ScrollRestore() {
  useEffect(() => {
    const nav = getNavigation()
    if (!nav) return
    if ("scrollRestoration" in history) {
      history.scrollRestoration = "manual"
    }

    const state = nav.currentEntry?.getState() as { scrollY?: number } | null
    if (state && typeof state.scrollY === "number") {
      const targetY = state.scrollY
      // The document height may not be final on mount — pages with
      // streamed Suspense or async content grow after the first
      // paint. Retry scroll for a few frames until the target is
      // reachable.
      let attempts = 0
      const tryScroll = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight
        if (max >= targetY || attempts > 30) {
          window.scrollTo(0, targetY)
          return
        }
        attempts++
        requestAnimationFrame(tryScroll)
      }
      requestAnimationFrame(tryScroll)
    }

    // Track the most recent scroll position. We persist this rather
    // than the live `window.scrollY` because programmatic scrolls
    // (e.g. `element.scrollIntoView()` invoked when a link is clicked
    // at the top of a long page) can reset scroll to 0 before the
    // navigate event fires — saving live would persist the 0.
    let lastScrollY = window.scrollY

    const save = () => {
      const entry = nav.currentEntry
      if (!entry) return
      const prev = (entry.getState() as Record<string, unknown> | null) ?? {}
      nav.updateCurrentEntry({
        state: { ...prev, scrollY: lastScrollY },
      })
    }

    // Update lastScrollY on every scroll (cheap, passive) but only
    // persist to nav state on a debounce. lastScrollY is what `save`
    // reads — so a later save() call (on navigate, pagehide, etc.)
    // always picks up the most recent user scroll, even if no
    // debounce-flush has fired yet.
    let scrollDebounce: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      lastScrollY = window.scrollY
      if (scrollDebounce) clearTimeout(scrollDebounce)
      scrollDebounce = setTimeout(save, 150)
    }
    window.addEventListener("scroll", onScroll, { passive: true })

    // For push/traverse: save in the navigate handler so the outgoing
    //   entry (currentEntry at that moment) gets the scroll position
    //   before the new entry takes over.
    // For replace (silent/targeted navigate): save in navigatesuccess. Saving in
    //   the navigate handler doesn't stick because the replace
    //   navigation commits the new state (null from replaceState) over
    //   our updateCurrentEntry call. After commit, currentEntry has
    //   the replaced URL — that's the entry we want to track.
    const onNavigate = (e: NavigateEvent) => {
      if (e.navigationType !== "replace") save()
    }
    const onSuccess = () => save()
    const onVis = () => {
      if (document.visibilityState === "hidden") save()
    }
    nav.addEventListener("navigate", onNavigate)
    nav.addEventListener("navigatesuccess", onSuccess)
    window.addEventListener("pagehide", save)
    document.addEventListener("visibilitychange", onVis)
    return () => {
      nav.removeEventListener("navigate", onNavigate)
      nav.removeEventListener("navigatesuccess", onSuccess)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("pagehide", save)
      document.removeEventListener("visibilitychange", onVis)
      if (scrollDebounce) clearTimeout(scrollDebounce)
    }
  }, [])

  return null
}
