/**
 * Frame navigation, cancel, producer lanes, and action-consequence
 * seqs over the channel — against a real drive. The claims:
 *
 *   1. a FRAME url frame renders FRAME-SCOPED: the session frame URL
 *      moves (written at the endpoint), the frame's targets lane on
 *      the OPEN region (no whole-tree segment, no region tear), the
 *      covering lane carries the statement's seq as its `nav=` flag,
 *      and window partons never re-render — the same scoping the
 *      discrete `?partials=<frame[0]>` long-poll had;
 *   2. a retransmitted frame url (seq at or below the key's consumed
 *      seq) applies as a no-op;
 *   3. `cancel` supersedes an in-flight frame render: one envelope
 *      carrying cancel-then-url aborts the stalled lane (its body
 *      closes with a muxend, no delivery announced) and exactly one
 *      settled covering lane lands — the newest statement's;
 *   4. a PRODUCER lane (a lane render that calls
 *      `markConnectionLive()`) announces its delivery EARLY via the
 *      `muxlive` frame — while the producer await still stalls the
 *      body — and closes with `muxend` at producer resolve, with NO
 *      drain-time `seq` entry (the announcement was the delivery);
 *   5. an action's consequence reservation assigns the covering
 *      lane's delivery seq INSIDE the action's transaction; the lane
 *      emits with exactly that seq, and re-reserving an unconsumed id
 *      reuses it;
 *   6. a reservation whose lane a window navigation tears is VOIDED —
 *      the `seqvoid` entry ships so the client's watermark can pass.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { markConnectionLive, runWithRequestAsync } from "../../runtime/context.ts"
import {
  _clearInvalidationRegistry,
  refreshSelector,
  runInvalidationTransaction,
} from "../../runtime/invalidation-registry.ts"
import { _clearAllSessions, getSessionFrameUrl } from "../../runtime/session.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { _peekConnectionSession, handleChannelPost } from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { Frame } from "../frame.tsx"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { _reserveActionConsequences } from "../segmented-response.ts"
import { pathname } from "../server-hooks.ts"

const renders = { shared: 0, panel: 0, producer: 0 }

// Controllable stalls, re-armed per test.
let releaseSlow: () => void = () => {}
let slowGate: Promise<void> = Promise.resolve()
function armSlowGate(): void {
  slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
}
let releaseProducer: () => void = () => {}
let producerGate: Promise<void> = Promise.resolve()
function armProducerGate(): void {
  producerGate = new Promise<void>((resolve) => {
    releaseProducer = resolve
  })
}

const WindowShared = parton(
  function WindowSharedRender(_: RenderArgs) {
    renders.shared++
    return <div data-shared>{`shared:${renders.shared}`}</div>
  },
  { selector: "win-shared" },
)

// Frame-scoped parton. Its body follows the FRAME url: `/panel/slow`
// stalls (the cancel test's in-flight render), `/panel/stream` is a
// PRODUCER (marks live and awaits the producer gate — the chat's
// ChunkSlot shape), anything else renders synchronously.
const FramePanel = parton(
  async function FramePanelRender(_: RenderArgs) {
    renders.panel++
    const p = pathname()
    if (p === "/panel/slow") {
      await slowGate
      return <div data-panel>{`panel-slow:${renders.panel}`}</div>
    }
    if (p === "/panel/stream") {
      renders.producer++
      markConnectionLive()
      await producerGate
      return <div data-panel>{`panel-produced:${renders.producer}`}</div>
    }
    return <div data-panel>{`panel:${p}:${renders.panel}`}</div>
  },
  { selector: "frame-panel" },
)

const PageFramed = (): ReactNode => (
  <PartialRoot>
    <WindowShared />
    <Frame name="frame-panel" initialUrl="/panel/a">
      <FramePanel />
    </Frame>
  </PartialRoot>
)

// A window route pair for the reservation-void test.
const NavA = parton(
  function ConsANavRender(_: RenderArgs) {
    renders.shared++
    return <div data-a>consequence-a</div>
  },
  { match: "/cons-a", selector: "cons-a" },
)
// Test-only stall switch: the parton stalls only while the flag is
// up, so the void test can park ONE lane render on the gate and still
// let the subsequent whole-tree navigation segment render through.
let stallCons = false
const ConsSlow = parton(
  async function ConsSlowRender(_: RenderArgs) {
    if (stallCons) await slowGate
    return <div data-slow>cons-slow</div>
  },
  { match: "/cons-a", selector: "cons-slow" },
)
const PageCons = (): ReactNode => (
  <PartialRoot>
    <NavA />
    <ConsSlow />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.shared = 0
  renders.panel = 0
  renders.producer = 0
  stallCons = false
  armSlowGate()
  armProducerGate()
})

afterEach(() => {
  releaseSlow()
  releaseProducer()
  clearRegistry("all")
  _clearAllSessions()
  _clearInvalidationRegistry()
})

async function post(scope: string, envelope: ChannelEnvelope, cookie?: string): Promise<number> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-test-scope": scope,
  }
  if (cookie) headers.cookie = cookie
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

async function waitForEntry(
  entries: Array<{ tag: string; body: string }>,
  predicate: (e: { tag: string; body: string }) => boolean,
  what: string,
): Promise<{ tag: string; body: string }> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const hit = entries.find(predicate)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for wire entry: ${what}`)
}

describe("frame url frames lane frame-scoped", () => {
  it("moves the session frame URL and lanes the frame's targets on the open region", async () => {
    const scope = freshLiveScope("frame-basic")
    const sid = "sid-frame-basic"
    await withLiveDrive(
      "http://localhost/host?live=1",
      PageFramed,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg0 = await drainPayloadSegment(first.value)
        expect(seg0).toContain("panel:/panel/a:1")
        expect(seg0).toContain("shared:1")
        const conn = h.connectionId() ?? ""

        const lanesSeg = await h.segments.next()
        if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
          throw new Error("expected lanes segment")
        const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

        // The frame statement: the frame's URL is now /panel/b.
        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 2,
              frames: [
                {
                  kind: "url",
                  url: "/panel/b",
                  intent: "silent",
                  frame: ["frame-panel"],
                },
              ],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)

        // The covering lane arrives ON the open region — no region
        // tear, no whole-tree segment — rendered against the NEW
        // frame URL, explicit (the refetch contract).
        const lane = await nextLane(laneIter)
        expect(lane.partonId).toBe("frame-panel")
        expect((await decodeLane(lane)).bodyText).toContain("panel:/panel/b:2")
        // Window partons untouched — frame scoping held.
        expect(renders.shared).toBe(1)

        // The session store reflects the endpoint's write.
        await runWithRequestAsync(
          new Request("http://localhost/host", {
            headers: { "x-test-scope": scope, cookie: `__frame_sid=${sid}` },
          }),
          async () => {
            expect(getSessionFrameUrl(["frame-panel"])).toBe("/panel/b")
          },
        )

        // The covering lane's delivery carries the statement's seq as
        // its nav flag, rendered as-of the consumed statement.
        const seqEntry = await waitForEntry(
          h.entries,
          (e) => e.tag === "seq" && e.body.startsWith("frame-panel\n"),
          "frame lane seq entry",
        )
        expect(seqEntry.body).toBe("frame-panel\n2 2 nav=2")
        expect(_peekConnectionSession(conn)?.consumedFrameNavSeqs.get("frame-panel")).toBe(2)

        // Retransmit idempotence: the same statement again latches
        // nothing and drives no lane.
        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 2,
              frames: [
                {
                  kind: "url",
                  url: "/panel/b",
                  intent: "silent",
                  frame: ["frame-panel"],
                },
              ],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)
        expect(_peekConnectionSession(conn)?.pendingFrameNavs.size).toBe(0)
        expect(renders.panel).toBe(2)

        await h.shutdown("frame-panel")
      },
      { headers: { cookie: `__frame_sid=${sid}` } },
    )
  })

  it("a cancel-then-url envelope aborts the stalled frame render — one settled covering lane", async () => {
    const scope = freshLiveScope("frame-cancel")
    const sid = "sid-frame-cancel"
    await withLiveDrive(
      "http://localhost/host?live=1",
      PageFramed,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        const lanesSeg = await h.segments.next()
        if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
          throw new Error("expected lanes segment")
        const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

        // Navigate the frame to the stalling URL: the covering lane
        // opens and its render parks on the gate.
        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 3,
              frames: [
                {
                  kind: "url",
                  url: "/panel/slow",
                  intent: "silent",
                  frame: ["frame-panel"],
                },
              ],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)
        const stalled = await nextLane(laneIter)
        expect(stalled.partonId).toBe("frame-panel")

        // The superseding statement: cancel + url in ONE envelope,
        // cancel first (the in-order pass applies cancel-then-url).
        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 4,
              frames: [
                { kind: "cancel", scope: "frame-panel" },
                {
                  kind: "url",
                  url: "/panel/c",
                  intent: "silent",
                  frame: ["frame-panel"],
                },
              ],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)

        // The stalled body closes (muxend, no delivery) — its decode
        // settles without the gate ever releasing.
        const torn = await decodeLane(stalled)
        expect(torn.bodyText).not.toContain("panel-slow")
        expect(torn.fp).toBeNull()

        // Exactly one settled covering lane — the newest statement's.
        const covering = await nextLane(laneIter)
        expect(covering.partonId).toBe("frame-panel")
        expect((await decodeLane(covering)).bodyText).toContain("panel:/panel/c:")
        const navFlagged = h.entries.filter(
          (e) => (e.tag === "seq" || e.tag === "muxlive") && e.body.startsWith("frame-panel\n"),
        )
        expect(navFlagged).toHaveLength(1)
        expect(navFlagged[0].body).toMatch(/^frame-panel\n\d+ 4 nav=4$/)
        // A replayed cancel (same seq) is a no-op: the covering lane's
        // render was started by a NEWER statement and stands.
        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 4,
              frames: [{ kind: "cancel", scope: "frame-panel" }],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)
        expect(_peekConnectionSession(conn)?.cancelSeqByScope.get("frame-panel")).toBe(4)

        releaseSlow()
        await h.shutdown("frame-panel")
      },
      { headers: { cookie: `__frame_sid=${sid}` } },
    )
  })
})

describe("producer lanes", () => {
  it("announces early (muxlive), streams past the first drain, muxends at producer resolve", async () => {
    const scope = freshLiveScope("frame-producer")
    const sid = "sid-frame-producer"
    await withLiveDrive(
      "http://localhost/host?live=1",
      PageFramed,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        const lanesSeg = await h.segments.next()
        if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
          throw new Error("expected lanes segment")
        const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

        expect(
          await post(
            scope,
            {
              connection: conn,
              seq: 5,
              frames: [
                {
                  kind: "url",
                  url: "/panel/stream",
                  intent: "silent",
                  frame: ["frame-panel"],
                },
              ],
            },
            `__frame_sid=${sid}`,
          ),
        ).toBe(204)

        const lane = await nextLane(laneIter)
        expect(lane.partonId).toBe("frame-panel")

        // The producer announcement lands WHILE the producer await
        // still stalls the body — the gate has not been released.
        const live = await waitForEntry(
          h.entries,
          (e) => e.tag === "muxlive" && e.body.startsWith("frame-panel\n"),
          "muxlive announcement",
        )
        expect(live.body).toMatch(/^frame-panel\n\d+ 5 nav=5$/)
        expect(renders.producer).toBe(1)

        // Producer resolves → the body drains and muxends. No
        // drain-time `seq` entry follows — the muxlive WAS the
        // delivery announcement.
        releaseProducer()
        expect((await decodeLane(lane)).bodyText).toContain("panel-produced:1")
        expect(
          h.entries.filter((e) => e.tag === "seq" && e.body.startsWith("frame-panel\n")),
        ).toHaveLength(0)

        await h.shutdown("frame-panel")
      },
      { headers: { cookie: `__frame_sid=${sid}` } },
    )
  })
})

describe("action consequence seqs", () => {
  it("reserves the covering lane's delivery seq inside the action's transaction; the lane emits with it", async () => {
    const scope = freshLiveScope("cons-basic")
    await withLiveDrive("http://localhost/cons-a?live=1", PageCons, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      // The action: bump cons-a, reserve INSIDE the transaction —
      // before the commit's flush wakes the driver.
      let reserved: number[] | null = null
      await runWithRequestAsync(
        new Request("http://localhost/cons-a", {
          headers: { "x-test-scope": scope },
        }),
        async () => {
          await runInvalidationTransaction(async () => {
            refreshSelector("cons-a")
            reserved = _reserveActionConsequences(conn)
            // Re-reserving an unconsumed id reuses its seq — one
            // render of the latest state covers both writes.
            expect(_reserveActionConsequences(conn)).toEqual(reserved)
          })
        },
      )
      expect(reserved).toEqual([2])

      // The consequence lane emits with EXACTLY the reserved seq.
      const lane = await nextLane(laneIter)
      expect(lane.partonId).toBe("cons-a")
      await decodeLane(lane)
      const seqEntry = await waitForEntry(
        h.entries,
        (e) => e.tag === "seq" && e.body.startsWith("cons-a\n"),
        "consequence lane seq entry",
      )
      expect(seqEntry.body).toBe("cons-a\n2 0")
      expect(_peekConnectionSession(conn)?.assignedLaneSeqs.size).toBe(0)

      await h.shutdown("cons-a")
    })
  })

  it("a window navigation voids a reservation whose lane it tears — the seqvoid entry ships", async () => {
    const scope = freshLiveScope("cons-void")
    await withLiveDrive("http://localhost/cons-a?live=1", PageCons, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")
      // From here ConsSlow stalls: its consequence lane opens and
      // parks on the gate with the assigned seq unspent.
      stallCons = true

      let reserved: number[] | null = null
      await runWithRequestAsync(
        new Request("http://localhost/cons-a", {
          headers: { "x-test-scope": scope },
        }),
        async () => {
          await runInvalidationTransaction(async () => {
            refreshSelector("cons-slow")
            reserved = _reserveActionConsequences(conn)
          })
        },
      )
      expect(reserved).toEqual([2])

      // A window navigation tears the stalled lane before it could
      // announce — the reservation voids and the entry ships so the
      // client's watermark can pass seq 2. The stall switch drops
      // first so the navigation segment's own ConsSlow render (the
      // bump moved its fp — no skip) flows through.
      stallCons = false
      expect(
        await post(scope, {
          connection: conn,
          seq: 7,
          frames: [{ kind: "url", url: "/cons-a?x=1", intent: "push" }],
        }),
      ).toBe(204)
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the navigation payload segment")
      await drainPayloadSegment(navSeg.value)
      // The void entry rides the reopened lanes region — pull it so
      // the splitter reads (and surfaces) the region's entries.
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
      const voided = await waitForEntry(h.entries, (e) => e.tag === "seqvoid", "seqvoid entry")
      expect(voided.body.split(" ").map(Number)).toContain(2)

      releaseSlow()
      await h.shutdown("cons-a")
    })
  })
})
