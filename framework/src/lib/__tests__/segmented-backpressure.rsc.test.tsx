/**
 * Downstream backpressure for the live segment driver. The response
 * stream's `pull` callback is the demand signal: while the consumer's
 * queue is full (`desiredSize <= 0`) the driver parks lane output
 * instead of buffering it server-side — a reader that stops pulling
 * on a held connection would otherwise accumulate every wake's lane
 * bytes for the connection's whole lifetime.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _captureCommitHandle, runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import { freshLiveScope } from "../../test/live-drive.tsx"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import {
  buildMarker,
  TAG_MUX_END,
  TAG_MUX_FRAME,
  TAG_SEGMENT_SETTLED,
  tryReadMarker,
} from "../fp-trailer-marker.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { PartialRoot, parton } from "../partial.tsx"
import { bindAttachStatement } from "../connection-session.ts"
import { clearRegistry } from "../partial-registry.ts"
import { createSegmentedResponse, driveSegmentedResponse } from "../segmented-response.ts"

// Render tracking with explicit completion signals — a test awaits
// "render N ran" on the counter itself, never on timing.
const renderState = {
  count: 0,
  waiters: [] as Array<{ n: number; resolve: () => void }>,
}
function renderReached(n: number): Promise<void> {
  if (renderState.count >= n) return Promise.resolve()
  return new Promise((resolve) => {
    renderState.waiters.push({ n, resolve })
  })
}

const PAD = "x".repeat(512)
const PressureLane = parton(
  function PressureLaneRender() {
    renderState.count++
    renderState.waiters = renderState.waiters.filter((w) => {
      if (w.n <= renderState.count) {
        w.resolve()
        return false
      }
      return true
    })
    return <div data-render={renderState.count}>{`pressure-${renderState.count}-${PAD}`}</div>
  },
  { selector: "pressure-lane" },
)

const SETTLED = buildMarker(TAG_SEGMENT_SETTLED, 0)
const encoder = new TextEncoder()
const MUXEND_HEADER = encoder.encode(`[parton:${TAG_MUX_END}:`)

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function pressurePage() {
  return (
    <PartialRoot>
      <PressureLane />
    </PartialRoot>
  )
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renderState.count = 0
  renderState.waiters = []
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("live segment driver — downstream backpressure", () => {
  it("lane output parks while the consumer's queue is full", async () => {
    const scope = freshLiveScope("bp-rsc")
    const request = new Request("http://localhost/pressure", {
      headers: { "x-test-scope": scope },
    })
    await runWithRequestAsync(request, async () => {
      // The statement is the live-subscription signal — a bare attach
      // makes this drive a held connection.
      bindAttachStatement({
        url: "/pressure",
        cached: [],
        since: null,
        visible: null,
      })
      // The response stream with production demand wiring: `pull`
      // releases parked pumps, `cancel` marks the demand dead.
      let real!: ReadableStreamDefaultController<Uint8Array>
      let pullWaiters: Array<() => void> = []
      const releasePulls = (): void => {
        const waiters = pullWaiters
        pullWaiters = []
        for (const resolve of waiters) resolve()
      }
      let parkedResolve!: () => void
      const parkedOnce = new Promise<void>((resolve) => {
        parkedResolve = resolve
      })
      const demand = {
        cancelled: false,
        pulled: (): Promise<void> => {
          // The driver consults demand only when the queue is full —
          // any call here IS the park.
          parkedResolve()
          return new Promise<void>((resolve) => {
            pullWaiters.push(resolve)
          })
        },
      }
      const response = new ReadableStream<Uint8Array>({
        start(c) {
          real = c
        },
        pull() {
          releasePulls()
        },
        cancel() {
          demand.cancelled = true
          releasePulls()
        },
      })

      // Counting facade: records every LANE frame (mux / muxend) the
      // driver enqueues while the queue is already full — the
      // unbounded-buffering signature.
      const violations: string[] = []
      let muxendResolve!: () => void
      const muxendSeen = new Promise<void>((resolve) => {
        muxendResolve = resolve
      })
      const facade = {
        get desiredSize(): number | null {
          return real.desiredSize
        },
        enqueue(chunk: Uint8Array): void {
          const parsed = tryReadMarker(chunk)
          const tag = typeof parsed === "object" ? parsed.tag : null
          if (
            (tag === TAG_MUX_FRAME || tag === TAG_MUX_END) &&
            real.desiredSize !== null &&
            real.desiredSize <= 0
          ) {
            violations.push(tag)
          }
          real.enqueue(chunk)
          if (tag === TAG_MUX_END) muxendResolve()
        },
      } as unknown as ReadableStreamDefaultController<Uint8Array>

      const renderOnce = (): ReadableStream<Uint8Array> =>
        wrapStreamWithFpTrailer(renderServerToFlight(pressurePage()), _captureCommitHandle())
      const drive = driveSegmentedResponse(facade, renderOnce, undefined, demand)
      void drive.catch(() => {})

      // Drain segment 0 — read until its settled milestone arrives.
      const reader = response.getReader()
      let acc: Uint8Array = new Uint8Array(0)
      while (indexOfBytes(acc, SETTLED) < 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended before segment 0 settled")
        if (value) acc = concatBytes(acc, value)
      }
      expect(renderState.count).toBe(1)

      // The consumer stops reading. The next wake's lane render still
      // runs, but its frames must park at the gate instead of being
      // pumped into the full queue.
      refreshSelector("pressure-lane")
      await renderReached(2)
      await Promise.race([parkedOnce, muxendSeen])
      expect(violations).toEqual([])

      // The consumer resumes: the parked lane drains through the gate
      // intact, muxend and all.
      let lane: Uint8Array = new Uint8Array(0)
      while (indexOfBytes(lane, MUXEND_HEADER) < 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended before the lane drained")
        if (value) lane = concatBytes(lane, value)
      }
      expect(violations).toEqual([])

      // Wind down: tear the consumer, then wake the parked driver so
      // its next lane attempt observes the dead demand and exits.
      await reader.cancel()
      refreshSelector("pressure-lane")
      await drive
    })
  })

  it("createSegmentedResponse wires pull/cancel as the demand signal end to end", async () => {
    const scope = freshLiveScope("bp-wire")
    const request = new Request("http://localhost/pressure-wire", {
      headers: { "x-test-scope": scope },
    })
    await runWithRequestAsync(request, async () => {
      bindAttachStatement({
        url: "/pressure-wire",
        cached: [],
        since: null,
        visible: null,
      })
      const renderOnce = (): ReadableStream<Uint8Array> =>
        wrapStreamWithFpTrailer(renderServerToFlight(pressurePage()), _captureCommitHandle())
      const response = createSegmentedResponse(renderOnce)
      const reader = response.getReader()

      // Segment 0 drains chunk by chunk through the gate (each read is
      // a pull).
      let acc: Uint8Array = new Uint8Array(0)
      while (indexOfBytes(acc, SETTLED) < 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended before segment 0 settled")
        if (value) acc = concatBytes(acc, value)
      }
      expect(renderState.count).toBe(1)

      // Stall, wake a lane, then resume: the parked lane must drain
      // intact once the consumer pulls again — no deadlock, no drop.
      refreshSelector("pressure-lane")
      await renderReached(2)
      let lane: Uint8Array = new Uint8Array(0)
      while (indexOfBytes(lane, MUXEND_HEADER) < 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended before the lane drained")
        if (value) lane = concatBytes(lane, value)
      }
      expect(indexOfBytes(lane, encoder.encode("pressure-2-")) >= 0).toBe(true)

      // Cancelling the response releases the parked driver: its next
      // lane attempt observes the dead demand and winds down.
      await reader.cancel()
      refreshSelector("pressure-lane")
    })
  })
})
