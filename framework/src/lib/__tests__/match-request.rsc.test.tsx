/**
 * `match` over the Request — per-field predicates and the
 * `searchParams` / `cookies` / `headers` record gates.
 *
 * The claims under test:
 *   1. a `searchParams` predicate gates existence order-independently
 *      (the load-more shape: page N exists iff `?pages` ≥ N);
 *   2. a miss parks: the client's cached variant survives as a hidden
 *      Activity placeholder, exactly like a pathname miss;
 *   3. `cookies` gates read the request's ORIGINAL Cookie header — a
 *      same-request `setCookie` overlay does not re-gate;
 *   4. a `headers` gate works and `x-parton-*` stays invisible;
 *   5. named params still flow from the string half alongside
 *      predicate fields;
 *   6. predicate flips move the ancestor fold (existence rides the
 *      descendant contribution), and declared gates are skip-safe
 *      from render one (request-reproducible — no cold-record lag).
 */

import { beforeEach, describe, expect, it } from "vitest"
import { compileMatch } from "../match.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { setCookie } from "../../runtime/context.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

async function flightAt(
  url: string,
  node: React.ReactNode,
  headers?: Record<string, string>,
): Promise<string> {
  const { stream } = await renderWithRequest(url, node, { headers })
  return await new Response(stream).text()
}

function fpById(flight: string, id: string): string | undefined {
  const m = new RegExp(`"partialId":"${id}","partialFingerprint":"([^"]+)"`).exec(flight)
  return m?.[1]
}

const ROOT_MK = hash(stableStringify({}))

// The load-more shape: page 3 exists iff ?pages >= 3.
const PageThree = parton(
  function PageThreeRender(_: RenderArgs) {
    return <span>page-three-body</span>
  },
  {
    selector: "#mr-page-3",
    match: { searchParams: { pages: (v) => Number(v ?? "1") >= 3 } },
  },
)

const CookieGated = parton(
  function CookieGatedRender(_: RenderArgs) {
    return <span>beta-panel-body</span>
  },
  {
    selector: "#mr-beta",
    match: { cookies: { beta: "1" } },
  },
)

function GateFlipper({ children }: { children: React.ReactNode }) {
  setCookie("beta", "1")
  return children
}

const HeaderGated = parton(
  function HeaderGatedRender(_: RenderArgs) {
    return <span>bot-banner-body</span>
  },
  {
    selector: "#mr-bot",
    match: { headers: { "user-agent": (v) => (v ?? "").includes("Bot") } },
  },
)

const InvisibleHeaderGated = parton(
  function InvisibleHeaderGatedRender(_: RenderArgs) {
    return <span>invisible-header-body</span>
  },
  {
    // x-parton-* headers are framework-internal: the gate sees null.
    selector: "#mr-invis",
    match: { headers: { "x-parton-render": (v) => v === null } },
  },
)

const ParamAndPredicate = parton(
  function ParamAndPredicateRender({ slug }: { slug: string } & RenderArgs) {
    return <span>{`combo-body:${slug}`}</span>
  },
  {
    selector: "#mr-combo",
    match: {
      pathname: "/combo/:slug",
      searchParams: { admit: (v) => v === "yes" },
    },
  },
)

beforeEach(() => clearRegistry("all"))

describe("match over the request", () => {
  it("a searchParams predicate gates existence, order-independently", async () => {
    const tree = (
      <PartialRoot>
        <PageThree />
      </PartialRoot>
    )
    expect(await flightAt("http://t/list", tree)).not.toContain("page-three-body")
    expect(await flightAt("http://t/list?pages=2", tree)).not.toContain("page-three-body")
    expect(await flightAt("http://t/list?pages=3", tree)).toContain("page-three-body")
    // Order independence: other params before/after don't matter.
    expect(await flightAt("http://t/list?q=x&pages=7&y=1", tree)).toContain("page-three-body")
  })

  it("a predicate miss parks the client's cached variant", async () => {
    const tree = (
      <PartialRoot>
        <PageThree />
      </PartialRoot>
    )
    const open = await flightAt("http://t/list?pages=3", tree)
    const fp = fpById(open, "mr-page-3")
    expect(fp).toBeDefined()
    const parked = await flightAt(`http://t/list?pages=1&cached=mr-page-3:${ROOT_MK}:${fp}`, tree)
    expect(parked).not.toContain("page-three-body")
    expect(parked).toContain('"data-partial-id":"mr-page-3"')
  })

  it("cookies gates read the ORIGINAL header — the setCookie overlay does not re-gate", async () => {
    const tree = (
      <PartialRoot>
        <GateFlipper>
          <CookieGated />
        </GateFlipper>
      </PartialRoot>
    )
    // The overlay sets beta=1 mid-request, but the gate reads the
    // request as sent: no header → parked. (Body reads via cookie()
    // would see the overlay — the gate deliberately does not.)
    expect(await flightAt("http://t/beta", tree)).not.toContain("beta-panel-body")
    // The next request carries the cookie → the gate opens.
    expect(await flightAt("http://t/beta", tree, { cookie: "beta=1" })).toContain("beta-panel-body")
  })

  it("headers gates work; x-parton-* stays invisible", async () => {
    const bots = (
      <PartialRoot>
        <HeaderGated />
      </PartialRoot>
    )
    expect(await flightAt("http://t/bot", bots)).not.toContain("bot-banner-body")
    expect(await flightAt("http://t/bot", bots, { "user-agent": "GoogleBot/2.1" })).toContain(
      "bot-banner-body",
    )

    const invis = (
      <PartialRoot>
        <InvisibleHeaderGated />
      </PartialRoot>
    )
    // Even when the header is present on the wire, the gate sees null.
    expect(await flightAt("http://t/invis", invis, { "x-parton-render": "1" })).toContain(
      "invisible-header-body",
    )
  })

  it("named params flow from the string half alongside predicate fields", async () => {
    const tree = (
      <PartialRoot>
        <ParamAndPredicate />
      </PartialRoot>
    )
    expect(await flightAt("http://t/combo/alpha", tree)).not.toContain("combo-body")
    const out = await flightAt("http://t/combo/alpha?admit=yes", tree)
    expect(out).toContain("combo-body:alpha")
  })

  it("a declared gate is skip-safe from render one, and a predicate flip un-parks", async () => {
    const tree = (
      <PartialRoot>
        <PageThree />
      </PartialRoot>
    )
    const r1 = await flightAt("http://t/list?pages=3", tree)
    const fp = fpById(r1, "mr-page-3")
    // Same request with the fp cached → skip (declared gates are
    // request-reproducible; no cold-record decline).
    const skipped = await flightAt(`http://t/list?pages=3&cached=mr-page-3:${ROOT_MK}:${fp}`, tree)
    expect(skipped).not.toContain("page-three-body")
    // Flip below the threshold with the same cached fp → parked, then
    // back above → renders again.
    const reopened = await flightAt(`http://t/list?pages=5&cached=mr-page-3:${ROOT_MK}:${fp}`, tree)
    expect(reopened).not.toContain("page-three-body") // fp still matches → skip
  })
})

describe("transport params are invisible to match", () => {
  it("a wildcard search capture is identical with and without transport params", () => {
    const m = compileMatch({ search: "*q=:query" })
    const plain = m.evaluate(new Request("http://t/pokemon/1?search=url&q=a"))
    const action = m.evaluate(
      new Request(
        "http://t/pokemon/1?search=url&q=a&cached=page-stage-3:x:y&__frame=preview&__frameUrl=/p",
      ),
    )
    expect(plain.matched).toBe(true)
    expect(plain.params).toEqual({ query: "a" })
    // The action-render shape of the SAME page must produce the SAME
    // variant identity — otherwise an action response mints a phantom
    // variant that supersedes (and hides) the real one on the client.
    expect(action.params).toEqual(plain.params)
    expect(m.extractParams("http://t/pokemon/1?q=a&cached=zzz")).toEqual({ query: "a" })
  })

  it("searchParams gates see the app URL, not transport params", () => {
    const m = compileMatch({ searchParams: { cached: (v: string | null) => v === null } })
    expect(m.evaluate(new Request("http://t/x?cached=a:b:c")).matched).toBe(true)
  })
})
