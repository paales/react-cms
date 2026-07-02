"use client";

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

import React, { type ReactNode } from "react";
import {
	addSeen,
	cacheFromStreamingChildren,
	harvestPartialIds,
	type LazyWalkStats,
	treeHasPendingLazy,
} from "./partial-cache.ts";
import {
	cacheLookup,
	getCurrentPagePartials,
	getTemplate,
	getTemplateRoute,
	pruneToLive,
	setTemplate,
	subscribeLaneCommits,
	templateRouteKey,
} from "./partial-client-state.ts";
import { deriveTemplate, renderTemplate } from "./partial-template.tsx";

export {
	_collectFramePaths,
	_dispatchFrameRefetch,
	_frame,
	_readFrameNode,
	_readFramesSnapshot,
	_windowNav,
	FrameNameContext,
	FrameNameProvider,
} from "./frame-client.tsx";
export {
	_applyFpTrailerFromDocument,
	_commitPartonLane,
	_warmCacheFromPayload,
} from "./partial-cache.ts";
export {
	_applyFpUpdates,
	getCachedPartialIds,
	registerClientPartial,
} from "./partial-client-state.ts";
export { isFrameworkSilentInfo } from "./refetch.ts";
export {
	type ActivatorFire,
	PageUrlContext,
	PageUrlProvider,
	PartialIdContext,
	useActivate,
	useNavigation,
	useScrollRestore,
} from "./use-navigation.tsx";

interface PartialsClientProps {
	/**
	 * Rendering mode:
	 * - "streaming": passthrough — renders children directly in the tree.
	 *   Used on full page renders so Suspense boundaries stay in the server
	 *   component tree and can stream.
	 * - "cache": template + cache merge — the existing behavior.
	 *   Used on partial re-fetches where only requested partials are fresh
	 *   and the rest are served from the client cache.
	 */
	mode?: "streaming" | "cache";
	// Optional at the type level so callers that supply children via
	// positional `createElement(PartialsClient, props, ...children)`
	// don't trip the required-prop check.
	children?: ReactNode;
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
let _walkedChildren: ReactNode = null;
let _walkComplete = false;

export function PartialsClient({
	mode = "cache",
	children,
}: PartialsClientProps) {
	// Re-render on per-parton lane commits (live connections write
	// freshly-decoded subtrees straight into the partial cache — see
	// `_commitPartonLane`). The transition keeps the swap non-urgent:
	// the current UI stays interactive and the fresh subtree commits
	// without a fallback flash, same as the default refetch commit mode.
	const [, bumpLaneEpoch] = React.useReducer((c: number) => c + 1, 0);
	React.useEffect(
		() =>
			subscribeLaneCommits(() => {
				React.startTransition(bumpLaneEpoch);
			}),
		[],
	);
	// PartialsClient is a `"use client"` component — but client components
	// STILL execute during SSR's render-to-HTML pass (entry.ssr.tsx ->
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
	//      `unwrapLazy(node)`, which returns `null` for unresolved Flight
	//      lazies (the form unrendered partial wrappers take while their
	//      chunks are still in flight). `deriveTemplate` likewise walks
	//      past lazies. In a production build the streamed children
	//      contain exactly those lazies — so a cache-walk-then-render
	//      path on the server outputs an EMPTY tree where the partial
	//      wrappers should have rendered, and the SSR HTML loses every
	//      partial body. Letting React see `children` directly preserves
	//      the lazies and resolves them through React's native Suspense /
	//      streaming machinery the way the bypass intended.
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
	if (typeof document === "undefined") return renderChildren([children]);

	const cache = getCurrentPagePartials();

	// ── Streaming mode ──────────────────────────────────────────────────
	//
	// Cache is populated from the streamed children by walking for keyed
	// `<Suspense>` elements — that's what `<Partial>` emits. Placeholders
	// (`<i data-partial hidden>`) are left alone so the existing cache
	// entry from a prior render still backs the template.
	//
	// Template is DERIVED on the client from the rendered children (not
	// built server-side). The derived template is persisted in module
	// state so subsequent cache-mode refetches can reuse it without a
	// server round-trip.
	//
	// Fingerprints land in the fingerprint map primarily via the synchronous
	// walk inside `cacheFromStreamingChildren` (the wrapper props carry
	// the fingerprint, so we don't have to wait for every
	// `<PartialErrorBoundary>` to commit). Each boundary's render still
	// re-registers as a fallback — harmless, same value.
	if (mode === "streaming") {
		// Lane-commit re-render: this payload was already walked to
		// completion, and only the cache changed since. Re-render the
		// persisted template against the updated cache — re-walking the
		// same children would overwrite lane-fresh entries with this
		// payload's older wrappers.
		if (_walkedChildren === children && _walkComplete) {
			return renderChildren(renderTemplate(getTemplate(), cache));
		}
		_walkedChildren = children;
		_walkComplete = false;
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
		const seen = new Map<string, Set<string>>();
		const stats: LazyWalkStats = { pending: 0 };
		cacheFromStreamingChildren(children, cache, seen, stats);
		// Route this payload renders for — keys the template reuse below so a
		// cross-route nav never reuses the prior route's template.
		const route = templateRouteKey();
		if (stats.pending > 0) {
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
			const template = getTemplate();
			if (template != null && route === getTemplateRoute()) {
				return renderChildren(renderTemplate(template, cache));
			}
			if (template == null) return renderChildren([children]);
			return renderChildren(renderTemplate(deriveTemplate(children), cache));
		}
		const derived = deriveTemplate(children);
		setTemplate(derived, route);

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
		let frontier: Array<[string, string]> = [];
		for (const [id, mks] of seen) for (const mk of mks) frontier.push([id, mk]);
		while (frontier.length > 0) {
			const next: Array<[string, string]> = [];
			for (const [id, mk] of frontier) {
				const wrapper = cacheLookup(cache, id, mk);
				if (!wrapper) continue;
				const inner = (wrapper as { props?: { children?: ReactNode } }).props
					?.children;
				if (inner == null) continue;
				const nested = new Map<string, Set<string>>();
				harvestPartialIds(inner, nested);
				for (const [nid, nmks] of nested) {
					for (const nmk of nmks) {
						const existing = seen.get(nid);
						if (!existing || !existing.has(nmk)) {
							addSeen(seen, nid, nmk);
							next.push([nid, nmk]);
						}
					}
				}
			}
			frontier = next;
		}

		// Drop entries from prior routes that don't appear on the new
		// page. `seen` covers fresh wrappers, placeholders from the new
		// tree, AND nested (id, matchKey) pairs harvested from cached
		// wrappers, so any variant still backing the rendered tree
		// survives. Pruning is at (id, matchKey) granularity — a parked
		// variant whose hidden Activity sibling is still emitted by the
		// server stays alive, while a variant no longer referenced
		// anywhere (different layout, never re-emitted) drops.
		pruneToLive(seen);
		_walkComplete = true;

		const rendered = renderTemplate(derived, cache);
		return renderChildren(rendered);
	}

	// ── Cache mode ──────────────────────────────────────────────────────
	//
	// Reuses the client-derived template from the most recent
	// streaming render. Cache-mode is always preceded by a full render
	// (initial HTML load), so the template is guaranteed to be populated.
	//
	// We descend into each refetched partial's content looking for
	// NESTED partials so they get their own top-level cache entries
	// too. Without this, a frame refetch that introduces a brand-new
	// inner partial would cache only the outer wrapper; a subsequent
	// same-URL refetch (which emits a placeholder for the inner) would
	// find no top-level cache entry to fill the placeholder.
	//
	// Guarded like the streaming path: a lane-commit re-render carries
	// the SAME children, and re-walking them would overwrite lane-fresh
	// cache entries with this payload's older wrappers. An incomplete
	// walk (pending lazy) re-runs so late-resolving wrappers still land.
	if (!(_walkedChildren === children && _walkComplete)) {
		_walkedChildren = children;
		const walkStats: LazyWalkStats = { pending: 0 };
		cacheFromStreamingChildren(children, cache, undefined, walkStats);
		_walkComplete = walkStats.pending === 0;
	}

	const rendered = renderTemplate(getTemplate(), cache);

	// Bound both client maps to what's actually on the page. `rendered`
	// is the FULL page (template + cache), so `harvestPartialIds` over it
	// yields every (id, matchKey) currently displayed OR parked (hidden
	// Activity placeholders are harvested too). Anything in the maps but
	// not here was superseded — a churned-away instance id (props pass a
	// new value → new effective id), an evicted variant — and the client
	// can no longer restore it, so it must stop being advertised in
	// `?cached=`. Without this, the maps only ever grew on the cache-mode
	// (in-app refetch) path — the streaming-mode prune above runs only on
	// a full page load, which never happens mid-session. Identity-method
	// agnostic: bounds props / vary / cell / match alike, because it
	// keys on "still in the rendered/parked tree", not on how data is
	// passed. Un-refetched partials (header, list pages) and live sibling
	// instances stay — they're present in `rendered`.
	//
	// Guard on a COMPLETE render. A substituted cache wrapper can still
	// carry an in-flight Flight lazy — a slow descendant (the search
	// stages) hadn't resolved when the wrapper was last cached. The
	// partials behind that lazy are still live but aren't materialised in
	// `rendered`, so `harvestPartialIds` doesn't see them; pruning would
	// evict their cache + advertised-fp entries, and the next render's
	// fp-skip placeholder would have nothing to substitute — blanking the
	// region until a full re-render restores it ("content behind search
	// disappears"). The streaming-mode path prunes only in its
	// non-pending branch for the same reason; mirror it here and defer
	// the prune to a later commit whose render is whole.
	if (!treeHasPendingLazy(rendered)) {
		const live = new Map<string, Set<string>>();
		harvestPartialIds(rendered, live);
		pruneToLive(live);
	}

	return renderChildren(rendered);
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
	return React.createElement(React.Fragment, null, ...rendered);
}
