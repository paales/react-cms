/**
 * Live-drive test harness — runs `driveSegmentedResponse` against a
 * `?live=1` request through the REAL production pieces (fp-trailer
 * wrap, segment splitter, lane demux) with an in-process reader on the
 * other end. Shared by the lane-protocol and wake-hook rsc suites.
 */

import type { ReactNode } from "react"
import { _captureCommitHandle, runWithRequestAsync } from "../runtime/context.ts"
import { refreshSelector } from "../runtime/invalidation-registry.ts"
import { wrapStreamWithFpTrailer } from "../lib/fp-trailer.ts"
import { type DemuxedLane, splitAtFpTrailer, splitSegments } from "../lib/fp-trailer-split.ts"
import { driveSegmentedResponse } from "../lib/segmented-response.ts"
import { renderServerToFlight } from "./rsc-server.ts"

export interface DriveHandle {
  segments: AsyncIterator<
    ReturnType<typeof splitSegments> extends AsyncIterable<infer S> ? S : never
  >
  /** Ends the connection: cancels the client reader and wakes the
   *  parked driver with a bump so its enqueue fails and the loop
   *  exits without waiting out the 20s keepalive. */
  shutdown: (wakeSelector: string) => Promise<void>
}

export async function withLiveDrive(
  url: string,
  page: () => ReactNode,
  scope: string,
  run: (h: DriveHandle) => Promise<void>,
): Promise<void> {
  const request = new Request(url, { headers: { "x-test-scope": scope } })
  await runWithRequestAsync(request, async () => {
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
    const iter = splitSegments(response)[Symbol.asyncIterator]()
    await run({
      segments: iter,
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
