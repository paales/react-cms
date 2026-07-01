import React, { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { deriveTemplate } from "../partial-template.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

/**
 * Unit coverage for `deriveTemplate` — the client-side walk that turns
 * a streamed payload into the persisted structural template (chrome
 * preserved, partial wrappers → `<i data-partial hidden>` placeholders).
 *
 * Two properties carry the merge machinery:
 *
 *   - Idempotence: a derived template re-derived yields the same
 *     structure with the same clean `${id}|${matchKey}` keys. The
 *     cache-mode path re-walks trees that already contain placeholders
 *     (server fp-skips), so a second derive must be a fixpoint — and
 *     must undo Flight's key-composite artifacts rather than compound
 *     them.
 *   - Pending lazies stay RAW (same node identity): a still-streaming
 *     Flight chunk must reach React untouched so native Suspense
 *     resolves it; dropping or replacing it blanks the region.
 */

function wrapper(id: string, mk: string, content: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary
      key={id}
      partialId={id}
      partialFingerprint={`fp_${id}`}
      partialMatchKey={mk}
    >
      {content}
    </PartialErrorBoundary>
  )
}

// A deferred Flight chunk that never arrives — a pending lazy, exactly
// what `unwrapLazy` classifies as `LAZY_PENDING`. Placed directly in
// the tree the way Flight places a deferred reference.
const pendingChunk = React.lazy(
  () => new Promise<{ default: React.ComponentType }>(() => {}),
) as unknown as ReactNode

function html(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

describe("deriveTemplate", () => {
  it("replaces partial wrappers with placeholders and keeps chrome", () => {
    const tree = (
      <main>
        <header data-testid="chrome" />
        {wrapper("hero", "mk1", <div data-testid="hero-body" />)}
      </main>
    )
    const markup = html(deriveTemplate(tree))
    expect(markup).toContain('data-testid="chrome"')
    expect(markup).toContain('data-partial-id="hero"')
    expect(markup).toContain('data-partial-match="mk1"')
    // The wrapper's CONTENT does not leak into the template — the
    // template is structure only; content lives in the cache.
    expect(markup).not.toContain('data-testid="hero-body"')
  })

  it("is idempotent: deriving a derived template is a fixpoint", () => {
    const tree = (
      <main>
        <header />
        {wrapper("hero", "mk1", <div />)}
        {wrapper("grid", "mk2", <ul />)}
      </main>
    )
    const once = deriveTemplate(tree)
    const twice = deriveTemplate(once)
    expect(html(twice)).toBe(html(once))
  })

  it("re-keys placeholders with Flight key-composite artifacts to clean id|matchKey keys", () => {
    // Flight composites an outer `.map()` key with the element's own
    // key ("page-1,page-1"). The derive re-emits placeholders keyed by
    // the stable data props, so reconciliation keys stay clean across
    // refetches.
    const composited = (
      <i
        key="page-1,page-1"
        hidden
        data-partial
        data-partial-id="page-1"
        data-partial-match="mkP"
      />
    )
    const derived = deriveTemplate(<main>{composited}</main>) as ReactElement
    const inner = (derived.props as { children: ReactNode }).children
    expect(isValidElement(inner)).toBe(true)
    expect((inner as ReactElement).key).toBe("page-1|mkP")
  })

  it("keeps a pending lazy raw — same node identity, not dropped", () => {
    const tree = [wrapper("hero", "mk1", <div />), pendingChunk]
    const derived = deriveTemplate(tree)
    expect(Array.isArray(derived)).toBe(true)
    const [placeholderNode, lazyNode] = derived as ReactNode[]
    // The wrapper became a placeholder…
    expect(isValidElement(placeholderNode)).toBe(true)
    expect(((placeholderNode as ReactElement).props as Record<string, unknown>)["data-partial-id"]).toBe(
      "hero",
    )
    // …while the pending lazy is the ORIGINAL node, untouched, so
    // React's native Suspense machinery resolves it.
    expect(lazyNode).toBe(pendingChunk)
  })

  it("keeps a pending lazy raw across a second derive (idempotent on pending trees)", () => {
    const tree = [wrapper("hero", "mk1", <div />), pendingChunk]
    const twice = deriveTemplate(deriveTemplate(tree)) as ReactNode[]
    expect(twice[1]).toBe(pendingChunk)
    expect(((twice[0] as ReactElement).props as Record<string, unknown>)["data-partial-id"]).toBe(
      "hero",
    )
  })
})
