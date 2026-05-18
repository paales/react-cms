"use client"

import { useEffect } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"
import { bumpDemoCounter, pushSeq } from "../pages/streaming-demo-actions.ts"

/**
 * Engages the segment loop on mount by firing a targeted RSC GET for
 * the live-tick partial. Without this, the initial SSR renders the
 * tick once and the page is static; with it, the client opens an RSC
 * GET that the server's segment driver keeps alive — each
 * `refreshSelector("streaming-demo-tick")` arrival re-renders the
 * partial and ships a new segment.
 */
export function LiveTickAutostart() {
  const [reload] = useNavigation().reload()
  useEffect(() => {
    void reload({ selector: "streaming-demo-tick", disableTransition: true })
  }, [reload])
  return null
}

export function BumpButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="streaming-demo-bump-btn"
      onClick={() => {
        void bumpDemoCounter()
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
