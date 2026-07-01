import React, { type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { substituteNested, harvestPartialIds } from "../partial-cache.ts"
import type { PartialCache } from "../partial-client-state.ts"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

/**
 * Unit coverage for `substituteNested` — the walk that fills a cached
 * tree's placeholders from the client cache. Drives the walk directly
 * against a locally-built `PartialCache`, no globals, no React commit.
 *
 * The corners under test are the contract's load-bearing parts:
 *
 *   - `skipKey` self-reference: every fp-skipped partial caches a
 *     wrapper that CONTAINS ITS OWN placeholder (the server emitted a
 *     skip for the region the wrapper covers). Without the skipKey
 *     guard the walk would substitute the wrapper into itself forever.
 *   - skipKey is `(id, matchKey)`, not id alone: two variants of one
 *     id coexist (parked Activity siblings), and a wrapper for variant
 *     A referencing variant B of the SAME id must still resolve B.
 *   - descend-through-unchanged-wrapper: when a wrapper's cache slot
 *     still holds the node being walked, the walk keeps descending so
 *     a deeply-nested partial with a FRESH slot still lands.
 */

// ─── Server-shaped node builders (mirror partial.tsx output) ────────

function wrapper(id: string, mk: string, content: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary
      key={id}
      partialId={id}
      partialFingerprint={`fp_${id}_${mk}`}
      partialMatchKey={mk}
    >
      {content}
    </PartialErrorBoundary>
  )
}

function placeholder(id: string, mk: string): ReactNode {
  return <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
}

function makeCache(entries: Array<[id: string, mk: string, node: ReactNode]>): PartialCache {
  const cache: PartialCache = new Map()
  for (const [id, mk, node] of entries) {
    let inner = cache.get(id)
    if (!inner) {
      inner = new Map()
      cache.set(id, inner)
    }
    inner.set(mk, node)
  }
  return cache
}

function html(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

describe("substituteNested — skipKey self-reference", () => {
  it("does not recurse into a wrapper's placeholder for itself", () => {
    // The canonical fp-skip shape: the cached wrapper for (hero, mk1)
    // contains a placeholder pointing at (hero, mk1). Substituting the
    // wrapper with skipKey "hero|mk1" must leave that placeholder as-is
    // instead of looping.
    const heroWrapper = wrapper("hero", "mk1", [
      placeholder("hero", "mk1"),
      <div key="body" data-testid="hero-body" />,
    ])
    const cache = makeCache([["hero", "mk1", heroWrapper]])

    const out = substituteNested(heroWrapper, cache, "hero|mk1")
    const markup = html(out)
    // Walk terminated (no stack overflow) and the self-placeholder
    // survived untouched alongside the body.
    expect(markup).toContain('data-testid="hero-body"')
    expect(markup).toContain("data-partial-id=\"hero\"")
  })

  it("still resolves a SAME-id placeholder for a different matchKey", () => {
    // skipKey folds in the matchKey: variant A's wrapper referencing
    // variant B of the same id must substitute B — the id alone being
    // skipped would leave the parked sibling blank.
    const variantB = wrapper("list", "mkB", <div data-testid="variant-b" />)
    const variantA = wrapper("list", "mkA", [
      placeholder("list", "mkB"),
      <div key="a" data-testid="variant-a" />,
    ])
    const cache = makeCache([
      ["list", "mkA", variantA],
      ["list", "mkB", variantB],
    ])

    const out = substituteNested(variantA, cache, "list|mkA")
    const markup = html(out)
    expect(markup).toContain('data-testid="variant-a"')
    expect(markup, "same-id different-matchKey sibling was not substituted").toContain(
      'data-testid="variant-b"',
    )
  })
})

describe("substituteNested — multi-variant substitution", () => {
  it("fills sibling placeholders of one id from their own variant slots", () => {
    const tree = (
      <main>
        {placeholder("pokemon-page", "mk1")}
        {placeholder("pokemon-page", "mk2")}
      </main>
    )
    const cache = makeCache([
      ["pokemon-page", "mk1", wrapper("pokemon-page", "mk1", <div data-testid="poke-1" />)],
      ["pokemon-page", "mk2", wrapper("pokemon-page", "mk2", <div data-testid="poke-2" />)],
    ])

    const markup = html(substituteNested(tree, cache, ""))
    expect(markup).toContain('data-testid="poke-1"')
    expect(markup).toContain('data-testid="poke-2"')
  })

  it("leaves a placeholder in place when its variant has no cache entry", () => {
    const tree = <main>{placeholder("missing", "mk1")}</main>
    const cache = makeCache([])
    const markup = html(substituteNested(tree, cache, ""))
    // No entry → placeholder survives (the region renders nothing, but
    // the marker isn't dropped; a later refetch fills it).
    expect(markup).toContain('data-partial-id="missing"')
  })
})

describe("substituteNested — descend through unchanged wrappers", () => {
  it("substitutes a deeply-nested fresh entry under a wrapper whose own slot is unchanged", () => {
    // The outer wrapper's cache slot holds the very node being walked
    // (fresh === node), so the walk must descend INTO it — otherwise a
    // refetch that only updated the nested partial never reaches the
    // rendered tree.
    const outer = wrapper(
      "outer",
      "",
      <section>
        {placeholder("inner", "")}
      </section>,
    )
    const freshInner = wrapper("inner", "", <div data-testid="inner-fresh" />)
    const cache = makeCache([
      ["outer", "", outer],
      ["inner", "", freshInner],
    ])

    const markup = html(substituteNested(<div>{outer}</div>, cache, ""))
    expect(markup, "nested fresh entry did not land through the unchanged outer wrapper").toContain(
      'data-testid="inner-fresh"',
    )
  })
})

describe("harvestPartialIds", () => {
  it("collects wrapper and placeholder (id, matchKey) pairs, including nested ones", () => {
    const tree = (
      <main>
        {wrapper("outer", "mkO", [placeholder("skipped", "mkS"), wrapper("inner", "mkI", <i />)])}
        {placeholder("top", "mkT")}
      </main>
    )
    const out = new Map<string, Set<string>>()
    harvestPartialIds(tree, out)
    expect(out.get("outer")).toEqual(new Set(["mkO"]))
    expect(out.get("skipped")).toEqual(new Set(["mkS"]))
    expect(out.get("inner")).toEqual(new Set(["mkI"]))
    expect(out.get("top")).toEqual(new Set(["mkT"]))
  })
})
