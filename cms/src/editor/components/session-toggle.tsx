"use client"

import type { ReactNode } from "react"
// Deep-import is required: `__cellWrite` is a server action and
// this file is `"use client"` — going through the cross-package
// barrel mis-resolves the Flight reference. See the caveat in
// `framework/index.ts`.
import { __cellWrite } from "@parton/framework/runtime/cell-actions.ts"

/**
 * Editor tweak toggle backed by a cell. The toggle's `name` is the
 * cell id (the editor cells in `state.ts` use the same id format
 * the legacy `session.enum` names did — `"editor-palette"`,
 * `"editor-tree-style"`, etc.) — so the toggle UI still addresses
 * settings by name while the underlying write goes through
 * `__cellWrite(id, value)`.
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
    void __cellWrite(name, value)
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
