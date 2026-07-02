/**
 * Byte-cache write-key deferral — the store key is computed AFTER the
 * body renders, folding the LIVE tracked-read set, so no entry is ever
 * keyed dep-less unless the body truly reads nothing.
 *
 * The hazard this closes: a `cache:` spec whose RENDER BODY does a
 * tracked read used to write its entry under the pre-render key, which
 * on a cold record folds no deps. A later cold-registry request with
 * DIFFERENT read values computed the same dep-less key on lookup and
 * HIT the stale entry — the fp-skip cold gate never protects the byte
 * cache (cache lookup is key equality, not a skip decision). With the
 * deferral, that lookup misses into a fresh render: over-fetch, never
 * stale. It also means per-value entries coexist (flavor=a and
 * flavor=b each hit their own bytes).
 *
 * Prod-tier: the assertions grep the wire text for the rendered
 * stamp, and the DEV Flight build would leak the wrapper's discarded
 * fresh element (Render runs every pass; on a hit its output is
 * dropped) into debug rows — a false "fresh render" sighting the
 * production build cannot produce.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { _clearCache } from "../cache.tsx"
import { cookie } from "../server-hooks.ts"

async function flightAt(
  url: string,
  node: React.ReactNode,
  headers?: Record<string, string>,
): Promise<string> {
  const { stream } = await renderWithRequest(url, node, { headers })
  return await new Response(stream).text()
}

// Render-body tracked read on a byte-cached spec — the exact shape the
// old "do request reads in schema" convention existed to forbid.
let renderSeq = 0
const CachedFlavor = parton(
  function CachedFlavorRender(_: RenderArgs) {
    const flavor = cookie("flavor") ?? "none"
    renderSeq++
    return <span>{`cached-flavor:${flavor}:render#${renderSeq}`}</span>
  },
  { selector: "#cache-write-key", cache: { maxAge: 60 } },
)

const tree = (
  <PartialRoot>
    <CachedFlavor />
  </PartialRoot>
)
const url = "http://t/cache-write-key"

function stamp(flight: string): string | undefined {
  return /cached-flavor:([a-z]+:render#\d+)/.exec(flight)?.[1]
}

beforeEach(async () => {
  clearRegistry("all")
  await _clearCache()
  renderSeq = 0
})

describe.skipIf(process.env.NODE_ENV !== "production")("byte cache — write-key deferral", () => {
  it("a cold-registry lookup with different read values misses instead of serving stale bytes", async () => {
    const r1 = await flightAt(url, tree, { cookie: "flavor=a" })
    expect(stamp(r1)).toBe("a:render#1")

    // Cold record: the dep record is gone, the byte cache is NOT.
    clearRegistry("all")

    // Different cookie, dep-less lookup key. The r1 entry was stored
    // under a deps-complete key (flavor=a), so this MUST miss and
    // render fresh — a dep-less write key would have served `a` here.
    const r2 = await flightAt(url, tree, { cookie: "flavor=b" })
    expect(stamp(r2)).toBe("b:render#2")
  })

  it("warm lookups hit per-value entries — each flavor replays its own bytes", async () => {
    const r1 = await flightAt(url, tree, { cookie: "flavor=a" })
    expect(stamp(r1)).toBe("a:render#1")
    // Warm the dep record for the b-variant.
    const r2 = await flightAt(url, tree, { cookie: "flavor=b" })
    expect(stamp(r2)).toBe("b:render#2")

    // Same values again: the lookup folds the committed record and must
    // BYTE-REPLAY each flavor's own entry — the stamps are r1's/r2's,
    // not fresh render numbers.
    const r3 = await flightAt(url, tree, { cookie: "flavor=b" })
    expect(stamp(r3)).toBe("b:render#2")
    const r4 = await flightAt(url, tree, { cookie: "flavor=a" })
    expect(stamp(r4)).toBe("a:render#1")
  })
})
