/**
 * `untrackedUrl()` — the one server-hook that deliberately does NOT
 * record a dependency. It reads the full request URL (origin, path,
 * every search param, named or not) for surfaces that must mirror the
 * raw request byte-for-byte — the CMS editor chrome's link-building is
 * the in-tree model. Because no dep key can cover "the whole URL,
 * whatever it is," the hook enforces its own precondition instead of
 * relying on the author to remember it: it throws unless the calling
 * spec declared `{ fpSkip: false }`, so an fp-carrying spec can never
 * silently serve a cached render whose embedded URL went stale.
 */

import { describe, expect, it } from "vitest"
import { flightToString, renderServerToFlight, renderWithRequest } from "../../test/rsc-server.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { untrackedUrl } from "../server-hooks.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("untrackedUrl()", () => {
  it("throws when the calling spec does not declare { fpSkip: false } — contained as an error card", async () => {
    const Reckless = parton(
      Object.assign(
        function RecklessUrlRender(_: RenderArgs) {
          const url = untrackedUrl()
          return <span data-testid="reckless-body">{url.href}</span>
        },
        { displayName: "reckless-url" },
      ),
      { match: "/reckless" },
    )
    const Healthy = parton(
      Object.assign(
        function HealthyUrlSiblingRender(_: RenderArgs) {
          return <span data-testid="healthy-body">HEALTHY-OK</span>
        },
        { displayName: "healthy-url" },
      ),
      { match: "/reckless" },
    )

    const out = await flightAt(
      "http://t/reckless",
      <PartialRoot>
        <Reckless />
        <Healthy />
      </PartialRoot>,
    )

    // The throw is contained to the offending parton — the sibling
    // still renders (see partial-error-containment.rsc.test.tsx).
    expect(out).toContain("HEALTHY-OK")
    expect(out).not.toContain("reckless-body")
    expect(out).toContain("partial-error-boundary.tsx#PartialErrorCard")
    expect(out).toContain("reckless-url")
  })

  it("returns the full request URL — untracked params included — for an { fpSkip: false } spec", async () => {
    const Authoritative = parton(
      Object.assign(
        function AuthoritativeUrlRender(_: RenderArgs) {
          const url = untrackedUrl()
          return <span data-testid="auth-body">{url.pathname + url.search}</span>
        },
        { displayName: "authoritative-url" },
      ),
      { match: "/auth", fpSkip: false },
    )

    // `extra` is never read via a tracked hook (no searchParam("extra")
    // anywhere) — untrackedUrl() must still carry it through, which is
    // the whole point: it preserves params the spec never named.
    const out = await flightAt(
      "http://t/auth?extra=xyz",
      <PartialRoot>
        <Authoritative />
      </PartialRoot>,
    )

    expect(out).toContain("/auth?extra=xyz")
  })

  it("is a no-op fallback outside a parton body — returns a placeholder URL, never throws", async () => {
    async function PlainProbe() {
      const url = untrackedUrl()
      return <span data-testid="plain-body">{url.href}</span>
    }
    const out = await flightToString(
      renderServerToFlight(
        <div>
          <PlainProbe />
        </div>,
      ),
    )
    expect(out).toContain("http://localhost/")
  })
})
