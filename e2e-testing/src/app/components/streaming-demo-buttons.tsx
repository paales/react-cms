"use client"

import { useEffect } from "react"
import type { ResolvedCell } from "@parton/framework"
import { Button } from "@parton/copies/components/ui/button"
import { pushSeq } from "../pages/streaming-demo-actions.ts"

/**
 * Stamps `<body data-streaming-demo-ready>` on hydration so the
 * Playwright spec can wait for React 19's event-replay to be
 * installed before clicking. Without this, fast Playwright clicks
 * land on the SSR DOM before `hydrateRoot` attached its delegated
 * root listener and the click is a no-op.
 *
 * The previous design also kicked the live-tick stream open here.
 * That's now framework-owned (the auto-injected `<LivePageHeartbeat>`
 * inside `PartialsClient`), so this component is only a hydration
 * signal for the test harness.
 */
export function StreamingDemoReady() {
  useEffect(() => {
    document.body.setAttribute("data-streaming-demo-ready", "1")
  }, [])
  return null
}

/**
 * Bump button — receives the resolved `bumps` cell via Flight prop
 * from `BumpCounter`'s schema. `.value` is the snapshot from the
 * server's last render; `.set` is the bound server-action ref
 * (`__cellWrite.bind(null, "demo.bumps")`). On commit, the action
 * fires `getServerNavigation().reload({selector: "cell:demo.bumps"})`
 * which refetches every parton carrying that label.
 */
export function BumpButton({ bumps }: { bumps: ResolvedCell<number> }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="streaming-demo-bump-btn"
      onClick={() => {
        void bumps.set(bumps.value + 1)
      }}
      className="w-fit"
    >
      Bump
    </Button>
  )
}

export function PushUrlButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="streaming-demo-push-btn"
      onClick={() => {
        void pushSeq()
      }}
      className="w-fit"
    >
      Push URL
    </Button>
  )
}
