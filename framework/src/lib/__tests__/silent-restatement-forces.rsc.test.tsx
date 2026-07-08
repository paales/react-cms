/**
 * Silent restatements must never lose a disjoint force. Two seams
 * guard it server-side: the consume chain UNIONS the statements'
 * `__force` selectors (a superseding statement's URL is authoritative,
 * its predecessor's forces are not moot), and a navigation tear
 * catching an EXPLICIT lane whose content never drained re-forces the
 * id after the reopen. The claim: statement 1 forces A (its lane
 * stalls mid-render), statement 2 forces only B — both A and B lane.
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
import { handleChannelPost } from "../connection-session.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { fa: 0, fb: 0 }
let releaseFa: () => void = () => {}
let faGate: Promise<void> = Promise.resolve()

const Fa = parton(
  async function FaRender(_: RenderArgs) {
    renders.fa++
    if (renders.fa > 1) await faGate
    return <div data-fa>{`fa:${renders.fa}`}</div>
  },
  { selector: "force-a" },
)
const Fb = parton(
  function FbRender(_: RenderArgs) {
    renders.fb++
    return <div data-fb>{`fb:${renders.fb}`}</div>
  },
  { selector: "force-b" },
)
const Page = (): ReactNode => (
  <PartialRoot>
    <Fa />
    <Fb />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.fa = 0
  renders.fb = 0
  faGate = new Promise((r) => {
    releaseFa = r
  })
})
afterEach(() => {
  releaseFa()
  clearRegistry("all")
  _clearInvalidationRegistry()
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

describe("silent restatement vs in-flight force", () => {
  it("a torn unfulfilled force re-lanes after the next consume", async () => {
    const scope = freshLiveScope("force-tear")
    await withLiveDrive("http://localhost/host", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload") throw new Error("seg0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      let lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("lanes")

      // Statement 1 forces fa — its lane STALLS on the gate.
      expect(
        await post(scope, {
          connection: conn,
          seq: 1,
          frames: [{ kind: "url", url: "/host?__force=force-a", intent: "silent" }],
        }),
      ).toBe(204)
      // Wait for the stalled fa render to begin.
      const deadline = Date.now() + 5000
      while (renders.fa < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(renders.fa).toBe(2)

      // Statement 2 forces only fb. The consume tears fa's stalled
      // lane; fa must re-lane after the reopen.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "url", url: "/host?__force=force-b", intent: "silent" }],
        }),
      ).toBe(204)
      releaseFa()

      // Walk segments: navigation segments + reopened lanes regions.
      // The mirror survives the consume, so statement 1's whole-tree
      // segment fp-skips the held partons — fa's forced refetch stalls
      // as a LANE (not a fresh whole-tree render), and statement 2's
      // consume TEARS that stalled lane: the region ends with fa's body
      // open, so its decode rejects (the browser entry's `handleLane`
      // swallows exactly this). Tolerate the torn lane here and count
      // only cleanly-decoded lanes — fa re-forces and lanes fresh on
      // the reopened region.
      const seen = new Set<string>()
      const until = Date.now() + 8000
      outer: while (Date.now() < until) {
        const step = await h.segments.next()
        if (step.done) break
        if (step.value.kind === "payload") {
          await drainPayloadSegment(step.value)
          continue
        }
        for await (const lane of step.value.lanes) {
          try {
            await decodeLane(lane)
          } catch {
            // A torn forced lane (superseded mid-render) — its
            // re-force lands on a later region.
            continue
          }
          seen.add(lane.partonId)
          if (seen.has("force-a") && seen.has("force-b")) break outer
        }
      }
      expect([...seen].sort()).toEqual(["force-a", "force-b"])
      await h.shutdown("force-a")
    })
  }, 20000)
})
