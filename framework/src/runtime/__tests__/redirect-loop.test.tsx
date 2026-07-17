// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Redirect } from "../redirect-client.tsx"
// The window navigate executor lives in the late-loaded `frame-client`;
// `<Redirect>`'s eager handle dynamically imports it on fire. Pre-load
// it so the dispatch resolves from cache within the mount effect's
// microtask chain — modelling the running app, where the live layer has
// loaded the executor before any redirect fires.
import "../../lib/frame-client.tsx"

/**
 * Redirect loop guard.
 *
 * `<Redirect url>` is rendered by Root when a page resolves a
 * `redirect(url)`. On mount it drives a client navigation to `url`.
 * When the destination resolves to ANOTHER redirect back to the same
 * URL — the degenerate self-redirect `redirect("/x")` served at `/x`,
 * or an A→B→A cycle whose hop lands back where we already are — the
 * client must NOT re-fire: the URL we're being sent to is the URL we're
 * already on. Re-firing spins a refetch → re-redirect → refetch loop
 * with no termination signal.
 *
 * The guard is structural: `<Redirect>` compares `url` against the
 * current entry's URL and short-circuits when they match.
 */

let container: HTMLElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
})

/** Point the jsdom navigation shim's `currentEntry.url` at `path`
 *  (resolved against the live jsdom origin so history mutation is
 *  allowed) and spy on its `navigate` so we can assert whether a fire
 *  happened. */
function spyOnNavigation(path: string): ReturnType<typeof vi.fn> {
  window.history.replaceState(null, "", path)
  const nav = (globalThis as { navigation?: { navigate: unknown } }).navigation!
  const spy = vi.fn((url: string, opts?: unknown) => {
    // Mirror the real shim: commit the URL so currentEntry.url advances.
    window.history.pushState(
      (opts as { state?: unknown })?.state ?? null,
      "",
      new URL(url, window.location.origin).pathname,
    )
    return { committed: Promise.resolve(), finished: Promise.resolve() }
  })
  nav.navigate = spy
  return spy
}

async function mountRedirect(url: string) {
  await act(async () => {
    root = createRoot(container)
    root.render(<Redirect url={url} />)
  })
}

describe("<Redirect> self-redirect guard", () => {
  it("does NOT navigate when the redirect target equals the current URL", async () => {
    // We are already at /redirect-loop. The page resolved
    // redirect("/redirect-loop") — pointing at itself. Following it
    // would refetch /redirect-loop, which resolves the same redirect,
    // which fires <Redirect url="/redirect-loop"> again: an unbounded
    // loop. The guard must short-circuit on url === currentEntry.url.
    const spy = spyOnNavigation("/redirect-loop")
    await mountRedirect("/redirect-loop")
    expect(spy).not.toHaveBeenCalled()
  })

  it("still navigates when the redirect target is a different URL", async () => {
    // The ordinary case: /redirect-demo → /cache-demo. A real cross-URL
    // redirect must still fire so the destination commits.
    const spy = spyOnNavigation("/redirect-demo")
    await mountRedirect("/cache-demo")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toContain("/cache-demo")
  })
})
