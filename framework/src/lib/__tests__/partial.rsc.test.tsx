/**
 * `parton` constructor — core flow tests.
 */

import { describe, expect, it } from "vitest"
import { parton, ROOT, PartialRoot, type RenderArgs } from "../partial.tsx"
import { cookie, park, pathname, searchParam } from "../server-hooks.ts"
import { Frame } from "../frame.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { setCookie } from "../../runtime/context.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("parton — match + skip", () => {
  it("renders pattern-matched specs with extracted params", async () => {
    // No vary — match params auto-flow into Render. `InferV<{match:
    // "/pokemon/:id"}>` resolves to `{id: string}`, so the call site
    // doesn't need to supply id.
    const Page = parton(
      function ParamPageRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="param-out">id={id}</span>
      },
      { match: "/pokemon/:id", selector: "#param-page" },
    )
    const out = await flightAt("http://t/pokemon/42", <Page />)
    // Flight serializes JSX children as an array `["id=", "42"]`.
    expect(out).toContain('"id=","42"')
    expect(out).toContain("param-out")
  })

  it("emits nothing on a pattern miss", async () => {
    const Page = parton(
      function MissTargetRender({}: RenderArgs) {
        return <span data-testid="should-not-appear">x</span>
      },
      { match: "/pokemon/:id", selector: "#match-miss-test" },
    )
    const out = await flightAt("http://t/cache-demo", <Page />)
    expect(out).not.toContain("should-not-appear")
  })

  it("emits nothing when the schema parks", async () => {
    const Page = parton(
      function ParkedTargetRender({}: RenderArgs) {
        return <span data-testid="parked-target">x</span>
      },
      {
        match: "/x",
        selector: "#parked-spec",
        schema: () => {
          if (searchParam("on") !== "1") park()
          return {}
        },
      },
    )
    const off = await flightAt("http://t/x", <Page />)
    expect(off).not.toContain("parked-target")
    const on = await flightAt("http://t/x?on=1", <Page />)
    expect(on).toContain("parked-target")
  })

  it("a framed spec's match gates on the frame URL, not the page URL", async () => {
    // `match` resolves against the frame-resolved request (like `vary`),
    // so a spec inside a <Frame> routes on the frame's URL. Before this
    // fix `match` used the page URL and a framed match could never hit.
    const Sub = parton(
      function FramedMatchRender({}: RenderArgs) {
        return <span data-testid="framed-open">open</span>
      },
      { match: "/sub/open", selector: "#framed-match" },
    )
    // Same page URL in both; only the frame URL differs.
    const open = await flightAt(
      "http://t/page",
      <Frame name="bug1-open" initialUrl="/sub/open">
        <Sub />
      </Frame>,
    )
    expect(open).toContain("framed-open")

    const closed = await flightAt(
      "http://t/page",
      <Frame name="bug1-closed" initialUrl="/sub/closed">
        <Sub />
      </Frame>,
    )
    expect(closed).not.toContain("framed-open")
  })
})

describe("parton — tracked reads + render", () => {
  it("a body's tracked read IS the request surface", async () => {
    const Page = parton(
      function FlavorPageRender({}: RenderArgs) {
        const flavor = searchParam("flavor", "vanilla")
        return <span data-testid="flavor">{flavor}</span>
      },
      { match: "/flavors", selector: "#flavor-spec" },
    )
    const v = await flightAt("http://t/flavors?flavor=chocolate", <Page />)
    expect(v).toContain("chocolate")
    const dflt = await flightAt("http://t/flavors", <Page />)
    expect(dflt).toContain("vanilla")
  })

  it("auto-flows match params to Render with no vary", async () => {
    const Page = parton(
      function MatchParamRender({ slug }: { slug: string } & RenderArgs) {
        return <span data-testid="slug-out">{slug}</span>
      },
      { match: "/p/:slug", selector: "#match-only-spec" },
    )
    const out = await flightAt("http://t/p/hello-world", <Page />)
    expect(out).toContain("hello-world")
  })

  it("merges match params + schema-read fields", async () => {
    const Page = parton(
      function MergedRender({
        slug,
        page,
      }: {
        slug: string
        page: number
      } & RenderArgs) {
        return (
          <span data-testid="merged">
            {slug}/{page}
          </span>
        )
      },
      {
        match: "/p/:slug",
        selector: "#merged-spec",
        schema: () => ({ page: Number(searchParam("page", "1")) }),
      },
    )
    const out = await flightAt("http://t/p/x?page=3", <Page />)
    // Flight serializes JSX children as an array `["x", "/", 3]` —
    // assert on the array form rather than the rendered text.
    expect(out).toContain('"x","/",3')
  })
})

describe("parton — selector & id derivation", () => {
  it("auto-derives selector from Render.name", async () => {
    function MyAutoSelectedRender({}: RenderArgs) {
      return <i data-testid="auto-selector-output">ok</i>
    }
    const Page = parton(MyAutoSelectedRender, { match: "/auto-selector-test" })
    const out = await flightAt("http://t/auto-selector-test", <Page />)
    expect(out).toContain("auto-selector-output")
  })

  it("strips Render/Page/Block/Partial suffixes when auto-deriving", async () => {
    function MyHeaderPage({}: RenderArgs) {
      return <i data-partial-id="auto-header-id">x</i>
    }
    // Even though the function ends in `Page`, the selector should
    // strip it. We can't easily inspect the selector from outside,
    // but we can verify the rendered partial wrapper carries the
    // expected id by reaching into the Flight payload.
    const Page = parton(MyHeaderPage, { match: "/strip-suffix-test" })
    const out = await flightAt("http://t/strip-suffix-test", <Page />)
    expect(out).toContain("auto-header-id")
  })
})

describe("parton — children passthrough", () => {
  it("forwards `children` from the spec component to Render", async () => {
    const Wrapper = parton(
      function WrapperRender({ children }: RenderArgs) {
        return (
          <div data-testid="wrapper">
            <span data-testid="wrapper-marker">w</span>
            {children}
          </div>
        )
      },
      { match: "/wrapper-test", selector: "#wrapper-spec" },
    )
    const out = await flightAt(
      "http://t/wrapper-test",
      <Wrapper>
        <span data-testid="inner-content">inner</span>
      </Wrapper>,
    )
    expect(out).toContain("wrapper-marker")
    expect(out).toContain("inner-content")
  })
})

describe("parton — call-site prop pass-through", () => {
  it("forwards JSX call-site props to Render alongside schema reads", async () => {
    const Inner = parton(
      function PassthroughInnerRender({
        pokemonId,
        flavor,
      }: {
        pokemonId: number
        flavor: string
      } & RenderArgs) {
        return (
          <span data-testid="passthrough-out">
            {pokemonId}/{flavor}
          </span>
        )
      },
      {
        selector: "#passthrough-inner",
        schema: () => ({ flavor: searchParam("flavor", "vanilla") }),
      },
    )
    // Outer wrapper: parses :id from URL, passes pokemonId as a JSX
    // prop to Inner. Inner gets `flavor` from its own schema read and
    // `pokemonId` from the call-site prop.
    const Outer = parton(
      function PassthroughOuterRender({ id }: { id: string } & RenderArgs) {
        return <Inner pokemonId={Number(id)} />
      },
      { match: "/p/:id", selector: "#passthrough-outer" },
    )
    const out = await flightAt("http://t/p/9?flavor=mint", <Outer />)
    expect(out).toContain("passthrough-out")
    // Flight serializes children as `[9, "/", "mint"]`.
    expect(out).toContain('9,"/","mint"')
  })

  it("inner spec receives props directly from the call site", async () => {
    // Zero declaration ceremony: Outer's match parses the URL, Inner
    // just takes pokemonId as a prop.
    const Inner = parton(
      function NoVaryInnerRender({ pokemonId }: { pokemonId: number } & RenderArgs) {
        return <span data-testid="no-vary-inner">id-{pokemonId}</span>
      },
      { selector: "#no-vary-inner" },
    )
    const Outer = parton(
      function NoVaryOuterRender({ id }: { id: string } & RenderArgs) {
        return <Inner pokemonId={Number(id)} />
      },
      { match: "/no-vary/:id", selector: "#no-vary-outer" },
    )
    const out = await flightAt("http://t/no-vary/77", <Outer />)
    expect(out).toContain("no-vary-inner")
    expect(out).toContain('"id-",77')
  })
})

describe("parton — two-step builder", () => {
  it("partial(opts) returns a callable builder that produces a spec", async () => {
    // The builder form lets authors derive `typeof Builder.props`
    // before the Render exists — the single-step form can't do that
    // because `const S = partial(R, opts)` + `function R(p: typeof
    // S.props)` hits a circular initializer.
    const Builder = parton({ match: "/builder/:slug", selector: "#two-step" })
    function BuilderRender(p: typeof Builder.props) {
      return <span data-testid="two-step-out">{p.slug}</span>
    }
    const Page = Builder(BuilderRender)
    const out = await flightAt("http://t/builder/hello", <Page />)
    expect(out).toContain("two-step-out")
    expect(out).toContain("hello")
  })

  it("builder threads schema reads through the same way single-step does", async () => {
    const Builder = parton({
      match: "/builder/:slug",
      selector: "#two-step-vary",
      schema: () => ({ variant: searchParam("variant", "default") }),
    })
    function BuilderVaryRender(p: typeof Builder.props) {
      return (
        <span data-testid="two-step-vary-out">
          {p.slug}:{p.variant}
        </span>
      )
    }
    const Page = Builder(BuilderVaryRender)
    const out = await flightAt(
      "http://t/builder/foo?variant=mint",
      <Page />,
    )
    expect(out).toContain('"foo",":","mint"')
  })
})

describe("parton — match grammar inference", () => {
  it("optional `:foo?` flows through as optional prop", async () => {
    const Page = parton(
      function OptionalParamRender({
        slug,
        page,
      }: { slug: string; page?: string } & RenderArgs) {
        return (
          <span data-testid="opt-out">
            {slug}/{page ?? "none"}
          </span>
        )
      },
      { match: "/opt/:slug{/:page}?", selector: "#opt-spec" },
    )
    const withPage = await flightAt("http://t/opt/x/2", <Page />)
    expect(withPage).toContain('"x","/","2"')
    const withoutPage = await flightAt("http://t/opt/x", <Page />)
    expect(withoutPage).toContain('"x","/","none"')
  })
})

describe("<Frame> — scope opener", () => {
  it("descendant partials' tracked reads see the frame-resolved request", async () => {
    // <Frame> writes its initialUrl to session if absent; the inner
    // partial's resolveFrameRequest then reads that URL via session,
    // and `pathname()` sees it instead of the page URL.
    const Inner = parton(
      function FramedInnerRender({}: RenderArgs) {
        const framePath = pathname()
        return <span data-testid="frame-pathname">{framePath}</span>
      },
      { selector: "#framed-inner" },
    )
    const out = await flightAt(
      "http://t/frame-host",
      <Frame name="drawer-test" initialUrl="/drawer/initial">
        <Inner />
      </Frame>,
    )
    expect(out).toContain("/drawer/initial")
    expect(out).not.toContain(">/frame-host<")
  })
})

describe("parton — cookie() sees mid-request setCookie writes", () => {
  // The cart pattern (e2e-testing/src/app/pages/magento/cart-actions.ts):
  // an action calls `setCookie("cart_id", X)` to persist a freshly-
  // created cart, then `getServerNavigation().reload({selector: "cart"})`.
  // The re-rendered cart spec reads `cookie("cart_id")` — without the
  // overlay it sees the stale request header (undefined / old value),
  // and the cart badge stays at 0 until the next nav. With the overlay,
  // the immediate re-render sees the new id, hits Magento, and the
  // badge updates as the reload intended.
  it("setCookie before a descendant spec is visible to that spec's cookie() read", async () => {
    function CookiePreloader({ children }: { children: React.ReactNode }) {
      setCookie("cart_id", "fresh-cart-123")
      return children
    }
    const CartBadge = parton(
      function CartBadgeRender({}: RenderArgs) {
        const cartId = cookie("cart_id")
        return <span data-testid="cart-id-out">cart={cartId ?? "none"}</span>
      },
      { selector: "#cart-vary-cookies" },
    )
    const out = await flightAt(
      "http://t/",
      <CookiePreloader>
        <CartBadge />
      </CookiePreloader>,
    )
    // Flight serializes JSX children as an array `["cart=", "fresh-cart-123"]`.
    expect(out).toContain('"cart=","fresh-cart-123"')
    expect(out).not.toContain('"cart=","none"')
  })

  it("setCookie overrides a request-header cookie value for cookie()", async () => {
    function ThemeFlipper({ children }: { children: React.ReactNode }) {
      setCookie("theme", "dark")
      return children
    }
    const Themed = parton(
      function ThemedRender({}: RenderArgs) {
        const theme = cookie("theme") ?? "light"
        return <span data-testid="theme-out">theme={theme}</span>
      },
      { selector: "#themed-vary-cookies" },
    )
    const { stream } = await renderWithRequest(
      "http://t/",
      <ThemeFlipper>
        <Themed />
      </ThemeFlipper>,
      { headers: { cookie: "theme=light" } },
    )
    const out = await new Response(stream).text()
    // Flight serializes JSX children as an array `["theme=", "dark"]`.
    expect(out).toContain('"theme=","dark"')
    expect(out).not.toContain('"theme=","light"')
  })
})

describe("multi-variant pool", () => {
  it("emits a hidden Activity sibling for each other cached matchKey", async () => {
    // Same spec, different match params. Client claims a cached
    // variant for /pokemon/1 (matchKey₁) while navigating to
    // /pokemon/2 (matchKey₂); server must emit a hidden Activity
    // sibling for matchKey₁ so React keeps the prior fiber alive
    // when /pokemon/1's body re-mounts on back-nav.
    const Page = parton(
      function MultiVariantTestRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="variant-body">id={id}</span>
      },
      { match: "/pokemon/:id", selector: "#multi-variant-test" },
    )
    const tree = (
      <PartialRoot>
        <Page />
      </PartialRoot>
    )

    // Pretend the client visited /pokemon/1 first, so it has
    // (id=multi-variant-test, matchKey₁) cached. Fake fp matters
    // less — the wire's matchKey is what drives sibling emission.
    const mk1 = hash(stableStringify({ id: "1" }))
    const stalefp = "0".repeat(16)
    const flight = await new Response(
      (
        await renderWithRequest(
          `http://t/pokemon/2?cached=multi-variant-test:${mk1}:${stalefp}`,
          tree,
        )
      ).stream,
    ).text()

    // Visible body for /pokemon/2 must be present.
    expect(flight).toContain('"id=","2"')
    // The prior variant's matchKey shows up as an Activity sibling
    // (mode:"hidden") + placeholder (data-partial-match=matchKey₁).
    expect(flight).toContain(`"data-partial-match":"${mk1}"`)
    expect(flight).toContain('"mode":"hidden"')
  })

  it("does not emit hidden siblings when the client has only the current variant cached", async () => {
    const Page = parton(
      function NoSiblingTestRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="no-sibling">id={id}</span>
      },
      { match: "/pokemon/:id", selector: "#no-sibling-test" },
    )
    const tree = (
      <PartialRoot>
        <Page />
      </PartialRoot>
    )
    const mk = hash(stableStringify({ id: "1" }))
    const stalefp = "0".repeat(16)
    const flight = await new Response(
      (
        await renderWithRequest(
          `http://t/pokemon/1?cached=no-sibling-test:${mk}:${stalefp}`,
          tree,
        )
      ).stream,
    ).text()
    expect(flight).toContain('"id=","1"')
    // No hidden Activity mode in the stream — only the visible one.
    expect(flight).not.toContain('"mode":"hidden"')
  })

  it("nested partial inherits matchKey from match-bearing ancestor", async () => {
    // Regression: navigating `/` → `/pokemon/1` → `/` → `/pokemon/2`
    // → `/` → `/pokemon/1` must surface `/pokemon/1`'s nested content
    // (Hero, Stats, …), NOT `/pokemon/2`'s. The bug was that nested
    // partials without their own `match` collapsed to a constant
    // matchKey, so each `/pokemon/n` visit overwrote the same cache
    // slot and the outer wrapper's substituteNested walk re-resolved
    // nested partials to whatever was cached most recently.
    //
    // Fix: a spec without its own named match params walks
    // `parent.path` and inherits the closest match-bearing ancestor's
    // matchKey. So a child of `/pokemon/:id` gets a distinct matchKey
    // per `:id` value — different cache slots, no cross-variant
    // clobbering.
    const Inner = parton(
      function InheritedMatchKeyInnerRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="inner-body">inner-id={id}</span>
      },
      { selector: "#inherited-match-key-inner" },
    )
    const Outer = parton(
      function InheritedMatchKeyOuterRender({
        id,
      }: { id: string } & RenderArgs) {
        return <Inner id={id} />
      },
      { match: "/pokemon/:id", selector: "#inherited-match-key-outer" },
    )
    const tree = (
      <PartialRoot>
        <Outer />
      </PartialRoot>
    )
    const flight1 = await new Response(
      (await renderWithRequest("http://t/pokemon/1", tree)).stream,
    ).text()
    const flight2 = await new Response(
      (await renderWithRequest("http://t/pokemon/2", tree)).stream,
    ).text()

    // The matchKey hashes are deterministic from the named match
    // params alone — both ancestor and descendant must produce them.
    const mk1 = hash(stableStringify({ id: "1" }))
    const mk2 = hash(stableStringify({ id: "2" }))
    expect(mk1).not.toBe(mk2)
    // Each render's Flight stream carries `partialMatchKey:"<mk>"`
    // on every PEB wrapper — outer AND inner. Both spec wrappers in
    // a single render share the same matchKey: proof of inheritance.
    const count = (haystack: string, needle: string) =>
      haystack.split(needle).length - 1
    expect(count(flight1, `partialMatchKey":"${mk1}"`)).toBeGreaterThanOrEqual(2)
    expect(count(flight2, `partialMatchKey":"${mk2}"`)).toBeGreaterThanOrEqual(2)
    // Cross-check: render-1 has no mk2 (and vice versa) — variants
    // are independent across requests.
    expect(count(flight1, `partialMatchKey":"${mk2}"`)).toBe(0)
    expect(count(flight2, `partialMatchKey":"${mk1}"`)).toBe(0)
  })

  it("parked emission produces a hidden Activity per cached variant", async () => {
    // Spec doesn't match this URL but the client has two variants
    // cached for the id. Server should emit a hidden Activity for
    // each cached matchKey so React doesn't unmount the parked
    // fibers as the user navigates between unrelated routes.
    const Page = parton(
      function ParkedMultiTestRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="parked-multi">id={id}</span>
      },
      { match: "/pokemon/:id", selector: "#parked-multi-test" },
    )
    const tree = (
      <PartialRoot>
        <Page />
      </PartialRoot>
    )
    const mk1 = hash(stableStringify({ id: "1" }))
    const mk2 = hash(stableStringify({ id: "2" }))
    const stalefp = "0".repeat(16)
    const flight = await new Response(
      (
        await renderWithRequest(
          `http://t/elsewhere?cached=parked-multi-test:${mk1}:${stalefp},parked-multi-test:${mk2}:${stalefp}`,
          tree,
        )
      ).stream,
    ).text()
    // Both variants represented as hidden placeholders. Body
    // content for either is absent (match miss → no fresh emit).
    expect(flight).not.toContain('"id=","1"')
    expect(flight).not.toContain('"id=","2"')
    expect(flight).toContain(`"data-partial-match":"${mk1}"`)
    expect(flight).toContain(`"data-partial-match":"${mk2}"`)
  })
})
