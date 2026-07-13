const URL_POSTFIX = "_.rsc"
const HEADER_ACTION_ID = "x-rsc-action"

/** Marks a request as a client-driven RSC render (an action `_.rsc`
 *  POST, or the attach's render request built by the entry from the
 *  statement's URL), as opposed to an initial SSR document load.
 *  Stamped by `parseRenderRequest` / the attach endpoint; read by
 *  `PartialRoot` to decide whether the page URL needs serializing into
 *  the payload (the client ignores it on a refetch — the live
 *  Navigation API is the source of truth there).
 *  Carried as a header rather than ALS state so it survives the
 *  `new Request(...)` reconstruction below into the render context.
 *  `x-parton-*` headers are stripped from the vary-facing header surface
 *  (`headersToRecord` in partial.tsx) so they never reach app code. */
export const HEADER_RSC_RENDER = "x-parton-render"

/** Framework-internal query params on render-request URLs. `cached`
 *  rides only action POST URLs (the response render's fp-skip manifest
 *  — capped, request-line-bound); `__nojs` is the document-level
 *  no-hydration debug flag. Both are consumed off the raw
 *  `getRequest()` before any spec renders, and stripped from the page
 *  URL serialized into the payload for descendant client components
 *  (`PageUrlProvider`): meaningless to app code, and — for `cached` —
 *  kilobytes that would otherwise echo back in every payload.
 *
 *  `__frame` / `__frameUrl` are deliberately NOT here: a spec may read
 *  them legitimately (the CMS editor checks `__frame=preview`), and a
 *  degraded page's frame navigation is a document GET carrying them.
 *  Everything the interactive transport needs rides the channel — the
 *  attach statement's body and `url` frames — never a page URL. */
export const FRAMEWORK_URL_PARAMS = ["cached", "__nojs"] as const

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
  extraHeaders?: Record<string, string>,
): Request {
  const url = new URL(urlString)
  url.pathname += URL_POSTFIX
  const headers = new Headers()
  if (action) {
    headers.set(HEADER_ACTION_ID, action.id)
  }
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value)
    }
  }
  return new Request(url.toString(), {
    method: action ? "POST" : "GET",
    headers,
    body: action?.body,
  })
}

export function parseRenderRequest(request: Request): RenderRequest {
  const url = new URL(request.url)
  const isPost = request.method === "POST"
  // A GET carrying the RSC-render header is a server-to-server page
  // embed (`<RemoteFrame>` — see `lib/page-embed.ts`): return Flight,
  // not an HTML document. The URL stays the ordinary page URL, so
  // match gates, tracked reads, and route keying all evaluate the
  // page itself. A POST carrying the same header on a plain page URL
  // (never the `_.rsc` action postfix) is the SAME request kind with a
  // bound-cell projection in its body (`x-parton-embed-cells` — cell
  // values may exceed any header ceiling, so they ride the body); the
  // header, not the method, is the dispatch signal either way.
  if (
    request.headers.get(HEADER_RSC_RENDER) === "1" &&
    (!isPost || !url.pathname.endsWith(URL_POSTFIX))
  ) {
    return { isRsc: true, isAction: false, request, url }
  }
  // The `_.rsc` postfix marks exactly one request kind: an action POST
  // (the attach rides its own endpoint, `POST /__parton/live`; every
  // other GET is a document). A postfixed non-POST is not a render
  // request — it falls through as a document URL nothing routes.
  if (isPost && url.pathname.endsWith(URL_POSTFIX)) {
    url.pathname = url.pathname.slice(0, -URL_POSTFIX.length)
    const actionId = request.headers.get(HEADER_ACTION_ID) || undefined
    if (!actionId) {
      throw new Error("Missing action id header for RSC action request")
    }
    // Rebuild on the de-postfixed URL and stamp the RSC-render marker so
    // `PartialRoot` can tell a client render from an SSR document. Body
    // is preserved (and `duplex` set) for the action POST.
    const headers = new Headers(request.headers)
    headers.set(HEADER_RSC_RENDER, "1")
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers }
    init.body = request.body
    init.duplex = "half"
    return {
      isRsc: true,
      isAction: true,
      actionId,
      request: new Request(url, init),
      url,
    }
  }
  return { isRsc: false, isAction: isPost, request, url }
}
