/**
 * Predictive warm projection — the app-registered half of the segment
 * driver's warm pass ([[segmented-response]]).
 *
 * The framework owns the MECHANISM: when a live connection's driver is
 * about to park and its session holds a telemetry statement it has not
 * yet projected, it hands the statement plus the route's PARKED
 * cullable partons to the registered projector, then renders the
 * returned ids into the server byte-cache ([[cache]]) without emitting
 * a byte. The app owns the GEOMETRY: only it knows how a scroll vector
 * maps onto its partons' coordinates, so the projection — horizon,
 * velocity threshold, coordinate math — lives in the app's projector,
 * with the telemetry's own timebase (`at`, `receivedAt`) as its
 * staleness judge (return `[]` for a statement not worth projecting).
 *
 * One projector per process (last registration wins — a module-scope
 * call, re-run naturally under HMR). No projector registered means the
 * warm pass costs nothing.
 */

import type { SessionTelemetry } from "./connection-session.ts"

/** One parked cullable parton the projector may choose to warm. */
export interface WarmCandidate {
  /** The parton's instance id — what the projector returns. */
  readonly id: string
  /** The spec catalog id (`WorldChunkRender` → `"world-chunk"`) —
   *  how a projector picks its kind out of a mixed route. */
  readonly type?: string
  /** The placement's call-site props as recorded on the snapshot —
   *  where coordinate-shaped identity lives. */
  readonly props?: Readonly<Record<string, unknown>>
}

/** Map a telemetry statement onto the parked partons the viewport is
 *  projected to reach — ids in priority order (the driver truncates at
 *  its per-park cap). Pure and synchronous; runs inside the driver. */
export type WarmProjector = (
  telemetry: SessionTelemetry,
  candidates: readonly WarmCandidate[],
) => readonly string[]

let projector: WarmProjector | null = null

/** Register the process's warm projector (or `null` to remove it). */
export function registerWarmProjector(p: WarmProjector | null): void {
  projector = p
}

/** The registered projector — the driver's read side. */
export function _getWarmProjector(): WarmProjector | null {
  return projector
}
