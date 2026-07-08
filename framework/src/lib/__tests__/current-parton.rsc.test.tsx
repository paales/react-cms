/**
 * Probe: a parton's OWN identity is readable by a free function called
 * within its render (`getCurrentParton`), reliably across awaits and
 * isolated between siblings. This is the exact attribution the old
 * tracked-accessor manifest could NOT keep — it pointed at "the current
 * partial" through a request-level cell that drifted across awaits and
 * under sibling interleaving, which is why dependency reads were forced
 * into an explicit `vary` (commit 2d607fc). Riding the per-component ALS
 * (see [[server-context]]) makes it reliable, and this is the foundation
 * server-hooks (inline cells, `tag()`, auto-tracked vary) build on.
 */

import { describe, expect, it } from "vitest"
import { flightToString, renderServerToFlight, renderWithRequest } from "../../test/rsc-server.ts"
import { parton, type RenderArgs } from "../partial.tsx"
import { getCurrentParton } from "../current-parton.ts"

type Phase = "top" | "after"
const seen: Array<{ tag: string; phase: Phase; id: string | undefined }> = []
function record(tag: string, phase: Phase) {
  seen.push({ tag, phase, id: getCurrentParton()?.id })
}
const idOf = (tag: string, phase: Phase): string | undefined =>
  seen.find((s) => s.tag === tag && s.phase === phase)?.id

// ── own id, stable across an await ───────────────────────────────────────
const Leaf = parton(
  async function CpLeafRender(_: RenderArgs) {
    record("leaf", "top")
    await new Promise((r) => setTimeout(r, 5)) // read AFTER an await
    record("leaf", "after")
    return <span data-leaf />
  },
  { selector: ".cp-leaf" },
)

describe("current-parton: a parton reads its own id", () => {
  it("reads the same own id before AND after an await", async () => {
    seen.length = 0
    const { stream } = await renderWithRequest("http://t/x", <Leaf />)
    await flightToString(stream)
    expect(idOf("leaf", "top")).toBe("cp-leaf")
    expect(idOf("leaf", "after")).toBe("cp-leaf") // survived the await
  })

  it("is undefined outside a parton body (non-parton server component)", async () => {
    seen.length = 0
    async function PlainProbe() {
      seen.push({ tag: "plain", phase: "top", id: getCurrentParton()?.id })
      return <span />
    }
    await flightToString(
      renderServerToFlight(
        <div>
          <PlainProbe />
        </div>,
      ),
    )
    expect(idOf("plain", "top")).toBeUndefined()
  })
})

// ── each parton stamps its own — a child sees the child, not the parent ──
const Child = parton(
  async function CpChildRender(_: RenderArgs) {
    record("child", "top")
    await new Promise((r) => setTimeout(r, 3))
    record("child", "after")
    return <span data-child />
  },
  { selector: ".cp-child" },
)
const Parent = parton(
  async function CpParentRender(_: RenderArgs) {
    record("parent", "top")
    await new Promise((r) => setTimeout(r, 3))
    record("parent", "after")
    return (
      <div>
        <Child />
      </div>
    )
  },
  { selector: ".cp-parent" },
)

describe("current-parton: each parton stamps its own identity", () => {
  it("a nested child reads the child's id, the parent reads the parent's", async () => {
    seen.length = 0
    const { stream } = await renderWithRequest("http://t/x", <Parent />)
    await flightToString(stream)
    expect(idOf("parent", "top")).toBe("cp-parent")
    expect(idOf("parent", "after")).toBe("cp-parent")
    expect(idOf("child", "top")).toBe("cp-child") // NOT "cp-parent"
    expect(idOf("child", "after")).toBe("cp-child")
  })
})

// ── sibling isolation under staggered awaits (the drift case) ────────────
const SibA = parton(
  async function CpSibARender(_: RenderArgs) {
    record("A", "top")
    await new Promise((r) => setTimeout(r, 20)) // longest — resumes last
    record("A", "after")
    return <span data-a />
  },
  { selector: ".cp-a" },
)
const SibB = parton(
  async function CpSibBRender(_: RenderArgs) {
    record("B", "top")
    await new Promise((r) => setTimeout(r, 5))
    record("B", "after")
    return <span data-b />
  },
  { selector: ".cp-b" },
)
const SibC = parton(
  async function CpSibCRender(_: RenderArgs) {
    record("C", "top")
    await new Promise((r) => setTimeout(r, 12))
    record("C", "after")
    return <span data-c />
  },
  { selector: ".cp-c" },
)

describe("current-parton: siblings stay isolated across interleaved awaits", () => {
  it("each sibling reads its own id after its await, not a concurrently-rendering sibling's", async () => {
    seen.length = 0
    const { stream } = await renderWithRequest(
      "http://t/x",
      <>
        <SibA />
        <SibB />
        <SibC />
      </>,
    )
    await flightToString(stream)
    // Each read its own id at the top…
    expect(idOf("A", "top")).toBe("cp-a")
    expect(idOf("B", "top")).toBe("cp-b")
    expect(idOf("C", "top")).toBe("cp-c")
    // …and STILL its own after the await — A resumes after B and C have
    // rendered, yet reads "cp-a", not "cp-b"/"cp-c" (the drift failure).
    expect(idOf("A", "after")).toBe("cp-a")
    expect(idOf("B", "after")).toBe("cp-b")
    expect(idOf("C", "after")).toBe("cp-c")
  })
})
