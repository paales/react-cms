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

import {
	_selectorMatchesSurface,
	type ParsedSelector,
	queryMatchingTs,
} from "../runtime/invalidation-registry.ts";
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
	return escalateToLaneCarriers(ids, snapshots);
}

/**
 * The nearest snapshot that can actually CARRY a lane — one with an
 * `emittedFp`, an addressable client identity the client can swap in
 * place. A matched parton without one (a selector-less spec: a layout
 * wrapper, or a cell-bound child like a cart line) has no client slot,
 * so its own lane would render but commit to nothing; the update must
 * ride its nearest addressable ancestor's lane instead — whose render
 * re-renders the subtree containing it, exactly as a whole-tree segment
 * does on the non-lane path. `parentPath` is root-first ending at the
 * immediate parent, so the nearest ancestor is at the tail. Returns
 * `null` when neither the id nor any ancestor is addressable (nothing
 * can carry the update — the caller drops it).
 */
function laneCarrierFor(
	id: string,
	snapshots: ReadonlyMap<string, PartialSnapshot>,
): string | null {
	const snap = snapshots.get(id);
	if (!snap) return null;
	if (snap.emittedFp) return id;
	for (let i = snap.parentPath.length - 1; i >= 0; i--) {
		const ancestorId = snap.parentPath[i];
		if (ancestorId === id) continue;
		if (snapshots.get(ancestorId)?.emittedFp) return ancestorId;
	}
	return null;
}

/** Map matched ids to their lane carriers (`laneCarrierFor`), dropping
 *  the uncarriable and deduping — several non-addressable children of
 *  one addressable ancestor collapse to a single ancestor lane, so its
 *  one render re-renders them all. First-occurrence order is preserved
 *  (delivery order for the driver's lane pass). */
function escalateToLaneCarriers(
	matched: Iterable<string>,
	snapshots: ReadonlyMap<string, PartialSnapshot>,
): string[] {
	const carriers: string[] = [];
	const seen = new Set<string>();
	for (const id of matched) {
		const carrier = laneCarrierFor(id, snapshots);
		if (carrier === null || seen.has(carrier)) continue;
		seen.add(carrier);
		carriers.push(carrier);
	}
	return carriers;
}

/**
 * The ids whose snapshots any of `selectors` would touch — the same
 * label + constraint-subset predicate as `_routeMatchingBumpIds`, but
 * against PENDING (un-flushed) selectors instead of registry entries.
 * The action-consequence reservation runs this inside the action's
 * invalidation transaction, before the commit wakes any driver.
 */
export function _routeMatchingSelectorIds(
	snapshots: ReadonlyMap<string, PartialSnapshot>,
	selectors: readonly ParsedSelector[],
): string[] {
	if (selectors.length === 0) return [];
	const ids: string[] = [];
	for (const [id, snap] of snapshots) {
		const surface = constraintSurface(snap);
		const hit = selectors.some(
			(s) =>
				snap.labels.includes(s.name) &&
				_selectorMatchesSurface(s.constraints, surface),
		);
		if (hit) ids.push(id);
	}
	return escalateToLaneCarriers(ids, snapshots);
}

/**
 * The ids whose snapshots READ one of the changed cookies — snapshots
 * whose tracked-read `deps` include `cookie:<name>` for any `name` in
 * `changed`. The per-parton driver lanes exactly these when a `cookie`
 * frame updates the connection's cookie overlay, so a client cookie
 * change re-renders only the `cookie()` readers (their fp folds the
 * overlay through `parseCookies`), never the whole route.
 *
 * Cookie deps are TRACKED READS, not labels, so they never ride the
 * registry-bump path (`_routeMatchingBumpIds` matches `snap.labels`).
 * That is deliberate: a cookie change is PER-CONNECTION (this client's
 * jar), so it wakes only its own session's driver via the flip-wake arm
 * — never a process-global `refreshSelector` that would spuriously wake
 * every peer connection.
 */
export function _routeMatchingCookieIds(
	snapshots: ReadonlyMap<string, PartialSnapshot>,
	changed: ReadonlySet<string>,
): string[] {
	if (changed.size === 0) return [];
	const ids: string[] = [];
	for (const [id, snap] of snapshots) {
		const deps = snap.deps;
		if (!deps) continue;
		for (const name of changed) {
			if (deps.has(`cookie:${name}`)) {
				ids.push(id);
				break;
			}
		}
	}
	return ids;
}

function constraintSurface(snap: PartialSnapshot): Record<string, unknown> {
	let varyInputs: Record<string, unknown> | null = null;
	if (snap.varyKey) {
		try {
			varyInputs = JSON.parse(snap.varyKey) as Record<string, unknown>;
		} catch {
			varyInputs = null;
		}
	}
	return {
		...(varyInputs ?? {}),
		...(snap.constraintArgs ?? {}),
	};
}

function snapshotHasMatchingBump(
	snap: PartialSnapshot,
	sinceTs: number,
): boolean {
	return queryMatchingTs(snap.labels, constraintSurface(snap)) > sinceTs;
}
