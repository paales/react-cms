/**
 * The WebTransport (HTTP/3) transport, end to end over a FAKE duplex.
 * Wires the server tunnel (`driveChannelWebTransport`, driving a
 * bidirectional stream's readable/writable halves) to the client
 * transport (`WebTransportTransport`, on a stubbed `WebTransport` global)
 * and proves the OPAQUE TUNNEL: the attach rides up as the first
 * newline-delimited JSON line, the SAME `\xFF`-marker segment + lane bytes
 * ride down the readable half (parsed by the unchanged `splitSegments`),
 * and an upstream envelope applies through the shared switch — its seq
 * surfacing on the downstream `applied` marker.
 *
 * A real QUIC server is unavailable in this environment (Node has no
 * stable HTTP/3 listener; Vite dev/preview is HTTP/1.1), so the pipe is a
 * pair of `TransformStream`s standing in for the bidi stream. That is
 * exactly the seam guarantee: `driveSegmentedResponse` and the client
 * splitter never name a transport, so a fake duplex exercises the tunnel
 * logic byte-for-byte — only the QUIC socket underneath is mocked. The
 * default transport stays fetch; this exercises the opt-in path in
 * isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _captureCommitHandle } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { decodeLane, freshLiveScope } from "../../test/live-drive.tsx"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import type { AttachStatement } from "../channel-protocol.ts"
import { type ChannelDuplexStream, driveChannelWebTransport } from "../channel-server.ts"
import { WebTransportTransport } from "../channel-transport.ts"
import { TAG_CONNECTION_ID, TAG_UPSTREAM_APPLIED } from "../fp-trailer-marker.ts"
import { type DemuxedLane, splitSegments } from "../fp-trailer-split.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { clearRegistry } from "../partial-registry.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { expires, time } from "../server-hooks.ts"

// A live ticker: content changes every render, wake declared in-body —
// so a lane arrives from the expiry boundary alone, no bump needed.
const renders = { n: 0 }
const WtClock = parton(
  function WtClockRender(_: RenderArgs) {
    renders.n++
    expires(time().in(80))
    return <time data-wt-clock>{`wt-tick-${renders.n}`}</time>
  },
  { selector: "wt-clock" },
)

/**
 * A fake WebTransport bidirectional stream as a pair of TransformStreams:
 * `upstream` is client→server (the newline-framed attach + envelopes),
 * `downstream` is server→client (the opaque marker bytes). Returns the
 * two mirrored duplex VIEWS — the client's (what the stubbed
 * `WebTransport.createBidirectionalStream` hands back) and the server's
 * (what `driveChannelWebTransport` drives).
 */
function fakeBidiPair(): {
  clientBidi: ChannelDuplexStream
  serverBidi: ChannelDuplexStream
} {
  const upstream = new TransformStream<Uint8Array, Uint8Array>()
  const downstream = new TransformStream<Uint8Array, Uint8Array>()
  return {
    clientBidi: { readable: downstream.readable, writable: upstream.writable },
    serverBidi: { readable: upstream.readable, writable: downstream.writable },
  }
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.n = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("channel WebTransport transport", () => {
  it("tunnels the attach, first segment, and a lane over one bidi stream; applies an upstream envelope", async () => {
    const scope = freshLiveScope("wt-smoke")
    const { clientBidi, serverBidi } = fakeBidiPair()

    // Server: drive the bidi stream directly — the shape
    // `createWebTransportServer.handleSession` extracts from a QUIC
    // session. The connect request carries the scope binding (cookies
    // would ride here too); the attach's stated URL validates against
    // its origin.
    const connectRequest = new Request("https://localhost/", {
      headers: { "x-test-scope": scope },
    })
    const renderOnce = (): ReadableStream<Uint8Array> =>
      wrapStreamWithFpTrailer(
        renderServerToFlight(
          <PartialRoot>
            <WtClock />
          </PartialRoot>,
        ),
        _captureCommitHandle(),
      )
    void driveChannelWebTransport(serverBidi, connectRequest, renderOnce)

    // Client: `new WebTransport(url)` hands back the fake session whose
    // bidi stream is the client's view of the pair.
    let closed = false
    vi.stubGlobal(
      "WebTransport",
      class {
        readonly ready = Promise.resolve()
        constructor(_url: string) {}
        createBidirectionalStream(): Promise<ChannelDuplexStream> {
          return Promise.resolve(clientBidi)
        }
        close(): void {
          closed = true
        }
      },
    )

    const transport = new WebTransportTransport("https://localhost/__parton/wt")
    const ac = new AbortController()
    const statement: AttachStatement = {
      url: "/wt-clock?live=1",
      cached: [],
      since: null,
      visible: null,
    }
    try {
      const { body } = await transport.open(statement, ac.signal)
      const entries: Array<{ tag: string; body: string }> = []
      let connId: string | null = null
      const iter = splitSegments(body, ac.signal, (tag, b) => {
        const text = new TextDecoder().decode(b)
        entries.push({ tag, body: text })
        if (tag === TAG_CONNECTION_ID) connId = text
      })[Symbol.asyncIterator]()

      // Segment 0 — the whole-tree render, tunneled down the readable.
      const first = await iter.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0 over WebTransport")
      const seg0 = await new Response(first.value.body).text()
      await first.value.trailers
      expect(seg0).toContain("wt-tick-1")
      // The `conn` handshake arrived on the stream (establishment).
      expect(connId).toBeTruthy()

      // Upstream: an envelope on the SAME bidi stream (a fresh
      // newline-framed line). Its seq must advance the server's applied
      // watermark — the upstream tunnel + the shared apply switch,
      // round-tripped.
      const accepted = await transport.send({
        connection: connId as unknown as string,
        seq: 9,
        frames: [{ kind: "ack", delivered: 0 }],
      })
      expect(accepted).toBe(true)

      // A lane from the 80ms expiry boundary, tunneled down as marker
      // bytes.
      const second = await iter.next()
      if (second.done || second.value.kind !== "lanes")
        throw new Error("expected lanes segment over WebTransport")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()
      const lane = (await laneIter.next()).value as DemuxedLane
      expect(lane.partonId).toBe("wt-clock")
      const { bodyText } = await decodeLane(lane)
      expect(bodyText).toContain("wt-tick-2")

      // The `applied` marker for seq 9 rides a wake — drain segments
      // until it surfaces (the upstream round-trip proof).
      const deadline = Date.now() + 2000
      const seen = (): boolean =>
        entries.some((e) => e.tag === TAG_UPSTREAM_APPLIED && e.body === "9")
      while (!seen() && Date.now() < deadline) {
        const next = await iter.next()
        if (next.done) break
        if (next.value.kind === "lanes") {
          for await (const l of next.value.lanes) {
            await new Response(l.body).arrayBuffer().catch(() => {})
          }
        } else {
          await new Response(next.value.body).arrayBuffer().catch(() => {})
          await next.value.trailers
        }
      }
      expect(seen()).toBe(true)

      ac.abort()
    } finally {
      transport.close()
    }
    expect(closed).toBe(true)
  })
})
