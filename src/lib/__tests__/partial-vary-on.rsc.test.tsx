/**
 * Auto-tracked manifest fingerprinting (formerly `<Partial varyOn>`).
 *
 * The framework opens a per-Partial manifest scope on every Partial
 * body and writes tracked accessor reads (`getSearchParam`,
 * `getCookie`, `getHeader`, `getPathname`) to it. The accumulated
 * keys land on the snapshot; the NEXT render resolves them against
 * the current request and folds the values into the structural
 * fingerprint. Result: a same-route nav that changes any read key
 * invalidates the fp without the author having to declare deps.
 *
 * Tests pin the four core invariants:
 *
 *   1. A Partial whose descendant reads `getSearchParam("foo")`
 *      produces distinct fps for two requests differing only in
 *      `?foo=`. (Need TWO renders — first to populate manifest,
 *      second to fold it in.)
 *
 *   2. A URL change in an UNREAD param leaves the fp unchanged.
 *
 *   3. An ancestor's fp captures a descendant's manifest, so an
 *      ancestor fp-skip can't short-circuit a descendant whose
 *      tracked read changed.
 *
 *   4. A Partial inside a frame resolves its tracked reads against
 *      the frame's URL — and a frame-URL change produces a distinct
 *      fp. (Verifies the frame-leak fix lets ambient resolution
 *      work correctly via `parent.frameChain`.)
 */
import { describe, expect, it, beforeEach, vi } from "vitest"

vi.mock("../cache.tsx", () => ({
  Cache: ({ children }: { children: React.ReactNode }) => children,
  _cacheStats: async () => ({ size: 0, keys: [] }),
  _clearCache: async () => {},
}))

import { renderWithRequest } from "../../test/rsc-server.ts"
import { PartialRoot, Partial } from "../partial.tsx"
import { ROOT, capturePartialContext } from "../partial-context.ts"
import { clearRegistry } from "../partial-registry.ts"
import { getSearchParam } from "../../framework/context.ts"

beforeEach(() => {
  clearRegistry()
})

function extractFingerprint(text: string, partialId: string): string | null {
  const forward = new RegExp(
    `"partialId"\\s*:\\s*"${partialId}"[^{}]*?"partialFingerprint"\\s*:\\s*"([^"]+)"`,
  )
  const reverse = new RegExp(
    `"partialFingerprint"\\s*:\\s*"([^"]+)"[^{}]*?"partialId"\\s*:\\s*"${partialId}"`,
  )
  return text.match(forward)?.[1] ?? text.match(reverse)?.[1] ?? null
}

async function renderFp(
  url: string,
  node: React.ReactNode,
  partialId: string,
): Promise<string | null> {
  const { stream } = await renderWithRequest(url, node)
  const text = await new Response(stream).text()
  return extractFingerprint(text, partialId)
}

/**
 * Render twice at the SAME url so the second render's fp folds in
 * the manifest collected by the first. Returns the second-render fp.
 */
async function warmedFp(
  url: string,
  tree: React.ReactNode,
  partialId: string,
): Promise<string | null> {
  await renderFp(url, tree, partialId)
  return renderFp(url, tree, partialId)
}

describe("Partial fingerprint — auto-tracked manifest", () => {
  function ReadConfig() {
    // Hoisted at the sync top of this server component body.
    const config = getSearchParam("config")
    return <span>config={config ?? ""}</span>
  }

  it("URL change in a tracked-accessor key produces a distinct fingerprint", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#fields">
          <ReadConfig />
        </Partial>
      </PartialRoot>
    )

    // Warm so the manifest exists for the second render's fp fold.
    const fpA = await warmedFp("http://localhost/?config=0", tree, "fields")
    clearRegistry()
    const fpB = await warmedFp("http://localhost/?config=1", tree, "fields")

    expect(fpA).toBeTruthy()
    expect(fpB).toBeTruthy()
    expect(fpA).not.toBe(fpB)
  })

  it("URL change in an UNREAD key leaves the fingerprint unchanged", async () => {
    function ReadSelect() {
      const select = getSearchParam("select")
      return <span>{select ?? ""}</span>
    }
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#fields">
          <ReadSelect />
        </Partial>
      </PartialRoot>
    )

    const fpA = await warmedFp("http://localhost/?select=a&unrelated=x", tree, "fields")
    clearRegistry()
    const fpB = await warmedFp("http://localhost/?select=a&unrelated=y", tree, "fields")

    expect(fpA).toBeTruthy()
    expect(fpB).toBeTruthy()
    expect(fpA).toBe(fpB)
  })

  it("ancestor fp captures a descendant's tracked-accessor reads", async () => {
    // Ancestor's own JSX shape is identical across both renders.
    // Only the descendant's `?config=` varies. With the descendant
    // manifest fold, the ancestor's fp must differ.
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#root">
          <div>
            <Partial parent={ROOT} selector="#fields">
              <ReadConfig />
            </Partial>
          </div>
        </Partial>
      </PartialRoot>
    )

    const fpA = await warmedFp("http://localhost/?config=0", tree, "root")
    clearRegistry()
    const fpB = await warmedFp("http://localhost/?config=1", tree, "root")

    expect(fpA).toBeTruthy()
    expect(fpB).toBeTruthy()
    expect(fpA).not.toBe(fpB)
  })

  it("ambient frame: a Partial inside a frame resolves its reads against the frame URL", async () => {
    function ReadQ() {
      const q = getSearchParam("q")
      return <span>{q ?? ""}</span>
    }
    function Inner() {
      const parent = capturePartialContext()
      return (
        <Partial parent={parent} selector="#inner">
          <ReadQ />
        </Partial>
      )
    }
    const treeA = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#outer" frame="outer" frameUrl="/?q=alpha">
          <Inner />
        </Partial>
      </PartialRoot>
    )
    const treeB = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#outer" frame="outer" frameUrl="/?q=beta">
          <Inner />
        </Partial>
      </PartialRoot>
    )

    // Page URL identical in both renders — only the frame URL differs.
    const fpA = await warmedFp("http://localhost/", treeA, "inner")
    clearRegistry()
    const fpB = await warmedFp("http://localhost/", treeB, "inner")

    expect(fpA).toBeTruthy()
    expect(fpB).toBeTruthy()
    expect(fpA).not.toBe(fpB)
  })
})
