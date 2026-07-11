/**
 * A flip-in dirties open ancestor lanes.
 *
 * An ancestor whose lane is OPEN when one of its descendants flips in
 * rendered against a visible set WITHOUT that id — its emission
 * carries the descendant as a culled pair, and under burst
 * backpressure those stale bytes can commit AFTER the descendant's
 * own flip lane materialized content, regressing the subtree
 * client-side. The flip drain therefore marks every open ancestor
 * lane dirty (the same coalescing a wake on an open lane uses):
 * pumpLane's dirty loop re-renders the ancestor once its current body
 * drains, against the session set that now holds the id, so the
 * connection's LAST word on the ancestor reflects the flip.
 *
 * The probe: a parent whose render parks on a test-controlled gate
 * (its lane stays open), a child flip consumed mid-render, and the
 * assertion that releasing the gate yields a SECOND parent lane body
 * — the dirty re-render — with the child served in-state inside it.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { handleChannelPost } from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

const renders = { parent: 0, child: 0 }

/** The parent's render parks here while non-null — holds its lane
 *  open across the test's flip statement. */
let gate: Promise<void> | null = null
let openGate: (() => void) | null = null

const DirtyChild = parton(
  function DirtyChildRender(_: RenderArgs) {
    renders.child++
    return <div data-child>{`child:full:${renders.child}`}</div>
  },
  { selector: "dirty-child", cull: { skeleton: SkelBox } },
)

const DirtyParent = parton(
  async function DirtyParentRender(_: RenderArgs) {
    renders.parent++
    if (gate) await gate
    return (
      <div data-parent>
        {`parent:full:${renders.parent}`}
        <DirtyChild />
      </div>
    )
  },
  { selector: "dirty-parent" },
)

const Page = (): ReactNode => (
  <PartialRoot>
    <DirtyParent />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.parent = 0
  renders.child = 0
  gate = null
  openGate = null
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

async function postVisible(
  scope: string,
  connection: string,
  seq: number,
  changed: string[],
  visible: string[],
): Promise<number> {
  const envelope: ChannelEnvelope = {
    connection,
    seq,
    frames: [{ kind: "visible", changed, visible }],
  }
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-scope": scope },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

describe("flip-in dirtying open ancestor lanes", () => {
  it("a child's in-flip re-renders the ancestor lane it landed under", async () => {
    const scope = freshLiveScope("flip-dirty")
    await withLiveDrive(
      "http://localhost/dirty?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg0 = await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        // The seed is an empty MEASUREMENT: the child is culled in the
        // whole-tree segment; the parent (non-cull) renders.
        expect(seg0).toContain("parent:full:1")
        expect(renders.child).toBe(0)

        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()

        // Open the parent's lane and park its render on the gate. The
        // lane's mux frame opens on the wire ahead of the parked body.
        gate = new Promise<void>((r) => {
          openGate = r
        })
        refreshSelector("dirty-parent")
        await until(() => renders.parent === 2, "the parent lane's render to start")
        const parentBody1 = await nextLane(laneIter)
        expect(parentBody1.partonId).toBe("dirty-parent")

        // The child flips IN while the parent's lane is open. The
        // drain lanes the child AND dirties the parent's open lane.
        expect(await postVisible(scope, conn, 1, ["dirty-child"], ["dirty-child"])).toBe(204)
        const childLane = await nextLane(laneIter)
        expect(childLane.partonId).toBe("dirty-child")
        expect((await decodeLane(childLane)).bodyText).toContain("child:full")

        // Release the parked render: its (now-stale-ordered) body
        // drains, and the dirty loop re-renders the parent against
        // the set that holds the child — the SECOND parent body.
        gate = null
        openGate?.()
        // Drain the parked iteration. (Its child emission is timing-
        // dependent here — a suspension-parked render resumes reading
        // the CURRENT set; the production hazard is byte backpressure,
        // where the body rendered wholly pre-flip. The mechanism under
        // test is the same either way.)
        await decodeLane(parentBody1)
        // WITHOUT the dirty mark the lane would close here (no wake
        // ever touched the parent) and this read would hang: the
        // dirty loop's SECOND body is the fix's observable. Its
        // emission is evaluated against the post-flip set — fresh
        // parent bytes serving the child in-state, or the zero-byte
        // confirmation when the trailer heal already covered the
        // fold drift (both truthful; never the culled pair again).
        const parentBody2 = await nextLane(laneIter)
        expect(parentBody2.partonId).toBe("dirty-parent")
        const body2 = (await decodeLane(parentBody2)).bodyText
        expect(body2).toContain('"data-partial-id":"dirty-parent"')
        expect(body2).not.toContain('"culled":true')

        await h.shutdown("dirty-parent")
      },
      { attach: { cached: [], since: null, visible: [] } },
    )
  }, 15_000)
})
