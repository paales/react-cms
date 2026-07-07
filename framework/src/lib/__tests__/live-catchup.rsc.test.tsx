/**
 * The attach statement — the live fire's POST body (`{cached, since,
 * visible}`, see [[channel-protocol]]) driving catch-up and fp-skip.
 *
 * The document's SSR trailer carries a registry anchor; the attach
 * presents it as the statement's `since`. The claims:
 *
 *   1. a valid anchor opens the connection STRAIGHT INTO LANES — no
 *      whole-route initial segment — and the first wake lanes exactly
 *      the partons that bumped after the anchor (siblings untouched)
 *   2. an anchor from a different epoch (another registry lifetime —
 *      a restart, a clear) is refused: the connection falls back to
 *      the full initial render, over-fetch never stale.
 *   3. the anchor rides ONLY the attach body — a live GET carrying the
 *      old `?since=` URL form takes the full initial render.
 *   4. the body manifest is the `?cached=` URL form's equal: the same
 *      tokens produce the same fp-skip verdicts on either transport.
 *   5. the body manifest is UNCAPPED — tokens past the URL form's
 *      request-line cap (96) are still honored.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  _currentTs,
  _registryEpoch,
  refreshSelector,
} from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const renders = { a: 0, b: 0 }

const LiveA = parton(
  function LiveARender(_: RenderArgs) {
    renders.a++
    return <div data-a>{`a:${renders.a}`}</div>
  },
  { selector: "live-a" },
)

const LiveB = parton(
  function LiveBRender(_: RenderArgs) {
    renders.b++
    return <div data-b>{`b:${renders.b}`}</div>
  },
  { selector: "live-b" },
)

function Page(): ReactNode {
  return (
    <PartialRoot>
      <LiveA />
      <LiveB />
    </PartialRoot>
  )
}

/** `id:matchKey:fp` tokens off a rendered Flight document — the same
 *  triple the client's fingerprint maps advertise. */
function tokensOf(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re =
    /"partialId":"([^"]+)","partialFingerprint":"([^"]+)","partialMatchKey":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], `${m[1]}:${m[3]}:${m[2]}`)
  return out
}

async function renderDocument(scope: string): Promise<string> {
  const { stream } = await renderWithRequest("http://localhost/page", <Page />, {
    headers: { "x-test-scope": scope },
  })
  return await new Response(stream).text()
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.a = 0
  renders.b = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("the attach — catch-up (statement.since)", () => {
  it("a valid anchor opens straight into lanes; the first wake lanes only what bumped after it", async () => {
    const scope = freshLiveScope("catchup")
    // The "document": renders the route, landing snapshots in the
    // registry. Its anchor is the timeline point right after.
    await renderDocument(scope)
    const anchorTs = _currentTs()
    expect(renders.a).toBe(1)
    expect(renders.b).toBe(1)

    // Something bumps after the document rendered — the catch-up's job.
    refreshSelector("live-b")

    await withLiveDrive(
      "http://localhost/page?live=1",
      Page,
      scope,
      async (h) => {
        // FIRST segment is the lanes region — no whole-route replay.
        const first = await h.segments.next()
        if (first.done) throw new Error("expected a first segment")
        expect(first.value.kind).toBe("lanes")
        if (first.value.kind !== "lanes") return
        const laneIter = first.value.lanes[Symbol.asyncIterator]()
        const step = await laneIter.next()
        if (step.done) throw new Error("expected a catch-up lane")
        // The server-minted connection id rides the lanes region as its
        // first framed entry — in hand by the first lane.
        expect(h.connectionId()).not.toBeNull()
        expect(step.value.partonId).toBe("live-b")
        expect((await decodeLane(step.value)).bodyText).toContain("b:2")
        // The untouched sibling never re-rendered and never laned.
        expect(renders.a).toBe(1)

        await h.shutdown("live-b")
      },
      {
        attach: {
          cached: [],
          since: { epoch: _registryEpoch(), ts: anchorTs },
          visible: null,
        },
      },
    )
  })

  it("an anchor from another registry lifetime is refused — full initial render", async () => {
    const scope = freshLiveScope("catchup")
    await renderDocument(scope)
    const anchorTs = _currentTs()

    await withLiveDrive(
      "http://localhost/page?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done) throw new Error("expected a first segment")
        expect(first.value.kind).toBe("payload")
        if (first.value.kind !== "payload") return
        const seg0 = await drainPayloadSegment(first.value)
        expect(seg0).toContain("a:")
        expect(seg0).toContain("b:")

        await h.shutdown("live-a")
      },
      {
        attach: {
          cached: [],
          since: { epoch: "stale-epoch", ts: anchorTs },
          visible: null,
        },
      },
    )
  })

  it("the anchor is attach-only: a live GET carrying ?since= takes the full initial render", async () => {
    const scope = freshLiveScope("catchup")
    await renderDocument(scope)
    const anchorTs = _currentTs()
    refreshSelector("live-b")

    await withLiveDrive(
      `http://localhost/page?live=1&since=${_registryEpoch()}:${anchorTs}`,
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done) throw new Error("expected a first segment")
        // No statement, no anchor — the URL form is not a carrier.
        expect(first.value.kind).toBe("payload")
        if (first.value.kind !== "payload") return
        await drainPayloadSegment(first.value)
        await h.shutdown("live-a")
      },
    )
  })
})

describe("the attach — manifest (statement.cached)", () => {
  it("the body manifest fp-skips identically to the ?cached= URL form", async () => {
    const scope = freshLiveScope("manifest")
    // Two document renders per drive: the second's emitted fps are the
    // warm, stable ones a client would advertise. Tokens re-derive
    // before the second drive because the first drive's shutdown wake
    // is itself a bump (it moves an fp).
    await renderDocument(scope)
    const urlTokens = tokensOf(await renderDocument(scope))
    const urlTokenA = urlTokens.get("live-a")
    const urlTokenB = urlTokens.get("live-b")
    if (!urlTokenA || !urlTokenB) throw new Error("expected tokens for both partons")
    let baseline = { a: renders.a, b: renders.b }

    // URL form: a live GET presenting both tokens in ?cached=.
    // Counter assertions sit BEFORE shutdown — the shutdown wake is a
    // bump whose lane render (into the torn stream) would count.
    let urlSegment = ""
    await withLiveDrive(
      `http://localhost/page?live=1&cached=${encodeURIComponent(`${urlTokenA},${urlTokenB}`)}`,
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        urlSegment = await drainPayloadSegment(first.value)
        expect(renders.a).toBe(baseline.a)
        expect(renders.b).toBe(baseline.b)
        await h.shutdown("live-a")
      },
    )
    expect(urlSegment).toContain('"data-partial-id":"live-a"')
    expect(urlSegment).toContain('"data-partial-id":"live-b"')

    // Body form: the attach statement presenting the same-shaped
    // tokens produces the same verdicts.
    await renderDocument(scope)
    const bodyTokens = tokensOf(await renderDocument(scope))
    const bodyTokenA = bodyTokens.get("live-a")
    const bodyTokenB = bodyTokens.get("live-b")
    if (!bodyTokenA || !bodyTokenB) throw new Error("expected tokens for both partons")
    baseline = { a: renders.a, b: renders.b }

    let bodySegment = ""
    await withLiveDrive(
      "http://localhost/page?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        bodySegment = await drainPayloadSegment(first.value)
        // Same verdicts: neither parton re-rendered, both answered
        // with the placeholder that confirms the client's copy.
        expect(renders.a).toBe(baseline.a)
        expect(renders.b).toBe(baseline.b)
        await h.shutdown("live-a")
      },
      { attach: { cached: [bodyTokenA, bodyTokenB], since: null, visible: null } },
    )
    expect(bodySegment).toContain('"data-partial-id":"live-a"')
    expect(bodySegment).toContain('"data-partial-id":"live-b"')
  })

  it("the body manifest is uncapped — tokens past the URL cap are still honored", async () => {
    const scope = freshLiveScope("manifest")
    await renderDocument(scope)
    const warm = await renderDocument(scope)
    const tokens = tokensOf(warm)
    const tokenA = tokens.get("live-a")
    const tokenB = tokens.get("live-b")
    if (!tokenA || !tokenB) throw new Error("expected tokens for both partons")
    const rendersAfterDocs = { a: renders.a, b: renders.b }

    // 200 filler tokens AHEAD of the real ones: a transport that
    // truncated at the URL form's cap (96) would drop both verdicts.
    const filler = Array.from(
      { length: 200 },
      (_, i) => `junk-${i}:aaaaaaaaaaaaaaaa:${i.toString(16).padStart(8, "0")}`,
    )

    await withLiveDrive(
      "http://localhost/page?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg = await drainPayloadSegment(first.value)
        expect(seg).toContain('"data-partial-id":"live-a"')
        expect(seg).toContain('"data-partial-id":"live-b"')
        expect(renders.a).toBe(rendersAfterDocs.a)
        expect(renders.b).toBe(rendersAfterDocs.b)
        await h.shutdown("live-a")
      },
      {
        attach: {
          cached: [...filler, tokenA, tokenB],
          since: null,
          visible: null,
        },
      },
    )
  })
})
