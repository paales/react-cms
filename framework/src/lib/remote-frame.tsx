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
import { registerPartial, type PartialSnapshot } from "./partial-registry.ts"
import {
  parseSnapshotTrailer,
  splitStreamAtSnapshotTrailer,
} from "./snapshot-trailer.ts"
import { getRequest } from "../runtime/context.ts"
import {
  CAPABILITY_HEADER,
  encodeCapability,
  type Capability,
} from "../runtime/capability.ts"

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
  /** Optional headers to send on the remote fetch. Composed
   *  with the capability header (the capability wins on collision). */
  headers?: Record<string, string>
  /** Host-declared scope the remote can read. Flat record of
   *  JSON-serializable values; serialized as the
   *  `x-parton-capability` header. The remote endpoint reads it
   *  into an ALS context and exposes via `getCapability()` to
   *  rendering specs. The remote sees ONLY what's declared
   *  here — the host's cookies don't leak (the fetch is
   *  `credentials: "omit"`). */
  capability?: Capability
  /** Stream the remote's payload through to the host's outer
   *  encoder instead of buffering first. Default `false`.
   *
   *  `true`: the host's decoder starts as the first chunk arrives;
   *  Suspense boundaries inside the remote payload stream their
   *  reveals to the host incrementally. Trade-off: snapshot
   *  registration happens asynchronously (on remote stream-end)
   *  and the timing can race the host's commit, causing the
   *  `usePartialReconcile` hook to see initial-render events for
   *  the remote's PartialBoundary that with the buffered path
   *  would happen before the subscription was set up. Use when
   *  the within-remote streaming win outweighs that wrinkle.
   *
   *  `false` (default): buffer the full remote response, parse
   *  the trailer, register snapshots, then decode. Each remote
   *  arrives atomically; multiple remote frames on the same page
   *  still parallelise via their own Suspense boundaries. The
   *  reconcile-hook timing is clean.
   */
  streaming?: boolean
}

function defaultModuleRewrite(srcOrigin: string): (path: string) => string {
  return (path) => {
    // Already-absolute URLs and bare package specifiers: leave alone.
    if (path.startsWith("http://") || path.startsWith("https://")) return path

    // Dev-mode filesystem-absolute paths (`/@fs/Users/...`). Both
    // host and remote run on the same machine in development, so
    // either process can serve the same path. Adding the remote
    // origin would actually break the host's vite-rsc plugin —
    // it rejects cross-origin URLs as invalid client references.
    // For shared framework modules (PartialErrorBoundary etc.)
    // the host can resolve `/@fs/...framework/...` against its own
    // bundle. Leaving these alone makes dev "just work".
    //
    // Production cross-origin is a different shape entirely (the
    // remote emits hashed asset URLs at its CDN; CORS on the
    // bundle assets lets the host browser load them). Authors
    // who need that can override via the `rewriteModuleRefs`
    // prop.
    if (path.startsWith("/@fs/") || path.startsWith("/@id/")) return path

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

// ─── Per-request fetch dedup ───────────────────────────────────────────
//
// Multiple `<RemoteFrame src=… capability=…>` placements on the same
// page would each fire a separate fetch even when the (src,
// capability) tuple is identical. Dedup: cache the FETCH on the
// in-flight request so identical placements share one network call.
// The buffered path returns the same byte array to each caller.
//
// Cache lives in a WeakMap keyed by the request object, so it dies
// with the request — no cross-request leakage. Streaming-mode
// RemoteFrames don't dedup (the streams are single-use and tee-ing
// would defeat the streaming purpose); they fire their own fetch
// each time, which is unusual enough to be the right default.

interface RemoteFetchResult {
  buffer: Uint8Array
}

const dedupByRequest = new WeakMap<Request, Map<string, Promise<RemoteFetchResult>>>()

function dedupKey(absoluteSrc: string, capability: Capability | undefined): string {
  return capability === undefined
    ? absoluteSrc
    : `${absoluteSrc}\x00${encodeCapability(capability)}`
}

function getDedupCache(): Map<string, Promise<RemoteFetchResult>> {
  let req: Request
  try {
    req = getRequest()
  } catch {
    // No request context (rare — RemoteFrame outside a server render).
    // Fall back to a private map so the function still works.
    return new Map()
  }
  let cache = dedupByRequest.get(req)
  if (!cache) {
    cache = new Map()
    dedupByRequest.set(req, cache)
  }
  return cache
}

async function fetchRemoteBuffered(
  absoluteSrc: string,
  capability: Capability | undefined,
  requestHeaders: Record<string, string>,
): Promise<RemoteFetchResult> {
  const cache = getDedupCache()
  const key = dedupKey(absoluteSrc, capability)
  let pending = cache.get(key)
  if (pending) return pending
  pending = (async () => {
    const response = await fetch(absoluteSrc, {
      headers: requestHeaders,
      credentials: "omit",
    })
    if (!response.ok || !response.body) {
      throw new Error(
        `RemoteFrame: fetch failed for ${absoluteSrc} (status ${response.status})`,
      )
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    return { buffer }
  })()
  cache.set(key, pending)
  return pending
}

export async function RemoteFrame({
  src,
  parent: _parent,
  rewriter,
  rewriteModuleRefs,
  headers,
  capability,
  streaming = false,
}: RemoteFrameProps): Promise<ReactNode> {
  // Resolve `src` to an absolute URL. `fetch` in the server runtime
  // doesn't accept bare-path inputs — and we need the origin
  // anyway to decide whether module-ref rewriting applies.
  const wasRelative = !isAbsoluteUrl(src)
  const absoluteSrc = wasRelative
    ? new URL(src, getRequest().url).href
    : src

  const requestHeaders: Record<string, string> = { ...(headers ?? {}) }
  if (capability !== undefined) {
    requestHeaders[CAPABILITY_HEADER] = encodeCapability(capability)
  }

  const sourceOrigin = new URL(absoluteSrc).origin
  // Only stamp `source` when the remote is genuinely on a
  // different origin from the host. For same-origin remotes
  // (`src` was relative or shares the host's origin), the host
  // already has the spec module in its catalog — the existing
  // local Component path in `partialFromSnapshot` handles
  // refetch correctly and is strictly faster than round-tripping
  // through a fresh `<RemoteFrame>` fetch. Stamping source for
  // same-origin would force every refetch onto the remote fetch
  // path, regressing speed and re-introducing the snapshot-
  // trailer timing concerns for hooks that observe registration
  // events (`usePartialReconcile`).
  const hostOrigin = (() => {
    try {
      return new URL(getRequest().url).origin
    } catch {
      return ""
    }
  })()
  const isCrossOrigin = sourceOrigin !== hostOrigin && hostOrigin !== ""
  const stampSource = (snap: PartialSnapshot): PartialSnapshot =>
    isCrossOrigin
      ? {
          ...snap,
          source: {
            kind: "remote",
            origin: sourceOrigin,
            capability: capability as Record<string, unknown> | undefined,
          },
        }
      : snap

  let flightStreamForDecode: ReadableStream<Uint8Array>

  if (streaming) {
    // Streaming split — no dedup (streams are single-use and
    // tee-ing would defeat the streaming purpose). Each placement
    // fires its own fetch.
    const response = await fetch(absoluteSrc, {
      headers: requestHeaders,
      credentials: "omit",
    })
    if (!response.ok || !response.body) {
      throw new Error(
        `RemoteFrame: fetch failed for ${absoluteSrc} (status ${response.status})`,
      )
    }
    const split = splitStreamAtSnapshotTrailer(response.body)
    flightStreamForDecode = split.mainStream
    void split.trailer.then((snapshots) => {
      if (!snapshots) return
      for (const [id, snap] of Object.entries(snapshots)) {
        registerPartial(id, stampSource(snap))
      }
    })
  } else {
    // Buffer-then-split (default) — dedup applies: identical
    // (src, capability) placements on the same page share one
    // fetch. Each placement still parses + registers + decodes
    // independently (each gets its own decoded React tree, so
    // the host can render them in different positions).
    const { buffer } = await fetchRemoteBuffered(absoluteSrc, capability, requestHeaders)
    const { flightBytes, snapshots } = parseSnapshotTrailer(buffer)
    if (snapshots) {
      for (const [id, snap] of Object.entries(snapshots)) {
        registerPartial(id, stampSource(snap))
      }
    }
    flightStreamForDecode = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(flightBytes)
        controller.close()
      },
    })
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

  const rewrittenStream = rewriteFlightStream(flightStreamForDecode, pipeline)
  return await createFromReadableStream<ReactNode>(rewrittenStream)
}
