import React, { type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  cacheFromStreamingChildren,
  harvestPartialIds,
  substituteNested,
  type LazyWalkStats,
} from "../partial-cache.ts"
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
    expect(markup).toContain('data-partial-id="hero"')
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
    const outer = wrapper("outer", "", <section>{placeholder("inner", "")}</section>)
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

// ─── Memoization (see "substituteNested memoization" in partial-cache.ts) ──

/** A hand-built Flight-shaped lazy: pending until `resolve()` flips the
 *  payload to fulfilled. Mirrors the `$$typeof`/`_payload`/`_init`
 *  shape `unwrapLazy` reads. */
function makeLazy() {
  const payload: { _status: number; _result?: ReactNode; promise: Promise<void> } = {
    _status: 0,
    promise: Promise.resolve(),
  }
  const node = {
    $$typeof: Symbol.for("react.lazy"),
    _payload: payload,
    _init: (p: typeof payload) => {
      if (p._status === 1) return p._result
      throw p.promise
    },
  } as unknown as ReactNode
  return {
    node,
    resolve(value: ReactNode) {
      payload._status = 1
      payload._result = value
    },
  }
}

describe("substituteNested — memoization", () => {
  it("returns the identical element on a re-walk with an unchanged cache", () => {
    // inner's substitution BUILDS a new element (outer's children
    // change), so without the memo every walk would produce a fresh
    // clone — identity across walks is the memo hit.
    const outer = wrapper("outer", "", <section>{placeholder("inner", "")}</section>)
    const cache = makeCache([
      ["outer", "", outer],
      ["inner", "", wrapper("inner", "", <div data-testid="inner-fresh" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|")
    const out2 = substituteNested(outer, cache, "outer|")
    expect(out1, "substitution should have rebuilt the outer wrapper").not.toBe(outer)
    expect(out2, "unchanged cache must return the memoized element").toBe(out1)
  })

  it("a slot overwrite invalidates exactly the dirty path — clean siblings stay identical", () => {
    // a's entry itself substitutes a nested placeholder, so its
    // sub-walk builds a new element (memoized). Overwriting b must
    // rebuild outer and b's branch while a's branch returns the
    // IDENTICAL memoized element (React bails out on it).
    const aEntry = wrapper("a", "", <div>{placeholder("a2", "")}</div>)
    const outer = wrapper("outer", "", [placeholder("a", ""), placeholder("b", "")])
    const cache = makeCache([
      ["outer", "", outer],
      ["a", "", aEntry],
      ["a2", "", wrapper("a2", "", <div data-testid="a2-content" />)],
      ["b", "", wrapper("b", "", <div data-testid="b-v1" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|") as ReactElementWithChildren
    cache.get("b")!.set("", wrapper("b", "", <div data-testid="b-v2" />))
    const out2 = substituteNested(outer, cache, "outer|") as ReactElementWithChildren

    expect(out2, "dirty commit must rebuild the touched spine").not.toBe(out1)
    const [a1, b1] = out1.props.children as ReactNode[]
    const [a2, b2] = out2.props.children as ReactNode[]
    expect(a2, "clean sibling branch must be the identical memoized element").toBe(a1)
    expect(b2).not.toBe(b1)
    expect(html(out2)).toContain('data-testid="b-v2"')
    expect(html(out2)).toContain('data-testid="a2-content"')
  })

  it("never memoizes a walk that saw a pending lazy — at any nesting level", () => {
    // The lazy sits inside a NESTED wrapper so both the nested and the
    // outer wrapper walks see it; neither may memoize (a lazy resolves
    // WITHOUT a cache write, so no dep could ever invalidate them).
    const lazy = makeLazy()
    const mid = wrapper("mid", "", lazy.node)
    const outer = wrapper("outer", "", <section>{mid}</section>)
    const cache = makeCache([
      ["outer", "", outer],
      ["mid", "", mid],
      ["inner", "", wrapper("inner", "", <div data-testid="inner-fresh" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|")
    expect(out1, "pending lazy leaves the tree untouched").toBe(outer)
    lazy.resolve(<div>{placeholder("inner", "")}</div>)
    const out2 = substituteNested(outer, cache, "outer|")
    expect(out2, "a memoized pending walk would return the stale tree forever").not.toBe(outer)
    expect(html(out2)).toContain('data-testid="inner-fresh"')
  })

  it("an unrelated matchKey variant write does not invalidate; the referenced one does", () => {
    const outer = wrapper("outer", "", <section>{placeholder("list", "mkB")}</section>)
    const cache = makeCache([
      ["outer", "", outer],
      ["list", "mkB", wrapper("list", "mkB", <div data-testid="list-b1" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|")
    // Write a DIFFERENT variant of the same id — not a dep of this walk.
    cache.get("list")!.set("mkC", wrapper("list", "mkC", <div data-testid="list-c" />))
    const out2 = substituteNested(outer, cache, "outer|")
    expect(out2, "unread variant write must not invalidate the memo").toBe(out1)
    // Now the variant the walk actually read.
    cache.get("list")!.set("mkB", wrapper("list", "mkB", <div data-testid="list-b2" />))
    const out3 = substituteNested(outer, cache, "outer|")
    expect(out3).not.toBe(out1)
    expect(html(out3)).toContain('data-testid="list-b2"')
  })

  it("a slot delete invalidates — the placeholder resurfaces", () => {
    const outer = wrapper("outer", "", <section>{placeholder("gone", "")}</section>)
    const cache = makeCache([
      ["outer", "", outer],
      ["gone", "", wrapper("gone", "", <div data-testid="gone-content" />)],
    ])

    expect(html(substituteNested(outer, cache, "outer|"))).toContain('data-testid="gone-content"')
    cache.get("gone")!.delete("")
    const out = substituteNested(outer, cache, "outer|")
    const markup = html(out)
    expect(markup, "deleted slot must not serve stale memoized content").not.toContain(
      'data-testid="gone-content"',
    )
    expect(markup).toContain('data-partial-id="gone"')
  })

  it("a miss recorded as a dep invalidates when the slot later fills", () => {
    const outer = wrapper("outer", "", <section>{placeholder("late", "")}</section>)
    const cache = makeCache([["outer", "", outer]])

    const out1 = substituteNested(outer, cache, "outer|")
    expect(html(out1)).toContain('data-partial-id="late"')
    cache.set("late", new Map([["", wrapper("late", "", <div data-testid="late-content" />)]]))
    const out2 = substituteNested(outer, cache, "outer|")
    expect(out2).not.toBe(out1)
    expect(html(out2)).toContain('data-testid="late-content"')
  })
})

type ReactElementWithChildren = React.ReactElement<{ children?: ReactNode }>

// ─── Outlined promise children (async Render bodies) ────────────────
//
// An async Render body reaches its PartialErrorBoundary wrapper as a
// raw Promise, which Flight ships as an outlined `$@` row and the
// client decodes to a chunk — an instrumented thenable with
// `status`/`value` fields, NOT a React lazy. The walks read that
// settlement record; these builders mirror the chunk shape the same
// way `makeLazy` mirrors the lazy shape.

/** A Flight-chunk-shaped instrumented thenable: pending until
 *  `resolve()` flips its own `status`/`value` record. */
function makeChunk() {
  const listeners: Array<(v: unknown) => void> = []
  const chunk = {
    status: "pending",
    value: null as ReactNode,
    reason: null as unknown,
    then(res?: (v: unknown) => void) {
      if (chunk.status === "fulfilled") {
        res?.(chunk.value)
        return
      }
      if (typeof res === "function") listeners.push(res)
    },
  }
  return {
    node: chunk as unknown as ReactNode,
    resolve(value: ReactNode) {
      chunk.status = "fulfilled"
      chunk.value = value
      for (const l of listeners.splice(0)) l(value)
    },
  }
}

describe("substituteNested — outlined promise children", () => {
  it("descends a fulfilled thenable and substitutes the placeholder inside", () => {
    const chunk = makeChunk()
    chunk.resolve(<section>{placeholder("inner", "")}</section>)
    const outer = wrapper("outer", "", chunk.node)
    const cache = makeCache([
      ["outer", "", outer],
      ["inner", "", wrapper("inner", "", <div data-testid="inner-fresh" />)],
    ])

    const markup = html(substituteNested(outer, cache, "outer|"))
    expect(
      markup,
      "a hole behind an async body's fulfilled promise children must substitute",
    ).toContain('data-testid="inner-fresh"')
  })

  it("never memoizes a walk that saw a pending thenable — the resolve heals without a cache write", () => {
    const chunk = makeChunk()
    const outer = wrapper("outer", "", <section>{chunk.node}</section>)
    const cache = makeCache([
      ["outer", "", outer],
      ["inner", "", wrapper("inner", "", <div data-testid="inner-fresh" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|")
    expect(out1, "pending promise children leave the tree untouched").toBe(outer)
    // The thenable settles WITHOUT any cache write — a memoized pending
    // walk would have no dep to invalidate it and serve the stale tree
    // forever.
    chunk.resolve(<div>{placeholder("inner", "")}</div>)
    const out2 = substituteNested(outer, cache, "outer|")
    expect(out2, "the walk after resolution must reach the newly-visible hole").not.toBe(outer)
    expect(html(out2)).toContain('data-testid="inner-fresh"')
  })

  it("treats a rejected thenable as opaque — left in place for the error boundary", () => {
    const rejected = {
      status: "rejected",
      reason: new Error("body threw"),
      then() {},
    } as unknown as ReactNode
    const outer = wrapper("outer", "", rejected)
    const cache = makeCache([["outer", "", outer]])
    // No throw, no substitution attempt into the rejection.
    expect(substituteNested(outer, cache, "outer|")).toBe(outer)
  })

  it("instruments a plain (uninstrumented) thenable so its settlement is readable later", async () => {
    const plain = Promise.resolve(<div>{placeholder("inner", "")}</div>)
    const outer = wrapper("outer", "", plain as unknown as ReactNode)
    const cache = makeCache([
      ["outer", "", outer],
      ["inner", "", wrapper("inner", "", <div data-testid="inner-fresh" />)],
    ])

    const out1 = substituteNested(outer, cache, "outer|")
    expect(out1, "an unsettled plain promise leaves the tree untouched").toBe(outer)
    await plain
    const out2 = substituteNested(outer, cache, "outer|")
    expect(html(out2), "the recorded settlement must be readable on the next walk").toContain(
      'data-testid="inner-fresh"',
    )
  })
})

describe("cacheFromStreamingChildren — outlined promise children", () => {
  it("caches a nested wrapper and marks holes seen behind fulfilled promise children", () => {
    const chunk = makeChunk()
    chunk.resolve(
      <section>
        {wrapper("nested", "mkN", <div />)}
        {placeholder("skipped", "mkS")}
      </section>,
    )
    const outer = wrapper("outer", "", chunk.node)
    const cache: PartialCache = new Map()
    const seen = new Map<string, Set<string>>()
    const stats: LazyWalkStats = { pending: 0, thenables: [] }
    cacheFromStreamingChildren(outer, cache, seen, stats)

    expect(stats.pending).toBe(0)
    expect(
      cache.get("nested")?.get("mkN"),
      "the nested wrapper behind the promise must get its own cache entry",
    ).toBeDefined()
    expect(seen.get("skipped"), "the hole behind the promise must be marked seen").toEqual(
      new Set(["mkS"]),
    )
  })

  it("counts a pending promise child and captures it as the re-walk signal", () => {
    const chunk = makeChunk()
    const outer = wrapper("outer", "", chunk.node)
    const cache: PartialCache = new Map()
    const stats: LazyWalkStats = { pending: 0, thenables: [] }
    cacheFromStreamingChildren(outer, cache, new Map(), stats)

    expect(stats.pending).toBe(1)
    expect(
      stats.thenables,
      "the pending thenable itself is the settlement signal to re-walk on",
    ).toContain(chunk.node)
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
