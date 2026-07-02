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
 * sibling renders stay isolated. That per-component isolation is what
 * makes read attribution reliable: a request-level slot would drift
 * across awaits and sibling renders, mis-attributing reads.
 *
 * Unlike `createServerContext`, this is read-your-OWN-value: a context
 * provider scopes DESCENDANTS via the frame's `childCtx` and deliberately
 * never sees its own overlay, so self-identity is a direct `parton` slot on
 * the rendering frame rather than a context entry. It is NOT inherited by
 * descendant frames — each parton stamps its own before its body runs, and a
 * non-parton server component nested in the body reads `undefined`.
 */

import { AsyncLocalStorage } from "node:async_hooks"
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

/** Wake/TTL hints written by the `expires()` / `staleUntil()` hooks. A
 *  live box: render-body writes land AFTER the boundary registered the
 *  snapshot, so wake consumers (the segment driver's expiry arm, the
 *  fp-skip TTL gate) read through the box at arm/decision time rather
 *  than at registration. Never part of the fingerprint — folding a
 *  wall-clock timestamp would shift the fp every millisecond. */
export interface WakeHints {
  expiresAt?: number
  staleUntil?: number
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
   *  folds it into the fingerprint (store-and-reread), so a tracked
   *  read moves the fp. The descendant fold re-reads them too.
   *  Mutable; the wrapper owns it. */
  readonly deps: Set<string>
  /** The parton's frame-resolved request — what tracked hooks read
   *  from, so a framed spec tracks its frame's URL/cookies. */
  readonly request: Request
  /** Resolved match params (`/pokemon/:id` → `{id}`), read by `param()`.
   *  NOT dep-recorded — match params already fold into the fp via
   *  `matchKey`, so `param()` is a pure read. */
  readonly params: Record<string, string>
  /** Observation options set by a `visible(opts)` read this render. Mutable
   *  — the hook writes it; the wrapper reads it back to build the cullable
   *  boundary's observer config. */
  visibleOptions?: VisibleOptions
  /** Which wrapper phase is executing. `"schema"` spans match →
   *  schema → fingerprint — everything BEFORE the fp is computed, where
   *  `park()` is legal; `"render"` is the Render body. The wrapper flips
   *  it just before invoking Render. Mutable; the wrapper owns it. */
  phase: "schema" | "render"
  /** Wake-hint box written by `expires()` / `staleUntil()` during this
   *  render. The wrapper passes the same object to the boundary, which
   *  stores it on the snapshot — so post-registration writes are visible
   *  to consumers. The wrapper owns the instance. */
  readonly wakeHints: WakeHints
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

/** Identity store for non-render execution — action dispatch. Renders
 *  stamp identity on the per-component frame (which isolates sibling
 *  renders); an action is one logical task with no siblings, so a plain
 *  ALS run scopes it. `getCurrentParton` prefers the frame — during a
 *  render the dispatch store is never populated. */
const dispatchStorage = new AsyncLocalStorage<CurrentParton>()

/**
 * Run `fn` with `parton` as the current parton — the action
 * dispatcher's stamp, so tracked hooks inside a schema callback (or an
 * action handler) read the ACTION's request: the caller's current
 * cookies/session, not a replay of render-time values.
 */
export function _runWithCurrentParton<T>(parton: CurrentParton, fn: () => T): T {
  return dispatchStorage.run(parton, fn)
}

/**
 * Read the rendering parton's own identity, or `undefined` when there is
 * no enclosing parton body (outside a render, or inside a non-parton
 * server component nested in the body). Valid anywhere in the body —
 * before or after awaits. During action dispatch, the dispatcher's
 * synthetic stamp (see `_runWithCurrentParton`).
 */
export function getCurrentParton(): CurrentParton | undefined {
  return sharedInternals?.__partonStorage?.getStore()?.parton ?? dispatchStorage.getStore()
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
 * Phase decides the ride. In the schema phase (pre-fp) the tag folds
 * into this render's label set directly — zero lag. In the Render body
 * (post-fp) it records a `tag:<name>` dependency key on the live dep
 * set, the same store-and-reread ride `cookie()`/`searchParam()` use:
 * the NEXT fp re-reads the tag's matching invalidation timestamp, and
 * the boundary surfaces the name as a refetch label at registration.
 * That is the natural slot for tags a loader's response yields (e.g.
 * `tag(`product:${data.id}`)` after a GraphQL await). No-op outside a
 * parton body.
 */
export function tag(name: string): void {
  const parton = getCurrentParton()
  if (!parton) return
  if (parton.phase === "schema") parton.tags.add(name)
  else parton.deps.add(`tag:${name}`)
}
