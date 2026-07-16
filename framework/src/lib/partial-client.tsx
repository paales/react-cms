"use client"

/**
 * Client-side partial merge coordinator.
 *
 * Receives a structural template (layout with partial placeholders)
 * and fresh partial content. Caches partials across renders and fills
 * the template from cache on every render.
 *
 * On full renders: all partials are fresh → cache fully populated.
 * On partial renders: only requested partials update the cache.
 * The template is always the same structural layout (main, footer, etc.),
 * so keyless wrappers are preserved across partial updates.
 *
 * Nested partials are supported: if "cart" is nested inside "header",
 * refreshing "header" re-renders the header layout but keeps cached
 * cart. Refreshing "cart" patches just the cart into cached header.
 *
 * Client API surface: `useNavigation()` returns a handle whose
 * `navigate(url, opts)` / `reload(opts)` methods drive every
 * refetch on the page. Targeted refetches are expressed through the
 * `selector` option (CSS-style `#id` / `.class` tokens) — see
 * {@link FrameworkNavigateOptions}. State lives in a URL (the page URL
 * or a frame URL); a spec's request-dependent inputs reach it through
 * tracked reads / `match` / cells, which re-resolve on each refetch.
 *
 * This module is the composition point and the `"use client"` boundary
 * — the machinery lives in focused siblings, re-exported below:
 *
 *   - `partial-client-state.ts` — the module-level mutable state
 *     (partial cache, fingerprints, template, in-flight registry,
 *     frame URLs) behind accessor functions.
 *   - `partial-cache.ts`        — cache/harvest/substitute tree walks.
 *   - `partial-template.tsx`    — template derivation + render.
 *   - `refetch.ts`              — batched targeted-refetch dispatch.
 *   - `frame-client.tsx`        — frame state machine + nav handles.
 *   - `use-navigation.tsx`      — the `useNavigation()` hook layer.
 */

import React, { type ReactNode } from "react"
import {
  addSeen,
  cacheFromStreamingChildren,
  harvestPartialIds,
  type LazyWalkStats,
  treeHasPendingLazy,
} from "./partial-cache.ts"
import {
  _addLiveTreeIds,
  _nextStoreSeq,
  _runWithStoreSeq,
  cacheLookup,
  getCurrentPagePartials,
  getTemplate,
  getTemplateRoute,
  notifyLaneCommitCoalesced,
  pruneToLive,
  setTemplate,
  subscribeLaneCommits,
  templateRouteKey,
} from "./partial-client-state.ts"
import { deriveTemplate, renderTemplate } from "./partial-template.tsx"
import { _sweepEmptyVisibilityObservers } from "./visibility.tsx"

// The EAGER frame surface only — the contexts, the provider, the pure
// frames-tree readers. The frame NAVIGATION machinery (`_frame`,
// `_windowNav`, `_dispatchFrameRefetch`) and the silent-info guard live
// in the late-loaded layer (`frame-client.tsx` / `refetch.ts`) and are
// imported directly by the modules that need them — never re-exported
// here, so this boundary keeps the channel transport out of its static
// closure.
export {
  _collectFramePaths,
  _readFrameNode,
  _readFramesSnapshot,
  FrameNameContext,
  FrameNameProvider,
} from "./frame-context.tsx"
export {
  _applyFpTrailerFromDocument,
  _commitPartonLane,
  _commitPartonLaneProgressive,
} from "./partial-cache.ts"
export {
  _applyFpUpdates,
  getCachedPartialIds,
  registerClientPartial,
} from "./partial-client-state.ts"
export {
  type ActivatorFire,
  PageUrlContext,
  PageUrlProvider,
  PartialIdContext,
  useActivate,
  useNavigation,
  useScrollRestore,
} from "./use-navigation.tsx"

interface PartialsClientProps {
  children?: ReactNode
}

/**
 * The most recent `children` tree the cache walk ran over, and whether
 * that walk was complete (no pending Flight lazies). A per-parton lane
 * commit re-renders PartialsClient with the SAME children — re-walking
 * them would overwrite the lane's fresh cache entries with this
 * (older) payload's wrappers, undoing the commit. The guard skips the
 * walk when the children were already walked to completion; an
 * incomplete walk (a chunk was in flight) re-runs so late-resolving
 * wrappers still get cached.
 */
let _walkedChildren: ReactNode = null
let _walkComplete = false
/** The store-seq batch of `_walkedChildren`'s walk — every re-walk of
 *  the SAME children (an incomplete walk re-run after chunks settled)
 *  writes under it, so a late pass never clobbers a slot a newer lane
 *  commit wrote in between (the out-of-order guard in `cacheStore`). */
let _walkStoreSeq = 0

/**
 * Arrange a re-walk of `children` for the moment its in-flight Flight
 * rows land. An incomplete walk skips wrappers still inside pending
 * lazies; without this, those wrappers only reach the cache if a
 * LATER render happens to re-walk the same children — and on a busy
 * page (lane commits, serialized culling flushes) a newer payload
 * replaces `_walkedChildren` first, losing the streamed bytes
 * permanently: the targeted partial's fresh content never lands, so
 * its region keeps showing the prior cache entry. Resolving the
 * captured thenables is the real completion signal.
 *
 * The resolution handler only NUDGES a re-render (the lane-commit
 * channel); the actual re-walk runs inside that render through the
 * ordinary incomplete-walk path. Walking here, in the microtask,
 * would force lazy initialization outside React's render lifecycle —
 * which wedges hydration on pages whose payload streams chunks
 * progressively (the RemoteFrame routes). Superseded payloads are
 * skipped — walking a stale payload would overwrite newer cache
 * entries, the same hazard the `_walkedChildren` guard exists for.
 * The nudge is streaming arrival, so it rides the lane flush quantum.
 */
function scheduleRewalkOnResolve(
  children: ReactNode,
  thenables: readonly PromiseLike<unknown>[],
): void {
  if (thenables.length === 0) return
  void Promise.allSettled(thenables.map((t) => Promise.resolve(t))).then(() => {
    if (_walkedChildren !== children || _walkComplete) return
    notifyLaneCommitCoalesced()
  })
}

export function PartialsClient({ children }: PartialsClientProps) {
  // Re-render on per-parton lane commits (live connections write
  // freshly-decoded subtrees straight into the partial cache — see
  // `_commitPartonLane`). The transition keeps the swap non-urgent:
  // the current UI stays interactive and the fresh subtree commits
  // without a fallback flash, same as the default refetch commit mode.
  const [, bumpLaneEpoch] = React.useReducer((c: number) => c + 1, 0)
  React.useEffect(
    () =>
      subscribeLaneCommits(() => {
        React.startTransition(bumpLaneEpoch)
      }),
    [],
  )
  // Post-commit sweep: any commit of the merge layer may have
  // materialized content under a cullable boundary whose observer was
  // attached while its fragment was still empty — re-attach those so
  // they can measure (see `_sweepEmptyVisibilityObservers`).
  React.useEffect(() => {
    _sweepEmptyVisibilityObservers()
  })
  // PartialsClient is a `"use client"` component — but client components
  // STILL execute during SSR's render-to-HTML pass (`../entry/ssr.tsx` ->
  // renderToReadableStream decodes the Flight tree and runs every
  // client-component body to produce the HTML). On the server we skip
  // the cache/template machinery entirely:
  //
  //   1. The partial cache, fingerprint map and template (see
  //      `partial-client-state.ts`) are module-level state —
  //      session-scoped for the BROWSER tab. The same module is reused
  //      across every request in the server process, so any write would
  //      leak request N's state into request N+1. That leak is what
  //      produced the production-preview "subsequent GET returns empty
  //      body" regression.
  //
  //   2. The cache-populating walk in `cacheFromStreamingChildren` calls
  //      `unwrapLazy(node)`, which classifies unresolved Flight chunks
  //      (the form unrendered partial wrappers take while their
  //      rows are still in flight) as pending and stops. `deriveTemplate`
  //      likewise walks past them. In a production build the streamed children
  //      contain exactly those pending chunks — so a cache-walk-then-render
  //      path on the server outputs an EMPTY tree where the partial
  //      wrappers should have rendered, and the SSR HTML loses every
  //      partial body. Letting React see `children` directly preserves
  //      the deferred nodes and resolves them through React's native
  //      Suspense / streaming machinery the way the bypass intended.
  //
  // Symmetry note for hydration: the browser path returns
  // `<Fragment>{...rendered}</Fragment>` (an explicit Fragment from
  // `renderChildren`). useId positions are sensitive to tree shape, so
  // returning raw `children` on the server while wrapping the client
  // tree in a Fragment desyncs hydration — `useId`-driven attributes
  // mismatch and the subtree ends up patched up imperfectly, breaking
  // the cache-mode merge path defer activators rely on. We mirror the
  // wrapper here so the SSR DOM and the client's first render share
  // the same useId tree positions.
  if (typeof document === "undefined") return renderChildren([children])

  const cache = getCurrentPagePartials()

  // Cache is populated from the streamed children by walking for keyed
  // `<Suspense>` elements — that's what `<Partial>` emits. Placeholders
  // (`<i data-partial hidden>`) are left alone so the existing cache
  // entry from a prior render still backs the template.
  //
  // Template is DERIVED on the client from the rendered children (not
  // built server-side). The derived template is persisted in module
  // state so template re-renders (lane commits) reuse it without a
  // server round-trip.
  //
  // Fingerprints land in the fingerprint map primarily via the synchronous
  // walk inside `cacheFromStreamingChildren` (the wrapper props carry
  // the fingerprint, so we don't have to wait for every
  // `<PartialErrorBoundary>` to commit). Each boundary's render still
  // re-registers as a fallback — gated on the content slot actually
  // holding the wrapper (`registerClientPartial`'s advertise-honesty
  // gate): a still-mounted fiber whose slots an eviction destroyed
  // must not resurrect the advertised fp, or the next holdings
  // statement claims bytes the client cannot restore.
  // Lane-commit re-render: this payload was already walked to
  // completion, and only the cache changed since. Re-render the
  // persisted template against the updated cache — re-walking the
  // same children would overwrite lane-fresh entries with this
  // payload's older wrappers.
  if (_walkedChildren === children && _walkComplete) {
    return renderChildren(renderTemplate(getTemplate(), cache))
  }
  if (_walkedChildren !== children) _walkStoreSeq = _nextStoreSeq()
  _walkedChildren = children
  _walkComplete = false
  // Walk the streamed tree and track every Partial id encountered,
  // whether emitted as a fresh wrapper or as an fp-skip placeholder.
  // Both kinds of id are still live on this route — the placeholder
  // means "the server confirmed your cache entry is current", so its
  // cache + fingerprint MUST survive the prune below.
  //
  // Clearing the fingerprint map up-front would wipe skipped
  // partials' fingerprints because the walk only re-sets them for
  // fresh wrappers. Likewise pruning the cache against just the
  // top-level placeholders from `deriveTemplate` (which stops at any
  // wrapper, so nested ids are never visited) would delete the cache
  // entries for nested partials whose ancestor was re-rendered fresh
  // but whose own region was fp-skipped — leaving `substituteNested`
  // no entry to fill the placeholder with on the next render.
  const seen = new Map<string, Set<string>>()
  const stats: LazyWalkStats = { pending: 0, thenables: [] }
  _runWithStoreSeq(_walkStoreSeq, () => cacheFromStreamingChildren(children, cache, seen, stats))
  // Route this payload renders for — keys the template reuse below so a
  // cross-route nav never reuses the prior route's template.
  const route = templateRouteKey()
  if (stats.pending > 0) {
    // Re-walk when the in-flight rows land, so this payload's
    // still-streaming wrappers reach the cache even if a newer
    // payload replaces `children` before any re-render.
    scheduleRewalkOnResolve(children, stats.thenables ?? [])
    // A Flight chunk hadn't arrived when we walked the children tree, so
    // the cache walk is incomplete — a wrapper inside a pending lazy was
    // missed. We still must substitute the fp-skipped CHROME (the nav,
    // the header) from cache: returning it raw leaves bare `<i hidden>`
    // placeholders, so the nav vanishes until the next full re-render
    // (the heartbeat) restores it. The choice turns on which template to
    // substitute through:
    //
    //   - Same-route template (steady-state streaming segment — e.g. the
    //     chat's `<ChunkSlot>` is suspended): render through the SAME
    //     complete template + cache path a cache-mode refetch takes. A
    //     page with two live connections commits cache-mode (the chat
    //     overlay's frame long-poll) AND streaming-mode (the heartbeat)
    //     segments onto one root; if this branch returned a raw shape
    //     instead, every partial inside the page would remount on each
    //     seam (the nav, the grid — the inspect-overlay flicker).
    //     Matching the cache path lets React reconcile in place, and the
    //     complete prior template carries structure currently behind the
    //     pending lazy that a fresh derive would miss.
    //
    //   - Cross-route nav whose new route still has a chunk in flight:
    //     derive a FRESH template from the NEW children and substitute.
    //     Reusing the prior route's template would re-render the page
    //     just navigated away from (the `/magento → /` stuck-page
    //     regression); a fresh derive shows the new page. `deriveTemplate`
    //     keeps pending lazies raw, so the new page's deferred content
    //     resolves natively for the NEW route, while
    //     `cacheFromStreamingChildren` above just cached every walkable
    //     wrapper — so the fp-skipped chrome fills from cache instead of
    //     blanking. The stored template is left untouched (this derive is
    //     incomplete); the next fully-resolved render refreshes it.
    //
    //   - No template yet (first render hydrating against SSR HTML): no
    //     cache to substitute from. Raw `children` keep the tree shape
    //     aligned for `useId`.
    const template = getTemplate()
    if (template != null && route === getTemplateRoute()) {
      return renderChildren(renderTemplate(template, cache))
    }
    if (template == null) return renderChildren([children])
    return renderChildren(renderTemplate(deriveTemplate(children), cache))
  }
  const derived = deriveTemplate(children)
  setTemplate(derived, route)

  // Expand `seen` with nested (id, matchKey) pairs reachable through
  // cached wrappers. When the server fp-skips an OUTER partial (e.g.
  // `cms-demo-root` unchanged across `/cms-demo/beta` →
  // `/cms-demo/gamma`), the new streamed tree carries only the
  // outer's placeholder. Without this expansion, the prune below
  // would drop every nested partial's cache entry — and the next
  // render's `substituteNested` walk over the cached outer wrapper
  // would find empty placeholders for slug-nav, hero, multi-slot,
  // product-grid, …, blanking those regions.
  //
  // Frontier-style BFS: each newly-discovered (id, matchKey) can
  // itself be a wrapper containing more nested partials, so harvest
  // until no new pairs appear.
  let frontier: Array<[string, string]> = []
  const harvestStats = { pending: 0 }
  for (const [id, mks] of seen) for (const mk of mks) frontier.push([id, mk])
  while (frontier.length > 0) {
    const next: Array<[string, string]> = []
    for (const [id, mk] of frontier) {
      const wrapper = cacheLookup(cache, id, mk)
      if (!wrapper) continue
      const inner = (wrapper as { props?: { children?: ReactNode } }).props?.children
      if (inner == null) continue
      const nested = new Map<string, Set<string>>()
      harvestPartialIds(inner, nested, harvestStats)
      for (const [nid, nmks] of nested) {
        for (const nmk of nmks) {
          const existing = seen.get(nid)
          if (!existing || !existing.has(nmk)) {
            addSeen(seen, nid, nmk)
            next.push([nid, nmk])
          }
        }
      }
    }
    frontier = next
  }

  // Drop entries from prior routes that don't appear on the new
  // page. `seen` covers fresh wrappers, placeholders from the new
  // tree, AND nested (id, matchKey) pairs harvested from cached
  // wrappers, so any variant still backing the rendered tree
  // survives. Pruning is at (id, matchKey) granularity — a parked
  // variant whose hidden Activity sibling is still emitted by the
  // server stays alive, while a variant no longer referenced
  // anywhere (different layout, never re-emitted) drops.
  //
  // A pending-BLOCKED harvest defers the prune: a cached wrapper whose
  // content is still streaming (a progressive lane commit mid-body)
  // hides its nested variants behind an unresolved chunk, and pruning
  // what the harvest couldn't see would blank those regions the moment
  // the template re-substitutes (fuzz class F11). Over-retention,
  // never blanking — the next fully-harvestable commit prunes; the
  // live-tree fold still refreshes the eviction exemption.
  if (harvestStats.pending === 0) {
    pruneToLive(seen)
  } else {
    _addLiveTreeIds(seen.keys())
  }
  _walkComplete = true

  const rendered = renderTemplate(derived, cache)
  return renderChildren(rendered)
}

/**
 * Return `<>{...rendered}</>`, but built via `React.createElement` so
 * the array is spread as positional children. `<>{rendered}</>` passes
 * the array as a single children prop, which makes React enforce the
 * unique-key rule on every item — and the cached partial elements
 * carry intentional non-keys (adding one would trigger Flight's
 * outer/inner key composite, remounting client state on refetch; see
 * `partialFromSnapshot`).
 */
function renderChildren(rendered: ReactNode[]): ReactNode {
  return React.createElement(React.Fragment, null, ...rendered)
}
