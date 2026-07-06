/**
 * Probe: the `cull` gate folds the RESOLVED viewport state.
 *
 * A parton declared with `cull:` records `visible:<id>?seed=<0|1>` —
 * the seed's VALUE rides the dep key — and its fingerprint folds
 * `measurement ?? seed` via store-and-reread. The consequence under
 * test: an unmeasured render and a measured one that RESOLVE the same
 * way fold the SAME fp (the first client report moves only the
 * partons it actually flips), while a resolution change (measured
 * against the seed, or in against out) moves it. A spec without the
 * gate is invariant to `?visible=` entirely.
 *
 * The seed runs in the parton's tracking context: an anchor-driven
 * seed's `searchParam()` read records as a dep, so a moved anchor
 * re-resolves the gate.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

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
async function fpAt(url: string, node: React.ReactNode, id: string): Promise<string | undefined> {
  return fpById(await flightAt(url, node)).get(id)
}

// Gated with the default seed (always in view cold) — the common case.
const Culled = parton(
  function CulledRender(_: RenderArgs) {
    return <div data-testid="culled">full</div>
  },
  { selector: "#culled-probe", cull: { skeleton: SkelBox } },
)

// Never gated — the control. ?visible= must not move its fp.
const Plain = parton(
  function PlainRender(_: RenderArgs) {
    return <div data-testid="plain" />
  },
  { selector: "#plain-probe" },
)

// Anchor-driven seed: in view cold iff `?anchor=` names it.
const Anchored = parton(
  function AnchoredRender(_: RenderArgs) {
    return <div data-anchored>full</div>
  },
  {
    selector: "#anchored-probe",
    cull: { skeleton: SkelBox, seed: () => searchParam("anchor") === "me" },
  },
)

describe("cull gate: the fp folds the resolved viewport state", () => {
  beforeEach(() => clearRegistry("all"))

  it("unmeasured and measured-in fold the same fp; measured-out moves it", async () => {
    const tree = (
      <PartialRoot>
        <Culled />
      </PartialRoot>
    )
    await flightAt("http://t/x", tree) // cold — records the gate dep
    const fpCold = await fpAt("http://t/x", tree, "culled-probe") // u → seed(1)
    const fpIn = await fpAt("http://t/x?visible=culled-probe", tree, "culled-probe") // 1
    expect(fpCold).toBeDefined()
    // THE headline: the first measurement that agrees with the seed is
    // not a change — the client's cached copy stays fp-valid.
    expect(fpIn).toBe(fpCold)

    // Measured OUT resolves differently: the culled path takes over —
    // no body render, no wire fp, the pair carries the skeleton ref.
    const culledFlight = await flightAt("http://t/x?visible=other", tree)
    expect(fpById(culledFlight).get("culled-probe")).toBeUndefined()
    expect(culledFlight).not.toContain('data-testid="culled"')
    expect(culledFlight).toContain('"id":"culled-probe"')
    expect(culledFlight).toContain('"culled":true')

    // Back in: same resolution as before → same fp, no churn.
    const fpIn2 = await fpAt("http://t/x?visible=culled-probe", tree, "culled-probe")
    expect(fpIn2).toBe(fpIn)
  })

  it("a spec without the gate is invariant to ?visible=", async () => {
    const tree = (
      <PartialRoot>
        <Plain />
      </PartialRoot>
    )
    await fpAt("http://t/x", tree, "plain-probe")
    const fpA = await fpAt("http://t/x", tree, "plain-probe")
    const fpB = await fpAt("http://t/x?visible=plain-probe", tree, "plain-probe")
    expect(fpA).toBeDefined()
    expect(fpB).toBe(fpA)
  })

  it("the seed's tracked reads re-resolve the gate: a moved anchor flips the cold state", async () => {
    const tree = (
      <PartialRoot>
        <Anchored />
      </PartialRoot>
    )
    // Anchored at me: cold renders full.
    const inFlight = await flightAt("http://t/x?anchor=me", tree)
    expect(inFlight).toContain("data-anchored")
    // Anchor moved: the seed resolves false, the gate culls — body
    // skipped, skeleton ref only.
    const outFlight = await flightAt("http://t/x?anchor=elsewhere", tree)
    expect(outFlight).not.toContain("data-anchored")
    expect(outFlight).toContain('"culled":true')
    // A measurement beats the seed regardless of the anchor.
    const measured = await flightAt("http://t/x?anchor=elsewhere&visible=anchored-probe", tree)
    expect(measured).toContain("data-anchored")
  })
})
