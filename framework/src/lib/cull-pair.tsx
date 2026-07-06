"use client";

/**
 * The two Activity slots of a cullable parton — the client half of
 * cull-to-park, in one component.
 *
 * The server emits every cullable parton as ONE `<CullPair>` (see
 * `cullPairEmit` in `partial.tsx`):
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
 *     It is ALWAYS present, which is what makes a cull-out flip a
 *     purely local operation: swap Activity modes, done — no bytes.
 *
 * Each slot renders `<Activity>` around its child; a culling flip is
 * a MODE change on the two Activities, so the content subtree PARKS
 * when the parton leaves view (fiber alive, DOM kept, effects
 * unmounted) and RESTORES in place when it returns — client state
 * survives the round trip.
 *
 * Mode comes from the visibility controller's live report
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
 * parton's id. Activity-hiding unmounts the parked slot's observer
 * effects, so exactly the showing slot observes; the observer
 * refcount in `cull-park.ts` distinguishes that handoff from the
 * parton leaving the page.
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
 * SSR renders modes purely from the `culled` prop — no report, no
 * cache — which matches the client's pre-report first render, so
 * hydration sees one shape.
 */

import React, { Activity, type ReactNode } from "react";
import {
	contentGeneration,
	cullStateSnapshot,
	reportedVisibility,
	subscribeCullState,
} from "./cull-park.ts";
import { cacheLookup, getCurrentPagePartials } from "./partial-client-state.ts";
import { _primeVisible, VisibilityObserver } from "./visibility.tsx";

interface CullPairProps {
	/** The parton's effective id — the visibility controller's key. */
	id: string;
	/** matchKey of the variant this pair belongs to — the content
	 *  slot's cache slot under `id`. */
	mk: string;
	/** Server-computed culled state of the render that produced this
	 *  element — the pre-report fallback only; a live report wins. */
	culled: boolean;
	/** Observer runway (IntersectionObserver rootMargin) from the
	 *  spec's `cull.rootMargin`. Omitted → the default runway. */
	obs?: string;
	/** The skeleton element — always present, always renderable. */
	skel: ReactNode;
	/** The content slot's child; absent when the client holds nothing
	 *  for this variant (nothing to park, nothing to restore). */
	children?: ReactNode;
}

const noopSubscribe = () => () => {};

export function CullPair({
	id,
	mk,
	culled,
	obs,
	skel,
	children,
}: CullPairProps): ReactNode {
	// Subscribe to reported-visibility flips + generation bumps for this
	// id. The snapshot string is per-id, so unrelated flips don't
	// re-render this pair. Server snapshot: no report (fall to `culled`).
	React.useSyncExternalStore(
		subscribeCullState,
		() => cullStateSnapshot(id),
		() => "u|0",
	);
	// Hydration gate for the cache-availability adjustment below. The
	// HYDRATION render must reproduce the SSR modes exactly — the walk
	// may not have cached a still-streaming slot yet, and adjusting an
	// Activity's mode against the server-rendered state mid-hydration
	// crashes React's hydration pass. useSyncExternalStore returns the
	// server snapshot during hydration and re-renders with the client
	// one right after mount, which is exactly the boundary needed.
	const hydrated = React.useSyncExternalStore(
		noopSubscribe,
		() => true,
		() => false,
	);
	const isServer = typeof document === "undefined";
	// Prime the controller with this emission's display state so the
	// first measurement is compared against what's actually shown.
	// (`_primeVisible` is a no-op once the id has a real report.)
	React.useEffect(() => {
		_primeVisible(id, !culled);
	}, [id, culled]);
	const reported = isServer ? undefined : reportedVisibility(id);
	const out = reported === undefined ? culled : !reported;

	// Content availability: the emission itself on the server/hydration
	// pass (a non-culled emission carries its content), the live cache
	// afterwards — every commit that stores a slot re-renders the pair,
	// so the check re-runs exactly when it can change.
	const cache = hydrated ? getCurrentPagePartials() : null;
	const hasContent = hydrated
		? cache != null && cacheLookup(cache, id, mk) != null
		: !culled;

	const generation = hydrated ? contentGeneration(id) : 0;
	return (
		<>
			{/* The content observer mounts only over REAL content. An
			    unbacked slot renders the bare `<i data-partial>` hole — a
			    connected zero-size node; an observer over it would testify
			    "out" for a parton that's squarely in view (the hole is what
			    its flip-in bytes will substitute), flipping it right back
			    out: a lane-rate flip loop. While content is missing the
			    SKELETON slot is showing (below) and its observer is the
			    parton's testimony. */}
			<Activity key={generation} mode={out ? "hidden" : "visible"}>
				{hasContent ? (
					<VisibilityObserver id={id} rootMargin={obs}>
						{children}
					</VisibilityObserver>
				) : (
					children
				)}
			</Activity>
			{/* The skeleton also shows IN VIEW while the content slot has
			    nothing to render (first bytes still streaming) — the pair
			    must always hold the parton's space and its observer. */}
			<Activity mode={out || !hasContent ? "visible" : "hidden"}>
				<VisibilityObserver id={id} rootMargin={obs}>
					{skel}
				</VisibilityObserver>
			</Activity>
		</>
	);
}
