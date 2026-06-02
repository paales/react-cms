"use server"

/**
 * Cursor move — the up-channel for the /cursors multiplayer demo.
 *
 * Every viewer calls this on pointer-move with its per-tab id. It reads
 * the current cursor map, drops entries that have gone stale (tabs that
 * closed or stopped moving), merges in the caller's position, and writes
 * the result back.
 *
 * `cursorsCell` is `deferred`, so this action's response carries no
 * re-render: the new map reaches every other viewer over their open
 * heartbeat stream, not on this POST. The write is fire-up; the
 * propagation is stream-down.
 *
 * The read-merge-write is last-write-wins across concurrent movers — two
 * cursors moving in the exact same tick can drop one entry for a frame,
 * which the next move restores. Fine for ephemeral presence; a
 * conflict-free merge would matter only if these were durable values.
 */

import { cursorsCell, type Cursor, type CursorMap } from "./cursors-state.ts"

/** Cursors older than this (no move within the window) are evicted. */
const STALE_MS = 10_000

export async function moveCursor(
  uid: string,
  x: number,
  y: number,
  color: string,
): Promise<void> {
  const now = Date.now()
  const current = (cursorsCell.peek() as CursorMap | null) ?? {}
  const next: CursorMap = { [uid]: { x, y, color, ts: now } }
  for (const [id, cursor] of Object.entries(current)) {
    if (id === uid) continue
    if (now - (cursor as Cursor).ts < STALE_MS) next[id] = cursor as Cursor
  }
  await cursorsCell.set(next)
}
