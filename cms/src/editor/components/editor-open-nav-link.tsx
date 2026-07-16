"use client"

import type { ReactNode } from "react"
import { useNavigation } from "@parton/framework/client"
// Deep-import from `cms-constants.ts` (zero side-effect imports) — see
// the matching note on `editor-open-link.tsx` for why this avoids the
// `node:async_hooks` evaluation that the runtime barrel forces.
import { EDITOR_COOKIE } from "@parton/framework/runtime/cms-constants.ts"

/**
 * Variant of {@link EditorOpenLink} that navigates to a different URL
 * before flipping the editor cookie. Used by app-nav `nav-link` blocks
 * whose authored href carries the `?editor=1` convention (e.g.
 * `/cms-demo?editor=1`): the link is a friendly target the author can
 * edit, but clicking it must both navigate to the destination AND set
 * the cookie so the EditorShell partial renders the chrome on the new
 * page. The URL-param itself is no-op server-side (see
 * `EDITOR_RESERVED_PARAMS` in `cms/src/editor/shell.tsx`) — the cookie
 * is the source of truth — so we strip it from the navigation target
 * to keep the browser URL clean.
 */
export function EditorOpenNavLink({
  href,
  className,
  title,
  testId,
  children,
}: {
  href: string
  className?: string
  title?: string
  testId?: string
  children: ReactNode
}) {
  const [navigate] = useNavigation().navigate()
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    const target = new URL(href, window.location.origin)
    target.searchParams.delete("editor")
    const dest = target.pathname + target.search + target.hash
    void navigate(dest, {
      cookies: { [EDITOR_COOKIE]: "1" },
    })
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      title={title}
      aria-label="Open editor"
      data-testid={testId}
    >
      {children}
    </a>
  )
}
