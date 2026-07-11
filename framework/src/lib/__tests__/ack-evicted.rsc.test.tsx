/**
 * The ack's `evicted` statement — the server half of "loss is
 * reportable". A client that destroyed committed content (pool-cap
 * eviction, cull-park eviction, page prune, a clobbered pair) names
 * the parton ids on its next ack frame; the server revokes EVERY fp
 * credit it holds for them — the optimistic override, the acked
 * layer, and the id's tokens inside still-pending delivery records —
 * so the next covering render re-ships bytes instead of confirming a
 * ghost. The claims:
 *
 *   1. session semantics — an eviction purges both mirror layers and
 *      pending records, and applies even on a NON-advancing ack (a
 *      loss with no new commits is still a statement);
 *   2. re-ship on the wire — content the mirror fully credits
 *      (promoted + acked) fp-skips its re-lane to a placeholder;
 *      after the client reports it evicted, the same re-lane RENDERS
 *      the body;
 *   3. a malformed `evicted` field is a protocol violation (`400`).
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import {
  _closeConnectionSession,
  _openConnectionSession,
  _peekConnectionSession,
  _recordDelivery,
  handleChannelPost,
} from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { evi: 0 }

const EviA = parton(
  function EviARender(_: RenderArgs) {
    renders.evi++
    return <div data-evi>{`evi:${renders.evi}`}</div>
  },
  { selector: "evi-a" },
)

const Page = (): ReactNode => (
  <PartialRoot>
    <EviA />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.evi = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

async function post(scope: string | undefined, envelope: unknown): Promise<number> {
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

describe("evicted — session semantics", () => {
  it("purges both mirror layers and pending records; applies on a non-advancing ack", async () => {
    const session = _openConnectionSession("evict-unit", null)
    try {
      session.cachedOverride = {
        fingerprints: new Map([
          ["a", new Set(["f1"])],
          ["b", new Set(["f2"])],
        ]),
        matchKeys: new Map([
          ["a", new Set(["mk"])],
          ["b", new Set(["mk"])],
        ]),
        slots: new Map([
          ["a", new Map([["mk", new Set(["f1"])]])],
          ["b", new Map([["mk", new Set(["f2"])]])],
        ]),
      }
      _recordDelivery(session, 1, [
        ["a", "mk", "f1"],
        ["b", "mk", "f2"],
      ])
      expect(
        await post(undefined, {
          connection: "evict-unit",
          seq: 1,
          frames: [{ kind: "ack", delivered: 1 }],
        }),
      ).toBe(204)
      expect(session.ackedFps.get("a")?.has("f1")).toBe(true)

      // A NON-advancing ack whose only content is the loss statement
      // still applies: the acked layer AND the optimistic override
      // drop the id; the sibling is untouched.
      expect(
        await post(undefined, {
          connection: "evict-unit",
          seq: 2,
          frames: [{ kind: "ack", delivered: 1, evicted: ["a"] }],
        }),
      ).toBe(204)
      expect(session.ackedFps.has("a")).toBe(false)
      expect(session.ackedSlots.has("a")).toBe(false)
      expect(session.cachedOverride?.fingerprints.has("a")).toBe(false)
      expect(session.cachedOverride?.slots.has("a")).toBe(false)
      expect(session.ackedFps.get("b")?.has("f2")).toBe(true)
      expect(session.cachedOverride?.fingerprints.has("b")).toBe(true)

      // A still-pending delivery's record loses the evicted id's
      // tokens: the record's later ack must not re-credit content the
      // client destroyed BEFORE committing it.
      _recordDelivery(session, 3, [
        ["c", "mk", "f3"],
        ["d", "mk", "f4"],
      ])
      expect(
        await post(undefined, {
          connection: "evict-unit",
          seq: 3,
          frames: [{ kind: "ack", delivered: 1, evicted: ["c"] }],
        }),
      ).toBe(204)
      expect(
        await post(undefined, {
          connection: "evict-unit",
          seq: 4,
          frames: [{ kind: "ack", delivered: 3 }],
        }),
      ).toBe(204)
      expect(session.ackedFps.has("c")).toBe(false)
      expect(session.ackedFps.get("d")?.has("f4")).toBe(true)
    } finally {
      _closeConnectionSession("evict-unit")
    }
  })

  it("a malformed evicted field is a protocol violation", async () => {
    const session = _openConnectionSession("evict-400", null)
    try {
      expect(
        await post(undefined, {
          connection: "evict-400",
          seq: 1,
          frames: [{ kind: "ack", delivered: 0, evicted: [7] }],
        }),
      ).toBe(400)
      expect(
        await post(undefined, {
          connection: "evict-400",
          seq: 1,
          frames: [{ kind: "ack", delivered: 0, evicted: "a" }],
        }),
      ).toBe(400)
    } finally {
      _closeConnectionSession("evict-400")
    }
  })
})

describe("evicted — credit revocation re-ships on the wire", () => {
  it("a re-lane that would confirm the mirror's credit renders fresh after the loss report", async () => {
    const scope = freshLiveScope("evicted-reship")
    await withLiveDrive("http://localhost/evicted?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const session = _peekConnectionSession(conn)
      expect(renders.evi).toBe(1)

      // The client commits delivery 1 — the fps become acked holdings
      // on top of the optimistic promote.
      expect(
        await post(scope, { connection: conn, seq: 1, frames: [{ kind: "ack", delivered: 1 }] }),
      ).toBe(204)

      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()

      // Unchanged content re-lanes to the zero-byte confirmation —
      // the mirror's credit is truthful here.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "visible", changed: ["evi-a"], visible: ["evi-a"] }],
        }),
      ).toBe(204)
      const lane1 = await nextLane(laneIter)
      expect(lane1.partonId).toBe("evi-a")
      const body1 = (await decodeLane(lane1)).bodyText
      expect(body1).toContain('"data-partial-id":"evi-a"')
      expect(renders.evi).toBe(1)

      // The client destroyed the content and reports the loss. Every
      // credit layer drops the id — and because the id is IN the
      // session's visible set (the client is looking at what it just
      // declared lost), the eviction re-queues an in-flip: the very
      // next lane RENDERS fresh bytes, no further statement needed
      // (the earlier confirmation may have raced the report by one
      // RTT, and waiting for the reconcile would leave the skeleton
      // up for its whole cadence).
      expect(
        await post(scope, {
          connection: conn,
          seq: 3,
          frames: [{ kind: "ack", delivered: 2, evicted: ["evi-a"] }],
        }),
      ).toBe(204)
      expect(session?.ackedFps.has("evi-a")).toBe(false)
      const lane2 = await nextLane(laneIter)
      expect(lane2.partonId).toBe("evi-a")
      expect((await decodeLane(lane2)).bodyText).toContain("evi:2")
      expect(renders.evi).toBe(2)

      await h.shutdown("evi-a")
    })
  })
})
