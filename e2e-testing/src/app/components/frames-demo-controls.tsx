"use client"

import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

/**
 * Button that navigates a named frame to a URL. Used from INSIDE a
 * frame's content — `frame` prop is optional; when omitted,
 * `useNavigation()` defaults to the ambient frame.
 */
export function FrameNavigateButton({
  frame: frameName,
  url,
  label,
  testId,
}: {
  frame?: string
  url: string
  label: string
  testId?: string
}) {
  const nav = useNavigation(frameName)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId ?? `frame-nav-${nav.name ?? "window"}`}
      onClick={() => void nav.navigate(url)}
    >
      {label}
    </Button>
  )
}

/**
 * Button that calls `updateCurrentEntry` to attach frame-state
 * to the current history entry.
 */
export function UpdateEntryStateButton({
  frame: frameName,
  patch,
  label,
  testId,
}: {
  frame?: string
  patch: Record<string, unknown>
  label: string
  testId?: string
}) {
  const nav = useNavigation(frameName)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId ?? `update-entry-${nav.name ?? "window"}`}
      onClick={() => nav.updateCurrentEntry({ state: patch })}
    >
      {label}
    </Button>
  )
}
