/**
 * Per-scope server state for the /streaming-demo page.
 *
 * `bumps` — client-mutable counter. The Bump button calls
 * `bumps.set(bumps.value + 1)` through the framework's
 * Flight-serialized server-action ref; the parton's `schema`
 * reads it back on the next render.
 *
 * There's no `tick` cell — the live tick demo reads time directly
 * from `vary`'s scope and declares `expiresAt: time.nextSecond` so
 * the segment driver wakes on each second boundary. See
 * `streaming-demo.tsx`'s `LiveTick`.
 */

import { cell } from "@parton/framework"

export const bumps = cell.number({
  id: "demo.bumps",
  vary: () => ({}),
  initial: 0,
})
