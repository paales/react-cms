"use client"

import { Fragment, useCallback, useRef, type FragmentInstance } from "react"
import { useActivate, type ActivatorFire } from "@react-cms/framework/lib/partial-client.tsx"
import type { ActivatorProps } from "@react-cms/framework"

export interface WhenVisibleProps extends ActivatorProps {
  /** `IntersectionObserver.rootMargin`. Default `"0px"`. */
  rootMargin?: string
  /** `IntersectionObserver.threshold`. */
  threshold?: number
}

/**
 * Activator: fires the enclosing Partial's refetch when the fallback
 * enters the viewport.
 *
 *   <Partial selector="#feed" fallback={<Skel/>} defer={<WhenVisible rootMargin="200px"/>}>
 *     <Feed/>
 *   </Partial>
 *
 * `partialId` and `children` are INJECTED by `<Partial defer=…>`. If
 * you need to render `<WhenVisible>` outside a `defer` slot (you
 * probably don't), pass `partialId` explicitly.
 *
 * Uses React 19 Fragment refs so there's no wrapper element around
 * the fallback. The IntersectionObserver attaches to the fragment's
 * DOM range.
 */
export function WhenVisible({
  partialId,
  children,
  rootMargin = "0px",
  threshold,
}: WhenVisibleProps) {
  if (!partialId) {
    throw new Error(
      "<WhenVisible> requires `partialId`. Use it as the `defer` prop " +
        "of a <Partial> (framework injects the id) or pass `partialId` " +
        "explicitly.",
    )
  }
  const ref = useRef<FragmentInstance | null>(null)
  const subscribe = useCallback(
    (fire: ActivatorFire) => {
      const instance = ref.current
      if (!instance) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) fire()
        },
        { rootMargin, threshold },
      )
      instance.observeUsing(observer)
      return () => {
        instance.unobserveUsing(observer)
        observer.disconnect()
      }
    },
    [rootMargin, threshold],
  )
  useActivate(partialId, subscribe)
  return <Fragment ref={ref}>{children}</Fragment>
}
