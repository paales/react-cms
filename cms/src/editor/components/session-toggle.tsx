"use client"

import type { ReactNode } from "react"
// Deep-import is required: `setSessionValue` is a server action and
// this file is `"use client"` — going through the cross-package barrel
// mis-resolves the Flight reference. See the caveat in
// `framework/index.ts`.
import { setSessionValue } from "@react-cms/framework/runtime/session-actions.ts"

/**
 * Editor tweak toggle backed by the framework's session-value
 * primitive. Click writes `name = value` via the `setSessionValue`
 * server action; the action returns an `{invalidate: ...}` directive
 * unioning every spec whose `vary` recorded a `session.*` read on
 * `name`, and the framework refetches that selector before the next
 * render.
 *
 * Renders an `<a href="#">` so accessibility / focus / hover work,
 * but intercepts plain left-clicks. Modifier-clicks pass through to
 * the browser (no useful default for `#`, but at least the page
 * doesn't lose focus on a meta-click).
 */
export function SessionToggleLink({
  name,
  value,
  className,
  title,
  active,
  testId,
  children,
}: {
  name: string
  value: string | number | boolean
  className?: string
  title?: string
  active?: boolean
  testId?: string
  children: ReactNode
}) {
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    void setSessionValue(name, value)
  }
  return (
    <a
      href="#"
      onClick={onClick}
      className={className}
      title={title}
      data-active={active ? "true" : undefined}
      data-testid={testId}
    >
      {children}
    </a>
  )
}
