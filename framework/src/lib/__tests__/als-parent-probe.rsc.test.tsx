/**
 * PROBE — does `als.run(ctx, () => renderToReadableStream(tree))` carry
 * `ctx` into an ASYNC descendant, and can a nested boundary give its
 * subtree a different ctx while the outer ctx is unaffected?
 *
 * This is the load-bearing question for runtime `parent` removal: if it
 * holds, every parton can read its `parent` from an ALS context set by
 * the boundary that renders it, instead of taking it as a prop.
 *
 * Delete once the mechanism is built (or kept as a regression).
 */

import { describe, expect, it } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import { renderServerToFlight, flightToString, consumePayload } from "../../test/rsc-server.ts"

const probeALS = new AsyncLocalStorage<string>()

/** Async server component: suspends, then reads the ALS store AFTER the
 *  await — so a pass proves the context survived the async boundary. */
async function CtxProbe({ tag }: { tag: string }) {
  await new Promise((r) => setTimeout(r, 5))
  return <span>{`[${tag}:${probeALS.getStore() ?? "NONE"}]`}</span>
}

/** Models a per-parton boundary: renders `children` through its OWN
 *  `renderToReadableStream`, wrapped in its own ALS scope, then returns
 *  the decoded subtree to the outer render. */
async function Boundary({ ctx, children }: { ctx: string; children: ReactNode }) {
  const stream = probeALS.run(ctx, () => renderServerToFlight(children))
  return await consumePayload<ReactNode>(stream)
}

describe("ALS across renderToReadableStream", () => {
  it("carries ctx into an async descendant", async () => {
    const stream = probeALS.run("CTX_A", () =>
      renderServerToFlight(
        <div>
          <CtxProbe tag="x" />
        </div>,
      ),
    )
    const text = await flightToString(stream)
    expect(text).toContain("[x:CTX_A]")
  })

  it("a nested boundary scopes its own ctx; the outer ctx is unaffected", async () => {
    const tree = (
      <div>
        <CtxProbe tag="outer" />
        <Boundary ctx="CTX_B">
          <CtxProbe tag="inner" />
        </Boundary>
        <CtxProbe tag="sibling-after" />
      </div>
    )
    const stream = probeALS.run("CTX_A", () => renderServerToFlight(tree))
    const text = await flightToString(stream)
    // Outer + the sibling after the boundary both see CTX_A.
    expect(text).toContain("[outer:CTX_A]")
    expect(text).toContain("[sibling-after:CTX_A]")
    // The boundary's subtree sees CTX_B — its own scope.
    expect(text).toContain("[inner:CTX_B]")
    // And crucially NOT leaked the other way.
    expect(text).not.toContain("[inner:CTX_A]")
    expect(text).not.toContain("[outer:CTX_B]")
  })

  it("interleaved boundaries don't cross-contaminate", async () => {
    const tree = (
      <div>
        <Boundary ctx="CTX_1">
          <CtxProbe tag="b1" />
        </Boundary>
        <Boundary ctx="CTX_2">
          <CtxProbe tag="b2" />
        </Boundary>
      </div>
    )
    const stream = probeALS.run("ROOT", () => renderServerToFlight(tree))
    const text = await flightToString(stream)
    expect(text).toContain("[b1:CTX_1]")
    expect(text).toContain("[b2:CTX_2]")
    expect(text).not.toContain("[b1:CTX_2]")
    expect(text).not.toContain("[b2:CTX_1]")
  })
})

/** Cheaper alternative: a parton sets its child ctx via `enterWith`
 *  (no boundary / no serialization) and just returns its children. If
 *  React renders each component in its own async resource, the child
 *  inherits it and siblings stay isolated. If it batches in a shared
 *  resource, `enterWith` leaks (last-writer-wins) — the known failure. */
async function EnterWithParton({ ctx, children }: { ctx: string; children: ReactNode }) {
  probeALS.enterWith(ctx)
  return children
}

describe("ALS via enterWith (no boundary) — observe whether it holds", () => {
  it("sibling partons enterWith their own ctx; async children read it", async () => {
    const tree = (
      <div>
        <EnterWithParton ctx="EW_A">
          <CtxProbe tag="a" />
        </EnterWithParton>
        <EnterWithParton ctx="EW_B">
          <CtxProbe tag="b" />
        </EnterWithParton>
      </div>
    )
    const stream = probeALS.run("ROOT", () => renderServerToFlight(tree))
    const text = await flightToString(stream)
    console.log("[enterWith siblings] ->", text.match(/\[[ab]:[^\]]+\]/g))
    expect(text).toMatch(/\[[ab]:/) // rendered something
  })

  it("nested enterWith: grandchild reads the inner ctx", async () => {
    const tree = (
      <EnterWithParton ctx="OUT">
        <div>
          <CtxProbe tag="mid" />
          <EnterWithParton ctx="IN">
            <CtxProbe tag="deep" />
          </EnterWithParton>
        </div>
      </EnterWithParton>
    )
    const stream = probeALS.run("ROOT", () => renderServerToFlight(tree))
    const text = await flightToString(stream)
    console.log("[enterWith nested] ->", text.match(/\[(mid|deep):[^\]]+\]/g))
    expect(text).toMatch(/\[(mid|deep):/)
  })
})
