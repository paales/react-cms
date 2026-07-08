/**
 * `<RemoteFrame>` — server-rendered frame from a remote endpoint.
 *
 * Fetches Flight bytes from another endpoint (same-origin path or
 * cross-origin URL), streams them through the row-level rewriter,
 * decodes the result, and returns the tree as JSX. The outer Flight
 * encoder serializes the decoded subtree into the host's response,
 * so Suspense pacing inside the remote payload streams through to
 * the client.
 *
 * Both the cache and `<RemoteFrame>` are consumers of the same
 * `flight-rewrite` primitive — wire-level stitching is the
 * framework's foundational composition mechanism. The cache passes
 * `passthroughRewriter`; `<RemoteFrame>` passes `moduleRefRewriter`
 * for cross-origin paths so the host's browser can resolve module
 * references back to the remote's origin.
 *
 * The snapshot trailer arrives at the END of the remote's stream, so
 * registration would normally land after the host's commit fired
 * (registration is in a `.then` microtask after the trailer Promise
 * resolves). To avoid that race, RemoteFrame calls
 * `deferCommitUntil(registrationPromise)` — the host's stream
 * wrappers (`wrapStreamWithFpTrailer` etc.) `Promise.allSettled` the
 * pending defers before firing commit, so the route-hint write for
 * every nested addressable partial lands before the response goes
 * out. Streaming is preserved end-to-end.
 *
 * Place inside a Suspense boundary if the remote may be slow:
 *
 *   <Suspense fallback={<Spinner />}>
 *     <RemoteFrame url="/__remote/payment-form" />
 *   </Suspense>
 */

import type { ReactNode } from "react"
import { createFromReadableStream } from "./flight-runtime.ts"
import {
  moduleRefRewriter,
  passthroughRewriter,
  rewriteFlightStream,
  type RowRewriter,
} from "./flight-rewrite.ts"
import type { PartialCtx } from "./partial-context.ts"
import { deferCommitUntil, registerPartial, type PartialSnapshot } from "./partial-registry.ts"
import { splitStreamAtSnapshotTrailer } from "./snapshot-trailer.ts"
import { getRequest } from "../runtime/context.ts"
import { CAPABILITY_HEADER, encodeCapability, type Capability } from "../runtime/capability.ts"

export interface RemoteFrameProps {
  /** Absolute URL or same-origin path of the remote Flight endpoint. */
  url: string
  /** Host-declared scope the remote can read. Flat record of
   *  JSON-serializable values; serialized as the
   *  `x-parton-capability` header. The remote endpoint reads it
   *  into an ALS context and exposes via `getCapability()` to
   *  rendering specs. The remote sees ONLY what's declared
   *  here — the host's cookies don't leak (the fetch is
   *  `credentials: "omit"`). */
  capability?: Capability
  /** Namespace prefix to apply to every id and label registered
   *  from this remote's snapshot trailer. `magento` turns the
   *  remote's `stocks` spec into a `magento:stocks` entry in the
   *  host's registry; selectors like `nav.reload({selector:
   *  "magento:stocks"})` then match without colliding with a local
   *  `stocks` spec or another remote's `stocks`. The original (bare)
   *  remote id lives on `snap.source.remoteId` so refetch routing
   *  can rebuild the right `/__remote/<id>` URL. The CLI's generated
   *  bindings pass this automatically using the install name. */
  namespace?: string
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

function isAbsoluteUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

function applyNamespace(snap: PartialSnapshot, namespace: string | undefined): PartialSnapshot {
  if (!namespace) return snap
  return {
    ...snap,
    labels: snap.labels.map((l) => `${namespace}:${l}`),
  }
}

export async function RemoteFrame({
  url,
  capability,
  namespace,
}: RemoteFrameProps): Promise<ReactNode> {
  // Resolve `url` to an absolute form. `fetch` in the server runtime
  // doesn't accept bare-path inputs — and we need the origin
  // anyway to decide whether module-ref rewriting applies.
  const wasRelative = !isAbsoluteUrl(url)
  const absoluteUrl = wasRelative ? new URL(url, getRequest().url).href : url

  const requestHeaders: Record<string, string> = {}
  if (capability !== undefined) {
    requestHeaders[CAPABILITY_HEADER] = encodeCapability(capability)
  }
  // Requests spawned on behalf of a scoped request inherit its scope:
  // the test harness partitions process-wide server state per
  // `x-test-scope` (see `runtime/context.ts` — `deriveScope`), and a
  // remote render is part of the host request's work. Without the
  // forward, every remote render lands in the shared default bucket —
  // parallel workers then contend on (and must wholesale-clear) each
  // other's remote caches.
  const hostScopeHeader = getRequest().headers.get("x-test-scope")
  if (hostScopeHeader) requestHeaders["x-test-scope"] = hostScopeHeader

  const sourceOrigin = new URL(absoluteUrl).origin
  // Only stamp `source` when the remote is genuinely on a different
  // origin from the host. For same-origin remotes the host already
  // has the spec in its catalog — the existing local Component path
  // in `partialFromSnapshot` handles refetch correctly and is
  // strictly faster than round-tripping through a fresh
  // `<RemoteFrame>` fetch.
  const hostOrigin = (() => {
    try {
      return new URL(getRequest().url).origin
    } catch {
      return ""
    }
  })()
  const isCrossOrigin = sourceOrigin !== hostOrigin && hostOrigin !== ""

  const response = await fetch(absoluteUrl, {
    headers: requestHeaders,
    credentials: "omit",
  })
  if (!response.ok || !response.body) {
    throw new Error(`RemoteFrame: fetch failed for ${absoluteUrl} (status ${response.status})`)
  }
  const split = splitStreamAtSnapshotTrailer(response.body)

  // Snapshot registration runs in this RemoteFrame's ALS scope (the
  // host's request registry). `.then` captures the current async
  // context, so the registration calls land in the host's
  // `pendingWrites` + canonical store + hint table.
  //
  // Without the defer below, the trailer Promise can resolve AFTER
  // the host's outer stream has flushed and committed — the
  // registration writes get applied but the route-hint table has
  // already been finalised, so cache-mode lookups miss. The defer
  // makes the host's commit wait for this Promise via the
  // stream-wrapping helpers' `Promise.allSettled` pass.
  const registration = split.trailer.then((snapshots) => {
    if (!snapshots) return
    for (const [bareId, snap] of Object.entries(snapshots)) {
      const id = namespace ? `${namespace}:${bareId}` : bareId
      const namespaced = applyNamespace(snap, namespace)
      const stamped: PartialSnapshot = isCrossOrigin
        ? {
            ...namespaced,
            source: {
              kind: "remote",
              origin: sourceOrigin,
              capability: capability as Record<string, unknown> | undefined,
              remoteId: bareId,
            },
          }
        : namespaced
      registerPartial(id, stamped)
    }
  })
  deferCommitUntil(registration)

  // Module-ref rewriting policy auto-derives from URL shape:
  // - Same-origin (relative `url`): host's bundle already knows the
  //   modules; no rewrite needed.
  // - Cross-origin (absolute `url`): rewrite relative module paths
  //   to absolute URLs at the remote origin so the host's browser
  //   can dynamically import them.
  const pipeline: RowRewriter = wasRelative
    ? passthroughRewriter
    : moduleRefRewriter(defaultModuleRewrite(sourceOrigin))

  const rewrittenStream = rewriteFlightStream(split.mainStream, pipeline)
  return await createFromReadableStream<ReactNode>(rewrittenStream)
}

/**
 * Typed binding factory for a remote spec.
 *
 * The CLI's `parton add` command generates files that call this
 * with the remote origin + selector baked in, producing a typed
 * component the host imports and renders directly:
 *
 *     // generated bindings (src/remote/magento/index.ts)
 *     export const MagentoPaymentSummary = remote<PaymentCap>({
 *       origin: "http://localhost:5181",
 *       selector: "magento-payment-summary",
 *       namespace: "magento",
 *     })
 *
 *     // host call site
 *     <MagentoPaymentSummary
 *       capability={{ cart_id: "...", currency: "EUR", total: 127.45 }}
 *     />
 *
 * The capability shape is enforced at compile time — the host
 * cannot pass a value that doesn't match what the remote spec
 * declared. The `namespace` is the CLI's install name; the host's
 * registry stores ids as `<namespace>:<selector>`, so two remotes
 * with overlapping selectors don't collide.
 */
export function remote<Cap = void>(opts: {
  origin: string
  selector: string
  namespace?: string
}): (
  props: {
    /** Optional URL search params appended to the remote's endpoint
     *  URL. Useful when the remote spec varies on its own
     *  `?step=…` etc. and the host wants to drive that variant from
     *  a wrapper parton's `vary`. */
    searchParams?: Record<string, string>
  } & (Cap extends void ? { capability?: never } : { capability: Cap }),
) => Promise<ReactNode> {
  const baseUrl = `${opts.origin}/__remote/${encodeURIComponent(opts.selector)}`
  return async function RemoteBinding(props) {
    const url =
      props.searchParams && Object.keys(props.searchParams).length > 0
        ? `${baseUrl}?${new URLSearchParams(props.searchParams).toString()}`
        : baseUrl
    return await RemoteFrame({
      url,
      capability: (props as { capability?: Capability }).capability,
      namespace: opts.namespace,
    })
  }
}
