/**
 * Probe: `tag(name)` — a body-phase server-hook reading getCurrentParton
 * — records a `tag:` dependency on the rendering parton, folded into
 * the fingerprint via the SAME queryMatchingTs path declared `selector`
 * labels use (store-and-reread: the recorded tag's timestamp is re-read
 * on every fold). So a later `refreshSelector(name)` (what a server
 * action's revalidation does) shifts the tagged parton's fp — it
 * re-renders / its fp-skip misses on the next nav — while an untagged
 * parton is untouched, and an unbumped tag causes no churn.
 *
 * This is the "a tracked read folds into the fp" leg proven on a
 * read-only spec — no cells, no fp-pipeline rewrite (tags ride the
 * existing dep-record fold).
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { tag } from "../current-parton.ts"
import { refreshSelector, _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

// Tags a dynamic entity in its body. The read lands on the dep record
// DURING Render — after the fp is computed — so it folds on the NEXT
// render (store-and-reread); tests warm up once before comparing fps.
const Tagged = parton(
  function TagProbeRender(_: RenderArgs) {
    tag("probe-entity:7")
    return <span data-testid="tagged" />
  },
  { selector: "#tag-probe" },
)

// Same shape, no tag — the control.
const Untagged = parton(
  function UntaggedProbeRender(_: RenderArgs) {
    return <span data-testid="untagged" />
  },
  { selector: "#untagged-probe" },
)

describe("tag(): body-phase server-hook folds into the fingerprint", () => {
  beforeEach(() => {
    clearRegistry("all")
    _clearInvalidationRegistry()
  })

  it("revalidating the tag moves the tagged parton's fp", async () => {
    const tree = (
      <PartialRoot>
        <Tagged />
      </PartialRoot>
    )
    await flightAt("http://t/x", tree) // cold — records the tag dep
    const fp1 = fpById(await flightAt("http://t/x", tree)).get("tag-probe")
    expect(fp1).toBeDefined()

    refreshSelector("probe-entity:7") // a server action's revalidate(...)

    const fp2 = fpById(await flightAt("http://t/x", tree)).get("tag-probe")
    expect(fp2).toBeDefined()
    expect(fp2).not.toBe(fp1) // the tag is folded — the bump shifted the fp
  })

  it("an untagged parton's fp is unaffected by the same bump", async () => {
    const tree = (
      <PartialRoot>
        <Untagged />
      </PartialRoot>
    )
    const fp1 = fpById(await flightAt("http://t/x", tree)).get("untagged-probe")
    expect(fp1).toBeDefined()

    refreshSelector("probe-entity:7")

    const fp2 = fpById(await flightAt("http://t/x", tree)).get("untagged-probe")
    expect(fp2).toBe(fp1) // never tagged probe-entity:7 → bump is irrelevant
  })

  it("a present-but-unbumped tag causes no fp churn across renders", async () => {
    const tree = (
      <PartialRoot>
        <Tagged />
      </PartialRoot>
    )
    await flightAt("http://t/x", tree) // cold — records the tag dep
    const fp1 = fpById(await flightAt("http://t/x", tree)).get("tag-probe")
    const fp2 = fpById(await flightAt("http://t/x", tree)).get("tag-probe")
    expect(fp1).toBeDefined()
    expect(fp2).toBe(fp1) // tag present, no bump → stable, no spurious churn
  })
})
