// Vendored Flight server, imported directly (not through the harness)
// so tests can pass render options — `signal` for the abort test. The
// models below carry no client references, so an empty manifest works.
import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge"
import { describe, expect, it } from "vitest"
import { consumePayload, flightToString } from "../../test/rsc-server.ts"

/**
 * Streaming-value slots: the Flight rows that DO support writing the
 * same slot multiple times within one response.
 *
 * Wire grammar (vendored server, `react-server-dom-webpack-server.
 * edge.development.js`):
 * - `serializeReadableStream` (L1287) opens a slot with `<id>:R`
 *   (object mode) or `<id>:r` (byte mode), then emits EVERY chunk of
 *   the stream as a plain model row with the SAME id
 *   (`tryStreamTask`), and closes with `<id>:C`.
 * - `serializeAsyncIterable` (L1363) is the same shape tagged
 *   `<id>:X` (iterable) / `<id>:x` (iterator/generator); the `C` row
 *   may carry a final return value.
 *
 * Client (`…-client.edge.development.js`): `startReadableStream`
 * (L3021) / `startAsyncIterable` (L3113) install a controller as the
 * slot chunk's `reason`; each subsequent same-id model row dispatches
 * to `resolveModelChunk` → `chunk.reason.enqueueModel(json)` (L1812),
 * which runs the FULL model parser (`createResolvedModelChunk` →
 * `initializeModelChunk` → `JSON.parse(json, response._fromJSON)`).
 * So streamed values are not limited to scalars: each one can be a
 * complete RSC element subtree, including refs to other rows.
 *
 * What they CANNOT do: re-render committed content. The client
 * surfaces the slot as one value — a ReadableStream / AsyncIterable —
 * whose identity never changes; successive values only reach the UI
 * if a client component consumes the iterator and setState()s. React
 * itself never re-renders on an enqueue.
 *
 * Abort/close semantics pinned below:
 * - Server-side `signal` abort errors the slot (error row for the
 *   slot id) and cancels the producer.
 * - A response that ends while a slot is still open errors the slot
 *   with "Connection closed." (`reportGlobalError`, client L1951 —
 *   fulfilled chunks with a controller `reason` get
 *   `reason.error(...)`).
 * - Backpressure: none per slot. The server pumps the producer as
 *   fast as it yields (`progress` → `reader.read()` loop, no
 *   destination check); a slow consumer buffers bytes, it does not
 *   slow the producer.
 */

const STUB_CLIENT_MANIFEST = {}

function renderModel<T>(model: T, options?: { signal?: AbortSignal }): ReadableStream<Uint8Array> {
  return ReactServer.renderToReadableStream(model, STUB_CLIENT_MANIFEST, {
    onError: () => "test-digest",
    ...options,
  })
}

function bytesToStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type ElementLike = {
  $$typeof: symbol
  type: unknown
  props: { children?: unknown }
}

describe("streaming-value slots (R / X / x rows)", () => {
  it("an async generator serializes as one slot id written repeatedly, then C-closed", async () => {
    async function* feed() {
      yield { tick: 0 }
      yield { tick: 1 }
      yield { tick: 2 }
    }
    const text = await flightToString(renderModel({ feed: feed() }))
    const open = /(?:^|\n)([0-9a-f]+):x\n/.exec(text)
    expect(open, `no x row in:\n${text}`).not.toBeNull()
    const id = open![1]
    // Three value rows with the SAME id, each a plain model row.
    expect(text).toContain(`${id}:{"tick":0}`)
    expect(text).toContain(`${id}:{"tick":1}`)
    expect(text).toContain(`${id}:{"tick":2}`)
    expect(text).toContain(`${id}:C`)
  })

  it("raw string values stream as length-prefixed T rows on the same slot id", async () => {
    // Strings take the text path (`enqueueValue`, tag `T`) instead of
    // the model path — `<id>:T<hex-len>,<raw bytes>` with NO trailing
    // newline. Anything that post-processes Flight bytes by splitting
    // on `\n` (flight-rewrite.ts) must not assume streamed responses
    // stay row-per-line.
    async function* feed() {
      yield "tick-0"
      yield "tick-1"
    }
    const text = await flightToString(renderModel({ feed: feed() }))
    const open = /(?:^|\n)([0-9a-f]+):x\n/.exec(text)
    const id = open![1]
    expect(text).toContain(`${id}:T6,tick-0`)
    expect(text).toContain(`${id}:T6,tick-1`)
  })

  it("successive values decode as full RSC ELEMENTS delivered into one slot", async () => {
    async function* feed() {
      yield <p>tick-0</p>
      yield (
        <section>
          <h1>tick-1</h1>
        </section>
      )
    }
    const stream = renderModel({ feed: feed() })
    const root = await consumePayload<{ feed: AsyncIterable<ElementLike> }>(stream)
    const got: ElementLike[] = []
    for await (const value of root.feed) got.push(value)
    expect(got).toHaveLength(2)
    expect(got[0].$$typeof).toBe(Symbol.for("react.transitional.element"))
    expect(got[0].type).toBe("p")
    expect(got[0].props.children).toBe("tick-0")
    expect(got[1].type).toBe("section")
    const inner = got[1].props.children as ElementLike
    expect(inner.type).toBe("h1")
  })

  it("values arrive over time — the slot exists (and the root resolves) before the producer finishes", async () => {
    const gate1 = deferred()
    const gate2 = deferred()
    async function* feed() {
      await gate1.promise
      yield "first"
      await gate2.promise
      yield "second"
    }
    const stream = renderModel({ feed: feed() })
    // Root resolves immediately: the slot row (`x`) flushes before any
    // value is produced.
    const root = await consumePayload<{ feed: AsyncIterable<string> }>(stream)
    const iter = root.feed[Symbol.asyncIterator]()

    // NB: wrap in a real Promise — `iter.next()` is a ReactPromise
    // whose `.then` does not chain.
    let firstSettled = false
    const first = (async () => {
      const r = await iter.next()
      firstSettled = true
      return r
    })()
    await new Promise((r) => setTimeout(r, 20))
    expect(firstSettled).toBe(false) // producer still gated

    gate1.resolve()
    expect((await first).value).toBe("first")

    gate2.resolve()
    expect((await iter.next()).value).toBe("second")
    expect((await iter.next()).done).toBe(true)
  })

  it("a ReadableStream value round-trips as a ReadableStream (R row)", async () => {
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(<span>a</span>)
        controller.enqueue(<span>b</span>)
        controller.close()
      },
    })
    const stream = renderModel({ feed: source })
    const root = await consumePayload<{ feed: ReadableStream<ElementLike> }>(stream)
    expect(root.feed).toBeInstanceOf(ReadableStream)
    const reader = root.feed.getReader()
    const a = await reader.read()
    const b = await reader.read()
    const end = await reader.read()
    expect((a.value as ElementLike).props.children).toBe("a")
    expect((b.value as ElementLike).props.children).toBe("b")
    expect(end.done).toBe(true)
  })

  it("server-side abort errors the open slot and cancels the producer", async () => {
    const gate = deferred()
    let producerCancelled = false
    async function* feed() {
      try {
        yield "one"
        await gate.promise
        yield "never"
      } finally {
        producerCancelled = true
      }
    }
    const controller = new AbortController()
    const stream = renderModel({ feed: feed() }, { signal: controller.signal })
    const root = await consumePayload<{ feed: AsyncIterable<string> }>(stream)
    const iter = root.feed[Symbol.asyncIterator]()
    expect((await iter.next()).value).toBe("one")

    controller.abort(new Error("stop-the-feed"))
    // The CLIENT sees the abort immediately: the slot's error row ships
    // regardless of what the producer is doing.
    await expect(iter.next()).rejects.toThrow(/stop-the-feed/)

    // The PRODUCER does not: the server cancels it via
    // `iterator.throw(reason)`, and async-generator operations are
    // serialized — the throw() queues BEHIND the producer's pending
    // `await`. A producer parked on a never-settling promise never
    // observes the abort; it runs its `finally` only once that await
    // settles.
    await new Promise((r) => setTimeout(r, 10))
    expect(producerCancelled).toBe(false)
    gate.resolve()
    await new Promise((r) => setTimeout(r, 10))
    expect(producerCancelled).toBe(true)
  })

  it("a response ending with the slot still open errors it with Connection closed.", async () => {
    // Handcrafted: X slot opened, one value, then the response ends
    // with no C row — the torn-connection case.
    const stream = bytesToStream('0:{"feed":"$1"}\n1:X\n1:"tick"\n')
    const root = await consumePayload<{ feed: AsyncIterable<string> }>(stream)
    const iter = root.feed[Symbol.asyncIterator]()
    expect((await iter.next()).value).toBe("tick")
    await expect(iter.next()).rejects.toThrow(/Connection closed/)
  })
})
