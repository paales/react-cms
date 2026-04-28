import { describe, expect, it } from "vitest"
import { consumePayload, renderServerToFlight } from "../../test/rsc-server.ts"

/**
 * Flight client streaming semantics.
 *
 * Previously shelled out to a CJS subprocess (see
 * `flight-streaming-helper.cjs`) because the vendored browser Flight
 * client fought with Vitest's ESM transform. We now run everything
 * in-process inside the `rsc` Vitest project, which provides the
 * `react-server` condition and uses the edge variants of the Flight
 * runtime — no `__webpack_require__` dance needed.
 */

function timedStream(chunks: Array<[delayMs: number, data: string]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const [delay, data] of chunks) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        controller.enqueue(encoder.encode(data))
      }
      controller.close()
    },
  })
}

describe("Flight client streaming", () => {
  it("root thenable resolves BEFORE the stream ends", async () => {
    const stream = timedStream([
      [0, '0:{"value":"$L1"}\n'],
      [500, '1:"delayed-content"\n'],
    ])
    const start = Date.now()
    const root = await consumePayload<{ value: unknown }>(stream)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100)
    expect((root.value as { $$typeof?: symbol })?.$$typeof).toBe(Symbol.for("react.lazy"))
  })

  it("lazy refs resolve when their chunk arrives on the stream", async () => {
    const stream = timedStream([
      [0, '0:{"value":"$L1"}\n'],
      [200, '1:"hello-world"\n'],
    ])
    const root = await consumePayload<{
      value: { _payload: { status: string; value: unknown } }
    }>(stream)
    const chunk = root.value._payload
    expect(chunk.status).toBe("pending")
    await new Promise((r) => setTimeout(r, 300))
    expect(chunk.status).toBe("fulfilled")
    expect(chunk.value).toBe("hello-world")
  })

  it("root blocks until chunk 0 arrives", async () => {
    const stream = timedStream([[300, '0:{"value":"delayed-root"}\n']])
    const start = Date.now()
    const root = await consumePayload<{ value: string }>(stream)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(root.value).toBe("delayed-root")
  })

  it("real server tree streams progressively via renderServerToFlight", async () => {
    // Mirrors the "three stages with different delays" pattern but
    // renders a real server tree — no dev server, no fetch.
    function Stage({ delay, label }: { delay: number; label: string }) {
      return <span>{new Promise<string>((r) => setTimeout(() => r(`${label}-done`), delay))}</span>
    }
    const tree = (
      <div>
        <Stage delay={0} label="a" />
        <Stage delay={100} label="b" />
        <Stage delay={200} label="c" />
      </div>
    )
    const start = Date.now()
    const stream = renderServerToFlight(tree)
    const text = await new Response(stream).text()
    const elapsed = Date.now() - start
    expect(text).toContain("a-done")
    expect(text).toContain("b-done")
    expect(text).toContain("c-done")
    // The last chunk needs ~200ms; allow slack for CI.
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(2000)
  })
})
