"use client"

import type { ResolvedCell } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"
import { pushSeq } from "../pages/streaming-demo-actions.ts"

/**
 * Bump button — receives the resolved `bumps` cell via Flight prop
 * from `BumpCounter`'s schema. `.value` is the snapshot from the
 * server's last render; `.set` is the bound server-action ref
 * (`__cellWrite.bind(null, "demo.bumps")`). On commit, the action
 * fires `refreshSelector("cell:demo.bumps")`, which re-renders every
 * parton that resolved that cell.
 */
export function BumpButton({ bumps }: { bumps: ResolvedCell<number> }) {
  return (
    <Button
      // `data-hydrated` — see PushUrlButton below.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
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
      // `data-hydrated`: React owns the button (onClick live) — the
      // demo partials hydrate after the page shell; e2e specs click
      // via the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
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
