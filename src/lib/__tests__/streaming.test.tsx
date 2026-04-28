import React, { Suspense } from "react"
import { renderToReadableStream } from "react-dom/server.edge"
import { describe, expect, it } from "vitest"

/**
 * Helper: collect a ReadableStream into an array of decoded string chunks.
 * Each chunk corresponds to a flush from the server renderer.
 */
async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks
}

/** Concatenate all chunks into a single string */
function join(chunks: string[]): string {
  return chunks.join("")
}

/**
 * Async server component that delays before rendering.
 * Simulates a slow data fetch or enrichment step.
 */
async function Delayed({ ms, children }: { ms: number; children: React.ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return <>{children}</>
}

describe("Suspense streaming", () => {
  it("streams fallback before delayed content", async () => {
    const tree = (
      <div>
        <p data-testid="immediate">Immediate content</p>
        <Suspense fallback={<p data-testid="fallback">Loading...</p>}>
          <Delayed ms={200}>
            <p data-testid="delayed">Delayed content</p>
          </Delayed>
        </Suspense>
      </div>
    )

    const stream = await renderToReadableStream(tree)
    const chunks = await collectChunks(stream)
    const full = join(chunks)

    // The first chunk should contain both the immediate content and the
    // Suspense fallback — React flushes the shell before the async
    // component resolves.
    expect(chunks[0]).toContain("Immediate content")
    expect(chunks[0]).toContain("Loading...")

    // The delayed content should NOT be in the first chunk — it arrives later.
    expect(chunks[0]).not.toContain("Delayed content")

    // But it should be in the full output (streamed in a later chunk).
    expect(full).toContain("Delayed content")

    // There should be at least 2 chunks: shell + delayed resolution.
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  it("streams multiple Suspense boundaries independently", async () => {
    const tree = (
      <div>
        <Suspense fallback={<span>Loading A...</span>}>
          <Delayed ms={100}>
            <span data-testid="a">Content A</span>
          </Delayed>
        </Suspense>
        <Suspense fallback={<span>Loading B...</span>}>
          <Delayed ms={300}>
            <span data-testid="b">Content B</span>
          </Delayed>
        </Suspense>
      </div>
    )

    const stream = await renderToReadableStream(tree)
    const chunks = await collectChunks(stream)
    const full = join(chunks)

    // First chunk: both fallbacks
    expect(chunks[0]).toContain("Loading A...")
    expect(chunks[0]).toContain("Loading B...")
    expect(chunks[0]).not.toContain("Content A")
    expect(chunks[0]).not.toContain("Content B")

    // Full output contains both resolved contents
    expect(full).toContain("Content A")
    expect(full).toContain("Content B")

    // Content A (100ms) should arrive before Content B (300ms).
    // Find which chunk first contains each.
    const chunkWithA = chunks.findIndex((c) => c.includes("Content A"))
    const chunkWithB = chunks.findIndex((c) => c.includes("Content B"))
    expect(chunkWithA).toBeLessThanOrEqual(chunkWithB)
  })

  it("non-suspended async components do not require Suspense", async () => {
    // An async component that resolves instantly should render
    // in the initial shell without a Suspense boundary.
    async function FastComponent() {
      return <p>Fast</p>
    }

    const tree = (
      <div>
        <FastComponent />
        <Suspense fallback={<span>Loading...</span>}>
          <Delayed ms={150}>
            <p>Slow</p>
          </Delayed>
        </Suspense>
      </div>
    )

    const stream = await renderToReadableStream(tree)
    const chunks = await collectChunks(stream)

    // Fast component is in the initial shell
    expect(chunks[0]).toContain("Fast")
    expect(chunks[0]).toContain("Loading...")
    expect(chunks[0]).not.toContain("Slow")

    expect(join(chunks)).toContain("Slow")
  })
})
