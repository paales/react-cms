"use client"

import { useMemo } from "react"
import { useActivate, type ActivatorFire } from "@react-cms/framework/lib/partial-client.tsx"
import type { ActivatorProps } from "@react-cms/framework"

/**
 * Activator: fires immediately when the enclosing Partial mounts.
 *
 *   <Partial selector="#live" defer={<WhenMounted/>}>
 *     <LiveData/>
 *   </Partial>
 *
 * Useful when the Partial's content is too expensive to include in the
 * initial payload but should activate as soon as the page commits —
 * e.g. a client-side-only data path that the initial stream can't
 * produce, or a racing-flow demo where the activator fires in parallel
 * with a suspending sibling.
 *
 * The simplest possible activator — demonstrates the minimum shape of
 * the `useActivate` contract.
 */
export function WhenMounted({ partialId, children }: ActivatorProps) {
  if (!partialId) {
    throw new Error(
      "<WhenMounted> requires `partialId`. Use it as the `defer` prop of a <Partial>.",
    )
  }
  const subscribe = useMemo(
    () => (fire: ActivatorFire) => {
      fire()
    },
    [],
  )
  useActivate(partialId, subscribe)
  return <>{children}</>
}
