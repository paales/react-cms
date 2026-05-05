/**
 * Regression: a wildcard-matched spec with no `vary` should be
 * fingerprint-stable across URLs that hit the same wildcard arm —
 * INCLUDING when the client adds framework-internal query params
 * like `?cached=…` and `?partials=…` to the navigation request.
 *
 * Reproduces the "/inspect → /inspect/p/3 re-renders the whole grid"
 * problem. The default `varyResult = { ...params }` for a spec
 * without an explicit `vary` was folding URLPattern's anonymous
 * wildcard captures (numeric keys, including the implicit
 * `search: "*"` URLPattern auto-fills for any pattern that doesn't
 * pin search) into the fingerprint. The search wildcard captured
 * the full `?cached=…&partials=…` string the client sent — the very
 * signal the client uses to ask the server to fp-skip ended up
 * changing the fingerprint and preventing the skip.
 *
 * Named-param matches (`/p/:id`) MUST stay reactive — anonymous
 * captures don't.
 */

import { describe, expect, it } from "vitest"
import { ReactCms, ROOT, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"

/** Pull every `partialFingerprint:"…"` value out of the Flight payload,
 *  keyed by partialId. The Flight serializer emits each
 *  `<PartialErrorBoundary>` instance's props inline; we just regex over
 *  the bytes. */
function fingerprintsByPartialId(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("wildcard match — fingerprint stability", () => {
  it("string match patterns are NOT auto-suffixed: '/inspect' is exact, '/inspect/*' requires a tail", async () => {
    // Pre-fix the framework auto-rewrote `/x/*` into `/x{/*}?`, which
    // collapsed the distinction between exact and prefix matches. The
    // strict reading is now the only one — authors who want both the
    // bare path AND its descendants spell that with `{/*}?` (see the
    // tests below).
    clearRegistry("all")
    const Exact = ReactCms.partial(
      function ExactMatchTestRender(_: RenderArgs) {
        return <span data-testid="exact-body">exact</span>
      },
      { selector: "#exact-match-test", match: "/inspect" },
    )
    const Strict = ReactCms.partial(
      function StrictWildcardTestRender(_: RenderArgs) {
        return <span data-testid="strict-body">strict</span>
      },
      { selector: "#strict-wildcard-test", match: "/inspect/*" },
    )

    const tree = (
      <PartialRoot>
        <Exact parent={ROOT} />
        <Strict parent={ROOT} />
      </PartialRoot>
    )

    const root = await flightAt("http://t/inspect", tree)
    expect(root).toContain("exact-body")
    expect(root).not.toContain("strict-body")

    const child = await flightAt("http://t/inspect/p/3", tree)
    expect(child).not.toContain("exact-body")
    expect(child).toContain("strict-body")
  })

  it("a spec with `match: '/inspect{/*}?'` keeps the same fingerprint across /inspect and /inspect/p/3", async () => {
    clearRegistry("all")
    const Base = ReactCms.partial(
      function InspectBaseFpTestRender(_: RenderArgs) {
        return <div data-testid="grid">grid</div>
      },
      { selector: "#inspect-base-fp-test", match: "/inspect{/*}?" },
    )

    const tree = (
      <PartialRoot>
        <Base parent={ROOT} />
      </PartialRoot>
    )

    const a = await flightAt("http://t/inspect", tree)
    const b = await flightAt("http://t/inspect/p/3", tree)

    const fpAtRoot = fingerprintsByPartialId(a).get("inspect-base-fp-test")
    const fpAtChild = fingerprintsByPartialId(b).get("inspect-base-fp-test")

    expect(fpAtRoot).toBeDefined()
    expect(fpAtChild).toBeDefined()
    expect(fpAtChild).toBe(fpAtRoot)
  })

  it("a wildcard-matched spec's fingerprint is stable when the URL grows a search string", async () => {
    // The bug the user observed: the very `?cached=` param the client
    // sends to opt into fp-skip changed the spec's fingerprint, so
    // the server could never skip. The fix is to drop URLPattern's
    // anonymous-wildcard captures (numeric keys, including the
    // implicit `search: "*"`) from the default fingerprint surface.
    clearRegistry("all")
    const Base = ReactCms.partial(
      function InspectBaseSearchFpTestRender(_: RenderArgs) {
        return <div data-testid="grid">grid</div>
      },
      { selector: "#inspect-base-search-fp-test", match: "/inspect{/*}?" },
    )

    const tree = (
      <PartialRoot>
        <Base parent={ROOT} />
      </PartialRoot>
    )

    const a = await flightAt("http://t/inspect", tree)
    const b = await flightAt("http://t/inspect/p/3?foo=bar&baz=qux", tree)

    const fpA = fingerprintsByPartialId(a).get("inspect-base-search-fp-test")
    const fpB = fingerprintsByPartialId(b).get("inspect-base-search-fp-test")

    expect(fpA).toBeDefined()
    expect(fpB).toBeDefined()
    expect(fpB).toBe(fpA)
  })

  it("a spec with `match: '/p/:id'` keeps named params reactive (sanity)", async () => {
    clearRegistry("all")
    const Detail = ReactCms.partial(
      function NamedParamFpTestRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="detail">id={id}</span>
      },
      { selector: "#named-param-fp-test", match: "/p/:id" },
    )

    const tree = (
      <PartialRoot>
        <Detail parent={ROOT} />
      </PartialRoot>
    )

    const a = await flightAt("http://t/p/1", tree)
    const b = await flightAt("http://t/p/2", tree)

    const fpA = fingerprintsByPartialId(a).get("named-param-fp-test")
    const fpB = fingerprintsByPartialId(b).get("named-param-fp-test")

    expect(fpA).toBeDefined()
    expect(fpB).toBeDefined()
    expect(fpA).not.toBe(fpB)
  })

  it("server fp-skips the wildcard-matched spec when the client sends the matching ?cached= entry", async () => {
    clearRegistry("all")
    const Base = ReactCms.partial(
      function InspectBaseSkipTestRender(_: RenderArgs) {
        return <div data-testid="skip-test-grid">grid-body</div>
      },
      { selector: "#inspect-base-skip-test", match: "/inspect{/*}?" },
    )

    const tree = (
      <PartialRoot>
        <Base parent={ROOT} />
      </PartialRoot>
    )

    // First render at /inspect — capture the spec's fp from the
    // Flight bytes. The body `grid-body` is in the payload (non-
    // skipped path).
    const first = await flightAt("http://t/inspect", tree)
    expect(first).toContain("grid-body")
    const fp = fingerprintsByPartialId(first).get("inspect-base-skip-test")
    expect(fp).toBeDefined()

    // Second render at /inspect/p/3, faking a client refetch that has
    // the prior fp cached. Server should fp-skip the base — the body
    // `grid-body` should NOT appear in the payload.
    const second = await flightAt(
      `http://t/inspect/p/3?cached=inspect-base-skip-test:${fp}`,
      tree,
    )
    expect(second).not.toContain("grid-body")
  })
})
