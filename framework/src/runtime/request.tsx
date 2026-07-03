const URL_POSTFIX = "_.rsc"
const HEADER_ACTION_ID = "x-rsc-action"

/** Marks a request as a client-driven RSC refetch (a `_.rsc` GET/POST),
 *  as opposed to an initial SSR document load. Stamped by
 *  `parseRenderRequest`; read by `PartialRoot` to decide whether the
 *  page URL needs serializing into the payload (the client ignores it on
 *  a refetch — the live Navigation API is the source of truth there).
 *  Carried as a header rather than ALS state so it survives the
 *  `new Request(...)` reconstruction below into the render context.
 *  `x-parton-*` headers are stripped from the vary-facing header surface
 *  (`headersToRecord` in partial.tsx) so they never reach app code. */
export const HEADER_RSC_RENDER = "x-parton-render"

/** Framework-internal query params appended to RSC fetch URLs. They drive
 *  `PartialRoot`'s refetch routing (`partials`/`cached`), the client commit
 *  mode (`streaming`), the segment driver's hold-open subscription
 *  (`live`) and its connection-session id (`__conn`), and post-action
 *  cache repopulation (`__populateCache`) — all consumed off the raw
 *  `getRequest()` before any spec renders. They're
 *  stripped from the page URL serialized into the payload for descendant
 *  client components (`PageUrlProvider`): meaningless to app code, and — for
 *  `cached` — kilobytes that would otherwise echo back in every payload.
 *
 *  `__frame` / `__frameUrl` are deliberately NOT here: a spec may read them
 *  legitimately (the CMS editor checks `__frame=preview`). Neither is
 *  `visible` — the `visible()` hook reads it off the request URL as the
 *  no-connection fallback carrier. A real SSR
 *  document load carries none of these params anyway, so the serialized
 *  page URL is already clean there — this is belt-and-braces. */
export const FRAMEWORK_URL_PARAMS = [
  "partials",
  "cached",
  "streaming",
  "live",
  "__conn",
  "__populateCache",
  "__nojs",
  "__cullFlip",
] as const

/** Return `urlString` with every framework-internal query param removed.
 *  Pure string→string; real app params (`?q=`, `?pages=`) pass through
 *  in place. Returns the input unchanged when no framework param was
 *  present, so a clean URL is never re-normalized. */
export function stripFrameworkParams(urlString: string): string {
  const url = new URL(urlString)
  let changed = false
  for (const p of FRAMEWORK_URL_PARAMS) {
    if (url.searchParams.has(p)) {
      url.searchParams.delete(p)
      changed = true
    }
  }
  return changed ? url.toString() : urlString
}

export type RenderRequest = {
  isRsc: boolean
  isAction: boolean
  actionId?: string
  request: Request
  url: URL
}

export function createRscRenderRequest(
  urlString: string,
  action?: { id: string; body: BodyInit },
): Request {
  const url = new URL(urlString)
  url.pathname += URL_POSTFIX
  const headers = new Headers()
  if (action) {
    headers.set(HEADER_ACTION_ID, action.id)
  }
  return new Request(url.toString(), {
    method: action ? "POST" : "GET",
    headers,
    body: action?.body,
  })
}

export function parseRenderRequest(request: Request): RenderRequest {
  const url = new URL(request.url)
  const isAction = request.method === "POST"
  if (url.pathname.endsWith(URL_POSTFIX)) {
    url.pathname = url.pathname.slice(0, -URL_POSTFIX.length)
    const actionId = request.headers.get(HEADER_ACTION_ID) || undefined
    if (request.method === "POST" && !actionId) {
      throw new Error("Missing action id header for RSC action request")
    }
    // Rebuild on the de-postfixed URL and stamp the RSC-render marker so
    // `PartialRoot` can tell a client refetch from an SSR document. Body
    // is preserved (and `duplex` set) for action POSTs.
    const headers = new Headers(request.headers)
    headers.set(HEADER_RSC_RENDER, "1")
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers }
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body
      init.duplex = "half"
    }
    return {
      isRsc: true,
      isAction,
      actionId,
      request: new Request(url, init),
      url,
    }
  }
  return { isRsc: false, isAction, request, url }
}
