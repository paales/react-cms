/**
 * Telemetry — the channel's LOSSY producer ([[channel-protocol]]'s
 * `telemetry` frame; design: docs/notes/channel-design.md § Wire
 * shape). The app-facing surface is one function: `reportTelemetry`
 * states the client's current scroll context (viewport box, scroll
 * position, velocity), and the module owns everything between that
 * statement and the wire.
 *
 * Lossy-class semantics, enforced here:
 *
 *   - **Newest-wins, no queue.** At most ONE frame is ever pending; a
 *     new report overwrites the old (an old scroll vector describes a
 *     viewport that no longer exists — sending it would state a
 *     falsehood). One frame per flush, never a backlog.
 *   - **Never sent alone at its own cadence.** `reportTelemetry` does
 *     NOT schedule a flush and this module adds no timers: the frame
 *     rides the next envelope some other statement justifies (a
 *     visibility flip, a delivery ack — during any scroll that could
 *     reach parked content, flips fire constantly, so telemetry flows
 *     exactly when it is useful). Scroll-cadence reports coalesce to
 *     the transport's existing rAF flush for free.
 *   - **Droppable.** A failed envelope drops the frame
 *     (`deliveryFailed` re-queues nothing); `collect(null)` — no
 *     connection — drops it too: telemetry has no discrete fallback
 *     because it is context, not a dependency, and re-presenting stale
 *     context later is worse than presenting none.
 *   - **Never reliable.** The producer declares no `reliable` flag, so
 *     frames never enter the transport's retransmit buffer.
 *
 * `"use client"` consumers import this module by deep path
 * (`@parton/framework/lib/telemetry.ts`) per the barrel caveat.
 */

import { type ChannelProducer, registerChannelProducer } from "./channel-client.ts"
import type { ChannelFrame, TelemetryFrame } from "./channel-protocol.ts"

/** The statement `reportTelemetry` takes — the frame's content minus
 *  the clock, which is stamped here (`performance.now()`) unless the
 *  caller measured its own. */
export interface TelemetryInput {
  viewport: { w: number; h: number }
  scroll: { x: number; y: number; vx: number; vy: number }
  /** Performance-clock ms of the measurement; defaults to now. */
  at?: number
}

/** The single pending frame — newest-wins, consumed per flush. */
let pending: TelemetryFrame | null = null

/**
 * State the client's current scroll context. Overwrites any unsent
 * statement (newest-wins) and schedules NOTHING: the frame rides the
 * next envelope another statement justifies. Safe to call at scroll
 * cadence — the cost is one field write.
 */
export function reportTelemetry(input: TelemetryInput): void {
  pending = {
    kind: "telemetry",
    viewport: { w: input.viewport.w, h: input.viewport.h },
    scroll: {
      x: input.scroll.x,
      y: input.scroll.y,
      vx: input.scroll.vx,
      vy: input.scroll.vy,
    },
    at: input.at ?? (typeof performance !== "undefined" ? performance.now() : Date.now()),
  }
}

/** The producer object — exported so tests can re-register it after
 *  `_resetChannelClient` (which clears the producer set). */
export const _telemetryProducer: ChannelProducer = {
  collect(connection: string | null): ChannelFrame | null {
    if (connection === null) {
      // No connection: drop, don't hold. Context re-measures itself —
      // the next scroll event states a fresh frame — and a held frame
      // would only ever be sent stale.
      pending = null
      return null
    }
    const frame = pending
    pending = null
    return frame
  },
  deliveryFailed(): void {
    // Dropped. Lossy class: the statement is already superseded by
    // whatever the viewport is doing now; no re-queue, no fallback.
  },
}

registerChannelProducer(_telemetryProducer)

/** Test-only: clear the pending statement. */
export function _resetTelemetry(): void {
  pending = null
}
