import { describe, expect, it } from "vitest"
import { Suspense } from "react"
import {
  composeRewriters,
  moduleRefRewriter,
  parseRow,
  passthroughRewriter,
  rewriteFlightStream,
  serializeRow,
  type FlightRow,
} from "../flight-rewrite.ts"
import { consumePayload, flightToString, renderServerToFlight } from "../../test/rsc-server.ts"

const ENC = new TextEncoder()

function stringStream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(ENC.encode(s))
      c.close()
    },
  })
}

function timedStream(chunks: Array<[delayMs: number, data: string]>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(c) {
      for (const [delay, data] of chunks) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        c.enqueue(ENC.encode(data))
      }
      c.close()
    },
  })
}

describe("parseRow / serializeRow", () => {
  it("parses a bare JSON row", () => {
    expect(parseRow('5:{"foo":"bar"}')).toEqual({
      id: "5",
      type: "",
      data: '{"foo":"bar"}',
    })
  })

  it("parses a typed module-import row", () => {
    expect(parseRow('1:I["./Button.tsx","main"]')).toEqual({
      id: "1",
      type: "I",
      data: '["./Button.tsx","main"]',
    })
  })

  it("parses a typed debug row", () => {
    expect(parseRow('d0:D{"time":4.16}')).toEqual({
      id: "d0",
      type: "D",
      data: '{"time":4.16}',
    })
  })

  it("treats single-char data without JSON-start as bare", () => {
    const r = parseRow("5:x")
    expect(r.type).toBe("")
    expect(r.data).toBe("x")
  })

  it("treats empty row data as bare with empty data", () => {
    expect(parseRow("5:")).toEqual({ id: "5", type: "", data: "" })
  })

  it("round-trips arbitrary rows", () => {
    const samples = [
      '0:{"value":"$L1"}',
      '1:I["./X.tsx","main"]',
      '14a:{"name":"CardContent"}',
      'db:D{"time":4.16}',
      '5:"hello world"',
    ]
    for (const s of samples) {
      expect(serializeRow(parseRow(s))).toBe(s)
    }
  })
})

describe("rewriteFlightStream", () => {
  it("passthrough preserves bytes exactly", async () => {
    const input = '0:{"value":"$L1"}\n1:"hello"\n'
    const rewritten = rewriteFlightStream(stringStream(input), passthroughRewriter)
    expect(await new Response(rewritten).text()).toBe(input)
  })

  it("handles chunks that split a row mid-line", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(ENC.encode('0:{"val'))
        c.enqueue(ENC.encode('ue":"hi"}\n1:"second"\n'))
        c.close()
      },
    })
    const rewritten = rewriteFlightStream(source, passthroughRewriter)
    expect(await new Response(rewritten).text()).toBe('0:{"value":"hi"}\n1:"second"\n')
  })

  it("handles chunks with multiple rows", async () => {
    const source = stringStream("0:1\n1:2\n2:3\n")
    const rewritten = rewriteFlightStream(source, passthroughRewriter)
    expect(await new Response(rewritten).text()).toBe("0:1\n1:2\n2:3\n")
  })

  it("passthrough of a real render is byte-identical to the input", async () => {
    // Render once → capture bytes → pipe through passthrough →
    // expect bytes back. Two separate renders would embed different
    // per-render timestamps in `D:N…` rows, so we compare against a
    // single captured stream.
    const tree = <div data-testid="hello">hello world</div>
    const captured = await flightToString(renderServerToFlight(tree))
    const rewritten = rewriteFlightStream(stringStream(captured), passthroughRewriter)
    expect(await new Response(rewritten).text()).toBe(captured)
  })

  it("decoded payload from rewritten stream is structurally equivalent", async () => {
    function Item({ n }: { n: number }) {
      return <li>item {n}</li>
    }
    const tree = (
      <ul>
        <Item n={1} />
        <Item n={2} />
      </ul>
    )
    const captured = await flightToString(renderServerToFlight(tree))
    const rewritten = rewriteFlightStream(stringStream(captured), passthroughRewriter)
    const text = await new Response(rewritten).text()
    expect(text).toContain("item ")
    expect(text).toContain("ul")
    expect(text).toContain("li")
    expect(text).toBe(captured)
  })

  it("rewriter can drop a row by returning null", async () => {
    const rewritten = rewriteFlightStream(stringStream('0:"keep"\n1:"drop"\n2:"keep"\n'), (row) =>
      row.id === "1" ? null : row,
    )
    expect(await new Response(rewritten).text()).toBe('0:"keep"\n2:"keep"\n')
  })

  it("rewriter can mutate row data", async () => {
    const rewritten = rewriteFlightStream(stringStream('0:"hello"\n'), (row) => ({
      ...row,
      data: row.data.replace("hello", "world"),
    }))
    expect(await new Response(rewritten).text()).toBe('0:"world"\n')
  })

  it("rewriter can return a verbatim string", async () => {
    const rewritten = rewriteFlightStream(stringStream('0:"x"\n'), () => "9:OVERRIDE")
    expect(await new Response(rewritten).text()).toBe("9:OVERRIDE\n")
  })

  it("preserves Suspense streaming pacing through passthrough", async () => {
    // Source emits root immediately, then the lazy ref's row after 200ms.
    // After passing through our rewriter, the consumer should still see
    // pending → fulfilled (i.e. the rewriter doesn't buffer the whole
    // stream).
    const source = timedStream([
      [0, '0:{"value":"$L1"}\n'],
      [200, '1:"delayed"\n'],
    ])
    const rewritten = rewriteFlightStream(source, passthroughRewriter)

    interface Root {
      value: { _payload: { status: string; value?: unknown } }
    }
    const root = await consumePayload<Root>(rewritten)
    const chunk = root.value._payload
    expect(chunk.status).toBe("pending")
    await new Promise((r) => setTimeout(r, 350))
    expect(chunk.status).toBe("fulfilled")
    expect(chunk.value).toBe("delayed")
  })

  it("composes multiple rewriters left-to-right", async () => {
    const upper = (row: FlightRow): FlightRow => ({ ...row, data: row.data.toUpperCase() })
    const wrap = (row: FlightRow): FlightRow => ({ ...row, data: `[${row.data}]` })
    const rw = composeRewriters(upper, wrap)
    const out = await new Response(rewriteFlightStream(stringStream('0:"hi"\n'), rw)).text()
    expect(out).toBe('0:["HI"]\n')
  })

  it("composeRewriters short-circuits on null", async () => {
    const drop: typeof passthroughRewriter = () => null
    const upper = (row: FlightRow): FlightRow => ({ ...row, data: row.data.toUpperCase() })
    const out = await new Response(
      rewriteFlightStream(stringStream('0:"a"\n1:"b"\n'), composeRewriters(drop, upper)),
    ).text()
    expect(out).toBe("")
  })

  it("renders a real server tree through passthrough", async () => {
    // A real server tree with a Suspense + async child. After passthrough,
    // the decoded tree must contain the same content.
    function AsyncChild() {
      return new Promise<string>((r) => setTimeout(() => r("loaded"), 50))
    }
    const tree = (
      <div>
        <Suspense fallback={<span>loading</span>}>
          <AsyncChild />
        </Suspense>
      </div>
    )
    const stream = renderServerToFlight(tree)
    const rewritten = rewriteFlightStream(stream, passthroughRewriter)
    const text = await flightToString(rewritten)
    expect(text).toContain("loaded")
    expect(text).toContain("loading")
  })
})

describe("moduleRefRewriter", () => {
  it("rewrites I-row module paths via transform", async () => {
    const rw = moduleRefRewriter((path) =>
      path.startsWith("./") ? `https://remote.example/assets/${path.slice(2)}` : path,
    )
    const input = '1:I["./Button.tsx","main"]\n2:I["lodash","default"]\n'
    const out = await new Response(rewriteFlightStream(stringStream(input), rw)).text()
    expect(out).toBe(
      '1:I["https://remote.example/assets/Button.tsx","main"]\n2:I["lodash","default"]\n',
    )
  })

  it("ignores non-I rows", async () => {
    const rw = moduleRefRewriter(() => "REWRITTEN")
    const input = '0:{"value":"$L1"}\n1:"hello"\n'
    const out = await new Response(rewriteFlightStream(stringStream(input), rw)).text()
    expect(out).toBe(input)
  })

  it("preserves additional array elements (export name, chunks)", async () => {
    const rw = moduleRefRewriter((path) => `prefix:${path}`)
    const input = '5:I["./X.tsx","Named",["a","b"]]\n'
    const out = await new Response(rewriteFlightStream(stringStream(input), rw)).text()
    expect(out).toBe('5:I["prefix:./X.tsx","Named",["a","b"]]\n')
  })

  it("no-ops when transform returns the same string", async () => {
    const rw = moduleRefRewriter((path) => path)
    const input = '1:I["./X.tsx","main"]\n'
    const out = await new Response(rewriteFlightStream(stringStream(input), rw)).text()
    expect(out).toBe(input)
  })

  it("tolerates malformed I row data (passes through)", async () => {
    const rw = moduleRefRewriter(() => "SHOULD-NOT-APPLY")
    const input = "1:I[malformed\n"
    const out = await new Response(rewriteFlightStream(stringStream(input), rw)).text()
    expect(out).toBe(input)
  })
})
