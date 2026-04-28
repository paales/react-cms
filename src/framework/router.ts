import { getRequest } from "./context.ts"

export type RouteParams = Record<string, string | undefined>

/**
 * Top-level route match. Reads the current request's pathname from
 * the ambient request context — callers don't thread a URL through.
 * Intended for page-level routing (`if (matchPath("/foo")) return
 * <Foo/>`); inside a `<Partial cache>` body, use `getPathname(pattern)`
 * instead so the match participates in the cache manifest.
 */
export function matchPath(pattern: string): RouteParams | null {
  const url = new URL(getRequest().url)
  const result = new URLPattern({ pathname: pattern }).exec({
    pathname: url.pathname,
  })
  return result ? (result.pathname.groups as RouteParams) : null
}

/**
 * Walk a pattern → handler list; invoke the first handler whose
 * pattern matches. Same ambient-URL behavior as `matchPath`.
 */
export function pickRoute<T>(routes: Array<[string, (params: RouteParams) => T]>): T | null {
  for (const [pattern, handler] of routes) {
    const params = matchPath(pattern)
    if (params !== null) return handler(params)
  }
  return null
}
