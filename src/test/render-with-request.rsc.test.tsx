import { describe, expect, it } from "vitest"
import { getCookie, getSearchParam } from "../framework/context.ts"
import { renderWithRequest } from "./rsc-server.ts"

describe("renderWithRequest", () => {
  it("exposes request search params to tracked accessors during render", async () => {
    function Echo() {
      const q = getSearchParam("q")
      return <span>{`query=${q ?? "(none)"}`}</span>
    }
    const { stream } = await renderWithRequest("http://localhost/?q=hello", <Echo />)
    const text = await new Response(stream).text()
    expect(text).toContain("query=hello")
  })

  it("exposes request cookies to tracked accessors during render", async () => {
    function CookieEcho() {
      const sid = getCookie("sid")
      return <span>{`sid=${sid ?? "(none)"}`}</span>
    }
    const { stream } = await renderWithRequest("http://localhost/", <CookieEcho />, {
      headers: { cookie: "sid=abc123; other=x" },
    })
    const text = await new Response(stream).text()
    expect(text).toContain("sid=abc123")
  })

  it("returns throws-out-of-render errors back to the caller", async () => {
    function Boom() {
      throw new Error("kaboom")
      return null
    }
    // The Flight renderer catches render errors and emits them in the
    // stream. Consumer-side, `createFromReadableStream` rejects when
    // we try to resolve the root. We assert on the serialized text
    // instead — it's the layer most tests actually care about.
    const { stream } = await renderWithRequest("http://localhost/", <Boom />)
    const text = await new Response(stream).text()
    expect(text).toContain("kaboom")
  })
})
