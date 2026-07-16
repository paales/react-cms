"use client"

import type { ReactNode } from "react"
import { useNavigation } from "@parton/framework/client"
// Deep-import from `cms-constants.ts` (zero side-effect imports)
// rather than `cms-runtime.ts` (which transitively loads
// `context.ts` → `node:async_hooks`, externalised for browser, throws
// at module-evaluation time). Importing through the barrel
// mis-resolves the Flight reference; both paths must be avoided
// from `"use client"` files.
import { EDITOR_COOKIE } from "@parton/framework/runtime/cms-constants.ts"

/**
 * Closes design mode by flipping `EDITOR_COOKIE` off via the
 * navigation API's client-side `cookies` option. One round trip
 * (the refetch fetch ships the new cookie value); no server
 * action, no `setCookie` side-effect in render.
 */
export function EditorCloseLink({
  className,
  title,
  testId,
  children,
}: {
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
    void navigate(window.location.pathname + window.location.search, {
      history: "replace",
      cookies: { [EDITOR_COOKIE]: "" },
    })
  }
  return (
    <a
      href="#"
      onClick={onClick}
      className={className}
      title={title}
      aria-label="Close editor"
      data-testid={testId}
    >
      {children}
    </a>
  )
}
