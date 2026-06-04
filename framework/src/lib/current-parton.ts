/**
 * Current-parton self context — the rendering parton's OWN identity,
 * readable by any free function called within its render (a "server
 * hook"). Where `ParentContext` ([[partial-context]]) gives a parton its
 * PARENT, this gives it ITSELF: the wrapper stamps its effective id onto
 * the rendering task before invoking the body, and `getCurrentParton`
 * reads it back.
 *
 * It rides the same patched per-component `AsyncLocalStorage` the
 * server-context reader uses (`__partonStorage`; see [[server-context]]),
 * so a read is valid anywhere in the body — before or after awaits — and
 * sibling renders stay isolated. That isolation is the property the old
 * tracked-accessor manifest lacked: it pointed at "the current partial"
 * through a request-level cell that drifted across awaits and siblings,
 * which is why dependency reads had to move into an explicit `vary`
 * (commit 2d607fc). Riding the per-component ALS makes the attribution
 * reliable, so reads can be tracked back to the parton that did them
 * again.
 *
 * Unlike `createServerContext`, this is read-your-OWN-value: a context
 * provider scopes DESCENDANTS and deliberately never sees its own
 * overlay, so self-identity is a direct field on the rendering task
 * rather than a context entry. It is NOT inherited by descendant tasks —
 * each parton stamps its own before its body runs, and a non-parton
 * server component nested in the body reads `undefined`.
 */

import React from "react"

/** The rendering task, as far as this module cares: just the slot for
 *  the current parton. Mirrors the `__partonStorage` access in
 *  server-context.ts (the same task object, a different field). */
interface PartonTask {
  currentParton?: CurrentParton
}

const sharedInternals = (
  React as unknown as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
      __partonStorage?: { getStore(): PartonTask | undefined }
    }
  }
).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

/** The rendering parton's own identity. */
export interface CurrentParton {
  /** The parton's effective render id — the one keying snapshots, the
   *  wire token, and cache lookups. */
  readonly id: string
  /** Invalidation tags registered by `tag(name)` during this render.
   *  The wrapper folds them into the parton's label set (alongside cell
   *  labels) before the fingerprint, so a later `refreshSelector(name)`
   *  shifts the fp. The Set is mutable; the wrapper owns the instance. */
  readonly tags: Set<string>
}

/**
 * Stamp the rendering parton onto the current task. Called by the parton
 * wrapper once its effective id is known, before it invokes schema /
 * Render, so server-hooks within the body read it. No-op outside a render
 * (no task).
 */
export function _setCurrentParton(parton: CurrentParton): void {
  const task = sharedInternals?.__partonStorage?.getStore()
  if (task) task.currentParton = parton
}

/**
 * Read the rendering parton's own identity, or `undefined` when there is
 * no enclosing parton body (outside a render, or inside a non-parton
 * server component nested in the body). Valid anywhere in the body —
 * before or after awaits.
 */
export function getCurrentParton(): CurrentParton | undefined {
  return sharedInternals?.__partonStorage?.getStore()?.currentParton
}

/**
 * Register an invalidation tag on the rendering parton — the server-hook
 * form of a `selector` label, but computed per render (e.g. an entity
 * key, `tag(`product:${id}`)`). Folded into the parton's fingerprint via
 * the same `queryMatchingTs` path declared selectors use, so a matching
 * `refreshSelector(name)` (a server action's revalidation) shifts the fp
 * and the parton re-renders on the next navigation; it also becomes a
 * selector-refetch target.
 *
 * Effective when called in the schema phase — which runs BEFORE the
 * fingerprint is computed. (A render-body `tag()` lands after the fp;
 * folding those needs a store-and-reread step that is not built yet.)
 * No-op outside a parton body.
 */
export function tag(name: string): void {
  sharedInternals?.__partonStorage?.getStore()?.currentParton?.tags.add(name)
}
