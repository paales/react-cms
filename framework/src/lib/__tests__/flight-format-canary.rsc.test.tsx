/**
 * Flight wire-format conformance canary.
 *
 * `flight-rewrite.ts`, `flight-graph.ts`, and `snapshot-trailer.ts`
 * operate on Flight BYTES without decoding to a React tree, so they
 * bake in facts about the wire format React's Flight serializer
 * emits. A React / @vitejs/plugin-rsc upgrade that changes any of
 * these facts would otherwise fail SILENTLY — a mis-spliced cache
 * payload, a corrupted rewrite — long after the upgrade landed. Each
 * test here renders a small fixture through the REAL Flight runtime
 * (framework/src/test/rsc-server.ts) and asserts one wire fact
 * directly against the emitted bytes, so a format change breaks THIS
 * file with a name pointing at the assumption that moved.
 *
 * The facts, and who depends on each (see also
 * docs/internals/flight-gotchas.md and cache-internals.md):
 *
 *  - row framing `<hex-id>:<type?><data>` + `\n`  — flight-rewrite's
 *    row splitting and `parseRow`/`serializeRow` round-trip
 *  - the ONE framing exception: length-prefixed `T` text rows
 *    (`<id>:T<hex-byte-length>,<raw bytes>`, NOT newline-terminated)
 *    — split-on-`\n` tooling sees one glued to the following row,
 *    so byte-preserving pass-through is what keeps such payloads
 *    decodable (the client re-derives the boundary from the length)
 *  - duplicate model rows are tolerated first-wins by the client
 *    — the splice's id-uniqueness tripwire
 *  - element rows `["$", type, key, props, …]`    — flight-graph's
 *    hole detection reads type at [1], key at [2], props at [3]
 *  - refs `$<id>` / `$L<id>` / `$@<id>`, optional `:deref.path`
 *    suffix, closed within one payload             — flight-graph's
 *    ref remap + reachability GC
 *  - `$$` escaping for literal dollar-strings      — why ref rewriting
 *    JSON-walks instead of regexing the text
 *  - `$undefined` sentinel for undefined props     — partial.tsx's
 *    fpProp spread economy
 *  - `I` client-module rows `[modulePath, …]`      — flight-rewrite's
 *    moduleRefRewriter + flight-graph's splice dedup
 *  - `$S` symbol rows (bare row, `"$S…"` string)   — flight-graph's
 *    splice dedup
 *  - import/symbol rows flush before any row that references them
 *    — spliceOne's single-pass, order-safe dedup
 *  - composite `"outer,inner"` keys                — the flight-gotchas
 *    keyed-Fragment rule
 *  - output is valid UTF-8 (never a 0xFF byte)     — snapshot-trailer's
 *    marker discriminator
 *  - newlines inside strings stay JSON-escaped     — why splitting the
 *    stream on raw 0x0a is safe
 */

import { Suspense, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import {
  consumePayload,
  flightToString,
  renderAndInspect,
  renderServerToFlight,
} from "../../test/rsc-server.ts"
import { ClientButton } from "../../test/__fixtures__/client-button.tsx"
import {
  parseRow,
  passthroughRewriter,
  rewriteFlightStream,
  serializeRow,
  type FlightRow,
} from "../flight-rewrite.ts"
import { joinRows, scaffoldMeta, splitRows } from "../flight-graph.ts"

// The ref grammar the rewriters bake in (flight-graph's REF_RE):
// `$`, optional `L`/`@`, a hex id, optional `:deref.path`.
const REF_RE = /^\$([L@]?)([0-9a-f]+)(:.*)?$/

async function renderRows(node: ReactNode): Promise<{
  text: string
  lines: string[]
  rows: FlightRow[]
}> {
  const text = await flightToString(renderServerToFlight(node))
  const lines = text.split("\n").filter((l) => l.length > 0)
  return { text, lines, rows: lines.map(parseRow) }
}

/** Collect every ref-string id reachable inside a JSON value. */
function collectRefIds(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const m = REF_RE.exec(value)
    if (m) into.add(m[2])
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefIds(v, into)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectRefIds(v, into)
  }
}

function jsonData(row: FlightRow): unknown {
  try {
    return JSON.parse(row.data)
  } catch {
    return undefined
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

async function renderBytes(node: ReactNode): Promise<Uint8Array> {
  return new Uint8Array(await new Response(renderServerToFlight(node)).arrayBuffer())
}

async function Delayed(): Promise<ReactNode> {
  await new Promise((r) => setTimeout(r, 5))
  return <p>late</p>
}

const suspenseFixture = (
  <Suspense fallback={<span>wait</span>}>
    <Delayed />
  </Suspense>
)

describe("row framing", () => {
  it("JSON rows are newline-terminated and parseRow/serializeRow round-trips every line byte-identically", async () => {
    // No large strings in this fixture, so no T rows — every row here
    // is `\n`-framed. The T-row exception is pinned separately below.
    const { text, lines } = await renderRows(suspenseFixture)
    expect(text.endsWith("\n"), "payload must end with a row terminator").toBe(true)
    for (const line of lines) {
      expect(serializeRow(parseRow(line)), `row envelope changed: ${line}`).toBe(line)
    }
  })

  it("row ids are lowercase hex, the root is row 0, and scaffoldMeta's maxId bounds them all", async () => {
    const { rows, text } = await renderRows(suspenseFixture)
    let manualMax = 0
    for (const row of rows) {
      if (row.id === "") continue // dev debug rows (`:N…`) carry no id
      expect(row.id, "row ids must stay hex — splice renumbering parses them base-16").toMatch(
        /^[0-9a-f]+$/,
      )
      manualMax = Math.max(manualMax, parseInt(row.id, 16))
    }
    expect(
      rows.some((r) => r.id === "0"),
      "the root row must be id 0 — reachability GC roots there",
    ).toBe(true)
    expect(scaffoldMeta(new TextEncoder().encode(text)).maxId).toBe(manualMax)
  })

  it("literal newlines in strings stay JSON-escaped — a raw 0x0a only terminates rows", async () => {
    const { text, rows } = await renderRows(<div title={"line1\nline2"}>multiline</div>)
    expect(text, "an in-string newline must arrive as the two bytes \\n").toContain(
      "line1\\nline2",
    )
    const root = rows.find((r) => r.id === "0")!
    const el = jsonData(root) as unknown[]
    expect((el[3] as { title: string }).title).toBe("line1\nline2")
  })
})

describe("streamed text rows (T)", () => {
  // ASCII fixture on purpose: byte offsets equal char offsets, so the
  // string-space slicing below is byte-exact.
  const big = "x".repeat(2048)
  const T_ROW_RE = /(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/

  it("a large string outlines to a length-prefixed T row with NO trailing newline", async () => {
    const text = new TextDecoder().decode(await renderBytes(<div title="t">{big}</div>))
    const m = T_ROW_RE.exec(text)
    expect(
      m,
      "large strings must outline to `<id>:T<hex-byte-length>,<raw bytes>` rows",
    ).not.toBeNull()
    const len = parseInt(m![2], 16)
    expect(len, "the T prefix counts the raw payload bytes").toBe(2048)
    const payloadStart = m!.index + m![0].length
    expect(text.slice(payloadStart, payloadStart + len)).toBe(big)
    expect(
      text[payloadStart + len],
      "a T row is NOT newline-terminated — the next row begins right after the counted bytes",
    ).not.toBe("\n")
    expect(
      text.slice(payloadStart + len),
      "the bytes after the T payload must open the next row's envelope",
    ).toMatch(/^[0-9a-f]*:/)
    // The element references the outlined text as a plain `$<id>` ref.
    expect(text).toContain(`"children":"$${m![1]}"`)
  })

  it("row tooling passes a T-row payload through byte-identically, and it still decodes", async () => {
    // The split-on-`\n` view cannot see a T row's boundary — it sees
    // the raw payload glued to the following row as one pseudo-row.
    // Pass-through is safe because nothing is re-framed: bytes out ==
    // bytes in, and the client re-derives the true boundary from the
    // length prefix. This is the contract that keeps cached partons
    // containing large strings replayable.
    const bytes = await renderBytes(<div title="t">{big}</div>)
    const original = new TextDecoder().decode(bytes)

    const rejoined = new TextDecoder().decode(joinRows(splitRows(bytes)))
    expect(rejoined, "splitRows→joinRows must be byte-preserving over T rows").toBe(original)

    const rewritten = new Uint8Array(
      await new Response(
        rewriteFlightStream(bytesToStream(bytes), passthroughRewriter),
      ).arrayBuffer(),
    )
    expect(
      new TextDecoder().decode(rewritten),
      "passthrough rewriteFlightStream must be byte-preserving over T rows",
    ).toBe(original)

    const payload = await consumePayload<React.ReactElement<{ children: string }>>(
      bytesToStream(rewritten),
    )
    expect(payload.props.children, "the T-row text must survive the round-trip").toBe(big)
  })
})

describe("duplicate rows", () => {
  it("a duplicated model row is tolerated by the client — first value wins, payload decodes", async () => {
    // Splice/dedup invariants treat re-sending a row id as at worst
    // redundant: today's client ignores a duplicate model row for an
    // already-resolved chunk. If a React upgrade makes redefinition
    // FATAL instead (resolveModelChunk treating a second model for a
    // settled chunk as an error), the wire-level splice must guarantee
    // id uniqueness absolutely — this assertion is the tripwire.
    const { text, lines } = await renderRows(suspenseFixture)
    const modelLine = lines.find((l) => /^[0-9a-f]+:\["\$","p"/.test(l))
    expect(modelLine, "fixture must outline the async child to its own model row").toBeDefined()
    const payload = await consumePayload<React.ReactElement<{ children: unknown }>>(
      bytesToStream(new TextEncoder().encode(`${text + modelLine}\n`)),
    )
    // Force the outlined child the way React.lazy does; the FIRST
    // row's value must win.
    const lazy = payload.props.children as unknown as {
      _init: (p: unknown) => React.ReactElement<{ children: string }>
      _payload: unknown
    }
    await new Promise((r) => setTimeout(r, 10))
    const child = lazy._init(lazy._payload)
    expect(child.props.children).toBe("late")
  })
})

describe("element row shape", () => {
  it("an element row is ['$', type, key, props, …] — hole detection reads props at index 3", async () => {
    const { rows } = await renderRows(<div title="t">body</div>)
    const el = jsonData(rows.find((r) => r.id === "0")!) as unknown[]
    expect(el[0], "element discriminator must be the '$' marker").toBe("$")
    expect(el[1], "element type at index 1").toBe("div")
    expect(el[2], "element key at index 2").toBe(null)
    expect((el[3] as Record<string, unknown>).title, "element props at index 3").toBe("t")
  })

  it("a keyed server component returning a keyed element composites 'outer,inner' on the wire", async () => {
    function Inner(): ReactNode {
      return <p key="inner">body</p>
    }
    const { rows } = await renderRows(<div>{[<Inner key="outer" />]}</div>)
    const keys = rows
      .map((r) => jsonData(r))
      .filter((d): d is unknown[] => Array.isArray(d) && d[0] === "$")
      .map((el) => el[2])
    expect(
      keys,
      "Flight composites an outer .map() key with the element's own key — the flight-gotchas keyed-Fragment rule hangs off this",
    ).toContain("outer,inner")
  })

  it("an undefined prop serializes as the '$undefined' sentinel (real bytes on the wire)", async () => {
    const { text } = await renderRows(<div title={undefined}>x</div>)
    expect(text).toContain('"title":"$undefined"')
  })
})

describe("reference grammar", () => {
  it("an async child under Suspense outlines to its own row behind a $L lazy ref", async () => {
    const { rows } = await renderRows(suspenseFixture)
    const root = jsonData(rows.find((r) => r.id === "0")!) as unknown[]
    const children = (root[3] as { children: string }).children
    const m = /^\$L([0-9a-f]+)$/.exec(children)
    expect(m, `suspended children must be a $L<hex> lazy ref, got: ${children}`).not.toBeNull()
    const target = rows.find((r) => r.id === m![1] && r.type === "")
    expect(target, "the lazy ref's target row must arrive in the same payload").toBeDefined()
    const el = jsonData(target!) as unknown[]
    expect(el[0]).toBe("$")
    expect(el[1]).toBe("p")
  })

  it("a promise value serializes as $@<id> with the resolution arriving as its own row", async () => {
    const payload = { p: Promise.resolve("later"), el: <div /> }
    const text = await flightToString(renderServerToFlight(payload as unknown as ReactNode))
    const rows = text.split("\n").filter((l) => l.length > 0).map(parseRow)
    const root = jsonData(rows.find((r) => r.id === "0")!) as { p: string }
    const m = /^\$@([0-9a-f]+)$/.exec(root.p)
    expect(m, `a promise must cross as a $@<hex> ref, got: ${root.p}`).not.toBeNull()
    const target = rows.find((r) => r.id === m![1] && r.type === "")
    expect(target?.data).toBe('"later"')
  })

  it("a repeated object dedups to a ref with a :deref path into the first occurrence", async () => {
    const shared = { deep: { price: 42 } }
    const { rows } = await renderRows(
      <div data-b={shared as never} data-c={shared as never} />,
    )
    const el = jsonData(rows.find((r) => r.id === "0")!) as unknown[]
    const props = el[3] as Record<string, unknown>
    expect(props["data-b"]).toEqual(shared)
    expect(
      props["data-c"],
      "second occurrence must be a `$<id>:path.to.first` deref ref — the optional suffix flight-graph's REF_RE preserves",
    ).toBe("$0:props:data-b")
  })

  it("the ref graph is closed: every referenced id resolves to a row in the same payload", async () => {
    const { rows } = await renderRows(
      <div>
        {suspenseFixture}
        <ClientButton label="click" />
      </div>,
    )
    const ids = new Set(rows.map((r) => r.id))
    const referenced = new Set<string>()
    for (const row of rows) collectRefIds(jsonData(row), referenced)
    expect(referenced.size).toBeGreaterThan(0)
    for (const id of referenced) {
      expect(ids.has(id), `ref to row ${id} dangles — reachability GC would drop live content`).toBe(
        true,
      )
    }
  })

  it("a literal dollar-string is escaped as $$ on the wire and decodes back to one $", async () => {
    const { text, payload } = await renderAndInspect<React.ReactElement<{ title: string }>>(
      <div title="$5.00">$5.00</div>,
    )
    expect(text, "literal $-strings must be $$-escaped — ref rewriting relies on it").toContain(
      '"$$5.00"',
    )
    expect(text).not.toContain('"$5.00"')
    expect(payload.props.title).toBe("$5.00")
  })
})

describe("shareable rows (splice dedup)", () => {
  it("a client component emits an I row of [modulePath, …] before any row referencing it", async () => {
    const { lines, rows } = await renderRows(
      <div>
        <ClientButton label="click" />
      </div>,
    )
    const iIdx = rows.findIndex((r) => r.type === "I")
    expect(iIdx, "client modules must arrive as `I`-typed rows").toBeGreaterThanOrEqual(0)
    const parsed = jsonData(rows[iIdx]) as unknown[]
    expect(Array.isArray(parsed), "I-row data must be a JSON array").toBe(true)
    expect(
      typeof parsed[0],
      "I-row's first element must be the module path string moduleRefRewriter rewrites",
    ).toBe("string")
    expect(parsed[0]).toContain("client-button.tsx#ClientButton")
    const refIdx = lines.findIndex((l) => l.includes(`"$L${rows[iIdx].id}"`))
    expect(refIdx, "some row must reference the client module").toBeGreaterThanOrEqual(0)
    expect(
      iIdx,
      "the I row must flush before the row referencing it — spliceOne's single-pass dedup depends on this order",
    ).toBeLessThan(refIdx)
  })

  it("Suspense crosses as a bare symbol row ('\"$Sreact.suspense\"') referenced by element type", async () => {
    const { lines, rows } = await renderRows(suspenseFixture)
    const symIdx = rows.findIndex((r) => r.type === "" && r.data === '"$Sreact.suspense"')
    expect(
      symIdx,
      "the Suspense symbol must be a bare row whose data string starts with $S — splice dedup keys on that shape",
    ).toBeGreaterThanOrEqual(0)
    const root = jsonData(rows.find((r) => r.id === "0")!) as unknown[]
    expect(root[1], "the Suspense element's type must reference the symbol row").toBe(
      `$${rows[symIdx].id}`,
    )
    const rootIdx = lines.findIndex((l) => l.startsWith("0:"))
    expect(symIdx, "the symbol row must flush before the row referencing it").toBeLessThan(rootIdx)
  })
})

describe("snapshot-trailer preconditions", () => {
  it("Flight output is valid UTF-8 — the 0xFF marker byte can never occur in payload bytes", async () => {
    const bytes = new Uint8Array(
      await new Response(
        renderServerToFlight(
          <div title="héllo — ✓ 日本語 🚀">
            <p>“smart quotes” · €99 · {"éÿ"}</p>
          </div>,
        ),
      ).arrayBuffer(),
    )
    expect(
      bytes.includes(0xff),
      "a 0xFF byte inside Flight output would be mistaken for the snapshot-trailer marker",
    ).toBe(false)
  })
})
