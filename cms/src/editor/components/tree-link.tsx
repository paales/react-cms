"use client"

import type { ReactNode } from "react"
import { useNavigation } from "@parton/framework/client"

/**
 * Nav link for the CMS editor's tree sidebar.
 *
 * Routes the click through `nav.navigate(href)` (a channel url
 * statement, not a document load). Selecting a tree entry changes
 * only the tree + field panels' tracked `?select=` read — every
 * preview parton's fingerprint is unchanged, so the whole-tree
 * statement prunes them to placeholders and the client keeps their
 * cached subtrees in place: no preview rerender, no flash.
 */
export function CmsEditTreeLink({
  href,
  className,
  children,
  testId,
  selected,
  style,
}: {
  href: string
  className?: string
  children: ReactNode
  testId?: string
  selected: boolean
  style?: React.CSSProperties
}) {
  const [navigate] = useNavigation().navigate()
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Modifier-clicks (open in new tab, etc.) and middle-button
    // navigate as the browser would — don't intercept them.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    void navigate(href, { history: "push" })
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      data-testid={testId}
      data-selected={selected}
      data-active={selected ? "true" : undefined}
      style={style}
    >
      {children}
    </a>
  )
}
