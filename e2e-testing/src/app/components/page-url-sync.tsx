"use client"

import { useEffect, useLayoutEffect } from "react"
// Client components import framework hooks from the client subpath, not the
// `@parton/framework` barrel — the barrel pulls server-only modules into the
// client bundle (see framework/index.ts).
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

// Layout effect on the client (scroll BEFORE paint), plain effect on the
// server (no-op, no SSR warning).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Two-way sync between the `?page=` URL and the browse grid's scroll
 * position — the app-side glue around the framework's culling (the app owns
 * its own `?page=` URL semantics; the framework owns observation + refetch):
 *
 *  - on mount, `?page=N` (a deep link, or the anchor a back-nav restores)
 *    scrolls section N into view — in a LAYOUT effect, so the page lands at
 *    the right position on the first paint instead of rendering at 0,0 and
 *    jumping;
 *  - as you scroll, the centered section's page is mirrored back to `?page=`
 *    so the position is shareable.
 *
 * The mirror write is `navigate({ history: "replace", silent: true })`:
 * silent (no refetch — the cull already follows the viewport), replace (no
 * history pile-up). It stays out of the culling's way because (1) the
 * framework intercepts framework-silent navs with `scroll: "manual"`, so the
 * viewport doesn't jump, and (2) the host strips `page` from its stale-commit
 * key, so a ticking anchor doesn't drop in-flight culling commits.
 *
 * The mirror is debounced (trailing-edge), so it can't use `useEffectEvent`
 * — effect events only fire synchronously inside an effect or handler, never
 * from a `setTimeout`. It uses the stable `navigate` (a dep) and reads the
 * current `?page=` once at mount, the way `load-more` does.
 */
export function PageUrlSync() {
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  // Deep-link / scroll-restore landing — before paint.
  useIsoLayoutEffect(() => {
    const url = nav.currentEntry?.url
    const page = url ? Number(new URL(url).searchParams.get("page") || "1") : 1
    if (page > 1) {
      document.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror the centered page back to ?page= after the scroll settles.
  useEffect(() => {
    const url0 = nav.currentEntry?.url
    const path = url0 ? new URL(url0).pathname : "/magento/browse"
    let lastPage = url0 ? new URL(url0).searchParams.get("page") || "" : ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      const cy = window.innerHeight / 2
      let center: number | null = null
      for (const s of document.querySelectorAll<HTMLElement>("[data-page]")) {
        const r = s.getBoundingClientRect()
        if (r.top <= cy && r.bottom >= cy) {
          center = Number(s.dataset.page)
          break
        }
      }
      if (center == null) return
      const want = center > 1 ? String(center) : ""
      if (want === lastPage) return
      lastPage = want
      navigate(want ? `${path}?page=${want}` : path, { history: "replace", silent: true })
    }
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 150)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate])

  return null
}
