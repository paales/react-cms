/**
 * The live connection's cached-override sets stay bounded. The segment
 * driver promotes every emitted (fp, matchKey) into the request-scoped
 * override so later renders fp-skip against them — and on a long-held
 * connection a parton whose fp drifts every lane (each bump folds a new
 * invalidation ts) would otherwise grow its per-id sets without limit.
 * Both promotion paths (`promoteSnapshotsToCachedOverride` at segment
 * and lane boundaries, `promoteFpUpdatesToCachedOverride` from lane
 * trailers) share one eviction discipline: oldest-first, capped — the
 * server-side mirror of the client's `FP_CAP_PER_VARIANT`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import { _getCachedOverride } from "../../runtime/context.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { cap: 0 }

const CapLane = parton(
  function CapLaneRender() {
    renders.cap++
    return <div data-cap-render={renders.cap}>{`cap-${renders.cap}`}</div>
  },
  { selector: "cap-lane" },
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.cap = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("live segment driver — cached-override bounds", () => {
  it("per-id fp/matchKey sets stay capped over many lane renders", async () => {
    await withLiveDrive(
      "http://localhost/cap?live=1",
      () => (
        <PartialRoot>
          <CapLane />
        </PartialRoot>
      ),
      freshLiveScope("cap-rsc"),
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        expect(renders.cap).toBe(1)

        // The override carrier is installed by PartialRoot during the
        // initial segment and shared with the driver for the whole
        // connection — the sets asserted on below are the live ones.
        const override = _getCachedOverride()
        expect(override).not.toBeNull()

        refreshSelector("cap-lane")
        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()

        // 12 successive bumps → 12 lane renders, each with a distinct
        // fp (every bump folds a fresh invalidation ts). Each drain
        // promotes the new fp into the override.
        for (let i = 0; i < 12; i++) {
          if (i > 0) refreshSelector("cap-lane")
          const lane = (await laneIter.next()).value as DemuxedLane
          expect(lane.partonId).toBe("cap-lane")
          await decodeLane(lane)
        }
        expect(renders.cap).toBe(13)

        const fps = override?.fingerprints.get("cap-lane")
        expect(fps).toBeDefined()
        // Every render produced a distinct fp; without the cap the set
        // holds all 13 of them.
        expect(fps?.size ?? 0).toBeGreaterThan(0)
        expect(fps?.size ?? 0).toBeLessThanOrEqual(8)
        expect(override?.matchKeys.get("cap-lane")?.size ?? 0).toBeLessThanOrEqual(8)

        await h.shutdown("cap-lane")
      },
    )
  })
})
