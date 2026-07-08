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
 * dep record, and a MEASURED fp-skip carries the confirm marker — the
 * placeholder that confirms the client's parked copy (the flip-in
 * lane's zero-byte confirmation).
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
async function flightAt(
  url: string,
  node: React.ReactNode,
  visible?: readonly string[],
): Promise<string> {
  const { stream } = await renderWithRequest(url, node, { visible })
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
    const warm = await flightAt(`http://t/x`, tree, [ID])
    const base = matchKeyOf(warm, ID)
    expect(base).toBeDefined()
    expect(warm).toContain("data-full")

    // Culled: no body, no fp — the pair (its `culled` prop routes
    // display) with the always-present content hole, so a later
    // flip-in's bytes have a mounted position to substitute into.
    const cold = await flightAt(`http://t/x`, tree, ["other"])
    expect(cold).not.toContain("data-full")
    expect(fpById(cold).get(ID)).toBeUndefined()
    expect(cold).toContain(`"id":"${ID}"`)
    expect(cold).toContain('"culled":true')
    expect(cold).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
  })

  it("per-state snapshots: a culled render does not erode the in-view dep record", async () => {
    await flightAt(`http://t/x?q=shoes`, tree, [ID]) // cold — records in-view deps
    const fpIn = fpById(await flightAt(`http://t/x?q=shoes`, tree, [ID])).get(ID)
    expect(fpIn).toBeDefined()

    // Cull out (the culled snapshot records only the gate's reads),
    // then return. The in-view fp must be computed from the IN-VIEW
    // state's record — folding the culled record would shift it and
    // every return would re-render even when nothing changed.
    await flightAt(`http://t/x?q=shoes`, tree, ["other"])
    const fpBack = fpById(await flightAt(`http://t/x?q=shoes`, tree, [ID])).get(ID)
    expect(fpBack).toBe(fpIn)

    // And the dependency still bites: a changed in-view read moves it.
    const fpOtherQ = fpById(await flightAt(`http://t/x?q=hats`, tree, [ID])).get(ID)
    expect(fpOtherQ).not.toBe(fpIn)
  })

  it("a MEASURED fp-skip carries the confirm marker — the flip confirmation", async () => {
    await flightAt(`http://t/x`, tree, [ID]) // cold
    const warm = await flightAt(`http://t/x`, tree, [ID])
    const base = matchKeyOf(warm, ID)
    const fpIn = fpById(warm).get(ID)

    // A flip-in revalidation's verdict: matching manifest fp under a
    // measured set → placeholder, zero body bytes, the confirm marker
    // (re-arms the restored fiber).
    const skip = await flightAt(`http://t/x?cached=${ID}:${base}:${fpIn}`, tree, [ID])
    expect(skip).not.toContain("data-full")
    expect(skip).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
    expect(skip).toContain('"data-partial-confirm":true')
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
