"use client"

import type { ReactNode } from "react"
import { useNavigation } from "../../lib/partial-client.tsx"

/**
 * Selector-targeted nav link for the CMS editor's tree sidebar.
 *
 * Plain `<a href="/cms-edit?select=…">` triggers a full page nav —
 * the entire `/cms-edit` route re-streams (outer chrome + preview
 * frame + field panel). Even with `startTransition` smoothing the
 * commit, the rerender re-derives the client template and reconciles
 * every Partial wrapper, which can produce a brief blank flash on
 * the preview pane while the new payload commits.
 *
 * Selecting a tree entry only needs the tree + the field panel to
 * change; the preview stays put. Routing the click through
 * `nav.navigate(href, { selector })` updates the URL AND restricts
 * the refetch to just `#cms-edit-tree` and `#cms-edit-fields`. The
 * preview Partial's snapshot is left alone — no rerender, no flash.
 */
export function CmsEditTreeLink({
  href,
  className,
  children,
  testId,
  selected,
}: {
  href: string
  className?: string
  children: ReactNode
  testId?: string
  selected: boolean
}) {
  const nav = useNavigation()
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Modifier-clicks (open in new tab, etc.) and middle-button
    // navigate as the browser would — don't intercept them.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    void nav.navigate(href, {
      history: "push",
      selector: "#cms-edit-tree #cms-edit-fields",
    })
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      data-testid={testId}
      data-selected={selected}
    >
      {children}
    </a>
  )
}
