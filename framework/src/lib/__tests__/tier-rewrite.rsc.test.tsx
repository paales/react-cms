/**
 * Tier enforcement — the vocabulary audit + the Paint-tier rewriter
 * (`lib/tier-rewrite.ts`) on the embed splice pipeline.
 *
 * Three layers:
 *  - row-level: the rewriter against real Flight bytes (vocabulary
 *    passes byte-meaningfully, Suspense symbol survives) and against
 *    synthetic rows (prop sanitization, module refs, opaque props,
 *    disallowed symbols, once-per-row policy) — synthetic rows are
 *    legitimate unit input for a row rewriter, and the shapes they
 *    encode are pinned by the format canary
 *    (`flight-format-canary.rsc.test.tsx`);
 *  - producer-side: a grant-headed embed render collapses the parton
 *    apparatus — bare bodies, no client boundary, no registration;
 *  - host-side: a stubbed self-serving fetch + `<RemoteFrame
 *    grant="paint">` prove the whole splice — vocabulary survives,
 *    violations degrade in place (marker in DEV), the embed box wraps
 *    the result, zero `I` rows reach the host wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Suspense, type ReactNode } from "react"
import { PartialRoot, computeRouteKey, parton, type RenderArgs } from "../partial.tsx"
import { RemoteFrame } from "../remote-frame.tsx"
import {
  EMBED_BOX_TAG,
  EMBED_DEPTH_HEADER,
  EMBED_GRANT_HEADER,
  EMBED_NS_HEADER,
  embedGrantsOf,
  embedNamespaceOf,
  encodeEmbedGrants,
  grantsVocabularyConstrained,
  normalizeEmbedGrants,
} from "../page-embed.ts"
import { createTierRewriter, tierViolationPolicy } from "../tier-rewrite.ts"
import { Divider, Heading, Image, Row, Stack, Text, TIER_VIOLATION_TAG } from "../vocabulary.tsx"
import { parseRow, rewriteFlightStream, serializeRow, type FlightRow } from "../flight-rewrite.ts"
import { createFromReadableStream } from "../flight-runtime.ts"
import { splitSegments } from "../fp-trailer-split.ts"
import { wrapStreamWithCommitOnly } from "../fp-trailer.ts"
import { TAG_SNAPSHOTS, wrapStreamWithSnapshotTrailer } from "../snapshot-trailer.ts"
import { _readSnapshotsForRoute, type PartialSnapshot } from "../partial-registry.ts"
import { HEADER_RSC_RENDER } from "../../runtime/request.tsx"
import { _captureCommitHandle, runWithRequestAsync } from "../../runtime/context.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

async function streamToText(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

function paintRewriter(opts?: { dev?: boolean }) {
  return createTierRewriter({
    grants: new Set(["paint"]),
    url: "http://t/embedded",
    dev: opts?.dev ?? true,
  })
}

/**
 * The splice round-trip the host performs: rewrite → decode →
 * re-encode. Assertions run on the re-encoded wire because that is
 * what a host response carries — the DEV build's debug-info rows in
 * the intermediate wire duplicate raw pre-audit props and are
 * orphaned (never decoded), so raw-wire assertions on them would read
 * rows that never render (the flake the project docs warn about).
 */
async function spliceRoundTrip(tree: ReactNode, opts?: { dev?: boolean }): Promise<string> {
  const rewritten = rewriteFlightStream(renderServerToFlight(tree), paintRewriter(opts))
  const decoded = await createFromReadableStream<ReactNode>(rewritten)
  return streamToText(renderServerToFlight(decoded))
}

/** Run one synthetic row through a fresh rewriter; returns the
 *  rewritten row's parsed data (or null if the row was dropped). */
function rewriteOne(rewriter: ReturnType<typeof createTierRewriter>, line: string): unknown | null {
  const out = rewriter(parseRow(line))
  if (out === null) return null
  const row = typeof out === "string" ? parseRow(out) : out
  return JSON.parse(row.data)
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

// ─── Grant grammar ─────────────────────────────────────────────────────

describe("grant grammar", () => {
  it("normalizes, encodes, and decodes a grant set", () => {
    expect(normalizeEmbedGrants(undefined)).toBeNull()
    const set = normalizeEmbedGrants("paint")!
    expect([...set]).toEqual(["paint"])
    expect(encodeEmbedGrants(set)).toBe("paint")
    expect(embedGrantsOf(new Headers({ [EMBED_GRANT_HEADER]: "paint" }))).toEqual(
      new Set(["paint"]),
    )
    expect(embedGrantsOf(new Headers())).toBeNull()
  })

  it("vocabulary constraint is `client ∉ grants`; null is unconstrained", () => {
    expect(grantsVocabularyConstrained(null)).toBe(false)
    expect(grantsVocabularyConstrained(new Set(["paint"]))).toBe(true)
    expect(grantsVocabularyConstrained(new Set(["client"]))).toBe(false)
  })
})

// ─── Rewriter against real Flight bytes ────────────────────────────────

describe("paint rewriter — vocabulary passes", () => {
  it("a vocabulary tree crosses byte-meaningfully, no violation", async () => {
    const tree = (
      <Stack gap="md" data-testid="summary">
        <Heading level={2}>Order summary</Heading>
        <Row justify="between">
          <Text tone="muted">Subtotal</Text>
          <Text tone="strong">€ 127.45</Text>
        </Row>
        <Divider />
        <Image src="https://remote.example/p.png" alt="product" width={64} height={64} />
      </Stack>
    )
    const out = await spliceRoundTrip(tree)
    expect(out).toContain("parton-stack")
    expect(out).toContain('"gap":"md"')
    expect(out).toContain("parton-heading")
    expect(out).toContain('"justify":"between"')
    expect(out).toContain("Order summary")
    expect(out).toContain("parton-divider")
    expect(out).toContain("https://remote.example/p.png")
    expect(out).not.toContain(TIER_VIOLATION_TAG)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("Suspense passes as an admitted structural symbol", async () => {
    const tree = (
      <Suspense fallback={<Text>loading</Text>}>
        <Text>done</Text>
      </Suspense>
    )
    const out = await spliceRoundTrip(tree)
    expect(out).toContain("$Sreact.suspense")
    expect(out).toContain("done")
    expect(out).not.toContain(TIER_VIOLATION_TAG)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("a non-vocabulary element degrades in place while siblings paint (DEV marker)", async () => {
    const tree = (
      <Stack>
        <div data-testid="leak">raw-div-leak</div>
        <Text>still-here</Text>
      </Stack>
    )
    const out = await spliceRoundTrip(tree, { dev: true })
    expect(out).not.toContain("raw-div-leak")
    expect(out).toContain("still-here")
    expect(out).toContain(TIER_VIOLATION_TAG)
    expect(out).toContain('"data-type":"div"')
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0][0])).toContain("tier-violation")
  })

  it("prod: silent degrade — no marker, still exactly one log line", async () => {
    const tree = (
      <Stack>
        <div>raw-div-leak</div>
        <Text>still-here</Text>
      </Stack>
    )
    const out = await spliceRoundTrip(tree, { dev: false })
    expect(out).not.toContain("raw-div-leak")
    expect(out).not.toContain(TIER_VIOLATION_TAG)
    expect(out).toContain("still-here")
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it("drops the remote's debug channel: no D/W rows, debug metadata orphaned out", async () => {
    const tree = (
      <Stack gap="sm">
        <Text>debug-clean</Text>
      </Stack>
    )
    const rewritten = await streamToText(
      rewriteFlightStream(renderServerToFlight(tree), paintRewriter()),
    )
    expect(rewritten).not.toMatch(/^[0-9a-f]+:D/m)
    expect(rewritten).not.toMatch(/^[0-9a-f]+:W/m)
  })
})

// ─── Rewriter against synthetic rows ───────────────────────────────────

describe("paint rewriter — audit + violations (synthetic rows)", () => {
  it("strips unaudited props from a vocabulary element (sanitize, not a violation)", () => {
    const rw = paintRewriter()
    const data = rewriteOne(
      rw,
      `0:["$","parton-text",null,{"tone":"muted","className":"evil","style":{"color":"red"},"dangerouslySetInnerHTML":{"__html":"x"},"children":"hi"}]`,
    ) as unknown[]
    const props = data[3] as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(["children", "tone"])
    expect(props.children).toBe("hi")
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("re-validates attr values: bad enum and non-http(s)/relative src drop the ATTR, not the element", () => {
    const rw = paintRewriter()
    const img = rewriteOne(
      rw,
      `0:["$","img",null,{"src":"javascript:alert(1)","alt":"x","width":9,"children":"gone"}]`,
    ) as unknown[]
    const imgProps = img[3] as Record<string, unknown>
    expect(imgProps.src).toBeUndefined()
    expect(imgProps.alt).toBe("x")
    expect(imgProps.children).toBeUndefined() // children:false tag
    const rel = rewriteOne(rw, `1:["$","img",null,{"src":"/logo.svg"}]`) as unknown[]
    expect((rel[3] as Record<string, unknown>).src).toBeUndefined()
    const text = rewriteOne(
      rw,
      `2:["$","parton-text",null,{"tone":"neon","children":"t"}]`,
    ) as unknown[]
    expect((text[3] as Record<string, unknown>).tone).toBeUndefined()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("drops I rows and degrades the element referencing the module", () => {
    const rw = paintRewriter()
    const dropped = rw(parseRow(`1:I["/src/leak-button.tsx#LeakButton","main"]`))
    expect(dropped).toBeNull()
    // The import row itself degrades silently — the log belongs to the
    // element that references it.
    expect(consoleError).not.toHaveBeenCalled()
    const data = rewriteOne(rw, `0:["$","$L1",null,{"children":"x"}]`) as unknown[]
    expect(data[1]).toBe(TIER_VIOLATION_TAG)
    const props = data[3] as Record<string, unknown>
    expect(props["data-offense"]).toBe("module")
    expect(props["data-type"]).toBe("/src/leak-button.tsx#LeakButton")
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it("bundler plumbing (virtual:vite-rsc/*) drops SILENTLY — no marker, no log", () => {
    const rw = paintRewriter()
    expect(
      rw(
        parseRow(`1:I["/@id/__x00__virtual:vite-rsc/remove-duplicate-server-css",[],"default",1]`),
      ),
    ).toBeNull()
    // The referencing element (vite-rsc's css-dedup helper beside the
    // page root) resolves to nothing — quietly.
    const data = rewriteOne(rw, `0:[["$","$L1","remove-duplicate-css",{}]]`) as unknown[]
    expect(data).toEqual([null])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("a bare string reference to a dropped module degrades too", () => {
    const rw = paintRewriter()
    rw(parseRow(`1:I["/src/leak.tsx#X","main"]`))
    const data = rewriteOne(rw, `0:{"icon":"$1","children":"ok"}`) as Record<string, unknown>
    expect(JSON.stringify(data.icon)).toContain(TIER_VIOLATION_TAG)
    expect(data.children).toBe("ok")
  })

  it("outlined (unauditable) props on a vocabulary element degrade — opaque-props", () => {
    const rw = paintRewriter()
    const data = rewriteOne(rw, `0:["$","parton-text",null,"$3"]`) as unknown[]
    expect(data[1]).toBe(TIER_VIOLATION_TAG)
    expect((data[3] as Record<string, unknown>)["data-offense"]).toBe("opaque-props")
  })

  it("an anchor never crosses a granted splice — Paint or Interactive", () => {
    // Navigation containment: a spliced embed lives in the HOST
    // document, so an `<a href>` that crossed would natively
    // top-level-navigate the whole host page on click — and a
    // cross-origin href is not even interceptable by the host's
    // navigate listener (`NavigateEvent.canIntercept` is false).
    // Links are therefore deliberately absent from VOCABULARY at
    // every shipped grant; admitting a link member is a
    // navigation-containment decision (what does a link DO inside a
    // contained splice?), not a table edit. This pin forces that
    // conversation.
    for (const grants of [new Set(["paint"]), new Set(["paint", "interactive"])]) {
      const rw = createTierRewriter({ grants, url: "http://t/embedded", dev: true })
      const anchor = rewriteOne(
        rw,
        `0:["$","a",null,{"href":"https://remote.example/away","children":"defect"}]`,
      ) as unknown[]
      expect(anchor[1]).toBe(TIER_VIOLATION_TAG)
      expect((anchor[3] as Record<string, unknown>)["data-offense"]).toBe("element")
      expect((anchor[3] as Record<string, unknown>)["data-type"]).toBe("a")
      // An href smuggled onto an ADMITTED tag is sanitize-dropped —
      // no audited attribute can carry a navigation.
      const text = rewriteOne(
        rw,
        `1:["$","parton-text",null,{"href":"https://remote.example/away","tone":"muted","children":"t"}]`,
      ) as unknown[]
      expect(text[1]).toBe("parton-text")
      expect(Object.keys(text[3] as Record<string, unknown>).sort()).toEqual(["children", "tone"])
    }
  })

  it("a disallowed symbol (Activity) degrades by name", () => {
    const rw = paintRewriter()
    // Symbol row passes (the ledger), the referencing element degrades.
    const sym = rw(parseRow(`1:"$Sreact.activity"`))
    expect(sym).not.toBeNull()
    const data = rewriteOne(rw, `0:["$","$1",null,{"mode":"hidden","children":"x"}]`) as unknown[]
    expect(data[1]).toBe(TIER_VIOLATION_TAG)
    expect((data[3] as Record<string, unknown>)["data-type"]).toBe("react.activity")
  })

  it("violation log dedupes per distinct (offense, type); every offense still degrades", () => {
    const rw = paintRewriter()
    const data = rewriteOne(
      rw,
      `0:[["$","div","a",{"children":"x"}],["$","div","b",{"children":"y"}]]`,
    ) as unknown[]
    // Two offenses, ONE structured line — same (element, div).
    expect(consoleError).toHaveBeenCalledTimes(1)
    const types = (data as unknown[][]).map((el) => el[1])
    expect(types).toEqual([TIER_VIOLATION_TAG, TIER_VIOLATION_TAG])
    // Keys survive the swap — array positions stay stable.
    expect((data as unknown[][]).map((el) => el[2])).toEqual(["a", "b"])
    // A repeat of the SAME offense in a later row stays deduped (dev
    // payloads duplicate every content element into debug metadata —
    // without this the log would flood with copies) …
    rewriteOne(rw, `2:["$","div",null,{}]`)
    expect(consoleError).toHaveBeenCalledTimes(1)
    // … while a DISTINCT offense logs its own line.
    rewriteOne(rw, `3:["$","em",null,{}]`)
    expect(consoleError).toHaveBeenCalledTimes(2)
  })

  it("tierViolationPolicy is the single flip point: marker in dev, null in prod", () => {
    const v = {
      url: "http://t/embedded",
      grants: ["paint"],
      offense: "element" as const,
      type: "div",
    }
    expect(tierViolationPolicy(v, { dev: false, log: false })).toBeNull()
    const marker = tierViolationPolicy(v, { dev: true, log: false, key: "k" }) as unknown[]
    expect(marker[1]).toBe(TIER_VIOLATION_TAG)
    expect(marker[2]).toBe("k")
    expect(consoleError).not.toHaveBeenCalled()
    tierViolationPolicy(v, { dev: false, log: true })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })
})

// ─── Producer side — the bare emission ─────────────────────────────────

/** "use client"-shaped leak for the wire: rendering a parton page in
 *  this harness serializes PartialErrorBoundary into `I` rows +
 *  `partialId` props; the grant-headed render must emit neither. */
const PaintPage = parton(
  async function TrPaintPageRender(_: RenderArgs) {
    return (
      <Stack gap="sm">
        <Heading level={2}>paint-page-heading</Heading>
        <Text>paint-page-text</Text>
      </Stack>
    )
  },
  { match: "/embedded" },
)

const OtherPage = parton(
  async function TrOtherPageRender(_: RenderArgs) {
    return <Text>other-page-content</Text>
  },
  { match: "/elsewhere" },
)

function EmbeddedRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <body>
          <PaintPage />
          <OtherPage />
        </body>
      </html>
    </PartialRoot>
  )
}

async function renderPageStream(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
): Promise<FlightBytes> {
  const request = new Request(url, { headers })
  const { result } = await runWithRequestAsync(request, async () => {
    const routeKey = computeRouteKey(url)
    const ns = embedNamespaceOf(new Headers(headers))
    const getSnapshots = () => {
      const all = _readSnapshotsForRoute("default", routeKey)
      if (ns === null) return all
      const own = new Map<string, PartialSnapshot>()
      for (const [id, snap] of all) if (id.startsWith(`${ns}:`)) own.set(id, snap)
      return own
    }
    const stream = wrapStreamWithSnapshotTrailer(
      wrapStreamWithCommitOnly(
        renderServerToFlight({ root } as unknown as ReactNode),
        _captureCommitHandle(),
      ),
      getSnapshots,
    )
    const [forCaller, forDrain] = stream.tee()
    await new Response(forDrain).arrayBuffer()
    return forCaller
  })
  return result
}

const EMBED_HEADERS = {
  [HEADER_RSC_RENDER]: "1",
  [EMBED_DEPTH_HEADER]: "1",
  [EMBED_NS_HEADER]: "e~trpaint",
}

describe("producer — vocabulary-constrained emission", () => {
  it("a grant-headed embed render emits bare bodies: no boundary, no I rows, no snapshots", async () => {
    const wire = await renderPageStream(<EmbeddedRoot />, "http://t/embedded", {
      ...EMBED_HEADERS,
      [EMBED_GRANT_HEADER]: "paint",
    })
    // Consume the wire the way the host does: split the trailer off,
    // decode the payload (possible at ALL only because the bare
    // emission ships no client refs — the bare vitest worker has no
    // module loader), then re-encode the content. Raw-wire matching
    // would read dev debug rows that never render — same reason the
    // `D` attach directives are dropped before decode here (the tier
    // rewriter does this on the real path; this test isolates the
    // producer, so it sheds the debug channel itself).
    const iter = splitSegments(wire)[Symbol.asyncIterator]()
    const first = await iter.next()
    if (first.done || first.value.kind !== "payload") throw new Error("no payload segment")
    const trailersPromise = first.value.trailers
    const payload = await createFromReadableStream<{ root: ReactNode }>(
      rewriteFlightStream(first.value.body, (row) => (row.type === "D" ? null : row)),
    )
    const out = await streamToText(renderServerToFlight(payload.root))
    const trailers = await trailersPromise

    expect(out).toContain("paint-page-heading")
    expect(out).toContain("parton-stack")
    // No client apparatus: no boundary `partialId` PROP (the JSON-key
    // form — dev `$E` owner-source strings quote framework source and
    // are not payload), no module imports.
    expect(out).not.toMatch(/"partialId":/)
    expect(out).not.toMatch(/^[0-9a-f]+:I\[/m)
    // The match-missed sibling parton renders NOTHING — no Activity
    // parking on this surface.
    expect(out).not.toContain("other-page-content")
    expect(out).not.toContain("react.activity")
    // No registration → empty snapshots trailer.
    const snapshotBytes = trailers.get(TAG_SNAPSHOTS)
    expect(snapshotBytes).toBeDefined()
    expect(JSON.parse(new TextDecoder().decode(snapshotBytes))).toEqual({})
  })

  it("the same render WITHOUT a grant keeps the full apparatus (control)", async () => {
    const out = await streamToText(
      await renderPageStream(<EmbeddedRoot />, "http://t/embedded", EMBED_HEADERS),
    )
    expect(out).toMatch(/"partialId":/)
    expect(out).toContain("paint-page-heading")
  })
})

// ─── Host side — the whole splice under a Paint grant ──────────────────

describe("host — <RemoteFrame grant='paint'>", () => {
  it("splices vocabulary, degrades the violating row, wraps in the embed box, ships zero I rows", async () => {
    const MixedPage = parton(
      async function TrMixedPageRender(_: RenderArgs) {
        return (
          <Stack gap="sm">
            <Text>mixed-vocab-line</Text>
            <div data-testid="tr-leak">mixed-raw-leak</div>
            <Text tone="muted">mixed-still-painted</Text>
          </Stack>
        )
      },
      { match: "/mixed" },
    )
    function MixedRoot() {
      return (
        <PartialRoot>
          <html lang="en">
            <body>
              <MixedPage />
            </body>
          </html>
        </PartialRoot>
      )
    }
    const calls: Headers[] = []
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const headers = new Headers(init?.headers)
        calls.push(headers)
        const headerRecord: Record<string, string> = {}
        headers.forEach((v, k) => {
          headerRecord[k] = v
        })
        return new Response(await renderPageStream(<MixedRoot />, url, headerRecord), {
          status: 200,
          headers: { "content-type": "text/x-component;charset=utf-8" },
        })
      },
    )

    const HostPage = parton(
      Object.assign(
        function TrHostRender(_: RenderArgs) {
          return (
            <Suspense fallback={null}>
              <RemoteFrame url="/mixed" grant="paint" />
            </Suspense>
          )
        },
        { displayName: "tr-host-spec" },
      ),
      { match: "/tr-host" },
    )
    const out = await streamToText(
      await renderPageStream(
        <PartialRoot>
          <html lang="en">
            <body>
              <HostPage />
            </body>
          </html>
        </PartialRoot>,
        "http://t/tr-host",
        {},
      ),
    )

    // The grant crossed as the header statement.
    expect(calls).toHaveLength(1)
    expect(calls[0].get(EMBED_GRANT_HEADER)).toBe("paint")
    // Vocabulary spliced; the violating row degraded in place while
    // its siblings painted; the embed box wraps the splice.
    expect(out).toContain("mixed-vocab-line")
    expect(out).toContain("mixed-still-painted")
    expect(out).not.toContain("mixed-raw-leak")
    expect(out).toContain(TIER_VIOLATION_TAG)
    expect(out).toContain(EMBED_BOX_TAG)
    expect(out).toContain('"data-grant":"paint"')
    // Zero module rows attributable to the embed on the host wire.
    // (The HOST page's own boundary still imports — filter to the
    // embedded content by asserting the leak component never made it.)
    expect(out).not.toContain("leak-button")
  })
})

// ─── serializeRow sanity (the synthetic rows above are real grammar) ───

describe("row grammar sanity", () => {
  it("parse/serialize round-trips the synthetic shapes used here", () => {
    const line = `1:I["/src/leak-button.tsx#LeakButton","main"]`
    const row: FlightRow = parseRow(line)
    expect(row.type).toBe("I")
    expect(serializeRow(row)).toBe(line)
  })
})
