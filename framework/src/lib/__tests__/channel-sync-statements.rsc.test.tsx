/**
 * SYNC url statements + torn-lane seq voids, against a real drive.
 * The claims:
 *
 *   1. a `sync: true` url frame (a scroller's bookmark mirror —
 *      the client's `record: false` class) applies LIGHTLY: request
 *      state moves (later lanes render against the new URL and stamp
 *      the statement's seq as their as-of), the open lanes region is
 *      NEVER torn, and no whole-tree navigation segment is emitted;
 *   2. a sync frame arriving while a NON-SYNC statement's coverage is
 *      owed folds its URL in without downgrading the statement:
 *      exactly one covering navigation segment lands, rendered
 *      against the sync frame's URL, as-of the sync frame's seq;
 *   3. a sync frame that CHANGES the route takes the full path — a
 *      covering navigation segment for the new route;
 *   4. a nav tear over an EARLY-ANNOUNCED forced lane voids the
 *      announced seq (`seqvoid` on the stream) — the client's
 *      contiguous ack watermark can pass it, so a torn streaming
 *      force can never wedge the delivery window (the measured
 *      skeletons-at-rest state).
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  freshLiveScope,
  withLiveDrive,
  drainPayloadSegment,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { _peekConnectionSession, handleChannelPost } from "../connection-session.ts"
import { tag } from "../current-parton.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"

const renders = { a: 0, b: 0, shared: 0, slow: 0 }

// The wedge fixture's stall — fast on the boot render (so its snapshot
// registers), gated when `slowMode` is armed (the forced lane's body).
// `nextSlowStart()` hands back a promise resolving when the NEXT gated
// render ENTERS the body — the announce entry is enqueued in the same
// pump iteration, synchronously before the render, so awaiting the
// start is the timer-free way to know the seq is on the wire.
let slowMode = false
let releaseSlow: () => void = () => {}
let slowGate: Promise<void> = Promise.resolve()
const slowStartWaiters: Array<() => void> = []
function nextSlowStart(): Promise<void> {
  return new Promise<void>((resolve) => {
    slowStartWaiters.push(resolve)
  })
}
function armSlowGate(): void {
  slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
}

const SyncShared = parton(function SyncSharedRender(_: RenderArgs) {
  tag("sync-shared")
  renders.shared++
  const page = searchParam("page") ?? "-"
  return <div data-shared>{`shared:page=${page}:${renders.shared}`}</div>
})
const SyncSlow = parton(
  async function SyncSlowRender(_: RenderArgs) {
    tag("sync-slow")
    renders.slow++
    // The stall must live in the forced LANE only. A forced target
    // re-renders in the covering segment too (render #2 — the boot
    // was #1), so the gate arms from render #3: the forced lane's.
    if (slowMode && renders.slow >= 3) {
      slowStartWaiters.shift()?.()
      await slowGate
    }
    return <div data-slow>{`slow:${renders.slow}`}</div>
  },
  // Matched to /sync-a: the tear-navigation's target route must not
  // render the gated body (a cold route renders every body — a stall
  // there would be the segment's, not the lane's).
  { match: "/sync-a" },
)
const SyncA = parton(
  function SyncARender(_: RenderArgs) {
    renders.a++
    return <div data-a>{`route-a:${renders.a}`}</div>
  },
  { match: "/sync-a" },
)
const SyncB = parton(
  function SyncBRender(_: RenderArgs) {
    renders.b++
    return <div data-b>{`route-b:${renders.b}`}</div>
  },
  { match: "/sync-b" },
)

const Page = (): ReactNode => (
  <PartialRoot>
    <SyncShared />
    <SyncSlow />
    <SyncA />
    <SyncB />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.a = 0
  renders.b = 0
  renders.shared = 0
  renders.slow = 0
  slowMode = false
  slowStartWaiters.length = 0
  armSlowGate()
})

afterEach(() => {
  releaseSlow()
  clearRegistry("all")
  _clearInvalidationRegistry()
})

async function post(scope: string | undefined, envelope: ChannelEnvelope): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (scope !== undefined) headers["x-test-scope"] = scope
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers,
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

describe("sync url statements", () => {
  it("applies lightly: request state moves, the lanes region survives, no segment is emitted", async () => {
    const scope = freshLiveScope("sync-light")
    await withLiveDrive("http://localhost/sync-a?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload") throw new Error("expected payload 0")
      const seg0 = await drainPayloadSegment(first.value)
      expect(seg0).toContain("route-a:1")
      expect(seg0).toContain("shared:page=-:1")
      const conn = h.connectionId() ?? ""

      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      // The sync statement: same route, ?page=2 mirrored in.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "url", url: "/sync-a?page=2", intent: "silent", sync: true }],
        }),
      ).toBe(204)

      // Request state follows without a consume cycle: a lane wake on
      // the SAME open region renders against the mirrored URL and
      // stamps the statement's seq as its as-of. The region was never
      // torn — the iterator yields, it is not done.
      refreshSelector("sync-shared")
      const lane = await nextLane(laneIter)
      expect(lane.partonId).toBe("sync-shared")
      const { bodyText } = await decodeLane(lane)
      expect(bodyText).toContain("shared:page=2:2")
      expect(_peekConnectionSession(conn)?.consumedNavSeq).toBe(2)
      const laneSeqs = h.entries.filter((e) => e.tag === "seq" && e.body.includes("\n"))
      expect(laneSeqs.at(-1)?.body).toBe("sync-shared\n2 2")

      // No whole-tree render ran for the mirror: the route parton
      // rendered exactly once (the boot segment).
      expect(renders.a).toBe(1)
    })
  })

  it("folds into an owed non-sync statement: one covering segment, the sync URL, the sync seq", async () => {
    const scope = freshLiveScope("sync-fold")
    await withLiveDrive("http://localhost/sync-a?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload") throw new Error("expected payload 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")

      // A real navigation with a mirror on its heels — ONE envelope,
      // frames in order: the mirror's URL is the newest truth, the
      // navigation's coverage is owed, so the mirror folds in without
      // downgrading the recorded intent.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [
            { kind: "url", url: "/sync-b", intent: "push" },
            { kind: "url", url: "/sync-b?page=9", intent: "silent", sync: true },
          ],
        }),
      ).toBe(204)

      // Exactly one covering segment lands: the new route, rendered
      // against the MERGED URL (the shared parton reads the mirrored
      // param), as-of the statement's seq.
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the covering segment")
      const navBody = await drainPayloadSegment(navSeg.value)
      expect(navBody).toContain("route-b:1")
      expect(navBody).toContain("shared:page=9:2")
      const segSeqs = h.entries.filter((e) => e.tag === "seq" && !e.body.includes("\n"))
      expect(segSeqs.at(-1)?.body).toBe("2 2")

      // The region reopens; no second payload segment follows.
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
    })
  })

  it("a route-changing sync statement takes the full path", async () => {
    const scope = freshLiveScope("sync-route")
    await withLiveDrive("http://localhost/sync-a?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload") throw new Error("expected payload 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")

      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "url", url: "/sync-b?x=1", intent: "silent", sync: true }],
        }),
      ).toBe(204)

      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected a covering segment for the route change")
      const navBody = await drainPayloadSegment(navSeg.value)
      expect(navBody).toContain("route-b:1")
    })
  })
})

describe("torn early-announced lanes", () => {
  it("a nav tear over a streaming forced lane voids its announced seq", async () => {
    const scope = freshLiveScope("sync-void")
    await withLiveDrive("http://localhost/sync-a?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload") throw new Error("expected payload 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("expected lanes")

      // Ack segment 0 — without it the nav consume prunes the
      // segment's unacked promotions and the covering render cannot
      // fp-skip the gated parton (it would stall the SEGMENT; the
      // wedge under test lives in the forced LANE).
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "ack", delivered: 1 }],
        }),
      ).toBe(204)

      // A streaming refetch statement forcing the slow parton: its
      // covering segment fp-skips the forced target, then the forced
      // lane announces its seq EARLY (the streaming-preferred class)
      // and stalls in the gated body.
      slowMode = true
      const laneStarted = nextSlowStart()
      expect(
        await post(scope, {
          connection: conn,
          seq: 3,
          frames: [
            { kind: "url", url: "/sync-a?__force=sync-slow", intent: "silent", streaming: true },
          ],
        }),
      ).toBe(204)
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the covering segment")
      await drainPayloadSegment(navSeg.value)
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened region")
      // The forced lane's body ENTERED (and stalled): its early
      // announcement is enqueued ahead of it on the wire.
      await laneStarted

      // A navigation tears the region over the STILL-STALLED body
      // (the gate stays held — a released body would drain cleanly and
      // need no void). The target route unmatches the slow parton, so
      // its unfulfilled force legitimately drops there. Draining the
      // traverse's covering segment forces the splitter past every
      // earlier wire entry, so the announce is observable without
      // polling.
      expect(
        await post(scope, {
          connection: conn,
          seq: 4,
          frames: [{ kind: "url", url: "/sync-b", intent: "push" }],
        }),
      ).toBe(204)
      const navSeg2 = await h.segments.next()
      if (navSeg2.done || navSeg2.value.kind !== "payload")
        throw new Error("expected the traverse's covering segment")
      await drainPayloadSegment(navSeg2.value)
      const announceEntry = h.entries.find(
        (e) => e.tag === "seq" && e.body.startsWith("sync-slow\n"),
      )
      expect(announceEntry, "the forced lane announced before stalling").toBeDefined()
      const announced = Number(announceEntry!.body.split("\n")[1]?.split(" ")[0])
      expect(Number.isFinite(announced)).toBe(true)

      // Drive the splitter across the void entry (enqueued right
      // after the traverse's consume, ahead of any later bytes) by
      // draining one more covering segment — a forced statement's, so
      // the flow is fully deterministic.
      const reopened2 = await h.segments.next()
      if (reopened2.done || reopened2.value.kind !== "lanes")
        throw new Error("expected the traverse's reopened region")
      expect(
        await post(scope, {
          connection: conn,
          seq: 5,
          frames: [{ kind: "url", url: "/sync-b?__force=sync-shared", intent: "silent" }],
        }),
      ).toBe(204)
      const navSeg3 = await h.segments.next()
      if (navSeg3.done || navSeg3.value.kind !== "payload")
        throw new Error("expected the force statement's covering segment")
      await drainPayloadSegment(navSeg3.value)

      // The announced seq was VOIDED on the stream — the client's
      // watermark passes it instead of wedging the delivery window.
      const voidEntries = h.entries.filter((e) => e.tag === "seqvoid")
      expect(
        voidEntries.some((e) => e.body.split(" ").includes(String(announced))),
        `voids: ${JSON.stringify(voidEntries)} announced: ${announced}`,
      ).toBe(true)

      // The gate stays held through the drive's life — the torn
      // render's continuation must not resume inside the request
      // scope (afterEach releases it once the drive is gone).
    })
  })
})
