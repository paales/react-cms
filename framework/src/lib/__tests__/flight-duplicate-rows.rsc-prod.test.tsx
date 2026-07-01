import { describe, expect, it } from "vitest"
import { consumePayload, flightToString, renderServerToFlight } from "../../test/rsc-server.ts"

/**
 * Duplicate model rows against the PRODUCTION Flight client build.
 *
 * The prod client shares the dev build's duplicate-row code path
 * byte-for-byte in shape (`react-server-dom-webpack-client.edge.
 * production.js`): the untyped-row dispatch routes an existing chunk
 * to `resolveModelChunk` (~L1930), which treats any non-`pending`
 * chunk as a stream slot — `chunk.reason.enqueueModel(value)` (L864).
 * A plain model chunk's `reason` is never a controller, so the
 * duplicate throws, `reportGlobalError` closes the response, pending
 * chunks reject, and later rows go unprocessed. This suite pins that
 * the prod build behaves identically to dev (dev twin:
 * `flight-duplicate-rows.rsc.test.tsx`) — same first-value-wins, same
 * teardown, no prod-only leniency.
 */

const PROD = process.env.NODE_ENV === "production"

function bytesToStream(
  text: string,
  tail?: { delayMs: number; text: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(text))
      if (tail) {
        await new Promise((r) => setTimeout(r, tail.delayMs))
        controller.enqueue(encoder.encode(tail.text))
      }
      controller.close()
    },
  })
}

function lazyPayload(node: unknown): Promise<unknown> {
  return (node as { _payload: Promise<unknown> })._payload
}

describe.skipIf(!PROD)("duplicate model rows — PRODUCTION Flight build", () => {
  it("loaded the production build (guard)", async () => {
    // The dev server build emits componentDebugInfo rows the prod build
    // omits. Fails loud if NODE_ENV didn't swap the builds in.
    const text = await flightToString(renderServerToFlight(<p>guard</p>))
    expect(text).not.toMatch(/"env":/)
  })

  it("keeps the FIRST value; the duplicate never reaches the tree", async () => {
    const stream = bytesToStream('0:{"value":"$1"}\n1:"first"\n1:"second"\n')
    const root = await consumePayload<{ value: string }>(stream)
    expect(root.value).toBe("first")
  })

  it("tears down the rest of the response: pending refs reject with the TypeError", async () => {
    const stream = bytesToStream(
      '0:{"a":"$1","b":"$L2"}\n1:"first"\n1:"second"\n2:"never-processed"\n',
    )
    const root = await consumePayload<{ a: string; b: unknown }>(stream)
    expect(root.a).toBe("first")
    await expect(lazyPayload(root.b)).rejects.toThrow(/enqueueModel/)
  })

  it("duplicate of an already-initialized chunk also errors (reason is null)", async () => {
    const stream = bytesToStream('0:{"a":"$1","b":"$L2"}\n1:"first"\n', {
      delayMs: 30,
      text: '1:"second"\n2:"late"\n',
    })
    const root = await consumePayload<{ a: string; b: unknown }>(stream)
    expect(root.a).toBe("first")
    await expect(lazyPayload(root.b)).rejects.toThrow(/enqueueModel/)
  })
})
