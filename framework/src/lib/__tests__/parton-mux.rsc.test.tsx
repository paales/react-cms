import { Suspense } from "react"
import { describe, expect, it } from "vitest"
import { consumePayload, renderServerToFlight } from "../../test/rsc-server.ts"
import { tryReadMarker } from "../fp-trailer-marker.ts"
import {
  type DemuxedParton,
  demuxPartonStreams,
  muxPartonStreams,
  TAG_MUX_END,
  TAG_MUX_FRAME,
} from "../parton-mux.ts"

/**
 * Per-parton multiplexed payloads — the prototype behind
 * `docs/notes/flight-multi-update.md` §3.
 *
 * Each parton renders through its OWN `renderToReadableStream` call
 * (exactly what the partial-refetch path produces), the transports are
 * interleaved frame-by-frame on one byte stream, and each side decodes
 * with its own `createFromReadableStream`. The claim under test: a
 * fast parton's payload settles fully while a slow sibling is still
 * suspended — no whole-tree segment gating on the slowest boundary.
 */

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

function lazyChunk(node: unknown): { status: string } & Promise<unknown> {
  return (node as { _payload: { status: string } & Promise<unknown> })._payload
}

/** Collect demuxed partons into a map while a background pump keeps the
 *  iterator advancing (frames only route to bodies while the generator
 *  is being driven). */
function startDemux(muxed: ReadableStream<Uint8Array>) {
  const iter = demuxPartonStreams(muxed)[Symbol.asyncIterator]()
  const seen = new Map<string, DemuxedParton>()
  const waiters = new Map<string, (p: DemuxedParton) => void>()
  const finished = (async () => {
    while (true) {
      const { done, value } = await iter.next()
      if (done) return
      seen.set(value.partonId, value)
      waiters.get(value.partonId)?.(value)
      waiters.delete(value.partonId)
    }
  })()
  const parton = (id: string): Promise<DemuxedParton> => {
    const existing = seen.get(id)
    if (existing) return Promise.resolve(existing)
    return new Promise((r) => waiters.set(id, r))
  }
  return { parton, finished }
}

/** Scan raw muxed bytes into an ordered `tag:partonId` event list. */
async function scanFrames(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = new Uint8Array(0)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const next = new Uint8Array(buffer.byteLength + value.byteLength)
    next.set(buffer, 0)
    next.set(value, buffer.byteLength)
    buffer = next
    while (true) {
      const parsed = tryReadMarker(buffer)
      if (parsed === "need-more" || parsed === "invalid") break
      const total = parsed.headerSize + parsed.length
      if (buffer.byteLength < total) break
      const body = buffer.slice(parsed.headerSize, total)
      buffer = buffer.slice(total)
      const text = decoder.decode(body)
      const id = parsed.tag === TAG_MUX_FRAME ? text.slice(0, text.indexOf("\n")) : text
      into.push(`${parsed.tag}:${id}`)
    }
  }
}

describe("per-parton multiplexed payloads", () => {
  it("round-trips two independent payloads over one framed stream", async () => {
    const muxed = muxPartonStreams([
      { partonId: "hero", stream: renderServerToFlight(<h1>hero-content</h1>) },
      {
        partonId: "cart",
        stream: renderServerToFlight(<aside>cart-content</aside>),
      },
    ])
    const { parton, finished } = startDemux(muxed)
    const [hero, cart] = await Promise.all([parton("hero"), parton("cart")])
    const [heroRoot, cartRoot] = await Promise.all([
      consumePayload<ElementLike>(hero.body),
      consumePayload<ElementLike>(cart.body),
    ])
    await finished
    expect(heroRoot.type).toBe("h1")
    expect(heroRoot.props.children).toBe("hero-content")
    expect(cartRoot.type).toBe("aside")
    expect(cartRoot.props.children).toBe("cart-content")
  })

  it("a fast parton settles fully while a slow sibling is still suspended", async () => {
    const gate = deferred<string>()
    async function SlowInner() {
      return <p>{await gate.promise}</p>
    }
    const muxed = muxPartonStreams([
      { partonId: "fast", stream: renderServerToFlight(<div>fast-done</div>) },
      {
        partonId: "slow",
        stream: renderServerToFlight(
          <Suspense fallback="loading">
            <SlowInner />
          </Suspense>,
        ),
      },
    ])
    const { parton, finished } = startDemux(muxed)

    // Both payloads ANNOUNCE immediately: each root row flushes before
    // the slow subtree resolves.
    const [fast, slow] = await Promise.all([parton("fast"), parton("slow")])
    const fastRoot = await consumePayload<ElementLike>(fast.body)
    const slowRoot = await consumePayload<ElementLike>(slow.body)

    // The fast payload is COMPLETE — content materialized, no pending
    // references — while the slow parton's boundary is still pending.
    expect(fastRoot.props.children).toBe("fast-done")
    const slowChild = lazyChunk(slowRoot.props.children)
    expect(slowChild.status).toBe("pending")

    // Release the slow render; its payload completes and the muxed
    // stream closes.
    gate.resolve("slow-done")
    const resolved = (await slowChild) as ElementLike
    expect(resolved.type).toBe("p")
    expect(resolved.props.children).toBe("slow-done")
    await finished
  })

  it("frame ordering on the wire: the fast payload closes before the slow one produces", async () => {
    const gate = deferred<string>()
    async function SlowInner() {
      return <p>{await gate.promise}</p>
    }
    const muxed = muxPartonStreams([
      { partonId: "fast", stream: renderServerToFlight(<div>fast-done</div>) },
      {
        partonId: "slow",
        stream: renderServerToFlight(
          <Suspense fallback="loading">
            <SlowInner />
          </Suspense>,
        ),
      },
    ])
    const events: string[] = []
    const scanned = scanFrames(muxed, events)

    // Give the fast render time to drain. Its payload END frame must be
    // on the wire while the slow parton has produced only its scaffold
    // (root row + pending ref) — and no end frame.
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toContain("muxend:fast")
    expect(events).toContain("mux:slow")
    expect(events).not.toContain("muxend:slow")

    gate.resolve("slow-done")
    await scanned
    // The slow parton's remaining content frame(s) arrive AFTER the
    // fast payload already closed — interleaving across payloads that a
    // single Flight response cannot express for plain rows.
    expect(events.indexOf("muxend:slow")).toBeGreaterThan(events.indexOf("muxend:fast"))
    expect(events.lastIndexOf("mux:slow")).toBeGreaterThan(events.indexOf("muxend:fast"))
  })

  it("a torn mux stream errors the open parton bodies", async () => {
    // Handcraft a single `mux` frame and close the source with no
    // `muxend` — the torn-connection case. The parton's body must
    // ERROR (not close cleanly), so its decoder's pending references
    // reject instead of hanging.
    const encoder = new TextEncoder()
    const idBytes = encoder.encode("solo")
    const chunk = encoder.encode('0:{"a":"$L1"}\n')
    const { buildMarker } = await import("../fp-trailer-marker.ts")
    const marker = buildMarker(TAG_MUX_FRAME, idBytes.byteLength + 1 + chunk.byteLength)
    const frame = new Uint8Array(marker.byteLength + idBytes.byteLength + 1 + chunk.byteLength)
    frame.set(marker, 0)
    frame.set(idBytes, marker.byteLength)
    frame[marker.byteLength + idBytes.byteLength] = 0x0a
    frame.set(chunk, marker.byteLength + idBytes.byteLength + 1)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame)
        controller.close()
      },
    })

    const iter = demuxPartonStreams(source)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    const solo = first.value as DemuxedParton
    expect(solo.partonId).toBe("solo")

    // Read the delivered chunk BEFORE driving the iterator over the
    // tear — erroring a ReadableStream controller discards its queue,
    // exactly like a torn HTTP body drops unread bytes. (A live decoder
    // pulls concurrently, so delivered rows land before the error.)
    const reader = solo.body.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('0:{"a":"$L1"}\n')

    const end = await iter.next()
    expect(end.done).toBe(true)
    await expect(reader.read()).rejects.toThrow(/incomplete/)
  })
})
