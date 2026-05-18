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
    // E2E hydration signal: stamps `<body data-streaming-demo-ready>`
    // once this useEffect runs. Tests wait for the attribute before
    // clicking. React 19's event-replay only catches clicks that
    // fire AFTER `hydrateRoot` has installed its delegated root
    // listener — Playwright's `.click()` on a Test-Id locator often
    // races ahead of that window (the SSR HTML is in the DOM, but
    // `await createFromReadableStream(rscStream)` is still resolving
    // upstream of `hydrateRoot`). Without the signal the click hits
    // bare DOM, no React handler attached, no replay queue, and the
    // bump action never fires.
    document.body.setAttribute("data-streaming-demo-ready", "1")
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
