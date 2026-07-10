/**
 * The WebSocket transport, end to end over a REAL socket. Wires the
 * server tunnel (`driveChannelSocket`, adapting a `ws` server socket to
 * a `ChannelSocket`) to the client transport (`WebSocketTransport`, on
 * Node's global `WebSocket`) and proves the OPAQUE TUNNEL: the attach
 * rides up as the first text message, the SAME `\xFF`-marker segment +
 * lane bytes ride down as binary frames (parsed by the unchanged
 * `splitSegments`), and an upstream envelope applies through the shared
 * switch — its seq surfacing on the downstream `applied` marker.
 *
 * The server drive reuses `driveSegmentedResponse` unchanged; the only
 * new server code is the socket adapter + the message routing in
 * `driveChannelSocket`. The default transport stays fetch — this
 * exercises the opt-in path in isolation.
 */

import type { AddressInfo } from "node:net"
import { type WebSocket as WsSocket, WebSocketServer } from "ws"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _captureCommitHandle } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { decodeLane, freshLiveScope } from "../../test/live-drive.tsx"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import type { AttachStatement } from "../channel-protocol.ts"
import { type ChannelSocket, driveChannelSocket } from "../channel-server.ts"
import { probeWebSocketTransport, WebSocketTransport } from "../channel-transport.ts"
import { TAG_CONNECTION_ID, TAG_UPSTREAM_APPLIED } from "../fp-trailer-marker.ts"
import { type DemuxedLane, splitSegments } from "../fp-trailer-split.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { clearRegistry } from "../partial-registry.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { expires, time } from "../server-hooks.ts"

// A live ticker: content changes every render, wake declared in-body —
// so a lane arrives from the expiry boundary alone, no bump needed.
const renders = { n: 0 }
const WsClock = parton(
  function WsClockRender(_: RenderArgs) {
    renders.n++
    expires(time().in(80))
    return <time data-ws-clock>{`ws-tick-${renders.n}`}</time>
  },
  { selector: "ws-clock" },
)

/** Adapt a `ws` server socket to the transport-agnostic ChannelSocket
 *  the tunnel drives — the shape the Vite plugin builds in production. */
function wsToChannelSocket(ws: WsSocket): ChannelSocket {
  const drainCbs: Array<() => void> = []
  return {
    send(bytes) {
      try {
        // The send callback fires when the frame reaches the socket —
        // the real drain signal (no timer).
        ws.send(bytes, () => {
          for (const cb of [...drainCbs]) cb()
        })
      } catch {}
    },
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
    onMessage(handler) {
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Upstream (client→server) is TEXT: the attach then envelopes.
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8")
        handler(text)
      })
    },
    onClose(handler) {
      ws.on("close", handler)
    },
    onDrain(handler) {
      drainCbs.push(handler)
    },
  }
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.n = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("channel WebSocket transport", () => {
  it("tunnels the attach, first segment, and a lane over one socket; applies an upstream envelope", async () => {
    const scope = freshLiveScope("ws-smoke")
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const port = (wss.address() as AddressInfo).port

    wss.on("connection", (ws) => {
      const socket = wsToChannelSocket(ws)
      // The upgrade request carries the scope binding (cookies would ride
      // here too); the attach's stated URL is validated against its origin.
      const upgradeRequest = new Request("http://localhost/", {
        headers: { "x-test-scope": scope },
      })
      const renderOnce = (): ReadableStream<Uint8Array> =>
        wrapStreamWithFpTrailer(
          renderServerToFlight(
            <PartialRoot>
              <WsClock />
            </PartialRoot>,
          ),
          _captureCommitHandle(),
        )
      void driveChannelSocket(socket, upgradeRequest, renderOnce)
    })

    const transport = new WebSocketTransport(`ws://localhost:${port}`)
    const ac = new AbortController()
    const statement: AttachStatement = {
      url: "/ws-clock?live=1",
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

      // Segment 0 — the whole-tree render, tunneled down as binary.
      const first = await iter.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0 over WS")
      const seg0 = await new Response(first.value.body).text()
      await first.value.trailers
      expect(seg0).toContain("ws-tick-1")
      // The `conn` handshake arrived on the socket (establishment).
      expect(connId).toBeTruthy()

      // Upstream: an envelope on the SAME socket. Its seq must advance
      // the server's applied watermark — the upstream tunnel + the
      // shared apply switch, round-tripped.
      const accepted = await transport.send({
        connection: connId as unknown as string,
        seq: 9,
        frames: [{ kind: "ack", delivered: 0 }],
      })
      expect(accepted).toBe(true)

      // A lane from the 80ms expiry boundary, tunneled down as binary.
      const second = await iter.next()
      if (second.done || second.value.kind !== "lanes")
        throw new Error("expected lanes segment over WS")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()
      const lane = (await laneIter.next()).value as DemuxedLane
      expect(lane.partonId).toBe("ws-clock")
      const { bodyText } = await decodeLane(lane)
      expect(bodyText).toContain("ws-tick-2")

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
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})

describe("the atPark detach — the transport handover's graceful wind-down", () => {
  it("closes the stream cleanly at the next full park, serving open work first", async () => {
    const scope = freshLiveScope("ws-atpark")
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const port = (wss.address() as AddressInfo).port
    wss.on("connection", (ws) => {
      const socket = wsToChannelSocket(ws)
      const upgradeRequest = new Request("http://localhost/", {
        headers: { "x-test-scope": scope },
      })
      const renderOnce = (): ReadableStream<Uint8Array> =>
        wrapStreamWithFpTrailer(
          renderServerToFlight(
            <PartialRoot>
              <WsClock />
            </PartialRoot>,
          ),
          _captureCommitHandle(),
        )
      void driveChannelSocket(socket, upgradeRequest, renderOnce)
    })

    const transport = new WebSocketTransport(`ws://localhost:${port}`)
    const statement: AttachStatement = {
      url: "/ws-clock?live=1",
      cached: [],
      since: null,
      visible: null,
    }
    try {
      const { body } = await transport.open(statement)
      let connId: string | null = null
      const iter = splitSegments(body, undefined, (tag, b) => {
        if (tag === TAG_CONNECTION_ID) connId = new TextDecoder().decode(b)
      })[Symbol.asyncIterator]()

      // Segment 0 drains; the connection is established.
      const first = await iter.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await new Response(first.value.body).text()
      await first.value.trailers
      expect(connId).toBeTruthy()

      // State the graceful wind-down. The drive exits at its next full
      // park — nothing latched, no open lanes — and the stream ENDS
      // CLEANLY: the region exit is a between-frames close (no torn
      // bodies), so iteration completes without error. The expiry
      // ticker's due lanes keep serving until the park.
      const accepted = await transport.send({
        connection: connId as unknown as string,
        seq: 1,
        frames: [{ kind: "detach", atPark: true }],
      })
      expect(accepted).toBe(true)

      const deadline = Date.now() + 3000
      let ended = false
      while (Date.now() < deadline) {
        const next = await iter.next()
        if (next.done) {
          ended = true
          break
        }
        if (next.value.kind === "lanes") {
          for await (const lane of next.value.lanes) {
            await new Response(lane.body).arrayBuffer()
          }
        } else {
          await new Response(next.value.body).arrayBuffer().catch(() => {})
          await next.value.trailers
        }
      }
      expect(ended).toBe(true)
    } finally {
      transport.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})

describe("probeWebSocketTransport — the auto-upgrade confirmation", () => {
  // The probe is the auto-upgrade's gate: it CONFIRMS the socket works
  // before the client commits the handover, by watching for the same
  // `conn` handshake the live path establishes on — not a bare `onopen`.
  const probeStatement: AttachStatement = {
    url: "/ws-clock",
    cached: [],
    since: null,
    visible: null,
  }

  it("confirms (true) when the server drives the socket and mints conn", async () => {
    const scope = freshLiveScope("ws-probe-ok")
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const port = (wss.address() as AddressInfo).port
    wss.on("connection", (ws) => {
      const socket = wsToChannelSocket(ws)
      const upgradeRequest = new Request("http://localhost/", {
        headers: { "x-test-scope": scope },
      })
      const renderOnce = (): ReadableStream<Uint8Array> =>
        wrapStreamWithFpTrailer(
          renderServerToFlight(
            <PartialRoot>
              <WsClock />
            </PartialRoot>,
          ),
          _captureCommitHandle(),
        )
      void driveChannelSocket(socket, upgradeRequest, renderOnce)
    })
    try {
      const ok = await probeWebSocketTransport(probeStatement, {
        url: `ws://localhost:${port}`,
        timeoutMs: 3000,
      })
      expect(ok).toBe(true)
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it("declines (false) when the socket opens but is never driven (no conn)", async () => {
    // The endpoint exists and upgrades — a bare `onopen` would (wrongly)
    // say "works" — but nothing drives it, so `conn` never arrives and
    // the probe correctly declines. The server closes right after accept
    // so the probe resolves without waiting out its timeout.
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const port = (wss.address() as AddressInfo).port
    wss.on("connection", (ws) => {
      ws.close()
    })
    try {
      const ok = await probeWebSocketTransport(probeStatement, {
        url: `ws://localhost:${port}`,
        timeoutMs: 3000,
      })
      expect(ok).toBe(false)
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it("declines (false) when the endpoint is absent (WS-unavailable → stay on fetch)", async () => {
    // The fallback guarantee in miniature: no server on the port, the WS
    // handshake fails, the probe declines — the caller stays on fetch,
    // its held connection untouched.
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const deadPort = (wss.address() as AddressInfo).port
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    const ok = await probeWebSocketTransport(probeStatement, {
      url: `ws://127.0.0.1:${deadPort}`,
      timeoutMs: 3000,
    })
    expect(ok).toBe(false)
  })
})
