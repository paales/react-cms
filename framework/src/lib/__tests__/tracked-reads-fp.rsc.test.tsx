/**
 * Probe: tracked-read server-hooks make `vary` implicit. A parton that
 * calls `searchParam("q")` in its Render records the dependency, and the
 * value folds into its fingerprint via store-and-reread (the fp is
 * computed before Render, so a render's recorded keys are re-read at the
 * NEXT render). So changing `?q` shifts the tracked spec's fp — exactly
 * as `vary: ({search}) => ({q: search.q})` would — while a control spec
 * that never tracks `q` is stable across the same change.
 *
 * `cookie()` shares the identical path (a different dep kind, read from
 * the same frame-resolved request); `searchParam` is used here because
 * the value is varied straight off the URL.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
async function fpAt(url: string, node: React.ReactNode, id: string): Promise<string | undefined> {
  const { stream } = await renderWithRequest(url, node)
  const text = await new Response(stream).text()
  return fpById(text).get(id)
}

// Tracks ?q via the server-hook — the auto-tracked replacement for
// `vary: ({search}) => ({q: search.q})`.
const Tracked = parton(
  function TrackedRender(_: RenderArgs) {
    const q = searchParam("q")
    return <span data-testid="tracked">{q ?? "—"}</span>
  },
  { selector: "#tracked-probe" },
)

// Reads nothing — the control. ?q must NOT move its fp.
const Untracked = parton(
  function UntrackedRender(_: RenderArgs) {
    return <span data-testid="untracked" />
  },
  { selector: "#untracked-probe" },
)

describe("tracked reads fold into the fingerprint (vary becomes implicit)", () => {
  beforeEach(() => clearRegistry("all"))

  it("a tracked ?q read shifts the fp when ?q changes, and is stable when it doesn't", async () => {
    const tree = (
      <PartialRoot>
        <Tracked />
      </PartialRoot>
    )
    // Cold render captures the dep key; the warm render folds its value
    // (store-and-reread). Warm up at ?q=A, then compare across changes.
    await fpAt("http://t/x?q=A", tree, "tracked-probe") // cold — records search:q
    const fpA = await fpAt("http://t/x?q=A", tree, "tracked-probe") // warm — folds q=A
    const fpB = await fpAt("http://t/x?q=B", tree, "tracked-probe") // folds q=B
    const fpA2 = await fpAt("http://t/x?q=A", tree, "tracked-probe") // folds q=A again

    expect(fpA).toBeDefined()
    expect(fpB).not.toBe(fpA) // ?q change moved the fp — the read is tracked
    expect(fpA2).toBe(fpA) // same ?q → same fp (stable, no churn)
  })

  it("a spec that never tracks ?q is unaffected by the ?q change", async () => {
    const tree = (
      <PartialRoot>
        <Untracked />
      </PartialRoot>
    )
    await fpAt("http://t/x?q=A", tree, "untracked-probe")
    const fpA = await fpAt("http://t/x?q=A", tree, "untracked-probe")
    const fpB = await fpAt("http://t/x?q=B", tree, "untracked-probe")
    expect(fpA).toBeDefined()
    expect(fpB).toBe(fpA) // no tracked read → ?q is invisible to the fp
  })
})
