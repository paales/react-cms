import { describe, expect, it } from "vitest"
import { consumePayload, flightToString, renderServerToFlight } from "../../test/rsc-server.ts"
import { splitRows } from "../flight-graph.ts"
import { parseRow } from "../flight-rewrite.ts"

/**
 * What the Flight CLIENT does when the same row id is written twice in
 * one response — the "can one slot be updated in place?" experiment
 * behind `docs/notes/flight-multi-update.md`.
 *
 * Ground truth in the vendored client
 * (`@vitejs/plugin-rsc/vendor/react-server-dom/cjs/
 * react-server-dom-webpack-client.edge.development.js`, and the
 * `.production.js` twin exercised by the `rsc-prod` tier):
 *
 * - An untyped model row for an id that already has a chunk dispatches
 *   to `resolveModelChunk(response, chunk, buffer)` (dev ~L4464,
 *   prod ~L1930).
 * - `resolveModelChunk` treats any non-`pending` chunk as a STREAM
 *   slot: `if ("pending" !== chunk.status) chunk.reason.enqueueModel(value)`
 *   (dev L1812, prod L863). Only the controller objects installed by
 *   `startReadableStream` / `startAsyncIterable` have an
 *   `enqueueModel` method. For a plain model chunk, `reason` is the
 *   Response (uninitialized `resolved_model`) or `null` (initialized
 *   `fulfilled`) — so the duplicate throws a TypeError.
 * - The TypeError escapes `processFullBinaryRow` → rejects the read
 *   loop's promise chain → `reportGlobalError` (dev L1951): the
 *   response is marked closed, every PENDING chunk rejects with the
 *   TypeError, and no further rows of the response are processed.
 *
 * So a duplicate plain row is neither "last write wins" nor a silent
 * skip: the first value stays, the second never reaches the tree, and
 * the rest of the response is torn down. Multi-write slots exist in
 * the wire format, but only for stream-typed rows (`R`/`r`/`X`/`x`)
 * — see `flight-stream-slots.rsc.test.tsx`.
 */

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

/** Unwrap a decoded `$L<id>` lazy to its underlying chunk promise. */
function lazyPayload(node: unknown): Promise<unknown> {
  return (node as { _payload: Promise<unknown> })._payload
}

describe("duplicate model rows — Flight client, dev build", () => {
  it("keeps the FIRST value; the duplicate never reaches the tree", async () => {
    // Row 1 arrives twice with different content before anything
    // initializes. The dup throws inside the row loop (the chunk's
    // `reason` is the Response, which has no `enqueueModel`), but the
    // already-buffered `resolved_model` chunks initialize lazily on
    // await — so the root still decodes, with the first value.
    const stream = bytesToStream('0:{"value":"$1"}\n1:"first"\n1:"second"\n')
    const root = await consumePayload<{ value: string }>(stream)
    expect(root.value).toBe("first")
  })

  it("tears down the rest of the response: pending refs reject with the TypeError", async () => {
    // `b` references row 2, which is only written AFTER the duplicate.
    // The dup's TypeError stops row processing, so row 2 is never read
    // and the closed response mints a rejected chunk for it.
    const stream = bytesToStream(
      '0:{"a":"$1","b":"$L2"}\n1:"first"\n1:"second"\n2:"never-processed"\n',
    )
    const root = await consumePayload<{ a: string; b: unknown }>(stream)
    expect(root.a).toBe("first")
    await expect(lazyPayload(root.b)).rejects.toThrow(/enqueueModel/)
  })

  it("duplicate of an already-initialized chunk also errors (reason is null)", async () => {
    // Await the root FIRST so chunk 1 initializes to `fulfilled`
    // (`reason = null`), then let the duplicate arrive. The client
    // still routes it through `chunk.reason.enqueueModel` — now a
    // null deref — and the pending `$L2` rejects via reportGlobalError.
    const stream = bytesToStream('0:{"a":"$1","b":"$L2"}\n1:"first"\n', {
      delayMs: 30,
      text: '1:"second"\n2:"late"\n',
    })
    const root = await consumePayload<{ a: string; b: unknown }>(stream)
    expect(root.a).toBe("first")
    await expect(lazyPayload(root.b)).rejects.toThrow(/enqueueModel/)
    expect(root.a).toBe("first") // value untouched by the dup
  })

  it("a real server render never emits two untyped model rows for one id", async () => {
    // The server allocates one task id per outlined model and only
    // reuses an id for stream-value rows / debug (`D`) sidecars. So
    // duplicate PLAIN rows cannot arise from `renderToReadableStream`
    // — only from post-processing (splice bugs) or a hand-built wire.
    function Late() {
      return new Promise<string>((r) => setTimeout(() => r("late"), 10))
    }
    const text = await flightToString(
      renderServerToFlight(
        <div>
          <p>static</p>
          <Late />
        </div>,
      ),
    )
    const seen = new Map<string, number>()
    for (const line of splitRows(new TextEncoder().encode(text))) {
      const row = parseRow(line)
      if (row.type !== "") continue // D/W debug rows may share the model's id
      seen.set(row.id, (seen.get(row.id) ?? 0) + 1)
    }
    for (const [id, count] of seen) {
      expect(count, `model row ${id} emitted ${count}×`).toBe(1)
    }
  })
})
