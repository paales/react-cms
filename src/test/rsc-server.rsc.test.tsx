import { describe, expect, it } from "vitest"
import { renderAndInspect, renderServerToFlight } from "./rsc-server.ts"

describe("renderServerToFlight", () => {
  it("renders a plain element tree to bytes", async () => {
    const stream = renderServerToFlight(<div data-foo="bar">hello</div>)
    const text = await new Response(stream).text()
    expect(text).toContain("hello")
    expect(text).toContain("data-foo")
  })

  it("renders an async server component", async () => {
    async function Greeting({ name }: { name: string }) {
      await Promise.resolve()
      return <span>hi, {name}</span>
    }
    const { text } = await renderAndInspect(<Greeting name="paul" />)
    expect(text).toContain("hi")
    expect(text).toContain("paul")
  })

  it("streams lazy chunks for suspended trees", async () => {
    function DelayedName({ delay }: { delay: number }) {
      return <span>{new Promise<string>((r) => setTimeout(() => r("late"), delay))}</span>
    }
    const stream = renderServerToFlight(<DelayedName delay={10} />)
    const text = await new Response(stream).text()
    // Flight uses `$L<n>` for pending refs in the first chunk, then
    // resolves them in later chunks. `late` should appear eventually.
    expect(text).toContain("late")
  })
})
