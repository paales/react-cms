"use client"

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react"
import { useNavigation } from "../../lib/partial-client.tsx"
import { cn } from "@/lib/utils"

/**
 * Address bar for the editor's preview pane.
 *
 * The window URL IS the preview URL — typing here drives
 * `useNavigation()` (window-scoped), updates the browser URL, and
 * Root re-runs `pickRoute` to render the new page inside the editor
 * chrome. The cookie-driven editor toggle persists across nav so
 * we never need to keep `?editor=1` on the wire.
 *
 * The input doubles as display + editor: it shows the current
 * previewed-page URL (editor-internal params stripped) and accepts
 * direct editing. Press Enter to navigate. Browser back / forward,
 * preview-internal `<a>` clicks, and other window-scoped navs all
 * update the input via `useSyncExternalStore` (unless the user is
 * actively typing, in which case we don't clobber their draft).
 *
 * Selector-targeted nav: every address-bar nav explicitly includes
 * `#preview #cms-edit-fields #cms-edit-tree` in the selector. The
 * preview Partial covers all page content; fields and tree need to
 * re-render so the auto-picked config tab follows the new path.
 * Without this, the field panel's structural fp wouldn't see the
 * URL change (it doesn't read pathname-tracked accessors directly)
 * and fp-skip would serve the previous render's tab selection.
 *
 * A `×` button clears the editor cookie via `?editor=0`.
 */

const EDITOR_RESERVED_PARAMS = ["editor", "select", "config"] as const

/** Strip editor-internal params for display in the URL bar — the
 *  bar should show the URL the *previewed page* sees, not the
 *  editor-state-decorated window URL. */
function shortPreviewUrl(href: string): string {
  try {
    const u = new URL(href, window.location.origin)
    for (const p of EDITOR_RESERVED_PARAMS) u.searchParams.delete(p)
    return u.pathname + (u.search ? u.search : "")
  } catch {
    return href
  }
}

/**
 * Compose the destination URL for a nav: keep the current
 * `?select=…&config=…` editor state, replace path + non-editor
 * search params with what the user typed.
 */
function withEditorState(target: string): string {
  const current = new URL(window.location.href)
  const next = new URL(target, window.location.origin)
  // Drop any editor params the target carries — we'll re-attach
  // freshly from the current URL so what the user has selected
  // travels with the navigation.
  for (const p of EDITOR_RESERVED_PARAMS) next.searchParams.delete(p)
  for (const p of EDITOR_RESERVED_PARAMS) {
    if (p === "editor") continue // cookie-driven; URL flag would just be noise
    const v = current.searchParams.get(p)
    if (v != null) next.searchParams.set(p, v)
  }
  return next.pathname + next.search
}

export function CmsEditAddressBar({ initialUrl }: { initialUrl: string }) {
  const nav = useNavigation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The "draft" — what's in the input box right now. Starts at the
  // server-rendered URL; gets resynced to the live URL on external
  // navs unless the user is actively focused on the input (so a
  // mid-typing nav from elsewhere doesn't clobber their typing).
  const [draft, setDraft] = useState(initialUrl)

  const liveUrl = useSyncExternalStore(
    (cb) => {
      nav.addEventListener("currententrychange", cb)
      return () => nav.removeEventListener("currententrychange", cb)
    },
    () => nav.currentEntry?.url ?? null,
    () => null,
  )
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Sync draft to live URL when navigation happens elsewhere — but
  // only if the user isn't actively editing (input not focused).
  useEffect(() => {
    if (!mounted || !liveUrl) return
    if (document.activeElement === inputRef.current) return
    setDraft(shortPreviewUrl(liveUrl))
  }, [mounted, liveUrl])

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const target = draft.trim()
    if (!target) return
    void nav.navigate(withEditorState(target), {
      history: "push",
      // Force the editor's tree + field panels to refetch alongside
      // the previewed page. Without this, the field panel's fp
      // (which doesn't capture the previewed-page pathname) matches
      // its prior render and the auto-picked config tab serves
      // stale. `#preview` covers the page content; the framework
      // recurses into its body so PokemonPage / CmsDemoPage / etc.
      // re-render normally.
      selector: "#preview #cms-edit-fields #cms-edit-tree",
    })
    inputRef.current?.blur()
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-1 items-center gap-2"
      data-testid="cms-edit-preview-nav"
    >
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={cn(
          "flex-1 rounded-md border border-input bg-muted/40 px-3 py-1.5",
          "text-sm font-mono",
          "focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-testid="cms-edit-preview-nav-input"
        aria-label="Preview URL"
      />
      <a
        href="?editor=0"
        className="rounded px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Close editor"
        aria-label="Close editor"
        data-testid="cms-edit-close"
      >
        ×
      </a>
    </form>
  )
}
