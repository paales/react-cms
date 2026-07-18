import { localCell, parton, type RenderArgs, searchParam, time } from "@parton/framework"
import { CellCheckbox, Reload } from "./components"

function RenderedAt() {
  return (
    <i>
      Rendered at{" "}
      {new Date(time().now).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        fractionalSecondDigits: 3,
      })}
    </i>
  )
}

export const HelloWorld = parton(async function GreetingRender(_: RenderArgs) {
  const name = searchParam("name")
  const target = !name ? "/?name=user" : "/"

  return (
    <section style={{ border: "1px solid #efefef", paddingInline: "1em", marginBlock: "3em" }}>
      <h1>Parton</h1>

      <p>
        A React-based <s>framework</s> research project. Parton is a React Server Components
        framework.
      </p>

      <h2>Navigation</h2>

      <p> Lets start with a few basics. Parton uses regular anchor tags for navigating.</p>
      <p>
        <a href={target}>Go to '{target}'</a>.
      </p>

      <p>
        Parton intercepts regular anchor tags with the{" "}
        <a href="https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API" target="_blank">
          Navigation API ↗
        </a>
        . When navigating we see nothing special, page is updated to reflect the new URL state. The
        backend rerenders the whole page and updates the page. Just like how a page{" "}
        <Reload>reload</Reload> will will reload everything on the page.
      </p>

      <p>
        However, when navigating, the client communicates what parton it already has. The server
        does a FULL rerender of the page and it can then skip all the partons it knows the client
        already has. Or better said, it skips 100% unless something has changed:
      </p>
      <p>
        <code>
          const name = searchParam('name') // current value: {name ? `"${name}"` : "null"}
        </code>
      </p>
      <p>
        This is not only a network optimization, but the server fully skips any form of rendering of
        irrelevant partons. Note the 'Rendered at' date of this parton changes but the ones below
        this one don't.
      </p>

      <NestedParton />

      <h3>Rerendering</h3>

      <p>
        A parton automatically keeps track of the pieces a parton accesses of the Request by using
        server hooks (<code>match("/product/:urlKey")</code>, <code>header("accept-language")</code>
        , <code>searchParam("name", "my-default")</code>, <code>cookie("cookiename")</code>). If the
        output of any of these methods change, we'll trigger a rewrite.
      </p>

      <RenderedAt />
    </section>
  )
}, "/")

export const NestedParton = parton(async function NestedParton(_: RenderArgs) {
  return (
    <details style={{ border: "1px solid #efefef", paddingInline: "1em", marginBlock: "0.5em" }}>
      <summary style={{ marginBlock: "0.5em" }}>
        <strong>Nested Parton</strong>: Partons can nest and render individually. <RenderedAt />
      </summary>
      <p>
        Whenever a Partons renders a child-parton, we replace the render output of the parton with a
        placeholder in the output stream. We re-assemble the stream on the client and later we can
        re-reasseble whenever only the parent changes.. This makes partons individually adressable,
        reloadable and quite a few other cool things we get to.
      </p>
    </details>
  )
}, "/")

export const Matching = parton(async function Matching(_: RenderArgs) {
  const loader = await localCell("loadingToggle", { initial: false, shape: "boolean" })

  return (
    <section style={{ border: "1px solid #efefef", paddingInline: "1em", marginBlock: "3em" }}>
      <h3>Matching</h3>
      <p>
        We can show and hide completele partons and let a parton match based on the request. But in
        Parton there is no 'page'. You might construct a page, and we link URL's to specific area's
        but funamentally there is only Request reflected state.
      </p>
      <label>
        Load data <CellCheckbox cell={loader} />
      </label>

      <p>
        <RenderedAt />
      </p>
    </section>
  )
})

export const DataLoading = parton(async function DataLoading(_: RenderArgs) {
  const loader = await localCell("loadingToggle", { initial: false, shape: "boolean" })

  return (
    <section style={{ border: "1px solid #efefef", paddingInline: "1em", marginBlock: "3em" }}>
      <h3>Data loading</h3>
      <p>A parton can do the things a regular React Server Component can do. Like data loading. </p>
      <label>
        Load data <CellCheckbox cell={loader} />
      </label>

      <p>
        <RenderedAt />
      </p>
    </section>
  )
})
