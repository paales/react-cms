"use client"

import { useEffect } from "react"

/** The bump control, plus the scenario hydration barrier: the effect
 *  only runs once the client runtime is live, so a spec that waits for
 *  `body[data-mp-ready]` never clicks pre-hydration DOM. */
export function BumpButton({ bump }: { bump: () => Promise<void> }) {
  useEffect(() => {
    document.body.dataset.mpReady = "1"
  }, [])
  return (
    <button data-testid="bump" onClick={() => void bump()}>
      Bump
    </button>
  )
}
