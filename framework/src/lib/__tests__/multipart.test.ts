/**
 * Streaming multipart parser — incremental delivery (@defer).
 */

import { describe, expect, it } from "vitest"
import { parseMultipartStream, parseMultipartResponse, type DeferChunk } from "../multipart.ts"

const enc = new TextEncoder()

/** Build a multipart/mixed Response. `sliceAt` splits the body into N-byte
 *  stream chunks so we exercise parts arriving across multiple reads. */
function multipartResponse(
  jsonParts: string[],
  opts?: { boundary?: string; sliceAt?: number },
): Response {
  const boundary = opts?.boundary ?? "-"
  const body =
    jsonParts
      .map((p) => `--${boundary}\r\nContent-Type: application/json\r\n\r\n${p}\r\n`)
      .join("") + `--${boundary}--\r\n`
  const bytes = enc.encode(body)
  const slice = opts?.sliceAt ?? bytes.length
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += slice) {
        controller.enqueue(bytes.subarray(i, Math.min(i + slice, bytes.length)))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
  })
}

async function collect<T>(res: Response): Promise<DeferChunk<T>[]> {
  const out: DeferChunk<T>[] = []
  for await (const c of parseMultipartStream<T>(res)) out.push(c)
  return out
}

describe("parseMultipartStream", () => {
  it("yields a single initial chunk for a non-multipart JSON response", async () => {
    const res = new Response(JSON.stringify({ data: { hello: "world" } }), {
      headers: { "content-type": "application/json" },
    })
    const chunks = await collect<{ hello: string }>(res)
    expect(chunks).toEqual([{ kind: "initial", data: { hello: "world" }, hasNext: false }])
  })

  it("yields initial then patch chunks in arrival order", async () => {
    const res = multipartResponse([
      JSON.stringify({ data: { product: { id: 1 } }, hasNext: true }),
      JSON.stringify({
        incremental: [{ data: { price: 42 }, path: ["product"] }],
        hasNext: false,
      }),
    ])
    const chunks = await collect(res)
    expect(chunks).toEqual([
      { kind: "initial", data: { product: { id: 1 } }, hasNext: true },
      { kind: "patch", patch: { data: { price: 42 }, path: ["product"] }, hasNext: false },
    ])
  })

  it("parses correctly when parts arrive across multiple stream reads", async () => {
    const res = multipartResponse(
      [
        JSON.stringify({ data: { product: { id: 1 } }, hasNext: true }),
        JSON.stringify({
          incremental: [{ data: { price: 42 }, path: ["product"] }],
          hasNext: false,
        }),
      ],
      { sliceAt: 7 }, // tiny slices: parts span many reads
    )
    const chunks = await collect(res)
    expect(chunks.map((c) => c.kind)).toEqual(["initial", "patch"])
    expect((chunks[1] as { patch: { data: unknown } }).patch.data).toEqual({ price: 42 })
  })

  it("throws on GraphQL errors in a chunk", async () => {
    const res = multipartResponse([JSON.stringify({ errors: [{ message: "boom" }] })])
    await expect(collect(res)).rejects.toThrow(/boom/)
  })
})

describe("parseMultipartResponse — buffered merge", () => {
  it("merges all incremental patches into the base data", async () => {
    const res = multipartResponse([
      JSON.stringify({ data: { product: { id: 1, name: "Widget" } }, hasNext: true }),
      JSON.stringify({ incremental: [{ data: { price: 42 }, path: ["product"] }], hasNext: false }),
    ])
    const merged = await parseMultipartResponse<{
      product: { id: number; name: string; price: number }
    }>(res)
    expect(merged).toEqual({ product: { id: 1, name: "Widget", price: 42 } })
  })

  it("merges patches at a nested array path", async () => {
    const res = multipartResponse([
      JSON.stringify({ data: { items: [{ id: "a" }, { id: "b" }] }, hasNext: true }),
      JSON.stringify({
        incremental: [{ data: { detail: "x" }, path: ["items", 1] }],
        hasNext: false,
      }),
    ])
    const merged = await parseMultipartResponse<{ items: Array<{ id: string; detail?: string }> }>(
      res,
    )
    expect(merged.items).toEqual([{ id: "a" }, { id: "b", detail: "x" }])
  })
})
