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
import {
  _drainPendingDefers,
  _readSnapshotsForRoute,
  deferRequestRegistryCommit,
  type PartialSnapshot,
} from "./partial-registry.ts"
import { computeRouteKey } from "./partial.tsx"
import { evalDepKeys } from "./server-hooks.ts"
import {
  _consumePendingUrlUpdate,
  _setSettleTrailerSink,
  getRequest,
  getScope,
} from "../runtime/context.ts"
import {
  _currentTs,
  _registryEpoch,
  queryMatchingTs,
} from "../runtime/invalidation-registry.ts"
import { getSessionFrameUrl } from "../runtime/session.ts"
import {
  buildMarker,
  TAG_FP_UPDATES,
  TAG_NEXT_SEGMENT,
  TAG_URL_UPDATE,
  type FpUpdatesPayload,
} from "./fp-trailer-marker.ts"

/**
 * Walk a captured snapshot map and return a `{ id: warm_fp }` map for
 * every entry whose recomputed fp differs from the fp the spec
 * actually emitted in this render. Returns `null` when no drift was
 * detected — the trailer is then omitted entirely.
 *
 * Pure function of (snapshots, request): no ALS reads, no module-level
 * mutation. The caller provides everything via the captured handle so
 * this stays safe to invoke from a TransformStream flush callback.
 *
 * Precomputes both the descendant folds (one pass over snapshots,
 * O(N) instead of the naïve O(N²) where every recomputeFp walked the
 * full map) and each snapshot's descendant contribution + parsed
 * varyKey (each used by both the contribution and by recomputeFp
 * itself). Without these the trailer dominated CPU under load: 25
 * snapshots × 625 ancestor-walks × per-walk JSON.parse + stableStringify.
 */
function computeFpUpdates(
  snapshots: Map<string, PartialSnapshot>,
  request: Request,
): FpUpdatesPayload | null {
  // Per-snapshot side-data we compute once and reuse across folds +
  // own-fp recompute. constraintSurface goes into queryMatchingTs;
  // contribution is the descendant's contribution string the fold
  // hashes; selfRequest resolves frame redirection once for both the
  // contribution and the recompute.
  interface SideData {
    constraintSurface: Record<string, unknown> | null
    contribution: string
    selfRequest: Request
    depsKey: string
  }
  const sideById = new Map<string, SideData>()
  for (const [id, snap] of snapshots) {
    const parsedVaryInputs = parseVaryKey(snap.varyKey)
    // The invalidation constraint surface mirrors the live fold exactly:
    // match params PLUS the snapshot's bound-cell args. Without the
    // constraintArgs half, a partition-scoped bump
    // (`cell:<id>?cx=1&cy=0`) never matches here — the recomputed fp
    // omits the ts the render-time fold folds, so the "warm" fp this
    // trailer ships can never equal a future render's candidate for any
    // spec over partitioned live data.
    const constraintSurface = snap.constraintArgs
      ? { ...(parsedVaryInputs ?? {}), ...snap.constraintArgs }
      : parsedVaryInputs
    const selfRequest =
      snap.framePath.length > 0 ? resolveFrameRequest(snap.framePath, request) : request
    const ts = queryMatchingTs(snap.labels ?? [], constraintSurface)
    const invKey = ts > 0 ? `|inv=${ts}` : ""
    // Tracked-read deps re-read at this request — mirrors the live
    // descendantContribution / own-fp fold in partial.tsx so the warm fp
    // the trailer ships matches what the next visit computes. The cold fp
    // omits deps (first render has no prior set); the warm one folds them,
    // which is exactly the drift this trailer ships. Empty (additive) for
    // any spec that records no tracked reads.
    const depsKey = evalDepKeys(snap.deps, selfRequest)
    const contribution = `${id}:${snap.varyKey ?? ""}|${stableStringify(snap.props ?? null)}${invKey}${depsKey}`
    sideById.set(id, { constraintSurface, contribution, selfRequest, depsKey })
  }

  // Build the fold map in one pass. Each descendant contributes its
  // string to every ancestor on its parentPath. O(N × D) where D is
  // average parent-path depth; previously O(N²) because each ancestor
  // re-walked the whole snapshot map.
  const foldParts = new Map<string, string[]>()
  for (const [descId, snap] of snapshots) {
    const side = sideById.get(descId)!
    for (const ancestorId of snap.parentPath) {
      if (ancestorId === descId) continue
      let arr = foldParts.get(ancestorId)
      if (!arr) {
        arr = []
        foldParts.set(ancestorId, arr)
      }
      arr.push(side.contribution)
    }
  }
  const folds = new Map<string, string>()
  for (const [ancestorId, parts] of foldParts) {
    parts.sort()
    folds.set(ancestorId, `|desc=${hash(parts.join(","))}`)
  }

  const updates: FpUpdatesPayload = {}
  for (const [id, snap] of snapshots) {
    if (!snap.emittedFp) continue
    const side = sideById.get(id)!
    const recomputed = recomputeFpWithFold(
      id,
      snap,
      side.constraintSurface,
      folds.get(id) ?? "",
      side.selfRequest.url,
      side.depsKey,
    )
    if (recomputed !== snap.emittedFp) {
      // `from` is the cold fp the body emitted; `to` the recomputed warm
      // fp. The client aliases `to` onto the slot still holding `from`,
      // matched by content — see `FpUpdate` in fp-trailer-marker.ts.
      updates[id] = { from: snap.emittedFp, to: recomputed }
    }
  }
  if (Object.keys(updates).length === 0) return null
  return updates
}

/** Cache for `JSON.parse(varyKey)` — varyKey strings are stable across
 *  segments of the same request (the snapshot's vary inputs don't move
 *  between segments for fp-skipped partials), so the same JSON.parse
 *  is called repeatedly. Keyed by the raw varyKey string.
 *
 *  Bound the cache so a long-running process with high varyKey churn
 *  doesn't grow unbounded. 4096 entries × ~200 bytes ≈ 1 MB worst case. */
const varyKeyParseCache = new Map<string, Record<string, unknown> | null>()
const VARY_KEY_CACHE_MAX = 4096

function parseVaryKey(varyKey: string | undefined): Record<string, unknown> | null {
  if (!varyKey) return null
  const cached = varyKeyParseCache.get(varyKey)
  if (cached !== undefined) return cached
  let parsed: Record<string, unknown> | null
  try {
    parsed = JSON.parse(varyKey) as Record<string, unknown>
  } catch {
    parsed = null
  }
  if (varyKeyParseCache.size >= VARY_KEY_CACHE_MAX) {
    const oldest = varyKeyParseCache.keys().next().value
    if (oldest !== undefined) varyKeyParseCache.delete(oldest)
  }
  varyKeyParseCache.set(varyKey, parsed)
  return parsed
}

/**
 * Recompute a spec's fp from its committed snapshot + a precomputed
 * fold for that ancestor + the snapshot's already-parsed vary inputs.
 * Mirrors the formula in `createSpecComponent` (partial.tsx) but
 * operates against an explicit snapshot map so it can run after the
 * ALS context has unwound.
 *
 * Stays in sync with `partial.tsx`'s fp formula by construction —
 * any divergence here would mean the trailer ships fp values the
 * server's own fp-check wouldn't accept on the next visit, breaking
 * the round-trip. If the formula in `partial.tsx` changes, mirror
 * the change here.
 *
 * `constraintSurface` and `fold` come from the precompute pass in
 * `computeFpUpdates`; the helper itself does no JSON parsing or
 * snapshot-map walks.
 */
function recomputeFpWithFold(
  id: string,
  snap: PartialSnapshot,
  constraintSurface: Record<string, unknown> | null,
  fold: string,
  frameRequestUrl: string,
  depsKey: string,
): string {
  const ambientFrameKey =
    snap.framePath.length > 0
      ? `|inFrame=${snap.framePath.join(".")}:${frameRequestUrl}`
      : ""
  const propsKey =
    snap.props && Object.keys(snap.props).length > 0
      ? `|props=${stableStringify(snap.props)}`
      : ""
  const varyKey = snap.varyKey ?? ""
  // Mirror `partial.tsx`'s formula — fold matchKey in so content-
  // independent specs still produce distinct fps across variants of
  // their match-bearing ancestor.
  const matchKey = snap.matchKey ?? ""
  // Resolved-cell surface the live render folded in (`|schema=<hash>`).
  // Re-resolving cells at flush is impossible, so the snapshot carries
  // the term verbatim; its position (between vary and props) must match
  // the live formula exactly.
  const schemaKey = snap.schemaKey ?? ""
  const invalidationTs = queryMatchingTs(snap.labels ?? [], constraintSurface)
  const invalidationKey = invalidationTs > 0 ? `|inv=${invalidationTs}` : ""
  const ownStructuralFp = hash(
    `${id}|matchKey=${matchKey}|vary=${varyKey}${schemaKey}${propsKey}${invalidationKey}${depsKey}`,
  )
  return hash(`${ownStructuralFp}${ambientFrameKey}${fold}`)
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
 * `../entry/rsc.tsx`.
 *
 * @param stream  The Flight stream from `renderToReadableStream`.
 * @param commit  The registry-commit handle (called inside flush before
 *                the trailer is computed). Optional — pass when caller
 *                wants to bundle commit + trailer into one wrap.
 */
/**
 * Wrap a stream so the registry commit fires at flush, without
 * emitting any trailer bytes. Used for RSC and SSR responses where
 * the rscStream is consumed downstream (the SSR path's `rsc-html-stream`
 * inlines its chunks into `<script>(self.__FLIGHT_DATA||=[]).push(...)
 * </script>` tags, so binary trailer bytes can't go here — the
 * JSON-stringified payload would leak into the rendered HTML source).
 *
 * Also defers the request-context auto-commit so the commit fires at
 * stream flush (post-render) instead of immediately after the request
 * handler returns. Flight's `renderToReadableStream` returns the
 * stream eagerly while the actual render runs lazily as the stream
 * is consumed; an auto-fire commit at return time would commit empty
 * `pendingHints`, wiping the canonical hint table from the prior
 * render (the streaming-mode commit replaces the routeKey hint
 * wholesale). With deferral, commit fires AFTER specs have registered,
 * preserving the snapshot set for subsequent requests.
 */
export function wrapStreamWithCommitOnly(
  stream: ReadableStream<Uint8Array>,
  commit?: () => void,
): ReadableStream<Uint8Array> {
  deferRequestRegistryCommit()
  // Capture the queued URL push at wrap time. By the time the
  // TransformStream's flush fires, the request ALS may have
  // unwound (the response stream is consumed by the HTTP server
  // outside our scope). For action POSTs the action body has
  // already finished and queued any `navigate()` updates by now;
  // capturing here gets them safely before ALS exits.
  let capturedUrlUpdate: ReturnType<typeof _consumePendingUrlUpdate> = null
  try {
    capturedUrlUpdate = _consumePendingUrlUpdate()
  } catch {}
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      async flush(controller) {
        await Promise.allSettled(_drainPendingDefers())
        if (commit) commit()
        if (capturedUrlUpdate) {
          emitUrlUpdate(controller, capturedUrlUpdate)
        }
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
  deferRequestRegistryCommit()

  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      async flush(controller) {
        await Promise.allSettled(_drainPendingDefers())
        if (commit) commit()
        if (!request) return
        const routeKey = computeRouteKey(request.url)
        const snapshots = _readSnapshotsForRoute(scope, routeKey)
        if (snapshots.size === 0) return
        // The live catch-up anchor: this document IS the page state as
        // of the registry timeline point below, so the heartbeat's
        // first attach presents it (the statement's `since`) and
        // the connection opens straight into lanes — only what bumped
        // after this document renders, never a whole-route replay of
        // bytes the document just delivered. Emitted before (and
        // independently of) the fp updates: a document with zero
        // cold→warm drift still anchors.
        const anchor = JSON.stringify({ epoch: _registryEpoch(), ts: _currentTs() })
        controller.enqueue(new TextEncoder().encode(`<!--live-anchor:${anchor}-->`))
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
  opts?: {
    /** Emit each parton's warm-fp entry the moment ITS subtree settles
     *  (default), instead of only at whole-stream flush. Lane renders
     *  pass `false`: a lane is a single parton, so its flush already
     *  fires at that parton's completion — and lanes run concurrently,
     *  which the one-sink-per-request slot doesn't model. */
    incremental?: boolean
    /** Observer for every update entry this response ships. The live
     *  connection passes one that folds each warm fp into its cached
     *  override, so the SERVER-side skip check tracks the same
     *  cold→warm drift the client's `?cached=` heals track — without
     *  it, a drifted parton (any ancestor of live descendants) can
     *  never fp-skip on the connection: its promoted emitted fp is
     *  permanently one drift behind the next render's candidate. */
    onUpdates?: (updates: FpUpdatesPayload) => void
    /** Scope the flush fold to this parton's subtree — the id plus
     *  every snapshot whose parentPath contains it. Lane renders pass
     *  their parton id: a lane is one parton's render, so its flush
     *  heals only what that render could have moved. Unscoped, every
     *  lane frame on a many-parton route recomputes — and re-ships —
     *  the standing drift of EVERY route snapshot (a snapshot's
     *  emittedFp only advances when IT re-renders, so cold→warm drift
     *  stands forever): O(route) hashing per frame and the same
     *  multi-KB payload repeating on every frame. Ancestors are
     *  deliberately outside the scope — an ancestor's fold needs
     *  contributions from ALL its descendants, which only a route-wide
     *  pass computes honestly; their heals ride whole-tree segments.
     *  Whole-tree renders leave this unset: their flush is the
     *  route-wide cold→warm heal. */
    flushScopeId?: string
  },
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
  deferRequestRegistryCommit()

  // Cumulative fp-update map for this response. Every emission — the
  // settle-time entries and the flush safety net — sends the WHOLE map,
  // so the last entry on the wire is always complete and consumers keep
  // last-wins semantics (the splitter's trailer map, `?cached=`
  // registration) without merge logic.
  const cumulative: FpUpdatesPayload = {}
  /** Entries already shipped. Each marker carries only the DELTA since
   *  the previous one — the client folds markers per-id (last-wins),
   *  so re-shipping the accumulated map would only repeat what it
   *  already applied: on a many-parton page (hundreds of chunks) the
   *  cumulative form made the trailer bytes quadratic in settles. */
  const emitted: FpUpdatesPayload = {}
  const incremental = opts?.incremental !== false && request !== null

  const emitDelta = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const delta: FpUpdatesPayload = {}
    for (const [id, entry] of Object.entries(cumulative)) {
      const sent = emitted[id]
      if (sent && sent.to === entry.to && sent.from === entry.from) continue
      delta[id] = entry
    }
    if (Object.keys(delta).length === 0) return
    emitTrailer(controller, delta)
    opts?.onUpdates?.(delta)
    Object.assign(emitted, delta)
  }

  /** Fold the current route snapshots into `cumulative` — either the
   *  subtree under `withinId` (settle-time: that parton + everything
   *  whose parentPath includes it, all final because settlement is
   *  subtree-inclusive) or the whole map (flush). Returns true when
   *  any entry was added or changed. */
  const foldUpdates = (withinId?: string): boolean => {
    if (!request) return false
    const routeKey = computeRouteKey(request.url)
    const all = _readSnapshotsForRoute(scope, routeKey)
    if (all.size === 0) return false
    let snapshots = all
    if (withinId !== undefined) {
      snapshots = new Map()
      for (const [id, snap] of all) {
        if (id === withinId || snap.parentPath.includes(withinId)) snapshots.set(id, snap)
      }
      if (snapshots.size === 0) return false
    }
    const updates = computeFpUpdates(snapshots, request)
    if (!updates) return false
    let changed = false
    for (const [id, entry] of Object.entries(updates)) {
      const prior = cumulative[id]
      if (prior && prior.to === entry.to && prior.from === entry.from) continue
      cumulative[id] = entry
      changed = true
    }
    return changed
  }

  return stream.pipeThrough(
    new TransformStream({
      start(controller) {
        if (!incremental) return
        // Settle-time emission: the parton wrapper notifies this sink
        // when a parton's subtree settles (see partial.tsx); the sink
        // recomputes that subtree's warm fps against the eagerly-
        // published registry and, on drift, ships the cumulative map
        // immediately — a fast parton's fp entry doesn't wait for a
        // slow sibling's loader. Enqueueing can race the stream's
        // teardown (a settle microtask after close), so a failed
        // enqueue is dropped: the flush safety net owned those bytes.
        _setSettleTrailerSink((partonId) => {
          if (!foldUpdates(partonId)) return
          try {
            emitDelta(controller)
          } catch {}
        })
      },
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      async flush(controller) {
        if (incremental) _setSettleTrailerSink(null)
        await Promise.allSettled(_drainPendingDefers())
        if (commit) commit()
        // Consume any URL push queued by `getServerNavigation().navigate(...)`
        // from within the render. Flush runs in the same async
        // context as the consumer, which inherits the request ALS
        // through async_hooks; the consume call resolves the same
        // store the render's navigate writes to.
        const urlUpdate = (() => {
          try {
            return _consumePendingUrlUpdate()
          } catch {
            return null
          }
        })()
        if (urlUpdate) {
          emitUrlUpdate(controller, urlUpdate)
        }
        // Safety net: anything that never settled (aborted subtrees) or
        // drifted after its settle emission (an invalidation bump landing
        // between a parton's settle and stream end). No wire bytes when
        // the settle-time entries already covered everything.
        if (!foldUpdates(opts?.flushScopeId)) return
        emitDelta(controller)
      },
    }),
  )
}

function emitTrailer(
  controller: TransformStreamDefaultController<Uint8Array>,
  updates: FpUpdatesPayload,
): void {
  emitTrailerEntry(controller, TAG_FP_UPDATES, JSON.stringify(updates))
}

/** Emit one trailer entry (header + body) onto a controller. The
 *  header carries the body length so the splitter can read the exact
 *  byte count. JSON bodies use UTF-8 encoding. */
export function emitTrailerEntry(
  controller: TransformStreamDefaultController<Uint8Array> | ReadableStreamDefaultController<Uint8Array>,
  tag: string,
  body: string | Uint8Array,
): void {
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  controller.enqueue(buildMarker(tag, bodyBytes.byteLength))
  if (bodyBytes.byteLength > 0) controller.enqueue(bodyBytes)
}

/** Emit a `next`-segment delimiter (zero-length body). Server-side
 *  helper used by multi-segment response builders to separate one
 *  Flight document from the next on a single connection. */
export function emitNextSegmentDelimiter(
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  controller.enqueue(buildMarker(TAG_NEXT_SEGMENT, 0))
}

/** Emit a `url`-update trailer entry. Body is JSON describing the
 *  URL push (e.g. `{ window?: string, frames?: Record<name, url> }`).
 *  The client bootstrap (`../entry/browser.tsx`) applies the push
 *  before committing the segment's setPayload. */
export function emitUrlUpdate(
  controller: TransformStreamDefaultController<Uint8Array> | ReadableStreamDefaultController<Uint8Array>,
  update: { window?: string; frames?: Record<string, string>; history?: "push" | "replace" },
): void {
  emitTrailerEntry(controller, TAG_URL_UPDATE, JSON.stringify(update))
}

// Re-export the scope getter so callers (e.g. tests) don't need to
// reach into runtime/context just to introspect which scope was used.
export { getScope as _getScope }
