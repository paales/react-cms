/**
 * `<RemoteFrame>` — server-rendered frame from a remote origin.
 *
 * Fetches Flight bytes from another endpoint (same-origin in v1;
 * cross-origin once CSP / capability scoping land), pipes them
 * through the row-level rewriter, decodes the result, and returns
 * the tree as JSX. The outer Flight encoder serializes the
 * decoded subtree into the host's response, so Suspense pacing
 * inside the remote payload streams through to the client.
 *
 * Both the cache and `<RemoteFrame>` are consumers of the same
 * `flight-rewrite` primitive — wire-level stitching is the
 * framework's foundational composition mechanism. The cache passes
 * `passthroughRewriter`; `<RemoteFrame>` passes a `moduleRefRewriter`
 * for cross-origin paths.
 *
 * Place inside a Suspense boundary if the remote may be slow:
 *
 *   <Suspense fallback={<Spinner />}>
 *     <RemoteFrame src="/__remote/payment-form" parent={parent} />
 *   </Suspense>
 *
 * Wire format of the remote endpoint: a bare React element encoded
 * with `renderToReadableStream`. No Root, no wrapper object — the
 * decoded value IS the JSX to render here.
 */

import type { ReactNode } from "react"
import { createFromReadableStream } from "./flight-runtime.ts"
import {
  composeRewriters,
  moduleRefRewriter,
  passthroughRewriter,
  rewriteFlightStream,
  type RowRewriter,
} from "./flight-rewrite.ts"
import type { PartialCtx } from "./partial-context.ts"
import { getRequest } from "../runtime/context.ts"

export interface RemoteFrameProps {
  /** Absolute URL or same-origin path of the remote Flight endpoint. */
  src: string
  /** Host `PartialCtx`. Threaded through normal placement; the
   *  remote's render happens in its own process scope so this isn't
   *  forwarded over the wire, but the prop keeps the JSX call site
   *  consistent with other partons. */
  parent: PartialCtx
  /** Extra rewriter applied to every Flight row from the remote.
   *  Compose with the module-ref rewrite (auto-derived from `src`
   *  origin when `rewriteModuleRefs` is omitted or `true`). */
  rewriter?: RowRewriter
  /** Controls module-ref rewriting:
   *  - `true` / omitted: relative paths (`./X.tsx`) and absolute
   *    server paths (`/src/X.tsx`) are rewritten to absolute URLs
   *    at the remote origin so the host's browser can dynamically
   *    import them.
   *  - `false`: pass through unchanged. Use when the remote already
   *    emits absolute URLs in its module refs.
   *  - `(path) => path`: custom rewrite. */
  rewriteModuleRefs?: boolean | ((path: string) => string)
  /** Optional headers to send on the remote fetch. The capability
   *  surface will be carried here once it lands. */
  headers?: Record<string, string>
}

function defaultModuleRewrite(srcOrigin: string): (path: string) => string {
  return (path) => {
    // Only rewrite paths that look local to the remote — leave
    // already-absolute URLs and bare package specifiers alone.
    if (path.startsWith("http://") || path.startsWith("https://")) return path
    if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) {
      try {
        return new URL(path, srcOrigin).href
      } catch {
        return path
      }
    }
    return path
  }
}

/** True iff `src` is an absolute URL (different origin possible). */
function isAbsoluteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://")
}

export async function RemoteFrame({
  src,
  parent: _parent,
  rewriter,
  rewriteModuleRefs,
  headers,
}: RemoteFrameProps): Promise<ReactNode> {
  // Resolve `src` to an absolute URL. `fetch` in the server runtime
  // doesn't accept bare-path inputs — and we need the origin
  // anyway to decide whether module-ref rewriting applies.
  const wasRelative = !isAbsoluteUrl(src)
  const absoluteSrc = wasRelative
    ? new URL(src, getRequest().url).href
    : src

  const response = await fetch(absoluteSrc, { headers })
  if (!response.ok || !response.body) {
    throw new Error(
      `RemoteFrame: fetch failed for ${absoluteSrc} (status ${response.status})`,
    )
  }

  // Auto-derive module rewrite policy from `src`:
  // - Relative `src` (same-origin): no rewrite needed; host's bundle
  //   already knows the modules.
  // - Absolute `src` (cross-origin): default to rewriting relative
  //   module paths to the remote origin so the host browser can
  //   import them.
  const transform: ((path: string) => string) | null =
    rewriteModuleRefs === false
      ? null
      : typeof rewriteModuleRefs === "function"
        ? rewriteModuleRefs
        : wasRelative
          ? null
          : defaultModuleRewrite(new URL(absoluteSrc).origin)

  const moduleRw: RowRewriter =
    transform != null ? moduleRefRewriter(transform) : passthroughRewriter

  const pipeline: RowRewriter =
    rewriter != null ? composeRewriters(moduleRw, rewriter) : moduleRw

  const rewrittenStream = rewriteFlightStream(response.body, pipeline)
  return await createFromReadableStream<ReactNode>(rewrittenStream)
}
