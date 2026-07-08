/**
 * Render-body `tag()` — the store-and-reread ride for invalidation
 * tags recorded AFTER the fingerprint (the slot for entity tags a
 * loader's response yields: `tag(`product:${data.id}`)` post-await).
 *
 * Claims:
 *   - the tag records a `tag:<name>` dep whose fold value is the
 *     matching invalidation ts, so a `refreshSelector(name)` moves the
 *     fp and un-skips a cached client;
 *   - the boundary surfaces the name as a refetch label on the
 *     committed snapshot;
 *   - the `cms:<key>` dep kind (registered by cms-runtime) evaluates
 *     through the same store-and-reread fold.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { computeRouteKey, parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import { clearRegistry, enterRequestRegistry, lookupPartial } from "../partial-registry.ts"
import { evalDepKeys, searchParam } from "../server-hooks.ts"
import { tag } from "../current-parton.ts"
// Side-effect: registers the `cms:` dep kind.
import "../../runtime/cms-runtime.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function fpById(flight: string, id: string): string | undefined {
  const m = new RegExp(`"partialId":"${id}","partialFingerprint":"([^"]+)"`).exec(flight)
  return m?.[1]
}

const ROOT_MK = hash(stableStringify({}))

const renders = { tagged: 0 }
const TaggedSpec = parton(
  function TaggedRender(_: RenderArgs) {
    renders.tagged++
    tag("product:42")
    return <span>{`tagged-body-${renders.tagged}`}</span>
  },
  { selector: "#tag-ride" },
)

beforeEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
  renders.tagged = 0
})

describe("render-body tag() — dep-record ride", () => {
  it("a refreshSelector on the tag moves the fp and un-skips a cached client", async () => {
    const url = "http://t/tag-ride"
    const tree = (
      <PartialRoot>
        <TaggedSpec />
      </PartialRoot>
    )
    await flightAt(url, tree) // cold: records the tag dep
    const warm = fpById(await flightAt(url, tree), "tag-ride")
    const warm2 = fpById(await flightAt(url, tree), "tag-ride")
    expect(warm).toBeDefined()
    expect(warm2).toBe(warm) // stable while the tag's ts is stable

    // Cached warm fp, no bump → skip (placeholder, no body).
    const cachedUrl = `${url}?cached=tag-ride:${ROOT_MK}:${warm}`
    const skipped = await flightAt(cachedUrl, tree)
    expect(skipped).not.toContain("tagged-body")

    // Bump the tag → the dep folds the new ts → fp mismatch → fresh.
    refreshSelector("product:42")
    const fresh = await flightAt(cachedUrl, tree)
    expect(fresh).toContain("tagged-body")
  })

  it("the tag surfaces as a refetch label on the committed snapshot", async () => {
    const url = "http://t/tag-ride"
    await flightAt(
      url,
      <PartialRoot>
        <TaggedSpec />
      </PartialRoot>,
    )
    const { result } = await runWithRequestAsync(new Request(url), async () => {
      enterRequestRegistry(computeRouteKey(url), "cache")
      return lookupPartial("tag-ride")
    })
    expect(result?.labels).toContain("product:42")
  })
})

describe("registered dep kinds + hook overloads", () => {
  it("the cms: dep kind evaluates through evalDepKeys", () => {
    const folded = evalDepKeys(new Set(["cms:some-row"]), new Request("http://t/"))
    expect(folded).toContain("cms:some-row=|cms=some-row:miss")
  })

  it("searchParam(name, fallback) defaults ABSENT params only", async () => {
    const seen: Array<string | null> = []
    const Probe = parton(
      function SearchDefaultRender(_: RenderArgs) {
        seen.push(searchParam("q", "dflt"), searchParam("q"))
        return <span>probe</span>
      },
      { selector: "#search-default" },
    )
    const tree = (
      <PartialRoot>
        <Probe />
      </PartialRoot>
    )
    await flightAt("http://t/sp", tree)
    await flightAt("http://t/sp?q=", tree)
    await flightAt("http://t/sp?q=x", tree)
    expect(seen).toEqual(["dflt", null, "", "", "x", "x"])
  })
})
