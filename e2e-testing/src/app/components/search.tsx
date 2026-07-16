"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigation } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"
import { Input } from "@parton/copies/components/ui/input"

/**
 * Both the header toggle's close button and the dialog's Escape /
 * backdrop dismissal drop the same two params — a shared updater so
 * the two call sites can't drift. Passed straight to `navigate` as
 * the updater-function target (`(url: URL) => URL`).
 */
function closeSearchOverlay(url: URL): URL {
  url.searchParams.delete("search")
  url.searchParams.delete("q")
  return url
}

// Static, stateless spinner — hoisted to module scope so it isn't a new
// component identity each render (which resets state and blocks the compiler).
const Spinner = () => (
  <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-muted-foreground/60 border-t-foreground" />
)

/**
 * Search toggle buttons for the header.
 *
 * Two variants:
 * - "Search (URL)":   sets `?search=1` on the PAGE URL.
 * - "Search (Frame)": navigates the `search` frame to `/?search=1`.
 *
 * `<SearchArea/>` is the same component in both modes; its scope
 * decides where `?search=` is read from.
 */
/**
 * Callback ref marking an element as React-owned: fires at the commit
 * that attaches (or hydration-adopts) the element — the same moment
 * its handlers go live. The search controls live in the header
 * partial, which is served from the client cache on warm navs and
 * hydrates AFTER the page shell; e2e specs wait for `data-hydrated`
 * on the specific control before interacting, because events fired
 * earlier hit inert DOM and are silently lost.
 */
function markHydrated(el: HTMLElement | null): void {
  el?.setAttribute("data-hydrated", "")
}

export function SearchToggle({ urlOpen }: { urlOpen: boolean }) {
  const [pageNavigate, pageProgress] = useNavigation().navigate()
  const pagePending = pageProgress.committed && !pageProgress.finished
  const frameNav = useNavigation("search")
  const [frameNavigate] = frameNav.navigate()
  const frameEntryUrl = frameNav.currentEntry?.url
  const frameOpen = frameEntryUrl ? new URL(frameEntryUrl).searchParams.has("search") : false

  // Open/close is a plain navigate: the whole-tree statement
  // re-evaluates the page, and fp-skip prunes everything except the
  // `?search` readers — the search-page region and the header (its
  // `SearchToggle` flips on the same param).
  function openUrl() {
    pageNavigate(
      (url) => {
        url.searchParams.set("search", "1")
        return url
      },
      { history: "push" },
    )
  }

  function closeUrl() {
    pageNavigate(closeSearchOverlay, { history: "push" })
  }

  function openFrame() {
    frameNavigate("/?search=1")
  }

  function closeFrame() {
    frameNavigate("/")
  }

  if (urlOpen) {
    return (
      <Button ref={markHydrated} type="button" size="sm" variant="secondary" onClick={closeUrl}>
        {pagePending ? <Spinner /> : <span>✕</span>}
        Close
      </Button>
    )
  }

  if (frameOpen) {
    return (
      <Button
        ref={markHydrated}
        type="button"
        size="sm"
        variant="secondary"
        onClick={closeFrame}
        data-testid="search-frame-close"
      >
        <span>✕</span>
        Close
      </Button>
    )
  }

  return (
    <div className="flex gap-2">
      <Button ref={markHydrated} type="button" size="sm" variant="outline" onClick={openUrl}>
        {pagePending ? <Spinner /> : <span>🔍</span>}
        Search (URL)
      </Button>
      <Button
        ref={markHydrated}
        type="button"
        size="sm"
        variant="outline"
        onClick={openFrame}
        data-testid="search-frame-open"
      >
        <span>🔍</span>
        Search (Frame)
      </Button>
    </div>
  )
}

/**
 * Dialog wrapper for the search overlay. Uses the native <dialog>
 * element.
 *
 * The `open` attribute is rendered into the SSR markup so the overlay
 * is visible from the first paint — `showModal()` only runs in a client
 * effect, so a `showModal`-only dialog would stay `display:none` until
 * hydration and the content would appear to "pop in". On hydration the
 * effect upgrades the already-open dialog to modal (backdrop + Escape +
 * top layer). `showModal()` throws on an already-`open` dialog, so the
 * upgrade closes first, then re-opens modally.
 *
 * The close-navigation is driven by `onCancel` (Escape / dismiss) and a
 * backdrop click — NOT `onClose`. `close` fires on every `.close()`,
 * including the programmatic upgrade close below; routing the
 * navigation through it would fire a spurious "remove ?search" nav on
 * hydration, which aborts the in-flight render and tears the page down.
 * `cancel` fires only on user dismissal, so the programmatic upgrade
 * stays silent.
 */
export function SearchDialog({ open, children }: { open: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      // Upgrade to a modal dialog. If it's already open (SSR rendered
      // the `open` attribute, or a prior effect opened it non-modally),
      // close first — `showModal()` throws InvalidStateError on an
      // open dialog. This `.close()` is silent: the close-navigation
      // hangs off `onCancel`, not `onClose`.
      if (dialog.open && !dialog.matches(":modal")) dialog.close()
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  function requestClose() {
    // Page scope: a plain navigate — fp-skip narrows the re-render to
    // the `?search` readers (search region + header). Frame scope: a
    // frame nav refetches the frame subtree.
    navigate(closeSearchOverlay, { history: "push" })
  }

  return (
    <dialog
      ref={dialogRef}
      open={open}
      onCancel={(e) => {
        // Escape: keep the dialog in the DOM (React owns open/close via
        // the `open` prop) and run the close-navigation instead.
        e.preventDefault()
        requestClose()
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) requestClose()
      }}
      className="top-[15vh] max-h-[80vh] w-[calc(100vw-2em)] max-w-[720px] justify-self-center overflow-auto rounded-xl border bg-card p-5 text-card-foreground backdrop:bg-black/60"
    >
      {children}
    </dialog>
  )
}

/**
 * Search input with live partial refetch — scope-agnostic.
 *
 * Fires `navigate()` on every keystroke — one channel statement whose
 * whole-tree segment fp-skips everything except the `?q` readers (the
 * search stages). Superseded fires are NOT aborted — they drain and
 * commit, ordered by the framework's monotonic commit guard (a late
 * older fire can't clobber a newer one), so the section converges on
 * the latest-ISSUED query. (Aborting a superseded fire would tear its
 * in-flight Flight document mid-decode and crash the page through the
 * error boundary.)
 *
 * `progress.committed && !progress.streaming` is the spinner predicate:
 * "asked, no rows back yet" — it clears the moment the first row
 * paints, even if the rest of the response is still streaming.
 */
export function SearchInput({ query }: { query: string }) {
  const nav = useNavigation()
  const [navigate, progress] = nav.navigate()
  const [value, setValue] = useState(query)
  const [streaming, setStreaming] = useState(false)

  function handleChange(next: string) {
    setValue(next)
    const milestones = navigate(
      (url) => {
        if (next) url.searchParams.set("q", next)
        else url.searchParams.delete("q")
        return url
      },
      { history: "replace", streaming },
    )
    // Superseded keystroke fires aren't aborted, so this normally just
    // resolves. Keep the AbortError guard anyway: an AbortError is a
    // lifecycle signal, not an error to surface to the bubbler.
    milestones.finished.catch((err) => {
      if (err instanceof Error && err.name === "AbortError") return
      throw err
    })
  }

  const isStale = progress.committed && !progress.streaming

  return (
    <div>
      <div className="relative">
        <Input
          ref={markHydrated}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search pokemon by name..."
          autoFocus
          className="h-11 pr-10 text-base"
        />
        {isStale && (
          <span className="pointer-events-none absolute top-1/2 right-3 inline-block size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted-foreground/60 border-t-foreground" />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <label
          data-testid="streaming-toggle"
          className="inline-flex cursor-pointer select-none items-center gap-2"
        >
          <input
            ref={markHydrated}
            type="checkbox"
            checked={streaming}
            onChange={(e) => setStreaming(e.target.checked)}
          />
          <span>
            streaming:{" "}
            <code className={streaming ? "text-emerald-400" : "text-sky-400"}>
              {String(streaming)}
            </code>
          </span>
          <span className="text-muted-foreground/70">
            {streaming
              ? "plain setState — fallback flashes, streams per chunk"
              : "startTransition — preserve UI, no fallback, no streaming"}
          </span>
        </label>
        <span className="text-muted-foreground/70">
          {nav.name === null ? "page URL scope" : `frame "${nav.name}" scope`}
        </span>
      </div>
    </div>
  )
}
