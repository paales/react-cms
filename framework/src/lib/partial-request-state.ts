/**
 * Per-request state for the Partial render pipeline.
 *
 * `<Partial>` runs its own body on every render and makes all the
 * decisions itself: fingerprint compute, fingerprint-match skip,
 * cache-mode filter, duplicate-id detection. It needs per-request
 * state to do that — the parsed request params, plus an accumulator
 * for "what has this request produced so far" (for duplicate-id
 * detection and visibility into what was rendered).
 *
 * This module provides an `AsyncLocalStorage`-backed store. The outer
 * `<PartialRoot>` parses the request, seeds the store, and runs its
 * children inside it; each `<Partial>` reads from it during render.
 */
import { AsyncLocalStorage } from "node:async_hooks"

export interface PartialRequestState {
  /** Effective ids explicitly requested via `?partials=` (resolved
   *  from selector labels). Null = no filter, render everything. */
  requestedIds: Set<string> | null
  /** Whether the request is a partial-refetch (cache mode) vs a full render (streaming mode). */
  isPartialRefetch: boolean
  /** `?__populateCache=1` — server-action flow that repopulates the client cache on first post-action render. */
  populateCache: boolean
  /** `?cached=id:matchKey:fp,…` — fingerprints the client already has
   *  in `_currentPageFingerprints`. Multi-fp per id supported (cold/warm
   *  fp drift); fingerprint-skip decisions consult this map. */
  cachedFingerprints: Map<string, Set<string>>
  /** `?cached=id:matchKey:fp,…` — matchKeys the client already has cached
   *  per id, derived from the same wire tokens. Drives hidden Activity
   *  sibling emission so navigating across variants of the same spec
   *  (`/pokemon/1` ↔ `/pokemon/2`) parks the prior variant rather than
   *  unmounting it. matchKey is `stableStringify(matchParams)`, stable
   *  across vary refreshes of the same route. */
  cachedMatchKeys: Map<string, Set<string>>
  /** The live connection's ACKED mirror layer — fps whose delivering
   *  emission the client COMMITTED (cumulative delivery acks; see
   *  `ConnectionSession.ackedFps`). The fp-skip verdict consults the
   *  OPTIMISTIC layer (`cachedFingerprints`) first — a same-parton
   *  re-lane within one RTT must still skip off the emit-time
   *  promotion — and falls back here on a miss: a client-proven fp the
   *  optimistic per-id cap evicted still skips. Absent on requests
   *  without a connection session. */
  ackedFingerprints?: ReadonlyMap<string, ReadonlySet<string>> | null
  /** Effective ids explicitly targeted this request (resolved from `?partials=`). Never skipped —
   *  except on a culling flip (see `cullFlip`). */
  explicitIds: Set<string>
  /** `?__cullFlip=1` — this refetch is a culling flip fired by the
   *  client's visibility controller. Its explicit targets are
   *  REVALIDATIONS, not forces: an fp match may skip them, emitting the
   *  placeholder that confirms the client's parked copy (restore with
   *  zero bytes). Only the visibility controller mints the param. */
  cullFlip: boolean
  /** Effective ids seen this request — debug-only record of what
   *  rendered. Multiple placements of the same keyless spec are
   *  allowed; this set is a `Set` but the values aren't unique. */
  seenIds: Set<string>
}

const als = new AsyncLocalStorage<PartialRequestState>()

/**
 * Enter the partial-state context for the remainder of the current
 * async execution. Used by `<PartialRoot>`: sets the state before
 * returning its JSX so that when React later renders the tree (via
 * async continuations in the same context), every `<Partial>` body
 * sees the store.
 *
 * `als.run(state, fn)` won't do here — it only scopes ALS for
 * synchronous code inside `fn` plus awaits chained off it. React's
 * rendering of the returned tree happens in the caller's continuation,
 * which is outside `fn`'s scope. `enterWith` sets the store on the
 * current async context itself, which React's render inherits.
 */
export function enterPartialState(state: PartialRequestState): void {
  als.enterWith(state)
}

export function runWithPartialState<T>(state: PartialRequestState, fn: () => T): T {
  return als.run(state, fn)
}

export function getPartialState(): PartialRequestState | undefined {
  return als.getStore()
}

export function requirePartialState(): PartialRequestState {
  const state = als.getStore()
  if (!state) {
    throw new Error(
      "<Partial> must be rendered inside <PartialRoot>. " +
        "The enclosing PartialRoot sets up the request-scoped state the Partial needs.",
    )
  }
  return state
}
