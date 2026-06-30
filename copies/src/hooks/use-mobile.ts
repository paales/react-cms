import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Subscribe to the breakpoint media query as an external store: no
  // setState-in-effect, and SSR gets a defined snapshot (false) instead of
  // the undefined → first-paint flash the useState version had.
  const subscribe = React.useCallback((onStoreChange: () => void) => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onStoreChange)
    return () => mql.removeEventListener("change", onStoreChange)
  }, [])
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  )
}
