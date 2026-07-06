/**
 * Cull-to-park — the server half, under the spec-level `cull` gate.
 *
 * A culled render skips the body entirely: the wire carries one
 * `<CullPair>` (skeleton reference + placement props) with the content
 * slot's placeholder hole — ALWAYS shipped, cached content or not: the
 * pair mounts inside the client's persisted template, and a later
 * flip-in's bytes can only reach the mounted tree through a
 * placeholder position — and no `partialFingerprint` (nothing to
 * advertise — the skeleton is client-derived). The registry keeps
 * per-state snapshots so the culled render never erodes the in-view
 * dep record, and a `?__cullFlip=1` refetch — the visibility
 * controller's explicit stamp — lets an explicit target fp-skip: the
 * placeholder that confirms the client's parked copy.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearRegistry } from "../partial-registry.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { searchParam } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
function matchKeyOf(flight: string, id: string): string | undefined {
  const re = new RegExp(
    `"partialId":"${id}","partialFingerprint":"[^"]+","partialMatchKey":"([^"]+)"`,
  )
  return re.exec(flight)?.[1]
}
async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

// The gate probe. Its body reads a search param, so the content state
// records a dep set the culled state (gate reads only) must not erode.
const CullProbe = parton(
  function CullProbeRender(_: RenderArgs) {
    return <div data-full={searchParam("q") ?? "none"} />
  },
  { selector: "#cull-probe", cull: { skeleton: SkelBox } },
)
const ID = "cull-probe"
const tree = (
  <PartialRoot>
    <CullProbe />
  </PartialRoot>
)

describe("cull-to-park: the culled emission is the pair, not a body", () => {
  beforeEach(() => clearRegistry("all"))

  it("a culled render ships the pair — skeleton ref, no body, the content hole", async () => {
    const warm = await flightAt(`http://t/x?visible=${ID}`, tree)
    const base = matchKeyOf(warm, ID)
    expect(base).toBeDefined()
    expect(warm).toContain("data-full")

    // Culled: no body, no fp — the pair (its `culled` prop routes
    // display) with the always-present content hole, so a later
    // flip-in's bytes have a mounted position to substitute into.
    const cold = await flightAt(`http://t/x?visible=other`, tree)
    expect(cold).not.toContain("data-full")
    expect(fpById(cold).get(ID)).toBeUndefined()
    expect(cold).toContain(`"id":"${ID}"`)
    expect(cold).toContain('"culled":true')
    expect(cold).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
  })

  it("per-state snapshots: a culled render does not erode the in-view dep record", async () => {
    await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree) // cold — records in-view deps
    const fpIn = fpById(await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree)).get(ID)
    expect(fpIn).toBeDefined()

    // Cull out (the culled snapshot records only the gate's reads),
    // then return. The in-view fp must be computed from the IN-VIEW
    // state's record — folding the culled record would shift it and
    // every return would re-render even when nothing changed.
    await flightAt(`http://t/x?q=shoes&visible=other`, tree)
    const fpBack = fpById(await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree)).get(ID)
    expect(fpBack).toBe(fpIn)

    // And the dependency still bites: a changed in-view read moves it.
    const fpOtherQ = fpById(await flightAt(`http://t/x?q=hats&visible=${ID}`, tree)).get(ID)
    expect(fpOtherQ).not.toBe(fpIn)
  })

  it("?__cullFlip=1 lets an explicit target fp-skip; a plain explicit target still forces", async () => {
    await flightAt(`http://t/x?visible=${ID}`, tree) // cold
    const warm = await flightAt(`http://t/x?visible=${ID}`, tree)
    const base = matchKeyOf(warm, ID)
    const fpIn = fpById(warm).get(ID)

    // The culling controller's revalidation: explicit target + matching
    // advertised fp + the cull-flip stamp → placeholder, zero body bytes.
    const skip = await flightAt(
      `http://t/x?partials=${ID}&__cullFlip=1&visible=${ID}&cached=${ID}:${base}:${fpIn}`,
      tree,
    )
    expect(skip).not.toContain("data-full")
    expect(skip).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
    // Measured verdict → the confirm marker (re-arms the restored fiber).
    expect(skip).toContain('"data-partial-confirm":true')

    // Without the stamp, an explicit target is a force — fresh body.
    const forced = await flightAt(
      `http://t/x?partials=${ID}&visible=${ID}&cached=${ID}:${base}:${fpIn}`,
      tree,
    )
    expect(forced).toContain("data-full")
  })

  it("an UNMEASURED fp-skip never carries the confirm marker", async () => {
    await flightAt(`http://t/x`, tree) // cold (seed: in view)
    const warm = await flightAt(`http://t/x`, tree)
    const base = matchKeyOf(warm, ID)
    const fpIn = fpById(warm).get(ID)
    // Same fp presented on an unmeasured request: skips, but the
    // verdict says nothing about a parked fiber's state — no confirm.
    const skip = await flightAt(`http://t/x?cached=${ID}:${base}:${fpIn}`, tree)
    expect(skip).not.toContain("data-full")
    expect(skip).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
    expect(skip).not.toContain('"data-partial-confirm":true')
  })
})
