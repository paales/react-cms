/**
 * Relevance predicate for the streaming segment driver.
 *
 * A held-open stream re-renders a new segment only when a
 * `refreshSelector` bump touches something the stream's route actually
 * renders. Without this, one viewer's `cell.set` would wake every open
 * stream into a (fp-skip) re-render — the cross-stream storm that
 * saturates the server under N concurrent viewers.
 *
 * Lives in its own module (rather than inside `segmented-response.ts`)
 * so the predicate is unit-testable without dragging in the render
 * graph (`partial.tsx` et al.) that the driver imports.
 */

import { queryMatchingTs } from "../runtime/invalidation-registry.ts";
import type { PartialSnapshot } from "./partial-registry.ts";

/**
 * True iff some bump with `ts > sinceTs` matches any of these
 * snapshots' labels + constraint surface. The surface is each
 * snapshot's `varyKey` (stable-stringified vary result) unioned with
 * its `constraintArgs` (bound-cell args) — the same inputs the live
 * fp folds through `queryMatchingTs`. A bump for a different partition
 * (another viewer's cart) or to an unrendered label returns `false`.
 */
export function _routeHasMatchingBump(
	snapshots: ReadonlyMap<string, PartialSnapshot>,
	sinceTs: number,
): boolean {
	for (const [, snap] of snapshots) {
		if (snapshotHasMatchingBump(snap, sinceTs)) return true;
	}
	return false;
}

/**
 * The ids whose snapshots a bump with `ts > sinceTs` touched — same
 * predicate as `_routeHasMatchingBump`, returning the matches instead
 * of short-circuiting. The per-parton segment driver renders exactly
 * these as lanes, so one viewer's partition-scoped write re-renders
 * only the partons it actually constrains.
 */
export function _routeMatchingBumpIds(
	snapshots: ReadonlyMap<string, PartialSnapshot>,
	sinceTs: number,
): string[] {
	const ids: string[] = [];
	for (const [id, snap] of snapshots) {
		if (snapshotHasMatchingBump(snap, sinceTs)) ids.push(id);
	}
	return ids;
}

function snapshotHasMatchingBump(
	snap: PartialSnapshot,
	sinceTs: number,
): boolean {
	let varyInputs: Record<string, unknown> | null = null;
	if (snap.varyKey) {
		try {
			varyInputs = JSON.parse(snap.varyKey) as Record<string, unknown>;
		} catch {
			varyInputs = null;
		}
	}
	const constraintSurface = {
		...(varyInputs ?? {}),
		...(snap.constraintArgs ?? {}),
	};
	return queryMatchingTs(snap.labels, constraintSurface) > sinceTs;
}
