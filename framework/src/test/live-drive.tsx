/**
 * Live-drive test harness — runs `driveSegmentedResponse` against a
 * `?live=1` request through the REAL production pieces (fp-trailer
 * wrap, segment splitter, lane demux) with an in-process reader on the
 * other end. Shared by the lane-protocol and wake-hook rsc suites.
 */

import type { ReactNode } from "react"
import { _captureCommitHandle, runWithRequestAsync } from "../runtime/context.ts"
import { refreshSelector } from "../runtime/invalidation-registry.ts"
import { ATTACH_HEADER, type AttachStatement } from "../lib/channel-protocol.ts"
import { applyAttachStatement } from "../lib/connection-session.ts"
import { TAG_CONNECTION_ID } from "../lib/fp-trailer-marker.ts"
import { wrapStreamWithFpTrailer } from "../lib/fp-trailer.ts"
import { type DemuxedLane, splitAtFpTrailer, splitSegments } from "../lib/fp-trailer-split.ts"
import { driveSegmentedResponse } from "../lib/segmented-response.ts"
import { renderServerToFlight } from "./rsc-server.ts"

export interface DriveHandle {
  segments: AsyncIterator<
    ReturnType<typeof splitSegments> extends AsyncIterable<infer S> ? S : never
  >
  /** The server-minted connection id, once the stream's `conn` entry
   *  has been read (null before). On the full path it precedes the
   *  first segment's Flight rows, so it is set by the time segment 0
   *  drains; on the catch-up path it is the lanes region's first
   *  frame, read on the way to the first lane. */
  connectionId: () => string | null
  /** Every wire ENTRY read so far, in arrival order (tag + decoded
   *  body) — how tests observe the `seq` delivery entries and the
   *  `applied` upstream watermark alongside the `conn` handshake. */
  entries: Array<{ tag: string; body: string }>
  /** Ends the connection: cancels the client reader and wakes the
   *  parked driver with a bump so its enqueue fails and the loop
   *  exits without waiting out the 20s keepalive. */
  shutdown: (wakeSelector: string) => Promise<void>
}

export interface LiveDriveInit {
  /** Drive an ATTACH — a POST whose body is the client statement,
   *  bound through the same `applyAttachStatement` seam the entry
   *  uses, so the driver's statement reads see production state. */
  attach?: AttachStatement
  /** Extra request headers (e.g. a `cookie` for the session-identity
   *  binding the attach records). */
  headers?: Record<string, string>
}

export async function withLiveDrive(
  url: string,
  page: () => ReactNode,
  scope: string,
  run: (h: DriveHandle) => Promise<void>,
  init?: LiveDriveInit,
): Promise<void> {
  const request = init?.attach
    ? new Request(url, {
        method: "POST",
        headers: {
          "x-test-scope": scope,
          [ATTACH_HEADER]: "1",
          "content-type": "application/json",
          ...init.headers,
        },
        body: JSON.stringify(init.attach),
      })
    : new Request(url, { headers: { "x-test-scope": scope, ...init?.headers } })
  await runWithRequestAsync(request, async () => {
    if (init?.attach) {
      const statement = await applyAttachStatement(request)
      if (statement === null) throw new Error("malformed attach statement")
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const response = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const renderOnce = () =>
      wrapStreamWithFpTrailer(renderServerToFlight(page()), _captureCommitHandle())
    const drive = driveSegmentedResponse(controller, renderOnce).then(() => {
      try {
        controller.close()
      } catch {}
    })
    let connectionId: string | null = null
    const entries: Array<{ tag: string; body: string }> = []
    const iter = splitSegments(response, undefined, (tag, body) => {
      const text = new TextDecoder().decode(body)
      entries.push({ tag, body: text })
      if (tag === TAG_CONNECTION_ID) connectionId = text
    })[Symbol.asyncIterator]()
    await run({
      segments: iter,
      connectionId: () => connectionId,
      entries,
      shutdown: async (wakeSelector: string) => {
        await iter.return?.()
        // The parked driver only observes the torn controller on its
        // next enqueue; a matching bump forces that wake.
        refreshSelector(wakeSelector)
        await drive
      },
    })
  })
}

export async function drainPayloadSegment(seg: {
  kind: "payload"
  body: ReadableStream<Uint8Array>
  trailers: Promise<Map<string, Uint8Array>>
}): Promise<string> {
  const text = await new Response(seg.body).text()
  await seg.trailers
  return text
}

export async function decodeLane(lane: DemuxedLane): Promise<{
  bodyText: string
  fp: Record<string, { from: string; to: string }> | null
}> {
  const { mainStream, trailer } = splitAtFpTrailer(lane.body)
  const bodyText = await new Response(mainStream).text()
  const fp = (await trailer) as Record<string, { from: string; to: string }> | null
  return { bodyText, fp }
}

let scopeCounter = 0
export function freshLiveScope(prefix: string): string {
  return `${prefix}-${Date.now()}-${scopeCounter++}`
}
