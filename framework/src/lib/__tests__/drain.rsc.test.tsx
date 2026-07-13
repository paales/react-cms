/**
 * Deploy-and-drain — the server half (`runtime/drain.ts` + the segment
 * driver's wind-down). The claims:
 *
 *   1. `beginDrain` writes the `drain` wire entry ONCE on every held
 *      connection and the drive closes CLEANLY at its next full park —
 *      the stream ends (lanes region and all) without an error, the
 *      session closes, and the drain resolves `settled`.
 *   2. A lane in flight when the drain begins SETTLES first: its full
 *      body reaches the wire before the stream closes — the settle
 *      phase, not a tear.
 *   3. The attach refusal is explicit: `drainAttachRefusal()` answers
 *      `503` + `x-parton-drain: 1` while draining (`null` before), and
 *      the WebSocket driver refuses a new attach by writing the
 *      `drain` entry and closing — no session ever opens.
 *   4. The deadline has teeth: a lane that can never settle (a wedged
 *      loader) is force-closed at `deadlineMs` — the drain resolves
 *      with the connection in `forcedConnections`, the stream ends,
 *      and the drop is reported (console.warn), never silent.
 *   5. An attach that slips past the refusal gate while the drain
 *      fans out still winds down: `openLiveConnectionSession` marks
 *      the fresh session itself.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import {
  _resetDrainForTests,
  beginDrain,
  drainAttachRefusal,
  isDraining,
} from "../../runtime/drain.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import { DRAIN_REFUSAL_HEADER } from "../channel-protocol.ts"
import { type ChannelSocket, driveChannelSocket } from "../channel-server.ts"
import { _peekConnectionSession } from "../connection-session.ts"
import { buildMarker, TAG_DRAIN } from "../fp-trailer-marker.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { a: 0, slow: 0, hang: 0 }

const DrainA = parton(
  function DrainARender(_: RenderArgs) {
    renders.a++
    return <div data-a>{`a:${renders.a}`}</div>
  },
  { selector: "drain-a" },
)

/** Fast on the initial whole-tree render, ~80ms on lane re-renders —
 *  the in-flight-lane fixture (a loader the settle phase must wait
 *  out). */
const SlowA = parton(
  async function SlowARender(_: RenderArgs) {
    renders.slow++
    if (renders.slow > 1) await sleep(80)
    return <div data-slow>{`slow:${renders.slow}`}</div>
  },
  { selector: "slow-a" },
)

/** Fast on the initial render, NEVER resolves on lane re-renders — the
 *  wedged-loader fixture the deadline force-closes. */
const HangA = parton(
  async function HangARender(_: RenderArgs) {
    renders.hang++
    if (renders.hang > 1) await new Promise(() => {})
    return <div data-hang>{`hang:${renders.hang}`}</div>
  },
  { selector: "hang-a" },
)

const PageA = (): ReactNode => (
  <PartialRoot>
    <DrainA />
  </PartialRoot>
)
const PageSlow = (): ReactNode => (
  <PartialRoot>
    <SlowA />
  </PartialRoot>
)
const PageHang = (): ReactNode => (
  <PartialRoot>
    <HangA />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.a = 0
  renders.slow = 0
  renders.hang = 0
})

afterEach(() => {
  _resetDrainForTests()
  clearRegistry("all")
  _clearInvalidationRegistry()
  vi.restoreAllMocks()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

describe("the drain frame + the clean wind-down", () => {
  it("announces `drain` once and closes the stream at the full park; the drain settles", async () => {
    const scope = freshLiveScope("drain-clean")
    await withLiveDrive("http://localhost/drain?live=1", PageA, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      expect(_peekConnectionSession(conn)).toBeDefined()

      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()

      const drained = beginDrain({ deadlineMs: 5_000 })

      // The idle connection parks empty: the drive announces the drain
      // and closes cleanly — the lanes region ends, the stream ends,
      // nothing errors.
      expect((await laneIter.next()).done).toBe(true)
      expect((await h.segments.next()).done).toBe(true)
      expect(h.entries.filter((e) => e.tag === TAG_DRAIN)).toHaveLength(1)
      expect(_peekConnectionSession(conn)).toBeUndefined()

      const result = await drained
      expect(result.settled).toBe(true)
      expect(result.forcedConnections).toEqual([])
    })
  })

  it("a lane in flight when the drain begins settles before the close", async () => {
    const scope = freshLiveScope("drain-settle")
    await withLiveDrive("http://localhost/drain-settle?live=1", PageSlow, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)

      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()

      // Open a lane (its render sleeps ~80ms), then drain immediately:
      // the wind-down must serve the lane's full body first.
      refreshSelector("slow-a")
      await sleep(10)
      const drained = beginDrain({ deadlineMs: 5_000 })

      const lane = await nextLane(laneIter)
      expect(lane.partonId).toBe("slow-a")
      expect((await decodeLane(lane)).bodyText).toContain("slow:2")

      expect((await laneIter.next()).done).toBe(true)
      expect((await h.segments.next()).done).toBe(true)
      expect(h.entries.filter((e) => e.tag === TAG_DRAIN)).toHaveLength(1)

      const result = await drained
      expect(result.settled).toBe(true)
      expect(result.forcedConnections).toEqual([])
    })
  })
})

describe("the explicit attach refusal", () => {
  it("drainAttachRefusal answers 503 + x-parton-drain while draining, null before", async () => {
    expect(isDraining()).toBe(false)
    expect(drainAttachRefusal()).toBeNull()
    await beginDrain({ deadlineMs: 100 })
    expect(isDraining()).toBe(true)
    const refusal = drainAttachRefusal()
    expect(refusal).not.toBeNull()
    expect(refusal!.status).toBe(503)
    expect(refusal!.headers.get(DRAIN_REFUSAL_HEADER)).toBe("1")
  })

  it("the WebSocket driver refuses a new attach with the drain entry and closes", async () => {
    await beginDrain({ deadlineMs: 100 })
    const sent: Uint8Array[] = []
    let closed = false
    let onMessage: (data: string) => void = () => {}
    const socket: ChannelSocket = {
      send: (bytes) => {
        sent.push(bytes)
      },
      bufferedAmount: 0,
      close: () => {
        closed = true
      },
      onMessage: (h) => {
        onMessage = h
      },
      onClose: () => {},
      onDrain: () => {},
    }
    const done = driveChannelSocket(socket, new Request("http://localhost/"), () =>
      renderServerToFlight(<div />),
    )
    onMessage(JSON.stringify({ url: "/", cached: [], since: null, visible: null }))
    await done
    expect(closed).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual(buildMarker(TAG_DRAIN, 0))
  })
})

describe("the deadline", () => {
  it("force-closes a lane that can never settle, reports it, and resolves at the bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const scope = freshLiveScope("drain-deadline")
    await withLiveDrive("http://localhost/drain-hang?live=1", PageHang, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""

      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()

      // Open the wedged lane, then drain with a tight deadline.
      refreshSelector("hang-a")
      await sleep(20)
      const result = await beginDrain({ deadlineMs: 150 })
      expect(result.settled).toBe(false)
      expect(result.forcedConnections).toEqual([conn])
      // Never silent: both the process-level statement and the
      // driver's per-connection lane detail were reported.
      const warned = warn.mock.calls.map((c) => String(c[0]))
      expect(warned.some((m) => m.includes("drain deadline"))).toBe(true)
      expect(warned.some((m) => m.includes("hang-a"))).toBe(true)

      // The stream ends; the session is gone. The wedged lane's body
      // opened on the wire (its initial Flight rows flowed before the
      // loader stalled); the force-close winds it down on the CANCEL
      // path — the body closes with a muxend and NO delivery
      // announcement, so the client's decode settles without ever
      // committing the partial content (an unannounced body never
      // commits); the reattach's whole-tree render is the heal.
      const step = await laneIter.next()
      if (!step.done) {
        expect(step.value.partonId).toBe("hang-a")
        await decodeLane(step.value)
        expect(h.entries.some((e) => e.tag === "seq" && e.body.startsWith("hang-a\n"))).toBe(false)
        expect((await laneIter.next()).done).toBe(true)
      }
      expect((await h.segments.next()).done).toBe(true)
      expect(_peekConnectionSession(conn)).toBeUndefined()
    })
  })
})

describe("the fan-out race", () => {
  it("a session opened after the drain began still winds down (self-marked at open)", async () => {
    await beginDrain({ deadlineMs: 100 })
    const scope = freshLiveScope("drain-race")
    await withLiveDrive("http://localhost/drain-race?live=1", PageA, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()
      expect((await laneIter.next()).done).toBe(true)
      expect((await h.segments.next()).done).toBe(true)
      expect(h.entries.filter((e) => e.tag === TAG_DRAIN)).toHaveLength(1)
    })
  })
})
