import { act, Suspense } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
// eslint-disable-next-line import/no-unresolved -- browser export of the SSR runtime
import { renderToReadableStream } from "react-dom/server.browser"
import { beforeEach, describe, expect, it } from "vitest"
import {
  _visibleSetIds,
  _sweepEmptyVisibilityObservers,
  VisibilityObserver,
} from "../visibility.tsx"

/**
 * Late-materializing content under a cullable boundary — the
 * empty-fragment re-attach (real Chromium: real IntersectionObserver,
 * real Suspense timing).
 *
 * `FragmentInstance.observeUsing` attaches the observer to the host
 * children React knows about at that moment. A boundary whose content
 * is still suspended when its effect runs — dehydrated nested
 * boundaries on a fast prod hydration, unresolved Flight lazies — has
 * ZERO host children, the observer watches nothing, and children that
 * materialize later are not attached retroactively. Unfixed, such a
 * parton NEVER reports visibility: the connection's visible set never
 * contains it, and on a live connection everything the server parks
 * behind it stays parked (the website world's frozen-after-refresh
 * bug: the four seed bigChunks hydrate exactly like this).
 *
 * The fix: `_sweepEmptyVisibilityObservers()` re-attaches observers
 * that track zero connected nodes, driven by the framework's
 * content-arrival signals (a cullable boundary's observer mounting,
 * every PartialsClient commit).
 */

// A suspending child whose resolution WE control — pending at mount,
// resolved mid-test. `makeGate` returns a fresh gate per scenario so
// the SSR pass and the hydration pass share one, and the pure-client
// scenario gets its own.
function makeGate() {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready = false
  void gate.then(() => {
    ready = true
  })
  function LateChild({ testid }: { testid: string }) {
    if (!ready) throw gate
    return <div data-testid={testid} style={{ width: 200, height: 100 }} />
  }
  return { release, gate, LateChild }
}

describe("visibility observer over late-materializing content", () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
  })

  it("re-attaches an empty observer once the content commits, and the parton reports", async () => {
    const { release, gate, LateChild } = makeGate()
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <VisibilityObserver id="late-parton">
          <Suspense fallback={null}>
            <LateChild testid="late-content" />
          </Suspense>
        </VisibilityObserver>,
      )
    })

    // The observer effect has run against the empty fragment (the
    // child is suspended, the fallback renders no host node). Give the
    // IntersectionObserver a real frame: no report can exist yet.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect((_visibleSetIds() ?? []).join(",")).not.toContain("late-parton")

    // Content arrives.
    await act(async () => {
      release()
      await gate
    })
    expect(container.querySelector('[data-testid="late-content"]')).not.toBeNull()

    // The framework's content-arrival signals run the sweep (the
    // PartialsClient post-commit effect / a nested observer mounting);
    // here we drive the exported sweep directly.
    _sweepEmptyVisibilityObservers()

    // Real IO callbacks are async — poll a few frames for the report.
    let reported = false
    for (let i = 0; i < 20 && !reported; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      reported = (_visibleSetIds() ?? []).join(",").includes("late-parton")
    }
    expect(reported).toBe(true)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it("a boundary hydrating over a dehydrated child reports once adoption completes (the world's bigChunk shape)", async () => {
    // Asymmetric gates — the prod shape: the SSR HTML carries the
    // COMPLETE content, but the client's copy of the child is still
    // pending (a Flight lazy whose row hasn't arrived) when hydration
    // runs the boundary's effect. React defers the boundary
    // (dehydrated), the observer effect sees ZERO host children, and
    // when the client child later resolves React ADOPTS the SSR DOM —
    // an adoption, not a placement, so nothing re-attaches it to the
    // observer.
    const server = makeGate()
    server.release()
    await server.gate
    const client = makeGate()

    const page = (Child: typeof server.LateChild) => (
      <VisibilityObserver id="hydrated-parton">
        <Suspense fallback={null}>
          <Child testid="hydrated-content" />
        </Suspense>
      </VisibilityObserver>
    )

    const stream = await renderToReadableStream(page(server.LateChild))
    container.innerHTML = await new Response(stream).text()
    expect(container.querySelector('[data-testid="hydrated-content"]')).not.toBeNull()

    const root = await act(async () => hydrateRoot(container, page(client.LateChild)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect((_visibleSetIds() ?? []).join(",")).not.toContain("hydrated-parton")

    // The client child resolves; React adopts the dehydrated boundary.
    await act(async () => {
      client.release()
      await client.gate
    })
    expect(container.querySelector('[data-testid="hydrated-content"]')).not.toBeNull()

    _sweepEmptyVisibilityObservers()

    let reported = false
    for (let i = 0; i < 20 && !reported; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      reported = (_visibleSetIds() ?? []).join(",").includes("hydrated-parton")
    }
    expect(reported).toBe(true)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
