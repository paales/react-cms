/**
 * Wake-arm release — a parked live connection's wake cycle must not
 * accumulate registrations on long-lived state. Each park in
 * `waitForSegmentWake` arms several signals (bump, keepalive, expiry,
 * lane-drained, visibility); a promise reaction only frees when its
 * promise settles, and the registry's bump waiter set is shared by
 * every connection — so an arm that outlives its park grows the heap
 * linearly in wake count on a pure-idle connection (zero renders,
 * zero bytes shipped). The probe reads the registry's own waiter set:
 * after N expiry-driven wakes, it holds at most the currently-parked
 * wait's single registration.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _bumpWaiterCount,
  _clearInvalidationRegistry,
} from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { expires, time } from "../server-hooks.ts"

const renders = { clock: 0 }

// Ticking parton: each 40ms expiry boundary is one wake with no bump
// involved — the pure time-driven idle path.
const LeakClock = parton(
  function LeakClockRender(_: RenderArgs) {
    renders.clock++
    expires(time().in(40))
    return <time data-leak-clock>{`tick-${renders.clock}`}</time>
  },
  { selector: "leak-clock" },
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.clock = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("live segment driver — wake-arm release", () => {
  it("expiry-driven wakes release their bump-arm registrations", async () => {
    await withLiveDrive(
      "http://localhost/leak?live=1",
      () => (
        <PartialRoot>
          <LeakClock />
        </PartialRoot>
      ),
      freshLiveScope("leak-rsc"),
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        expect(renders.clock).toBe(1)

        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()

        // Six expiry ticks: each is an expiry wake, and each drained
        // lane adds a lane-drained wake — every one of them parked and
        // re-armed the wait at least once.
        for (let i = 0; i < 6; i++) {
          const lane = (await laneIter.next()).value as DemuxedLane
          expect(lane.partonId).toBe("leak-clock")
          await decodeLane(lane)
        }
        expect(renders.clock).toBeGreaterThanOrEqual(7)

        // Every exited wait released its bump registration; only the
        // currently-parked wait may hold one. Without release the set
        // grows one closure per wake — each retaining its whole wake
        // race — for as long as no bump lands anywhere in the process.
        expect(_bumpWaiterCount()).toBeLessThanOrEqual(2)

        await h.shutdown("leak-clock")
      },
    )
  })
})
