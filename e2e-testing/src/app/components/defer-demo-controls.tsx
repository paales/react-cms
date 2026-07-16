"use client"

import { useRef, useState } from "react"
import { useActivate, type ActivatorFire, type ActivatorProps } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"
import { bumpTag } from "../pages/tag-demo-actions.ts"

/**
 * Manual activator: a button in the dormant slot that fires the
 * activation on click. Demonstrates the click-driven shape of the
 * `useActivate` contract — the framework injects `partialId` (the
 * parton's effective id) into the `defer` element, and the fire
 * routes through the same id-forcing protocol every activator uses.
 */
export function WhenClicked({
  partialId,
  children,
  label,
  testId,
}: ActivatorProps & { label?: string; testId?: string }) {
  if (!partialId) {
    throw new Error("<WhenClicked> requires `partialId`. Use it as the `defer` prop of a parton.")
  }
  const fireRef = useRef<ActivatorFire | null>(null)
  useActivate(partialId, (fire) => {
    fireRef.current = fire
    return () => {
      fireRef.current = null
    }
  })
  return (
    <>
      {children}
      <div>
        <Button
          // `data-hydrated`: React owns the button (onClick live) — the
          // demo controls hydrate after the page shell; e2e specs click
          // via the marker-qualified locator.
          ref={(el) => el?.setAttribute("data-hydrated", "")}
          type="button"
          size="sm"
          variant="outline"
          data-testid={testId ?? "activate-manual"}
          onClick={() => fireRef.current?.()}
        >
          {label ?? "Activate"}
        </Button>
      </div>
    </>
  )
}

/**
 * Tag-bump refetch button: fires the `bumpTag` server action — the
 * event-shaped refresh signal. The concurrent partons subscribe by
 * reading `tag("concurrent-<x>")`; each bump lanes its reader on the
 * held stream, and rapid clicks produce concurrent lane renders.
 */
export function BumpButton({
  name,
  label,
  testId,
}: {
  name: string
  label?: string
  testId?: string
}) {
  const [pending, setPending] = useState(false)
  return (
    <Button
      // `data-hydrated` — see WhenClicked above.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId ?? `bump-${name}`}
      onClick={() => {
        setPending(true)
        void bumpTag(name).finally(() => setPending(false))
      }}
      disabled={pending}
    >
      {pending ? "…" : (label ?? "Refetch")}
    </Button>
  )
}
