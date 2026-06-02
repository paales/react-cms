/**
 * Shared state for the /cursors multiplayer demo.
 *
 * One global, `deferred` cell holds every viewer's cursor keyed by a
 * per-tab id: `{ [uid]: { x, y, color, ts } }`. Each viewer merges its
 * own entry on pointer-move (see `cursors-actions.ts::moveCursor`);
 * because the cell is `deferred`, those writes carry no re-render on the
 * POST — every other viewer picks up the new map over its open heartbeat
 * stream. localCell storage is process-global, so the map is shared
 * across connections (a Redis/etc. backend swaps in later without
 * touching this surface).
 */

import { localCell } from "@parton/framework"

export interface Cursor {
  x: number
  y: number
  color: string
  /** Epoch ms of the last move — used to evict cursors from tabs that
   *  closed or went idle so the map (and the rendered dots) don't grow
   *  unbounded. */
  ts: number
}

export type CursorMap = Record<string, Cursor>

export const cursorsCell = localCell({
  id: "cursors",
  shape: "opaque",
  vary: () => ({}),
  initial: {} as CursorMap,
  deferred: true,
})
