"use client"

/**
 * The two slots of a cullable parton — the client half of
 * cull-to-park, in one component: a CONTENT `<Activity>` that parks,
 * and a SKELETON that is conditionally rendered.
 *
 * The server emits every cullable parton as ONE `<CullPair>` (see
 * `cullPairOf` in `partial.tsx`):
 *
 *   - `children` — the CONTENT slot's child: the parton's rendered
 *     body (its PEB wrapper), an `<i data-partial>` hole the merge
 *     layer fills from the client cache, or nothing at all (a culled
 *     instance the client holds no content for — the common cold
 *     case, and the reason a culled placement costs a couple hundred
 *     bytes instead of a rendered body).
 *   - `skel` — the SKELETON: an instance of the spec's declared
 *     `cull.skeleton` client component, carrying the placement's
 *     serializable props. It renders CLIENT-SIDE and ships as one
 *     module reference + props, so the culled state needs no server
 *     render, no cache variant, no fingerprint, and no manifest slot.
 *     Being stateless, it is mounted only while shown (`showSkel`) —
 *     a cull-out flip stays a purely local operation regardless: flip
 *     the content Activity to hidden, mount the skeleton, no bytes.
 *
 * The content slot renders `<Activity>` around its child, so a
 * culling flip is a MODE change that PARKS the content subtree when
 * the parton leaves view (fiber alive, DOM kept, effects unmounted)
 * and RESTORES it in place when it returns — client state survives
 * the round trip. The skeleton is NOT an Activity: a born-hidden
 * Activity never gets `display:none` (React applies the hide only on
 * a visible→hidden transition, never on initial hydration/mount), so
 * a skeleton parked hidden at hydration would paint and ghost behind
 * the content. Conditional rendering sidesteps that — the skeleton is
 * simply absent when it shouldn't show.
 *
 * Display comes from the visibility controller's live report
 * (`cull-park.ts`, via useSyncExternalStore) with the server-computed
 * `culled` prop as the pre-report fallback — the report IS the
 * display state, so a flip shows instantly while any revalidation
 * runs in the background. The skeleton also shows while the content
 * slot has nothing to render yet (bytes still streaming in), so the
 * pair always holds the parton's space and its viewport observer.
 *
 * The content Activity is keyed by the slot's GENERATION
 * (`cull-park.ts`): an fp-matched return restores the parked fiber in
 * place (generation unchanged, same cached element — React bails
 * out), while fresh returning bytes (fp moved while parked) bump it
 * and REMOUNT — the parked copy is dropped, per drop-on-drift
 * semantics.
 *
 * Both slots wrap their child in a `<VisibilityObserver>` under the
 * parton's id, and exactly one is mounted at a time (the content slot
 * when it holds content and is in view, the skeleton otherwise). A
 * flip hands observation from one to the other; the observer refcount
 * in `cull-park.ts` distinguishes that handoff from the parton
 * leaving the page.
 *
 * On mount the pair PRIMES the visibility controller with its
 * server-computed display state (`_primeVisible`). The controller
 * compares the first IntersectionObserver report against the primed
 * state, so a measurement that merely AGREES with what the server
 * already rendered (the seeded viewport at boot) is a no-op instead
 * of a page-wide revalidation storm. Effects flush synchronously in
 * the commit and IO callbacks are always async, so the prime can't
 * lose the race against the first report.
 *
 * SSR renders the content slot's mode and `showSkel` purely from
 * `culled` and the emitted `children` shape — no report, no cache —
 * which matches the client's pre-report first render, so hydration
 * sees one shape.
 */

import React, { Activity, isValidElement, type ReactNode } from "react"
import {
  contentGeneration,
  cullStateSnapshot,
  reportedVisibility,
  subscribeCullState,
} from "./cull-park.ts"
import { isPlaceholder } from "./partial-cache.ts"
import { _primeVisible, _visibilityContentRegressed, VisibilityObserver } from "./visibility.tsx"

/**
 * Whether the content slot's child is REAL content to show, versus an
 * unfilled `<i data-partial>` hole (or nothing at all). The server ships
 * the parton's rendered body — a partial wrapper — when it has content,
 * and a placeholder hole (or null) when the client must fill the slot
 * from its cache; the merge layer substitutes a cached body into that
 * hole before the pair renders. Reading the child directly is the real
 * content-presence signal — correct for every cull state (fresh, culled,
 * fp-skip park/restore, match-miss) and every render path — unlike a
 * cache lookup on the cullable's OWN id, which misses whenever the body
 * is a nested parton (the content caches under the CHILD's id).
 */
function contentIsReal(node: ReactNode): boolean {
  if (node == null || typeof node === "boolean") return false
  if (Array.isArray(node)) return node.some(contentIsReal)
  if (isValidElement(node) && isPlaceholder(node)) return false
  return true
}

interface CullPairProps {
  /** The parton's effective id — the visibility controller's key. */
  id: string
  /** Server-computed culled state of the render that produced this
   *  element — the pre-report fallback only; a live report wins. */
  culled: boolean
  /** Observer runway (IntersectionObserver rootMargin) from the
   *  spec's `cull.rootMargin`. Omitted → the default runway. */
  obs?: string
  /** The skeleton element — client-rendered from the placement's
   *  props; mounted only while the pair shows it (see `showSkel`). */
  skel: ReactNode
  /** The content slot's child; absent when the client holds nothing
   *  for this variant (nothing to park, nothing to restore). */
  children?: ReactNode
}

const noopSubscribe = () => () => {}

export function CullPair({ id, culled, obs, skel, children }: CullPairProps): ReactNode {
  // Subscribe to reported-visibility flips + generation bumps for this
  // id. The snapshot string is per-id, so unrelated flips don't
  // re-render this pair. Server snapshot: no report (fall to `culled`).
  React.useSyncExternalStore(
    subscribeCullState,
    () => cullStateSnapshot(id),
    () => "u|0",
  )
  // Hydration gate for the content Activity's generation key below. The
  // HYDRATION render must reproduce the SSR key exactly — the server
  // keys the slot 0, but a returning page can carry a non-zero
  // generation in client state that, applied on the first render, would
  // remount the subtree against the server DOM. useSyncExternalStore
  // returns the server snapshot during hydration and re-renders with the
  // client one right after mount, which is exactly the boundary needed.
  const hydrated = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
  const isServer = typeof document === "undefined"
  // Prime the controller with this emission's state so the first
  // measurement is compared against what's actually shown. The
  // controller overlays any live report for the id — the same
  // precedence `out` uses below — and is a no-op once the id has a
  // real observer report.
  React.useEffect(() => {
    _primeVisible(id, !culled)
  }, [id, culled])
  const reported = isServer ? undefined : reportedVisibility(id)

  // Content availability read straight off the content slot's child —
  // the real signal (see `contentIsReal`), not a cache-presence proxy.
  // On the SSR/hydration pass this equals `!culled` (a culled emission
  // ships a hole, a live one its body), so the pair hydrates to one
  // shape; past hydration it tracks what will actually render.
  const hasContent = contentIsReal(children)
  const out = reported === undefined ? culled : !reported
  // Regression detector: a commit whose substitution can no longer
  // back this pair's content slot — the cache entry was destroyed (a
  // stale ancestor commit clobbered it, an eviction raced the
  // display) — regresses an IN-VIEW pair to its skeleton. The pair is
  // the one component that can testify to that (it renders the loss),
  // so it writes the explicit signal: reset the id's visibility
  // baseline (the skeleton observer's next measurement re-states the
  // flip) and report the loss upstream (the re-stated flip's lane
  // re-renders instead of confirming the destroyed copy). Only a
  // true→false CONTENT transition while the pair displays in-view
  // (`!out`) — a fresh pair streaming its first bytes never had
  // content, and a client-stated out-flip (or a server-stated cull
  // the display honors) flips `out` for the same commit.
  const hadContent = React.useRef(hasContent)
  React.useEffect(() => {
    const regressed = hadContent.current && !hasContent && !out
    hadContent.current = hasContent
    if (regressed) _visibilityContentRegressed(id)
  }, [id, hasContent, out])
  // The skeleton shows out of view, or in view while the content slot
  // is still a hole (first bytes streaming). It is CONDITIONALLY
  // rendered, never a hidden `<Activity>`: React applies an Activity's
  // hide only on a visible→hidden TRANSITION, never on the initial
  // hydration/mount of a born-hidden one — a skeleton born hidden would
  // paint with no `display:none` and ghost behind the content. The
  // content slot keeps its Activity so its subtree PARKS on a cull-out.
  const showSkel = out || !hasContent

  const generation = hydrated ? contentGeneration(id) : 0
  return (
    <>
      {/* The content observer mounts only over REAL content. An
			    unbacked slot renders the bare `<i data-partial>` hole — a
			    connected zero-size node; an observer over it would testify
			    "out" for a parton that's squarely in view (the hole is what
			    its flip-in bytes will substitute), flipping it right back
			    out: a lane-rate flip loop. While content is missing the
			    SKELETON (below) shows and its observer is the parton's
			    testimony. The content Activity parks the subtree on a
			    cull-out — fiber alive, DOM kept, effects unmounted. */}
      <Activity key={generation} mode={out ? "hidden" : "visible"}>
        {hasContent ? (
          <VisibilityObserver id={id} rootMargin={obs}>
            {children}
          </VisibilityObserver>
        ) : (
          children
        )}
      </Activity>
      {/* Skeleton: CONDITIONALLY rendered, not a parked Activity — a
			    born-hidden Activity never gets `display:none` (React hides
			    only on a visible→hidden transition), so it would ghost
			    behind the content. Stateless (client-rendered from the
			    placement's props), so nothing is lost by mounting and
			    unmounting it across flips. Its observer hands off to/from
			    the content slot's — the refcount + microtask sweep in
			    `cull-park.ts` absorb the pass-through-zero. */}
      {showSkel ? (
        <VisibilityObserver id={id} rootMargin={obs}>
          {skel}
        </VisibilityObserver>
      ) : null}
    </>
  )
}
