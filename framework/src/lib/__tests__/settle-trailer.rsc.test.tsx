/**
 * Settle-time fp-trailer emission — a parton's warm-fp entry ships the
 * moment ITS subtree settles, not when the whole render drains.
 *
 * The claims under test:
 *   1. on a cold render with a slow sibling, the fast parton's fp
 *      entry appears on the wire BEFORE the slow sibling's body bytes
 *      — the entry didn't wait for the stream flush;
 *   2. entries are cumulative (each emission carries the whole map),
 *      so the last entry on the wire equals exactly what the flush
 *      protocol ships — consumers keep last-wins semantics;
 *   3. the splitter records interleaved entries without ending the
 *      body block: the Flight body reassembles completely.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { cookie } from "../server-hooks.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { splitAtFpTrailer } from "../fp-trailer-split.ts"
import { runWithRequestAsync, _captureCommitHandle } from "../../runtime/context.ts"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Cold drift comes from the tracked read: render 1 emits a dep-less
// cold fp; the recompute folds the recorded cookie dep → {from,to}.
const FastDrift = parton(
  function FastDriftRender(_: RenderArgs) {
    const pref = cookie("pref") ?? ""
    return <span>{`fast-drift-body:${pref}`}</span>
  },
  { selector: "#settle-fast" },
)

const SlowSibling = parton(
  async function SlowSiblingRender(_: RenderArgs) {
    await delay(150)
    return <aside>slow-sibling-body</aside>
  },
  { selector: "#settle-slow" },
)

/** Drive the wrapped stream chunk by chunk, returning each chunk as
 *  latin1 text in arrival order (markers included — `\xFF` survives
 *  the latin1 round-trip, unlike utf-8 decoding). */
async function collectWireChunks(url: string, node: ReactNode): Promise<string[]> {
  const request = new Request(url, { headers: { cookie: "pref=a" } })
  const { result } = await runWithRequestAsync(request, async () => {
    const raw = renderServerToFlight(node)
    const wrapped = wrapStreamWithFpTrailer(raw, _captureCommitHandle())
    const chunks: string[] = []
    const reader = wrapped.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value).toString("latin1"))
    }
    return chunks
  })
  return result
}

beforeEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("settle-time trailer emission", () => {
  it("a fast parton's fp entry ships before a slow sibling's body bytes", async () => {
    const chunks = await collectWireChunks(
      "http://t/settle",
      <PartialRoot>
        <FastDrift />
        <SlowSibling />
      </PartialRoot>,
    )
    const wire = chunks.join("")
    // Sanity: both bodies and at least one fp entry naming the fast
    // parton made it onto the wire.
    expect(wire).toContain("fast-drift-body")
    expect(wire).toContain("slow-sibling-body")
    // The entry's JSON body chunk (`{"settle-fast":{"from"…`) — a shape
    // that never occurs in Flight body bytes.
    const fastEntryAt = chunks.findIndex((c) => c.includes('"settle-fast":{"from"'))
    const slowBodyAt = chunks.findIndex((c) => c.includes("slow-sibling-body"))
    expect(fastEntryAt).toBeGreaterThanOrEqual(0)
    expect(slowBodyAt).toBeGreaterThanOrEqual(0)
    // The load-bearing ordering: the fast parton's warm fp did NOT wait
    // for the slow sibling's render to drain.
    expect(fastEntryAt).toBeLessThan(slowBodyAt)
  })

  it("interleaved entries reassemble the body completely; last entry wins", async () => {
    const request = new Request("http://t/settle-split", {
      headers: { cookie: "pref=a" },
    })
    const { result } = await runWithRequestAsync(request, async () => {
      const raw = renderServerToFlight(
        <PartialRoot>
          <FastDrift />
          <SlowSibling />
        </PartialRoot>,
      )
      const wrapped = wrapStreamWithFpTrailer(raw, _captureCommitHandle())
      const { mainStream, trailer } = splitAtFpTrailer(wrapped)
      const bodyText = await new Response(mainStream).text()
      return { bodyText, trailer: await trailer }
    })
    // The body block was interrupted by settle-time entries; the
    // splitter must route them to the trailer map and keep every body
    // byte flowing.
    expect(result.bodyText).toContain("fast-drift-body")
    expect(result.bodyText).toContain("slow-sibling-body")
    expect(result.bodyText).not.toContain("ÿ")
    // Cumulative last-wins: the resolved trailer carries the fast
    // parton's drift entry ({from,to} object shape).
    const entry = result.trailer?.["settle-fast"] as { from: string; to: string } | undefined
    expect(entry?.from).toBeDefined()
    expect(entry?.to).toBeDefined()
    expect(entry?.to).not.toBe(entry?.from)
  })
})
