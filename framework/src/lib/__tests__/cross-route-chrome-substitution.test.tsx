import React, { Suspense, act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it } from "vitest"
import { PartialsClient } from "../partial-client.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Deterministic reproduction of the "chrome blanks on a cross-route nav
 * to a still-streaming page" bug — at the client-merge layer, no
 * network, no timing.
 *
 * When `PartialsClient` commits a payload whose new page still has a
 * Flight chunk in flight, its cache walk is incomplete, so it can't
 * derive a full template. For a CROSS-route nav it used to return raw
 * `children` — which skips the cache substitution that fills fp-skipped
 * partials. So the shared chrome (the nav), emitted by the server as a
 * bare `<i hidden>` placeholder because the client advertised its fp,
 * never got its cached content and blanked out until the heartbeat
 * re-rendered the page seconds later.
 *
 * In the live app the race only fires occasionally (the deferred chunk
 * sometimes lands before the commit paints), so it can't be guarded by
 * an e2e. Here the pending chunk is a never-resolving `React.lazy`, so
 * the cross-route-pending commit is forced every run.
 */

// A fresh server-rendered partial: a keyed `<PartialErrorBoundary>`
// carrying its id, the way `partial.tsx` emits one.
function fresh(id: string, content: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary key={id} partialId={id} partialFingerprint={`fp_${id}`} partialMatchKey="">
      {content}
    </PartialErrorBoundary>
  )
}

// An fp-skip: the bare placeholder the server emits when the client
// already advertised this partial's fp.
function placeholder(id: string): ReactNode {
  return <i key={`${id}|`} hidden data-partial data-partial-id={id} data-partial-match="" />
}

// A deferred Flight chunk that never arrives — a pending lazy, exactly
// what `unwrapLazy` classifies as `LAZY_PENDING`. Placed directly in the
// tree the way Flight places a deferred reference (a lazy object, not a
// `<Lazy />` element — the cast reflects that wire shape, which the
// `ReactNode` type doesn't model).
const pendingChunk = React.lazy(
  () => new Promise<{ default: React.ComponentType }>(() => {}),
) as unknown as ReactNode

// Commit a payload through `PartialsClient` (its render mutates the
// module-level cache + template) and return the DOM HTML. The client
// renderer is used, not a server renderer: the new page's content is a
// never-resolving `<Suspense>`, which the client renderer commits as its
// fallback rather than throwing (legacy server renderer) or hanging
// (streaming server renderer waiting for the boundary).
function commitAt(route: string, mode: "streaming" | "cache", body: ReactNode): string {
  window.history.pushState({}, "", route)
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() => {
    root.render(
      <PartialsClient mode={mode}>
        <main>{body}</main>
      </PartialsClient>,
    )
  })
  const html = container.innerHTML
  act(() => root.unmount())
  return html
}

beforeEach(() => {
  // Reset the module-level cache + template: an empty streaming render
  // prunes every prior (id, matchKey) entry.
  commitAt("/", "streaming", null)
})

describe("cross-route nav to a still-streaming page", () => {
  it("substitutes fp-skipped chrome from cache instead of blanking it", () => {
    // 1. Fully render the "/" route: the nav renders fresh, so it's
    //    cached, and `_template` is derived for "/".
    commitAt("/", "streaming", [
      fresh(
        "app-nav",
        <nav data-testid="the-nav">
          <a href="/x">link</a>
        </nav>,
      ),
      fresh("home-content", <div data-testid="home-content" />),
    ])

    // 2. Cross-route nav to "/other": the server fp-skips the unchanged
    //    nav (a placeholder, because the client advertised its fp) and
    //    the new page's content is still streaming (a pending Flight
    //    chunk). This is the moment the bug bit.
    const html = commitAt("/other", "streaming", [
      placeholder("app-nav"),
      <Suspense key="pending" fallback={<div data-testid="pending-fallback" />}>
        {pendingChunk}
      </Suspense>,
    ])

    // The nav must be substituted from cache — not left as a bare hidden
    // placeholder (which renders nothing: the "nav disappears until the
    // heartbeat" bug).
    expect(
      html,
      "fp-skipped chrome was not substituted on a cross-route streaming nav",
    ).toContain('data-testid="the-nav"')

    // …while the new page's still-pending content resolves natively via
    // Suspense (its fallback shows), not blanked.
    expect(html).toContain('data-testid="pending-fallback"')
  })

  it("does not reuse the prior route's template (no stuck-page)", () => {
    // Render "/" with its own content, then a cross-route nav to a
    // still-streaming "/other". The prior route's `home-content` must NOT
    // leak into the new page — reusing the old template was the
    // `/magento → /` stuck-page regression the raw-children path avoided.
    commitAt("/", "streaming", [
      fresh("app-nav", <nav data-testid="the-nav" />),
      fresh("home-content", <div data-testid="home-content" />),
    ])

    const html = commitAt("/other", "streaming", [
      placeholder("app-nav"),
      <Suspense key="pending" fallback={<div data-testid="pending-fallback" />}>
        {pendingChunk}
      </Suspense>,
    ])

    // The nav (shared chrome) survives, but the prior page's content does not.
    expect(html).toContain('data-testid="the-nav"')
    expect(html, "prior route's content leaked into the new page (stuck-page)").not.toContain(
      'data-testid="home-content"',
    )
  })
})
