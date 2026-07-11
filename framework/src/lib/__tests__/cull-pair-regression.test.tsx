/**
 * CullPair's regression detector — the producer of the clobber-class
 * loss signal. A commit that leaves an IN-VIEW pair's content slot
 * unbacked (the cache entry behind its substitution was destroyed)
 * regresses the display content→skeleton with no client-stated
 * out-flip; the pair writes the explicit signal
 * (`_visibilityContentRegressed`): the id's visibility baseline resets
 * so the skeleton observer's next measurement re-states the flip, and
 * the loss rides the next ack's `evicted` statement.
 *
 * Negative claims: a pair that never had content (first bytes still
 * streaming) fires nothing, and a regression that arrives WITH a
 * stated out-flip (the display honors it — `out` flips in the same
 * commit) is a normal cull-out, not a loss.
 */

import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetChannelClient } from "../channel-client.ts"
import type { AckFrame, ChannelEnvelope } from "../channel-protocol.ts"
import { CullPair } from "../cull-pair.tsx"
import { _resetCullPark, reportCullState } from "../cull-park.ts"
import { _resetVisibilityController } from "../visibility.tsx"

class StubIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return []
  }
}

let rafQueue: FrameRequestCallback[] = []
function raf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb(0)
}

let fetchCalls: Array<{ init: RequestInit }> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function sentAcks(): AckFrame[] {
  return fetchCalls
    .flatMap((c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames)
    .filter((f): f is AckFrame => f.kind === "ack")
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  rafQueue = []
  fetchCalls = []
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver)
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    fetchCalls.push({ init })
    return Promise.resolve({ status: 204 })
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  vi.unstubAllGlobals()
})

const hole = (id: string): React.ReactNode => (
  <i hidden data-partial data-partial-id={id} data-partial-match="mk" />
)

function pair(id: string, culled: boolean, children: React.ReactNode): React.ReactNode {
  return (
    <CullPair id={id} culled={culled} skel={<span data-skel="" />}>
      {children}
    </CullPair>
  )
}

/** The pending evicted ids, read off the wire: fire a flush-justifying
 *  report is not needed — the regression itself schedules one. */
async function flushedEvicted(): Promise<string[]> {
  raf()
  await settle()
  return sentAcks().flatMap((a) => a.evicted ?? [])
}

describe("CullPair regression detector", () => {
  it("an in-view pair losing its content reports the loss and re-arms the flip", async () => {
    const { _channelEstablished } = await import("../channel-client.ts")
    _channelEstablished("c1")
    // Displayed in view: the live report says so (the id flipped in
    // at some point), and the content slot holds real content.
    reportCullState("pair-x", true)
    act(() => {
      root.render(pair("pair-x", false, <div data-content="">CONTENT</div>))
    })
    // The clobber: a commit re-renders the pair with an unbacked hole
    // while the display still says in-view.
    act(() => {
      root.render(pair("pair-x", false, hole("pair-x")))
    })
    expect(await flushedEvicted()).toEqual(["pair-x"])
    // The pair fell back to its skeleton — the loss is visible.
    expect(container.querySelector("[data-skel]")).not.toBeNull()
  })

  it("a pair that never had content fires nothing", async () => {
    act(() => {
      root.render(pair("pair-cold", false, hole("pair-cold")))
    })
    act(() => {
      root.render(pair("pair-cold", false, hole("pair-cold")))
    })
    expect(await flushedEvicted()).toEqual([])
  })

  it("a stated out-flip regressing the slot is a cull-out, not a loss", async () => {
    reportCullState("pair-out", true)
    act(() => {
      root.render(pair("pair-out", false, <div>CONTENT</div>))
    })
    // The client stated the out-flip; the commit that follows may
    // legitimately carry the culled emission's hole.
    act(() => {
      reportCullState("pair-out", false)
    })
    act(() => {
      root.render(pair("pair-out", true, hole("pair-out")))
    })
    expect(await flushedEvicted()).toEqual([])
  })
})
