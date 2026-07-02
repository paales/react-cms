/**
 * Addressable gate — non-addressable specs (no author-declared
 * selector/vary/match) don't emit a `partialFingerprint` on the
 * wire. The per-spec fp cycle (boundary prop → client registration
 * → next-nav `?cached=` triple → fp-trailer update) is redundant
 * for them: they have no external refetch handle, so they only
 * ever render as part of their parent's render. The parent's
 * descendant fold still folds their varyKey/contentKey
 * contributions in, so fp-skip safety is preserved at the parent.
 *
 * Auto-derived selectors (from `Render.name`) DON'T count as
 * author-declared addressability — they only exist to give the
 * spec catalog a unique id.
 */

import { describe, expect, it } from "vitest"
import { parton, ROOT, PartialRoot, type RenderArgs } from "../partial.tsx"
import { cookie, searchParam } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"

/** Pull `(partialId, partialFingerprint?)` pairs out of a Flight
 *  payload, keyed by partialId. `partialFingerprint` is absent
 *  when the boundary was emitted without the prop (the gate
 *  collapses to `partialFingerprint={undefined}`, which Flight
 *  omits from the serialized prop bag). */
function fingerprintsByPartialId(flight: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  // `partialId` always appears; `partialFingerprint` is optional.
  // Scan for partialId first, then look ahead for an optional
  // partialFingerprint within the next ~100 chars (same element's
  // prop bag — Flight serializes element props inline as a single
  // JSON object).
  const idRe = /"partialId":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = idRe.exec(flight)) !== null) {
    const id = m[1]
    const tail = flight.slice(m.index, m.index + 200)
    const fpMatch = /"partialFingerprint":"([^"]+)"/.exec(tail)
    out.set(id, fpMatch ? fpMatch[1] : undefined)
  }
  return out
}

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("addressable gate — wire fp emission", () => {
  it("a spec with no author-declared selector/vary/match emits no partialFingerprint on the wire", async () => {
    clearRegistry("all")

    // Non-addressable child: no `selector`, no `vary`, no `match`.
    // Catalog id auto-derives to "gate-child" from Render.name.
    const Child = parton(function GateChildRender(_: RenderArgs) {
      return <span data-testid="gate-child-body">child</span>
    })

    // Addressable parent: explicit `selector` AND `match`. The
    // parent IS reachable for refetch and SHOULD emit an fp.
    const Parent = parton(
      function GateParentRender() {
        return (
          <div data-testid="gate-parent-body">
            <Child />
          </div>
        )
      },
      { selector: "#gate-parent", match: "/gate" },
    )

    const tree = (
      <PartialRoot>
        <Parent />
      </PartialRoot>
    )

    const out = await flightAt("http://t/gate", tree)
    const fps = fingerprintsByPartialId(out)

    // Sanity: both partials rendered.
    expect(out).toContain("gate-parent-body")
    expect(out).toContain("gate-child-body")

    // Parent is addressable — fp present.
    expect(fps.has("gate-parent")).toBe(true)
    expect(fps.get("gate-parent")).toMatch(/^[0-9a-f]{16}$/)

    // Child is non-addressable — boundary exists (id is bound to
    // the React tree for context propagation), but the fp prop is
    // omitted, so Flight doesn't serialize it.
    expect(fps.has("gate-child")).toBe(true)
    expect(fps.get("gate-child")).toBeUndefined()
  })

  it("an explicit selector flips the gate on — the spec emits a fingerprint", async () => {
    clearRegistry("all")

    // Same Render, same lack of vary/match — but `selector` is
    // explicit. Author opted in to addressability; fp on the wire.
    const Child = parton(
      function SelectorOptInChildRender(_: RenderArgs) {
        return <span data-testid="opt-in-body">child</span>
      },
      { selector: ".opt-in-child" },
    )

    const Parent = parton(
      function SelectorOptInParentRender() {
        return (
          <div>
            <Child />
          </div>
        )
      },
      { selector: "#opt-in-parent", match: "/opt-in" },
    )

    const out = await flightAt(
      "http://t/opt-in",
      <PartialRoot>
        <Parent />
      </PartialRoot>,
    )
    const fps = fingerprintsByPartialId(out)
    expect(fps.get("opt-in-child")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("an explicit schema flips the gate on — the spec emits a fingerprint", async () => {
    clearRegistry("all")

    // No selector, no match, but `schema` is declared. Author opted in.
    const VaryChild = parton(
      function VaryOptInChildRender({ v }: { v: string } & RenderArgs) {
        return <span data-testid="vary-opt-in-body">{`child-${v}`}</span>
      },
      { schema: () => ({ v: searchParam("v", "x") }) },
    )

    const Parent = parton(
      function VaryOptInParentRender() {
        return (
          <div>
            <VaryChild />
          </div>
        )
      },
      { selector: "#vary-opt-in-parent", match: "/vary-opt-in" },
    )

    const out = await flightAt(
      "http://t/vary-opt-in",
      <PartialRoot>
        <Parent />
      </PartialRoot>,
    )
    const fps = fingerprintsByPartialId(out)
    expect(fps.get("vary-opt-in-child")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("the parent's fingerprint moves when a non-addressable child's tracked read would move (fold safety)", async () => {
    clearRegistry("all")

    // Child reads a cookie via its schema. Child is still addressable
    // here (schema alone trips the gate), but the important assertion
    // is that the PARENT's fp picks up the child's dep contribution
    // through the descendant fold. Without the fold, fp-skipping the
    // parent would serve a stale child body when only the cookie
    // changed.
    const FoldChild = parton(
      function FoldChildRender({ flag }: { flag: string } & RenderArgs) {
        return <span data-testid="fold-body">flag={flag}</span>
      },
      { schema: () => ({ flag: cookie("flag") ?? "off" }) },
    )

    const Parent = parton(
      function FoldParentRender() {
        return (
          <div>
            <FoldChild />
          </div>
        )
      },
      { selector: "#fold-parent", match: "/fold" },
    )

    const tree = (
      <PartialRoot>
        <Parent />
      </PartialRoot>
    )

    // Two cold renders + a warm render so the fold has snapshots
    // to read from. Cold→cold→warm is the typical fp-trailer flow:
    // first render registers descendant snapshots; subsequent
    // renders see them and fold them in.
    await flightAt("http://t/fold", tree)
    const off = await flightAt("http://t/fold", tree)
    // Same request again with the cookie flipped. The parent has
    // no own vary on the cookie, but the child's vary contribution
    // (via the fold) should still move the parent's fp.
    const { stream: onStream } = await renderWithRequest("http://t/fold", tree, {
      headers: { cookie: "flag=on" },
    })
    const on = await new Response(onStream).text()

    const fpOff = fingerprintsByPartialId(off).get("fold-parent")
    const fpOn = fingerprintsByPartialId(on).get("fold-parent")
    expect(fpOff).toBeDefined()
    expect(fpOn).toBeDefined()
    expect(fpOn).not.toBe(fpOff)
  })
})
