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
  /** Effective ids explicitly requested via `?partials=` + `?tags=` (union, resolved from selector tokens). Null = no filter. */
  requestedIds: Set<string> | null
  /** Whether the request is a partial-refetch (cache mode) vs a full render (streaming mode). */
  isPartialRefetch: boolean
  /** `?__populateCache=1` — server-action flow that repopulates the client cache on first post-action render. */
  populateCache: boolean
  /** `?cached=id:fp,…` — fingerprints the client already has in `_cache`. */
  cachedFingerprints: Map<string, string | null>
  /** Effective ids explicitly targeted this request (resolved from `?partials=`+`?tags=`). Never skipped. */
  explicitIds: Set<string>
  /** Effective ids seen this request (catches duplicate anonymous Partials via `__anon:` collision and debug). */
  seenIds: Set<string>
  /** `#`-token names seen this request (for cross-Partial uniqueness enforcement). */
  seenUniqueTokens: Set<string>
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
