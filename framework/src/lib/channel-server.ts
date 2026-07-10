/**
 * The server half of the full-duplex transports — a channel over ONE
 * connection, behind the same channel semantics the fetch endpoints
 * serve. Two drivers, one shape:
 *
 *   - `driveChannelSocket` — a WebSocket, via the abstract
 *     [[ChannelSocket]] adapter (a Vite plugin, [[vite/channel-server]],
 *     adapts a `ws` socket for dev/preview).
 *   - `driveChannelWebTransport` — a WebTransport (HTTP/3) bidirectional
 *     stream (a standalone QUIC server drives it — `createWebTransportServer`
 *     in the RSC entry; Vite serves no HTTP/3).
 *
 * Both are OPAQUE TUNNELS: the SAME `\xFF`-marker downstream byte stream
 * the fetch attach serves rides down (binary WS messages / the bidi
 * stream's readable half), and the SAME JSON attach/envelopes ride up
 * (WS text messages / newline-delimited JSON on the bidi stream's
 * writable half) — no reframing of the marker wire, so the whole protocol
 * above (`driveSegmentedResponse`, the connection session,
 * `applyEnvelopeToSession`) is reused UNCHANGED.
 *
 * Each connection is inherently bound (one connection per socket/session),
 * so envelopes only prove they name THIS connection's session under the
 * attach's scope + cookie (`_resolveBoundSession`) — the origin check
 * lives at the handshake, not per-message. This module carries no
 * RSC-render dependency, so its testable core imports without one.
 */

import { runWithRequestAsync } from "../runtime/context.ts"
import { HEADER_RSC_RENDER } from "../runtime/request.tsx"
import {
  type AttachStatement,
  type ChannelEnvelope,
  decodeAttachStatement,
  decodeChannelEnvelope,
} from "./channel-protocol.ts"
import {
  _resolveBoundSession,
  applyEnvelopeToSession,
  bindAttachStatement,
} from "./connection-session.ts"
import { driveSegmentedResponse, type SegmentedResponseDemand } from "./segmented-response.ts"

/**
 * Buffered bytes past which the driver's downstream enqueues park until
 * a queued send flushes (`onDrain`) — the WebSocket mirror of the fetch
 * response stream's `desiredSize` pull-gate.
 */
const SOCKET_HIGH_WATER_MARK = 1 << 20 // 1 MB

/**
 * The transport-adapter seam. A Vite plugin (or any host) implements
 * this over its socket library; `driveChannelSocket` speaks only to it.
 * The downstream carries binary marker bytes (`send`); the upstream
 * carries text (attach + envelopes, `onMessage`). Backpressure is the
 * two real signals: `bufferedAmount` (how much is queued) and `onDrain`
 * (a queued send actually flushed) — no timers.
 */
export interface ChannelSocket {
  /** Write one downstream binary frame — the segment/lane marker bytes. */
  send(bytes: Uint8Array): void
  /** Bytes queued but not yet flushed to the network
   *  (`WebSocket.bufferedAmount`) — the backpressure level. */
  readonly bufferedAmount: number
  /** Close the socket (winds the drive down). */
  close(): void
  /** Register the upstream text handler: the attach statement (first
   *  message) then channel envelopes. */
  onMessage(handler: (data: string) => void): void
  /** Register the close handler — the client is gone (tab close,
   *  network drop), the drive's teardown signal. */
  onClose(handler: () => void): void
  /** Register a flush signal: a previously-queued `send` reached the
   *  network, so a parked enqueue may resume. */
  onDrain(handler: () => void): void
}

/**
 * Drive one channel connection over a socket. The attach is the FIRST
 * upstream message (mirrors the fetch attach's POST body); envelopes
 * follow on the same socket. On the attach, binds the statement and runs
 * `driveSegmentedResponse` UNCHANGED — its `enqueue` writes down the
 * socket, its `demand` reads socket backpressure. Each subsequent
 * envelope applies through the SAME `applyEnvelopeToSession` switch the
 * fetch endpoint uses, in a request scope carrying the upgrade's cookies
 * (so a frame-url's session write lands where the client's cookie
 * resolves). Resolves when the connection ends.
 *
 * `request` is the upgrade request — its headers (the `Cookie`) supply
 * the scope + session identity binding; its URL supplies the origin the
 * attach's stated URL is validated against. `renderSegment` produces one
 * segment's Flight stream (fp-trailer-wrapped), the same closure the
 * fetch attach passes to `createSegmentedResponse`.
 */
export async function driveChannelSocket(
  socket: ChannelSocket,
  request: Request,
  renderSegment: () => ReadableStream<Uint8Array>,
): Promise<void> {
  const origin = new URL(request.url).origin

  // Downstream backpressure — the WebSocket twin of the response
  // stream's pull-gate. Enqueues park while the socket's buffer sits
  // past the high-water mark; a flushed send (`onDrain`) releases the
  // parked pumps. A close winds the drive down: `cancelled` surfaces at
  // the next lane enqueue (mirroring the fetch stream's `cancel()`), so
  // a mid-lane torn socket stops promptly and a fully-parked one is
  // reaped by the keepalive backstop or a `detach` frame — parity with
  // the fetch transport.
  let drainWaiters: Array<() => void> = []
  const releaseDrain = (): void => {
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }
  socket.onDrain(releaseDrain)
  const demand: SegmentedResponseDemand = {
    cancelled: false,
    pulled: () =>
      demand.cancelled
        ? Promise.resolve()
        : new Promise<void>((resolve) => drainWaiters.push(resolve)),
  }
  // `driveSegmentedResponse` touches only `enqueue` + `desiredSize`
  // (never `close`/`error` — those are the fetch stream wrapper's job),
  // so a minimal shim stands in for the response controller.
  const controller = {
    enqueue(bytes: Uint8Array): void {
      socket.send(bytes)
    },
    get desiredSize(): number | null {
      return demand.cancelled ? null : SOCKET_HIGH_WATER_MARK - socket.bufferedAmount
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  socket.onClose(() => {
    demand.cancelled = true
    releaseDrain()
  })

  let attached = false
  socket.onMessage((data) => {
    if (!attached) {
      attached = true
      const statement = decodeStatement(data)
      if (statement === null || !sameOriginAttach(statement, origin)) {
        socket.close()
        resolveDone()
        return
      }
      const stated = new URL(statement.url, origin)
      // The one-shot `__force` overlay never enters request state (the
      // driver reads it off the statement and lanes the targets after
      // the region opens) — mirror the attach endpoint's strip.
      stated.searchParams.delete("__force")
      const headers = new Headers(request.headers)
      headers.set(HEADER_RSC_RENDER, "1")
      const renderRequest = new Request(stated, { headers })
      void runWithRequestAsync(renderRequest, async () => {
        bindAttachStatement(statement)
        await driveSegmentedResponse(controller, renderSegment, undefined, demand)
      }).then(resolveDone, resolveDone)
      return
    }
    // A channel envelope — apply it through the shared switch in a
    // request scope carrying the upgrade's cookies. A malformed or
    // unbound envelope is dropped (a WebSocket has no per-message
    // response to answer 400/404 with; the client's retransmit buffer
    // + the keepalive backstop cover the loss).
    const envelope = decodeEnvelope(data)
    if (envelope === null) return
    void runWithRequestAsync(request, async () => {
      const session = _resolveBoundSession(envelope.connection)
      if (session === null) return
      applyEnvelopeToSession(session, envelope, request.url)
    })
  })

  await done
  // The drive finished (keepalive elapse, detach, the handover's
  // park-exit) — close the socket so the client's downstream body ends,
  // exactly as the fetch wrapper closes its response stream. Without
  // this the client would hold a silent socket for a stream the server
  // already wound down.
  socket.close()
}

/**
 * A WebTransport bidirectional stream, structurally — the two
 * independent byte half-streams `driveChannelWebTransport` drives. Matches
 * the DOM `WebTransportBidirectionalStream` (whose `readable`/`writable`
 * are typed as `any`-chunked) narrowed to the `Uint8Array` chunks the
 * tunnel carries, so a standalone QUIC server passes its session's bidi
 * stream straight in and a test passes a fake duplex (a pair of
 * `TransformStream`s).
 */
export interface ChannelDuplexStream {
  /** Upstream: newline-delimited JSON — the attach (first line) then
   *  channel envelopes. */
  readonly readable: ReadableStream<Uint8Array>
  /** Downstream: the segment/lane `\xFF`-marker bytes, unframed. */
  readonly writable: WritableStream<Uint8Array>
}

/**
 * Drive one channel connection over a WebTransport (HTTP/3) bidirectional
 * stream — the WebTransport twin of `driveChannelSocket`. The attach is
 * the FIRST upstream line; envelopes follow, each `\n`-terminated (a QUIC
 * stream is raw bytes with no message boundaries, so the upstream half
 * carries the newline delimiter the WebSocket gives for free — the
 * DOWNSTREAM half stays byte-identical, unframed). On the attach, binds
 * the statement and runs `driveSegmentedResponse` UNCHANGED: its `enqueue`
 * writes the marker bytes to the stream's writable, its `demand` reads the
 * writable's native backpressure (`writer.desiredSize` / `writer.ready` —
 * no timers, no `bufferedAmount` indirection). Each subsequent line
 * applies through the SAME `applyEnvelopeToSession` switch the fetch
 * endpoint uses, in a request scope carrying the upgrade's cookies.
 * Resolves when the connection ends (the drive winds down and the
 * writable closes so the client's downstream body ends).
 *
 * `request` is the connect request — its headers (the `Cookie`) supply
 * the scope + session identity binding, its URL the origin the attach's
 * stated URL is validated against. `renderSegment` is the same closure
 * the fetch attach and the WS driver pass.
 */
export async function driveChannelWebTransport(
  stream: ChannelDuplexStream,
  request: Request,
  renderSegment: () => ReadableStream<Uint8Array>,
): Promise<void> {
  const origin = new URL(request.url).origin
  const writer = stream.writable.getWriter()

  // Downstream backpressure — the WebTransport twin of the response
  // stream's pull-gate, sourced from the writable's OWN signals:
  // `writer.desiredSize` is the queue headroom (≤ 0 = at the high-water
  // mark) and `writer.ready` resolves when a queued write flushes. A
  // teardown (the upstream ending, or a downstream write erroring) flips
  // `cancelled` and wakes any parked pump — `cancelled` then surfaces at
  // the next lane enqueue (mirroring the fetch stream's `cancel()`), so a
  // mid-lane torn session stops promptly and a fully-parked one is reaped
  // by the keepalive backstop or a `detach` frame, parity with fetch/WS.
  let resolveCancelled!: () => void
  const cancelledSignal = new Promise<void>((resolve) => {
    resolveCancelled = resolve
  })
  const demand: SegmentedResponseDemand = {
    cancelled: false,
    pulled: () =>
      demand.cancelled
        ? Promise.resolve()
        : Promise.race([
            writer.ready.then(
              () => {},
              () => {},
            ),
            cancelledSignal,
          ]),
  }
  const teardown = (): void => {
    if (demand.cancelled) return
    demand.cancelled = true
    resolveCancelled()
  }
  // `driveSegmentedResponse` touches only `enqueue` + `desiredSize`
  // (never `close`/`error` — those are this driver's teardown), so a
  // minimal shim stands in for the response controller.
  const controller = {
    enqueue(bytes: Uint8Array): void {
      if (demand.cancelled) return
      void writer.write(bytes).catch(teardown)
    },
    get desiredSize(): number | null {
      return demand.cancelled ? null : writer.desiredSize
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let driveStarted = false
  let attached = false

  const handleLine = (line: string): void => {
    // Tolerate blank lines (a stray delimiter is never a message).
    if (line.length === 0) return
    if (!attached) {
      attached = true
      driveStarted = true
      const statement = decodeStatement(line)
      if (statement === null || !sameOriginAttach(statement, origin)) {
        teardown()
        resolveDone()
        return
      }
      const stated = new URL(statement.url, origin)
      // The one-shot `__force` overlay never enters request state —
      // mirror the attach endpoint's strip.
      stated.searchParams.delete("__force")
      const headers = new Headers(request.headers)
      headers.set(HEADER_RSC_RENDER, "1")
      const renderRequest = new Request(stated, { headers })
      void runWithRequestAsync(renderRequest, async () => {
        bindAttachStatement(statement)
        await driveSegmentedResponse(controller, renderSegment, undefined, demand)
      }).then(resolveDone, resolveDone)
      return
    }
    // A channel envelope — apply it through the shared switch in a
    // request scope carrying the connect request's cookies. A malformed
    // or unbound envelope is dropped (a tunnel has no per-message
    // response to answer 400/404 with; the client's retransmit buffer +
    // the keepalive backstop cover the loss).
    const envelope = decodeEnvelope(line)
    if (envelope === null) return
    void runWithRequestAsync(request, async () => {
      const session = _resolveBoundSession(envelope.connection)
      if (session === null) return
      applyEnvelopeToSession(session, envelope, request.url)
    })
  }

  // The upstream read loop — decode UTF-8, split on the newline
  // delimiter, dispatch each complete line. Runs concurrently with the
  // drive (the attach's `driveSegmentedResponse` is kicked off unawaited
  // above, so later envelopes still flow through here).
  const reader = stream.readable.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    let buffer = ""
    try {
      for (;;) {
        const { value, done: readDone } = await reader.read()
        if (readDone) break
        buffer += decoder.decode(value, { stream: true })
        for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          handleLine(line)
        }
      }
    } catch {}
    // The upstream ended — the client is gone (session closed). Wind the
    // drive down; if the attach never arrived there is no drive to
    // resolve `done`, so resolve it here.
    teardown()
    if (!driveStarted) resolveDone()
  })()

  await done
  // The drive finished (keepalive elapse, detach, torn session) — close
  // the downstream so the client's body ends, and release the upstream.
  teardown()
  try {
    await writer.close()
  } catch {}
  try {
    await reader.cancel()
  } catch {}
}

function decodeStatement(data: string): AttachStatement | null {
  try {
    return decodeAttachStatement(JSON.parse(data))
  } catch {
    return null
  }
}

function decodeEnvelope(data: string): ChannelEnvelope | null {
  try {
    return decodeChannelEnvelope(JSON.parse(data))
  } catch {
    return null
  }
}

/** Same-origin gate for the attach's stated URL + any frame targets —
 *  the WebSocket twin of the attach endpoint's validation (the upgrade
 *  handshake already proved the socket's own origin). */
function sameOriginAttach(statement: AttachStatement, origin: string): boolean {
  try {
    if (new URL(statement.url, origin).origin !== origin) return false
    for (const frame of statement.frames ?? []) {
      if (new URL(frame.url, origin).origin !== origin) return false
    }
    return true
  } catch {
    return false
  }
}
