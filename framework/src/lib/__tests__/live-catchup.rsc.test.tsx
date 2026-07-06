/**
 * Live catch-up — `?since=<epoch>:<ts>` skips the initial segment.
 *
 * The document's SSR trailer carries a registry anchor; the
 * heartbeat's first `?live=1` fire presents it. The claims:
 *
 *   1. a valid anchor opens the connection STRAIGHT INTO LANES — no
 *      whole-route initial segment — and the first wake lanes exactly
 *      the partons that bumped after the anchor (siblings untouched)
 *   2. an anchor from a different epoch (another registry lifetime —
 *      a restart, a clear) is refused: the connection falls back to
 *      the full initial render, over-fetch never stale.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  _currentTs,
  _registryEpoch,
  refreshSelector,
} from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { a: 0, b: 0 }

const LiveA = parton(
  function LiveARender(_: RenderArgs) {
    renders.a++
    return <div data-a>{`a:${renders.a}`}</div>
  },
  { selector: "live-a" },
)

const LiveB = parton(
  function LiveBRender(_: RenderArgs) {
    renders.b++
    return <div data-b>{`b:${renders.b}`}</div>
  },
  { selector: "live-b" },
)

function Page(): ReactNode {
  return (
    <PartialRoot>
      <LiveA />
      <LiveB />
    </PartialRoot>
  )
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.a = 0
  renders.b = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("live catch-up (?since=)", () => {
  it("a valid anchor opens straight into lanes; the first wake lanes only what bumped after it", async () => {
    const scope = freshLiveScope("catchup")
    // The "document": renders the route, landing snapshots in the
    // registry. Its anchor is the timeline point right after.
    const { stream } = await renderWithRequest(
      "http://localhost/page",
      <Page />,
      {
        headers: { "x-test-scope": scope },
      },
    )
    await new Response(stream).text()
    const anchorTs = _currentTs()
    expect(renders.a).toBe(1)
    expect(renders.b).toBe(1)

    // Something bumps after the document rendered — the catch-up's job.
    refreshSelector("live-b")

    const conn = "conn-catchup-1"
    await withLiveDrive(
      `http://localhost/page?live=1&__conn=${conn}&since=${_registryEpoch()}:${anchorTs}`,
      Page,
      scope,
      async (h) => {
        // FIRST segment is the lanes region — no whole-route replay.
        const first = await h.segments.next()
        if (first.done) throw new Error("expected a first segment")
        expect(first.value.kind).toBe("lanes")
        if (first.value.kind !== "lanes") return
        const laneIter = first.value.lanes[Symbol.asyncIterator]()
        const step = await laneIter.next()
        if (step.done) throw new Error("expected a catch-up lane")
        expect(step.value.partonId).toBe("live-b")
        expect((await decodeLane(step.value)).bodyText).toContain("b:2")
        // The untouched sibling never re-rendered and never laned.
        expect(renders.a).toBe(1)

        await h.shutdown("live-b")
      },
    )
  })

  it("an anchor from another registry lifetime is refused — full initial render", async () => {
    const scope = freshLiveScope("catchup")
    const { stream } = await renderWithRequest(
      "http://localhost/page",
      <Page />,
      {
        headers: { "x-test-scope": scope },
      },
    )
    await new Response(stream).text()
    const anchorTs = _currentTs()

    const conn = "conn-catchup-2"
    await withLiveDrive(
      `http://localhost/page?live=1&__conn=${conn}&since=stale-epoch:${anchorTs}`,
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done) throw new Error("expected a first segment")
        expect(first.value.kind).toBe("payload")
        if (first.value.kind !== "payload") return
        const seg0 = await drainPayloadSegment(first.value)
        expect(seg0).toContain("a:")
        expect(seg0).toContain("b:")

        await h.shutdown("live-a")
      },
    )
  })
})
