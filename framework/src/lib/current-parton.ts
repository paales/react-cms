/**
 * Current-parton self context — the rendering parton's OWN identity,
 * readable by any free function called within its render (a "server
 * hook"). Where `ParentContext` ([[partial-context]]) gives a parton its
 * PARENT, this gives it ITSELF: the wrapper stamps its effective id onto
 * the rendering task before invoking the body, and `getCurrentParton`
 * reads it back.
 *
 * It rides the same per-render FRAME in the `partonStorage` ALS the
 * server-context reader uses (`__partonStorage`; see [[server-context]]),
 * so a read is valid anywhere in the body — before or after awaits — and
 * sibling renders stay isolated. That isolation is the property the old
 * tracked-accessor manifest lacked: it pointed at "the current partial"
 * through a request-level cell that drifted across awaits and siblings,
 * which is why dependency reads had to move into an explicit `vary`
 * (commit 2d607fc). Riding the per-component frame makes the attribution
 * reliable, so reads can be tracked back to the parton that did them
 * again.
 *
 * Unlike `createServerContext`, this is read-your-OWN-value: a context
 * provider scopes DESCENDANTS via the frame's `childCtx` and deliberately
 * never sees its own overlay, so self-identity is a direct `parton` slot on
 * the rendering frame rather than a context entry. It is NOT inherited by
 * descendant frames — each parton stamps its own before its body runs, and a
 * non-parton server component nested in the body reads `undefined`.
 */

import React from "react"

/** The per-render frame, as far as this module cares: just the slot for the
 *  current parton. Mirrors the `__partonStorage` access in server-context.ts
 *  (the same frame object, a different field). */
interface PartonFrame {
  parton?: CurrentParton
}

const sharedInternals = (
  React as unknown as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
      __partonStorage?: { getStore(): PartonFrame | undefined }
    }
  }
).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

/** Observation options a cullable parton declares at its `visible()` read.
 *  Server-side state, threaded to the client boundary's IntersectionObserver
 *  (via the `cullable` prop). */
export interface VisibleOptions {
  /** Runway — how far beyond the viewport still counts as "in view", as an
   *  IntersectionObserver `rootMargin`. Bigger = fetch further ahead.
   *  Default `"600px 0px"`. */
  readonly rootMargin?: string
}

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
  /** Request-dimension dependency keys read via tracked hooks
   *  (`cookie()`, `searchParam()`, …) during this render — e.g.
   *  `"cookie:cart_id"`. The wrapper stores the (live) Set on the
   *  snapshot; the NEXT render re-reads each key's current value and
   *  folds it into the fingerprint (store-and-reread), so a tracked read
   *  moves the fp like a `vary` axis without an explicit `vary`. The
   *  descendant fold re-reads them too. Mutable; the wrapper owns it. */
  readonly deps: Set<string>
  /** The parton's frame-resolved request — what tracked hooks read
   *  from, so a framed spec tracks its frame's URL/cookies (consistent
   *  with how `vary` already saw the frame-resolved request). */
  readonly request: Request
  /** Resolved match params (`/pokemon/:id` → `{id}`), read by `param()`.
   *  NOT dep-recorded — match params already fold into the fp via
   *  `matchKey`, so `param()` is a pure read. */
  readonly params: Record<string, string>
  /** Observation options set by a `visible(opts)` read this render. Mutable
   *  — the hook writes it; the wrapper reads it back to build the cullable
   *  boundary's observer config. */
  visibleOptions?: VisibleOptions
}

/**
 * Stamp the rendering parton onto the current frame. Called by the parton
 * wrapper once its effective id is known, before it invokes schema /
 * Render, so server-hooks within the body read it. No-op outside a render
 * (no frame).
 */
export function _setCurrentParton(parton: CurrentParton): void {
  const frame = sharedInternals?.__partonStorage?.getStore()
  if (frame) frame.parton = parton
}

/**
 * Read the rendering parton's own identity, or `undefined` when there is
 * no enclosing parton body (outside a render, or inside a non-parton
 * server component nested in the body). Valid anywhere in the body —
 * before or after awaits.
 */
export function getCurrentParton(): CurrentParton | undefined {
  return sharedInternals?.__partonStorage?.getStore()?.parton
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
  sharedInternals?.__partonStorage?.getStore()?.parton?.tags.add(name)
}
