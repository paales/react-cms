/**
 * Telemetry on the session + predictive warming at park. The claims:
 *
 *   1. a `telemetry` frame updates the session's slot LATEST-WINS (a
 *      stale envelope can't regress it) and causes NO render and NO
 *      delivery — telemetry is context, not a dependency: after a
 *      telemetry-only envelope, no body re-runs and no new delivery
 *      seq appears on the wire (the `applied` announcement is the
 *      envelope machinery's, not telemetry's);
 *   2. the warm pass renders projected parked partons into the server
 *      byte-cache WITHOUT emitting a byte — no delivery seq, no lane,
 *      no mirror promotion — and the next real flip-in lane replays
 *      the warm entry instead of running the body: warm flip latency
 *      beats the body's own cost, cold flip latency cannot (the
 *      warm-vs-cold number);
 *   3. warming is bounded: at most MAX_WARM_PER_PARK renders per
 *      telemetry statement, priority order preserved;
 *   4. warming respects the backpressure window: while the unacked
 *      delivery window is exceeded nothing warms; the freeing ack's
 *      wake warms the same statement (a window-skip records nothing).
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
import { _cacheStats, _clearCache } from "../cache.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { _peekConnectionSession, handleChannelPost } from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import {
  _setFirstAckDeadlineMs,
  _setMaxWarmPerPark,
  _setUnackedDeliveryWindow,
} from "../segmented-response.ts"
import { registerWarmProjector } from "../warm-projection.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The controlled body cost the warm-vs-cold number measures against:
 *  a warm flip replays cached bytes (never pays this), a cold flip
 *  runs the body (always pays this). */
const SLOW_MS = 120

const renders = { tel: 0, warm: 0, cold: 0, capA: 0, capB: 0, win: 0 }

const TelA = parton(
  function TelARender(_: RenderArgs) {
    renders.tel++
    return <div>{`tel:full:${renders.tel}`}</div>
  },
  { selector: "tel-a" },
)

/** The costly subtree — a plain child server component, where cached
 *  content's real work lives in the RSC model. The byte cache stores
 *  its rendered output, so a HIT replays it without running it: the
 *  counter is the proof, the sleep is the measured cost. (The parton's
 *  own body function runs on every render — hit or miss — which is
 *  why the cost sits in the child.) */
async function SlowLeaf({ tag }: { tag: "warm" | "cold" }) {
  renders[tag]++
  await sleep(SLOW_MS)
  return <div>{`${tag}:full:${renders[tag]}`}</div>
}

const CullWarm = parton(
  function CullWarmRender(_: RenderArgs) {
    return <SlowLeaf tag="warm" />
  },
  { selector: "cull-warm", cull: { skeleton: SkelBox }, cache: { maxAge: 60 } },
)

const CullCold = parton(
  function CullColdRender(_: RenderArgs) {
    return <SlowLeaf tag="cold" />
  },
  { selector: "cull-cold", cull: { skeleton: SkelBox }, cache: { maxAge: 60 } },
)

const CullCapA = parton(
  function CullCapARender(_: RenderArgs) {
    renders.capA++
    return <div>{`capA:full:${renders.capA}`}</div>
  },
  {
    selector: "cull-cap-a",
    cull: { skeleton: SkelBox },
    cache: { maxAge: 60 },
  },
)

const CullCapB = parton(
  function CullCapBRender(_: RenderArgs) {
    renders.capB++
    return <div>{`capB:full:${renders.capB}`}</div>
  },
  {
    selector: "cull-cap-b",
    cull: { skeleton: SkelBox },
    cache: { maxAge: 60 },
  },
)

const CullWin = parton(
  function CullWinRender(_: RenderArgs) {
    renders.win++
    return <div>{`win:full:${renders.win}`}</div>
  },
  { selector: "cull-win", cull: { skeleton: SkelBox }, cache: { maxAge: 60 } },
)

beforeEach(() => {
  _clearInvalidationRegistry()
  // Held drives in this suite outlive the 5s never-acked deadline
  // under load; only the window test acks.
  _setFirstAckDeadlineMs(60_000)
  for (const k of Object.keys(renders) as Array<keyof typeof renders>) {
    renders[k] = 0
  }
})

afterEach(async () => {
  registerWarmProjector(null)
  _setMaxWarmPerPark()
  _setUnackedDeliveryWindow()
  _setFirstAckDeadlineMs()
  clearRegistry("all")
  _clearInvalidationRegistry()
  await _clearCache("all")
})

async function post(scope: string, envelope: ChannelEnvelope): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-scope": scope },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

const telemetryEnvelope = (connection: string, seq: number, vx: number): ChannelEnvelope => ({
  connection,
  seq,
  frames: [
    {
      kind: "telemetry",
      viewport: { w: 1280, h: 800 },
      scroll: { x: 1000, y: 2000, vx, vy: 0 },
      at: 500 + seq,
    },
  ],
})

const flipInEnvelope = (
  connection: string,
  seq: number,
  id: string,
  visible: string[],
): ChannelEnvelope => ({
  connection,
  seq,
  frames: [
    // `cached: []` — the client states it holds nothing for the
    // flipped id, so the lane must produce content, never confirm.
    { kind: "visible", changed: [id], visible, cached: [] },
  ],
})

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Poll until the byte-cache holds an entry for `idPrefix` — the warm
 *  render's storage lands in the background after its stream drains. */
async function untilCached(idPrefix: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const stats = await _cacheStats()
    if (stats.keys.some((k) => k.startsWith(`${idPrefix}:`))) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for cache entry ${idPrefix}`)
}

describe("the session telemetry slot", () => {
  it("is latest-wins and never renders — no body run, no delivery seq from telemetry alone", async () => {
    const scope = freshLiveScope("tel-slot")
    await withLiveDrive(
      "http://localhost/tel",
      () => (
        <PartialRoot>
          <TelA />
        </PartialRoot>
      ),
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        expect(conn).not.toBe("")
        expect(renders.tel).toBe(1)
        const seqEntries = (): number => h.entries.filter((e) => e.tag === "seq").length
        expect(seqEntries()).toBe(1)

        // Open the lanes region first — entries surface as the
        // splitter reads, and the splitter reads on demand.
        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()

        // Telemetry lands on the slot; the envelope's applied
        // announcement is the ONLY wire consequence.
        expect(await post(scope, telemetryEnvelope(conn, 5, 800))).toBe(204)
        await until(
          () => h.entries.some((e) => e.tag === "applied" && e.body === "5"),
          "applied announcement",
        )
        const session = _peekConnectionSession(conn)
        expect(session?.telemetry).toMatchObject({
          seq: 5,
          viewport: { w: 1280, h: 800 },
          scroll: { x: 1000, y: 2000, vx: 800, vy: 0 },
          at: 505,
        })

        // A stale envelope cannot regress the slot.
        expect(await post(scope, telemetryEnvelope(conn, 3, -100))).toBe(204)
        expect(session?.telemetry).toMatchObject({ seq: 5 })

        // Context, not a dependency: nothing rendered, nothing
        // delivered.
        expect(renders.tel).toBe(1)
        expect(seqEntries()).toBe(1)

        // Positive control: a real bump still lanes.
        refreshSelector("tel-a")
        const lane = await nextLane(laneIter)
        expect(lane.partonId).toBe("tel-a")
        expect(renders.tel).toBe(2)

        await h.shutdown("tel-a")
      },
      { attach: { cached: [], since: null, visible: null } },
    )
  })
})

describe("predictive warming at park", () => {
  it("warms the byte-cache byte-silently; the flip-in replays warm while a cold flip pays the body", async () => {
    registerWarmProjector((_telemetry, candidates) =>
      candidates.filter((c) => c.id === "cull-warm").map((c) => c.id),
    )
    const scope = freshLiveScope("warm-path")
    await withLiveDrive(
      "http://localhost/warm",
      () => (
        <PartialRoot>
          <CullWarm />
          <CullCold />
        </PartialRoot>
      ),
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg0 = await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        expect(conn).not.toBe("")
        // Everything parked: no body ran, both pairs culled.
        expect(seg0).not.toContain("warm:full")
        expect(seg0).not.toContain("cold:full")
        const seqEntries = (): number => h.entries.filter((e) => e.tag === "seq").length
        expect(seqEntries()).toBe(1)

        // The statement arrives; the warm pass runs at the next park.
        expect(await post(scope, telemetryEnvelope(conn, 1, 900))).toBe(204)
        await until(() => renders.warm === 1, "warm render")
        await untilCached("cull-warm")
        // Byte-silent: the warm render minted NO delivery seq (no lane,
        // no segment) and promoted nothing into the mirror — the only
        // pending delivery record is segment 0's own.
        expect(seqEntries()).toBe(1)
        const session = _peekConnectionSession(conn)
        expect(session?.ackedFps.size ?? 0).toBe(0)
        expect(session?.pendingDeliveries.size).toBe(1)
        expect(session?.deliverySeq).toBe(1)

        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()

        // WARM flip: the lane replays the cached bytes — the body
        // (and its SLOW_MS) never runs again.
        const warmT0 = Date.now()
        expect(await post(scope, flipInEnvelope(conn, 2, "cull-warm", ["cull-warm"]))).toBe(204)
        const warmLane = await nextLane(laneIter)
        expect(warmLane.partonId).toBe("cull-warm")
        const warmBody = (await decodeLane(warmLane)).bodyText
        // Statement → fully-drained lane: the honest latency window
        // (a lane surfaces at its first frame, long before it closes).
        const warmMs = Date.now() - warmT0
        expect(warmBody).toContain("warm:full:1")
        expect(renders.warm).toBe(1)
        expect(warmMs).toBeLessThan(SLOW_MS)

        // COLD flip (never projected): the body runs and its cost is
        // the floor.
        const coldT0 = Date.now()
        expect(
          await post(scope, flipInEnvelope(conn, 3, "cull-cold", ["cull-warm", "cull-cold"])),
        ).toBe(204)
        const coldLane = await nextLane(laneIter)
        expect(coldLane.partonId).toBe("cull-cold")
        const coldBody = (await decodeLane(coldLane)).bodyText
        const coldMs = Date.now() - coldT0
        expect(coldBody).toContain("cold:full:1")
        expect(renders.cold).toBe(1)
        expect(coldMs).toBeGreaterThanOrEqual(SLOW_MS - 20)

        // The warm-vs-cold number this suite exists to pin.
        console.info(
          `[warm-vs-cold] flip-lane latency: warm ${warmMs}ms, cold ${coldMs}ms (body ${SLOW_MS}ms)`,
        )

        await h.shutdown("cull-warm")
      },
      { attach: { cached: [], since: null, visible: [] } },
    )
  })

  it("warms at most MAX_WARM_PER_PARK partons per statement, in priority order", async () => {
    _setMaxWarmPerPark(1)
    registerWarmProjector((_telemetry, candidates) => {
      const ids = candidates.map((c) => c.id).sort()
      // [cull-cap-a, cull-cap-b] — the cap must truncate to the first.
      return ids
    })
    const scope = freshLiveScope("warm-cap")
    await withLiveDrive(
      "http://localhost/cap",
      () => (
        <PartialRoot>
          <CullCapA />
          <CullCapB />
        </PartialRoot>
      ),
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        expect(await post(scope, telemetryEnvelope(conn, 1, 700))).toBe(204)
        await until(() => renders.capA === 1, "capped warm render")
        await untilCached("cull-cap-a")
        // Give a would-be second warm every chance to run, then prove
        // it never did.
        await sleep(200)
        expect(renders.capA).toBe(1)
        expect(renders.capB).toBe(0)
        const stats = await _cacheStats()
        expect(stats.keys.some((k) => k.startsWith("cull-cap-b:"))).toBe(false)
        // Everything here stayed PARKED — a shutdown bump would never
        // lane (parked partons don't), so close via the explicit
        // detach statement instead.
        expect(
          await post(scope, {
            connection: conn,
            seq: 2,
            frames: [{ kind: "detach" }],
          }),
        ).toBe(204)
        await h.shutdown("cull-cap-a")
      },
      { attach: { cached: [], since: null, visible: [] } },
    )
  })

  it("skips warming entirely while the unacked delivery window is exceeded; the freeing ack warms", async () => {
    _setUnackedDeliveryWindow(1)
    registerWarmProjector((_telemetry, candidates) => candidates.map((c) => c.id))
    const scope = freshLiveScope("warm-win")
    await withLiveDrive(
      "http://localhost/win",
      () => (
        <PartialRoot>
          <CullWin />
        </PartialRoot>
      ),
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        // Segment 0's delivery (seq 1) is unacked — the window (1) is
        // full: the statement must warm NOTHING.
        expect(await post(scope, telemetryEnvelope(conn, 1, 900))).toBe(204)
        await sleep(250)
        expect(renders.win).toBe(0)
        expect((await _cacheStats()).keys.length).toBe(0)

        // The ack frees the window; its wake reaches the park point
        // and the SAME statement warms (a window-skip records
        // nothing).
        expect(
          await post(scope, {
            connection: conn,
            seq: 2,
            frames: [{ kind: "ack", delivered: 1 }],
          }),
        ).toBe(204)
        await until(() => renders.win === 1, "post-ack warm render")
        await untilCached("cull-win")
        // Parked route — close via detach (see the cap test's note).
        expect(
          await post(scope, {
            connection: conn,
            seq: 3,
            frames: [{ kind: "detach" }],
          }),
        ).toBe(204)
        await h.shutdown("cull-win")
      },
      { attach: { cached: [], since: null, visible: [] } },
    )
  })
})

describe("warm registrations never claim client holdings", () => {
  it("the client-mirror promote skips warmed snapshots; a real re-registration promotes", async () => {
    const { _runWithWarmRenderScope, _setCachedOverride, _getCachedOverride } =
      await import("../../runtime/context.ts")
    const { enterRequestRegistry, registerPartial, lookupPartial } =
      await import("../partial-registry.ts")
    const { computeRouteKey } = await import("../partial.tsx")
    const { promoteSnapshotsToCachedOverride } = await import("../segmented-response.ts")

    const url = "http://localhost/warm-claim"
    const snap = () => ({
      type: "warm-claim",
      fallback: null,
      labels: ["warm-claim"],
      framePath: [],
      parentFrameChain: [],
      parentPath: [],
      matchKey: "mk",
      emittedFp: "fp-warm-claim",
    })
    await runWithRequestAsync(new Request(url), async () => {
      enterRequestRegistry(computeRouteKey(url), "cache")
      _setCachedOverride({ fingerprints: new Map(), matchKeys: new Map(), slots: new Map() })

      // A byte-silent warm render registers the parton's content
      // snapshot — truthful registry state, stamped `warmed`.
      await _runWithWarmRenderScope(new Set(["warm-claim"]), async () => {
        registerPartial("warm-claim", snap())
      })
      expect(lookupPartial("warm-claim")?.warmed).toBe(true)

      // The promote (a lane drain's walk, a segment's whole-tree
      // pass) must NOT claim it — no client ever received the bytes,
      // and a deferred flip carries no holdings statement to correct
      // a phantom credit.
      const tokens: string[] = []
      promoteSnapshotsToCachedOverride(undefined, (id) => tokens.push(id))
      expect(tokens).toEqual([])
      expect(_getCachedOverride()?.fingerprints.has("warm-claim")).toBe(false)

      // The next REAL emission re-registers without the mark and
      // promotes normally.
      registerPartial("warm-claim", snap())
      expect(lookupPartial("warm-claim")?.warmed).toBeUndefined()
      promoteSnapshotsToCachedOverride(undefined, (id) => tokens.push(id))
      expect(tokens).toEqual(["warm-claim"])
      expect(_getCachedOverride()?.fingerprints.get("warm-claim")?.has("fp-warm-claim")).toBe(true)
    })
  })
})
