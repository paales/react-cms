/**
 * Fingerprint trailer — emits warm-fp updates for partials whose
 * registered fp shifted across cold→warm during this render.
 *
 * Why this exists: a spec's fp folds in `descendantFold`, which reads
 * from `getRouteSnapshots()`. On the very first render of a route in
 * a scope, no descendants are registered yet, so the fold is empty.
 * The spec emits fp_cold. After the render commits, descendants ARE
 * registered, so the SAME spec on the next request would compute a
 * non-empty fold and a different fp_warm. With a single-fp client
 * pool the client would send fp_cold on the next visit, the server
 * would compute fp_warm, mismatch → fresh render. Keepalive then
 * costs a wasted body re-run.
 *
 * The trailer ships fp_warm down to the client in the SAME response,
 * piggy-backed onto the Flight stream as a length-prefixed segment
 * after a 12-byte sentinel. The client stores both fp_cold and
 * fp_warm in its fingerprint set for the id; on the next visit it
 * sends both, the server matches whichever applies, fp-skip works
 * on the very next nav.
 *
 * The same framing generalises to other trailer payloads — see the
 * "Restart-streaming via segmented Flight" item in `docs/notes/IDEAS.md`.
 */

import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { _readSnapshotsForRoute, type PartialSnapshot } from "./partial-registry.ts"
import { computeRouteKey } from "./partial.tsx"
import { getRequest, getScope } from "../runtime/context.ts"
import { cmsFingerprintContribution } from "../runtime/cms-runtime.ts"
import { getSessionFrameUrl } from "../runtime/session.ts"
import { FP_TRAILER_MARKER } from "./fp-trailer-marker.ts"

export { FP_TRAILER_MARKER } from "./fp-trailer-marker.ts"

/**
 * Walk a captured snapshot map and return a `{ id: warm_fp }` map for
 * every entry whose recomputed fp differs from the fp the spec
 * actually emitted in this render. Returns `null` when no drift was
 * detected — the trailer is then omitted entirely.
 *
 * Pure function of (snapshots, request): no ALS reads, no module-level
 * mutation. The caller provides everything via the captured handle so
 * this stays safe to invoke from a TransformStream flush callback.
 */
function computeFpUpdates(
  snapshots: Map<string, PartialSnapshot>,
  request: Request,
): Record<string, string> | null {
  const updates: Record<string, string> = {}
  for (const [id, snap] of snapshots) {
    if (!snap.emittedFp) continue
    const recomputed = recomputeFp(id, snap, snapshots, request)
    if (recomputed !== snap.emittedFp) {
      updates[id] = recomputed
    }
  }
  if (Object.keys(updates).length === 0) return null
  return updates
}

/**
 * Recompute a spec's fp from its committed snapshot + the captured
 * request. Mirrors the formula in `createSpecComponent` (partial.tsx)
 * but operates against an explicit snapshot map so it can run after
 * the ALS context has unwound.
 *
 * Stays in sync with `partial.tsx`'s fp formula by construction —
 * any divergence here would mean the trailer ships fp values the
 * server's own fp-check wouldn't accept on the next visit, breaking
 * the round-trip. If the formula in `partial.tsx` changes, mirror
 * the change here.
 */
function recomputeFp(
  id: string,
  snap: PartialSnapshot,
  snapshots: Map<string, PartialSnapshot>,
  request: Request,
): string {
  const frameRequest = snap.framePath.length > 0 ? resolveFrameRequest(snap.framePath, request) : request
  const cmsKey = snap.cmsId ? cmsFingerprintContribution(snap.cmsId, frameRequest) : ""
  const ambientFrameKey =
    snap.framePath.length > 0 ? `|inFrame=${snap.framePath.join(".")}:${frameRequest.url}` : ""
  const propsKey =
    snap.props && Object.keys(snap.props).length > 0
      ? `|props=${stableStringify(snap.props)}`
      : ""
  const varyKey = snap.varyKey ?? ""
  const ownStructuralFp = hash(`${id}|vary=${varyKey}${propsKey}${cmsKey}`)
  const fold = computeFoldFromSnapshots(id, snapshots, frameRequest)
  return hash(`${ownStructuralFp}${ambientFrameKey}${fold}`)
}

/**
 * Descendant-fold computation that operates on an explicit snapshot
 * map. Mirrors `computeDescendantFold` in partial.tsx — same logic,
 * different source of snapshots (parameter vs. ALS).
 */
function computeFoldFromSnapshots(
  ancestorId: string,
  snapshots: Map<string, PartialSnapshot>,
  request: Request,
): string {
  const parts: string[] = []
  for (const [descId, snap] of snapshots) {
    if (descId === ancestorId) continue
    if (!snap.parentPath.includes(ancestorId)) continue
    parts.push(descendantContributionFromSnapshot(descId, snap, request))
  }
  if (parts.length === 0) return ""
  parts.sort()
  return `|desc=${hash(parts.join(","))}`
}

/**
 * Single descendant's contribution to its ancestor's fold. Falls back
 * to the stored `varyKey` when the live vary call would require state
 * we don't have at flush time (e.g. the descendant's spec catalog is
 * not loaded). The snapshot-stored varyKey is what the descendant
 * itself just emitted, so it's already accurate for this request.
 */
function descendantContributionFromSnapshot(
  descId: string,
  snap: PartialSnapshot,
  request: Request,
): string {
  // Same shape as the no-vary branch in `descendantContribution`
  // (partial.tsx). For specs WITH vary, the snapshot's `varyKey`
  // already captures the same value the descendant emitted on this
  // request — re-running vary here would produce the identical string,
  // so we skip the extra work.
  const cmsKey = snap.cmsId ? cmsFingerprintContribution(snap.cmsId, request) : ""
  return `${descId}:${snap.varyKey ?? ""}|${stableStringify(snap.props ?? null)}|${cmsKey}`
}

/**
 * Frame resolution mirror — same logic as the private
 * `resolveFrameRequest` in `partial.tsx`, but takes an explicit base
 * request rather than calling `getRequest()` (so the flush hook can
 * use the captured request consistently).
 */
function resolveFrameRequest(framePath: readonly string[], baseRequest: Request): Request {
  const sessionUrl = getSessionFrameUrl(framePath)
  if (sessionUrl == null) return baseRequest
  const resolved = new URL(sessionUrl, baseRequest.url).toString()
  return new Request(resolved, { headers: baseRequest.headers, method: "GET" })
}

/**
 * Wrap a Flight `ReadableStream` so that, after the upstream render
 * finishes, the wrapped stream emits a length-prefixed trailer
 * containing any cold→warm fp drift detected by recomputing each
 * spec's fp against the now-populated snapshot registry. The trailer
 * is omitted entirely when no drift exists, so warm-path requests
 * pay nothing.
 *
 * Composes with `wrapStreamWithRegistryCommit`: the registry commit
 * must run BEFORE the trailer computation (the recompute reads the
 * committed canonical store), so callers should compose by inlining
 * the commit step into the same flush callback. See
 * `e2e-testing/src/entry.rsc.tsx`.
 *
 * @param stream  The Flight stream from `renderToReadableStream`.
 * @param commit  The registry-commit handle (called inside flush before
 *                the trailer is computed). Optional — pass when caller
 *                wants to bundle commit + trailer into one wrap.
 */
/**
 * Wrap a stream so the registry commit fires at flush, without
 * emitting any trailer bytes. Used for SSR responses where the
 * rscStream is consumed by `rsc-html-stream`'s `injectRSCPayload`
 * (which inlines its chunks into `<script>(self.__FLIGHT_DATA||=[])
 * .push(...)</script>` tags) — emitting binary trailer bytes here
 * would make their JSON-stringified text content visible in the
 * rendered HTML source.
 */
export function wrapStreamWithCommitOnly(
  stream: ReadableStream<Uint8Array>,
  commit?: () => void,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush() {
        if (commit) commit()
      },
    }),
  )
}

/**
 * Wrap an SSR HTML stream so an HTML comment with the fp-trailer is
 * appended after the final byte. Pair with `wrapStreamWithCommitOnly`
 * on the underlying rscStream so the trailer doesn't leak into
 * `FLIGHT_DATA` script tags.
 *
 * The comment lives AFTER `</html>` (browsers parse it as a Comment
 * node at the document root). Client-side, `_applyFpTrailerFromDocument`
 * scans for it on hydration and applies the warm fps to
 * `_currentPageFingerprints`. Reverse-tag protocol: the comment
 * starts with `<!--fp-trailer:` so the client can locate it without
 * a stable id attribute (an attribute would only work on element
 * nodes, not comment nodes).
 */
export function wrapSsrStreamWithFpTrailer(
  stream: ReadableStream<Uint8Array>,
  commit?: () => void,
): ReadableStream<Uint8Array> {
  let request: Request | null = null
  let scope = "default"
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    // Outside a request context — trailer just won't fire.
  }

  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush(controller) {
        if (commit) commit()
        if (!request) return
        const routeKey = computeRouteKey(request.url)
        const snapshots = _readSnapshotsForRoute(scope, routeKey)
        if (snapshots.size === 0) return
        const updates = computeFpUpdates(snapshots, request)
        if (!updates) return
        // Escape `-->` (the only sequence that would prematurely end
        // an HTML comment) by inserting a backslash inside the dashes.
        // The client reverses this on parse.
        const json = JSON.stringify(updates).replace(/--/g, "-\\-")
        const comment = `<!--fp-trailer:${json}-->`
        controller.enqueue(new TextEncoder().encode(comment))
      },
    }),
  )
}

export function wrapStreamWithFpTrailer(
  stream: ReadableStream<Uint8Array>,
  commit?: () => void,
): ReadableStream<Uint8Array> {
  // Capture per-request state at wrap time. The registry ALS is NOT
  // entered yet at this point (`<PartialRoot>` enters it during
  // render), so we can't read the routeKey from there. Instead, we
  // capture the request URL + scope, which are stable for the
  // lifetime of the request, and recompute routeKey at flush time
  // (after `<PartialRoot>`'s registry context has unwound but the
  // canonical store has been committed).
  let request: Request | null = null
  let scope = "default"
  try {
    request = getRequest()
    scope = getScope()
  } catch {
    // Outside a request context — trailer just won't fire.
  }

  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush(controller) {
        if (commit) commit()
        if (!request) return
        const routeKey = computeRouteKey(request.url)
        const snapshots = _readSnapshotsForRoute(scope, routeKey)
        if (snapshots.size === 0) return
        const updates = computeFpUpdates(snapshots, request)
        if (!updates) return
        emitTrailer(controller, updates)
      },
    }),
  )
}

function emitTrailer(
  controller: TransformStreamDefaultController<Uint8Array>,
  updates: Record<string, string>,
): void {
  controller.enqueue(FP_TRAILER_MARKER)
  const json = new TextEncoder().encode(JSON.stringify(updates))
  const lenBuf = new Uint8Array(4)
  new DataView(lenBuf.buffer).setUint32(0, json.byteLength, false)
  controller.enqueue(lenBuf)
  controller.enqueue(json)
}

// Re-export the scope getter so callers (e.g. tests) don't need to
// reach into runtime/context just to introspect which scope was used.
export { getScope as _getScope }
