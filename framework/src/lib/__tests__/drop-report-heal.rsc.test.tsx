/**
 * F6 — the drop-report vs covering-render race
 * (docs/notes/convergence-fuzzing.md, findings ledger). Two members,
 * one discipline: a delivery's evidence must describe what the CLIENT
 * actually holds, and the moment the render actually read.
 *
 *   1. The as-of drop member. A lane promoted into the optimistic
 *      mirror at drain can be DROPPED by the client's as-of guard (a
 *      navigation/refetch statement advanced its navigation point
 *      while the lane was in flight). The covering segment renders
 *      synchronously AT the consume — before the drop report can
 *      possibly arrive — so its verdict phantom-confirms the dropped
 *      content, and its own drain promote re-claims the fp AFTER the
 *      report's revocation runs. The fix under test: the `dropped`
 *      report revokes every credit (`revokeDroppedDelivery`) AND
 *      queues the delivery's ids for a FORCED heal lane
 *      (`pendingDropHeals`) — fp-skip yields, fresh bytes ship within
 *      one delivery, and the purged covering record never folds the
 *      phantom into the acked layer.
 *
 *   2. The flush-alias member. A `visible` statement landing between
 *      a lane's row render and its stream flush must not retag the
 *      emitted fp with a state the row does not carry (an out-flip
 *      ships no covering lane, so the aliased heal would stand as the
 *      connection's last word and mis-tag the client's holding
 *      forever). The fix under test: the lane iteration pins its
 *      visibility moment (`_createConnectionLiveProbe`'s pin /
 *      `_runWithPinnedVisible`), so render, verdict, flush recompute,
 *      and drain promote all describe one set.
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
import { CHANNEL_ENDPOINT } from "../channel-protocol.ts"
import { _peekConnectionSession, handleChannelPost } from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

const renders = { healA: 0, healB: 0, alias: 0 }

const HealA = parton(
  function HealARender(_: RenderArgs) {
    renders.healA++
    return <div data-heal-a>{`heal-a:${renders.healA}`}</div>
  },
  { selector: "heal-a" },
)

const HealB = parton(
  function HealBRender(_: RenderArgs) {
    renders.healB++
    return <div data-heal-b>{`heal-b:${renders.healB}`}</div>
  },
  { selector: "heal-b" },
)

const DropPage = (): ReactNode => (
  <PartialRoot>
    <HealA />
    <HealB />
  </PartialRoot>
)

/** The alias fixture's render parks here while non-null — holds its
 *  flip-in lane open across the test's out-flip statement. */
let gate: Promise<void> | null = null
let openGate: (() => void) | null = null

const AliasCull = parton(
  async function AliasCullRender(_: RenderArgs) {
    renders.alias++
    if (gate) await gate
    return <div data-alias>{`alias:${renders.alias}`}</div>
  },
  { selector: "alias-cull", cull: { skeleton: SkelBox } },
)

const AliasPage = (): ReactNode => (
  <PartialRoot>
    <AliasCull />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.healA = 0
  renders.healB = 0
  renders.alias = 0
  gate = null
  openGate = null
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

async function post(scope: string, envelope: unknown): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-scope": scope },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Every `partialFingerprint` value in a Flight body text (dev debug
 *  rows duplicate the emission's value — collecting all is exact for
 *  a single-parton lane body). */
function emittedFps(body: string): string[] {
  return [...body.matchAll(/"partialFingerprint":"([^"]+)"/g)].map((m) => m[1])
}

function emittedMatchKey(body: string): string {
  const m = body.match(/"partialMatchKey":"([^"]+)"/)
  if (!m) throw new Error("no partialMatchKey in body")
  return m[1]
}

describe("F6 — a dropped delivery heals within one delivery", () => {
  it("drop report after the covering promote → forced heal lane, no phantom in the acked layer", async () => {
    const scope = freshLiveScope("drop-heal")
    await withLiveDrive("http://localhost/drop?live=1", DropPage, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const session = _peekConnectionSession(conn)
      expect(renders.healA).toBe(1)

      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      // The client committed segment 0 (delivery 1).
      expect(
        await post(scope, { connection: conn, seq: 1, frames: [{ kind: "ack", delivered: 1 }] }),
      ).toBe(204)

      // A bump lanes heal-a (delivery 2) — promoted into the
      // optimistic mirror at drain. The client will NOT commit it.
      refreshSelector("heal-a")
      const lane2 = await nextLane(laneIter)
      expect(lane2.partonId).toBe("heal-a")
      const lane2Decoded = await decodeLane(lane2)
      expect(lane2Decoded.bodyText).toContain("heal-a:2")
      const droppedFps = new Set(emittedFps(lane2Decoded.bodyText))
      for (const { to } of Object.values(lane2Decoded.fp ?? {})) droppedFps.add(to)

      // The refetch statement — the client's navigation point moves
      // (envelope seq 2), making delivery 2 droppable by its as-of
      // guard. The covering segment renders synchronously at the
      // consume; no drop report can precede it.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "url", url: "/drop?__force=heal-b", intent: "silent" }],
        }),
      ).toBe(204)
      // The old lanes region ends cleanly.
      while (!(await laneIter.next()).done) {
        /* drain the region out */
      }

      // The covering segment (delivery 3): heal-a fp-skips against the
      // dropped lane's promotion — the PHANTOM CONFIRM (the placeholder
      // ships, the body never re-runs). This is the race's precondition,
      // asserted so the heal below is proven to fire against it.
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the covering payload segment")
      const navBody = await drainPayloadSegment(navSeg.value)
      expect(navBody).toContain('"data-partial-id":"heal-a"')
      expect(navBody).not.toContain("heal-a:3")
      expect(renders.healA).toBe(2)

      // The forced target lanes on the reopened region (delivery 4).
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
      const laneIter2 = reopened.value.lanes[Symbol.asyncIterator]()
      const laneB = await nextLane(laneIter2)
      expect(laneB.partonId).toBe("heal-b")
      expect((await decodeLane(laneB)).bodyText).toContain("heal-b:2")

      // The client's ack: it committed deliveries 3 and 4, but DROPPED
      // delivery 2 (its as-of predates the navigation point). The
      // report arrives AFTER the covering segment's drain promote
      // re-claimed heal-a's fp.
      expect(
        await post(scope, {
          connection: conn,
          seq: 3,
          frames: [{ kind: "ack", delivered: 4, dropped: [2] }],
        }),
      ).toBe(204)

      // The heal: one FORCED lane re-ships heal-a fresh — fp-skip
      // yields, so the covering promote's re-claim cannot re-confirm.
      const healLane = await nextLane(laneIter2)
      expect(healLane.partonId).toBe("heal-a")
      expect((await decodeLane(healLane)).bodyText).toContain("heal-a:3")
      expect(renders.healA).toBe(3)

      // The acked layer holds NO fp of the dropped delivery: the
      // revocation purged the covering record's derivative claim
      // before its fold (the client committed a zero-byte placeholder,
      // never the content).
      const acked = session?.ackedFps.get("heal-a") ?? new Set<string>()
      for (const fp of droppedFps) {
        expect(acked.has(fp)).toBe(false)
      }

      await h.shutdown("heal-a")
    })
  }, 15_000)
})

describe("F6 — the flush describes the render, not the flush moment", () => {
  it("an out-flip landing mid-lane does not retag the in-state body; the client's holding confirms on re-entry", async () => {
    const scope = freshLiveScope("flush-alias")
    await withLiveDrive(
      "http://localhost/alias?live=1",
      AliasPage,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        // Measured out at attach — the body never ran.
        expect(renders.alias).toBe(0)

        const lanesSeg = await h.segments.next()
        if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")
        const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()
        expect(
          await post(scope, { connection: conn, seq: 1, frames: [{ kind: "ack", delivered: 1 }] }),
        ).toBe(204)

        // Flip IN — the lane renders the body, parked on the gate.
        gate = new Promise<void>((r) => {
          openGate = r
        })
        expect(
          await post(scope, {
            connection: conn,
            seq: 2,
            frames: [{ kind: "visible", changed: ["alias-cull"], visible: ["alias-cull"] }],
          }),
        ).toBe(204)
        await until(() => renders.alias === 1, "the flip-in lane's render to start")

        // The out-flip lands while the lane's render is suspended —
        // BETWEEN the row's render and the stream's flush. Without the
        // pinned visibility moment, the flush recompute would read the
        // OUT set and retag the in-state body with the out-state fp.
        expect(
          await post(scope, {
            connection: conn,
            seq: 3,
            frames: [{ kind: "visible", changed: ["alias-cull"], visible: [] }],
          }),
        ).toBe(204)

        // Release the render; the lane drains and its trailer heals
        // apply to the client's slot — the model of the client's
        // holding after this commit.
        gate = null
        openGate?.()
        const lane = await nextLane(laneIter)
        expect(lane.partonId).toBe("alias-cull")
        const decoded = await decodeLane(lane)
        expect(decoded.bodyText).toContain("alias:1")
        const mk = emittedMatchKey(decoded.bodyText)
        let heldFp = emittedFps(decoded.bodyText)[0]
        const heal = decoded.fp?.["alias-cull"]
        if (heal && heal.from === heldFp) heldFp = heal.to

        // Flip back IN, stating the client's ACTUAL holding. The
        // covering lane must CONFIRM — the retained copy is current
        // and correctly tagged. An aliased heal would have mis-tagged
        // it with the out-state fp, and this lane would re-render.
        expect(
          await post(scope, {
            connection: conn,
            seq: 4,
            frames: [
              {
                kind: "visible",
                changed: ["alias-cull"],
                visible: ["alias-cull"],
                cached: [`alias-cull:${mk}:${heldFp}`],
              },
            ],
          }),
        ).toBe(204)
        const confirmLane = await nextLane(laneIter)
        expect(confirmLane.partonId).toBe("alias-cull")
        const confirmBody = (await decodeLane(confirmLane)).bodyText
        expect(confirmBody).toContain("data-partial-confirm")
        expect(renders.alias).toBe(1)

        await h.shutdown("alias-cull")
      },
      { attach: { cached: [], since: null, visible: [] } },
    )
  }, 15_000)
})
