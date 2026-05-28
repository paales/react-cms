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

import { queryMatchingTs } from "../runtime/invalidation-registry.ts"
import type { PartialSnapshot } from "./partial-registry.ts"

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
  for (const snap of snapshots.values()) {
    let varyInputs: Record<string, unknown> | null = null
    if (snap.varyKey) {
      try {
        varyInputs = JSON.parse(snap.varyKey) as Record<string, unknown>
      } catch {
        varyInputs = null
      }
    }
    const constraintSurface = { ...(varyInputs ?? {}), ...(snap.constraintArgs ?? {}) }
    if (queryMatchingTs(snap.labels, constraintSurface) > sinceTs) return true
  }
  return false
}
