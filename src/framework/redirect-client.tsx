"use client"

import { useEffect } from "react"
import { useNavigation } from "../lib/partial-client.tsx"

/**
 * Client-side redirect. Rendered by `Root` when a page threw
 * `redirect(url)`. Calls through the framework's window navigation
 * handle on mount so the route-intercept machinery runs normally
 * (and commits the destination's payload to the destination URL).
 *
 * For HTML requests we'd rather the browser follow a 302 than
 * wait for hydration — the entry handler checks the framework
 * control channel after `renderHTML` awaits and returns 302 +
 * Location, pre-empting this component from ever running on the
 * client. This component is the fallback for RSC refetches, where
 * a `fetch()` 302 would transparently follow and commit the
 * wrong payload.
 */
export function Redirect({ url }: { url: string }) {
  const nav = useNavigation()
  useEffect(() => {
    void nav.navigate(url)
  }, [url, nav])
  return null
}
