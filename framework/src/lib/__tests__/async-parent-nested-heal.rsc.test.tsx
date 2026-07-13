/**
 * F8 — an addressable parton nested inside an ASYNC-body parent must
 * heal on live updates (docs/notes/convergence-fuzzing.md, findings
 * ledger).
 *
 * An async Render body reaches its `<PartialErrorBoundary>` wrapper as
 * a raw Promise (`partial.tsx` calls `spec.Render(renderProps)` and
 * wraps the returned value directly), so Flight serializes the
 * wrapper's children as an OUTLINED PROMISE ROW — `"children":"$@N"` —
 * which the client decodes to a Flight chunk (an instrumented
 * thenable), NOT a React lazy. The client merge walks
 * (`cacheFromStreamingChildren`, `substituteNested`,
 * `harvestPartialIds`) must read the chunk's own settlement — descend
 * a fulfilled chunk, treat a pending one as in-flight — or everything
 * behind the promise is invisible to the merge layer: the nested
 * child's cache entry never lands from the parent's payload, and a
 * parent lane that fp-skips the child commits a wrapper whose
 * `<i data-partial>` hole mounts through React's native thenable
 * resolution, permanently outside `substituteNested`'s reach (the
 * website's auction-lot bug: the child's own lane bytes sat in the
 * cache under the exactly-matching key while the DOM kept the hole).
 *
 * This test drives the REAL pipeline end to end: real server renders
 * through the request context, the real Flight encode → decode round
 * trip, and the real client commit walk + template substitution the
 * browser entry runs on a lane commit.
 */

import { beforeEach, describe, expect, it } from "vitest"
import type { ReactElement, ReactNode } from "react"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { searchParam } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { consumePayload, type FlightBytes } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import {
  _commitPartonLane,
  getPartialId,
  getPlaceholderId,
  isPartialWrapper,
  isPlaceholder,
} from "../partial-cache.ts"
import { getCurrentPagePartials, pruneToLive } from "../partial-client-state.ts"
import { deriveTemplate, renderTemplate } from "../partial-template.tsx"

// ─── Fixture: async-body parent containing an addressable child ─────

const Lot = parton(
  function LotRender(_: RenderArgs) {
    const v = searchParam("v") ?? "0"
    return <span data-testid="lot-body">lot-v{v}</span>
  },
  { selector: "#lot" },
)

const AsyncParent = parton(
  async function AsyncParentRender(_: RenderArgs) {
    // The await is what makes the body's return value a genuinely
    // pending Promise at wrap time — the outlined-row geometry.
    await Promise.resolve()
    return (
      <div data-testid="parent-body">
        <Lot />
      </div>
    )
  },
  { selector: "#async-parent" },
)

const tree = (
  <PartialRoot>
    <AsyncParent />
  </PartialRoot>
)

// ─── Helpers ────────────────────────────────────────────────────────

async function renderBoth(url: string): Promise<{ text: string; payload: ReactNode }> {
  const { stream } = await renderWithRequest(url, tree)
  const [a, b] = (stream as FlightBytes).tee()
  const [text, payload] = await Promise.all([new Response(a).text(), consumePayload<ReactNode>(b)])
  return { text, payload }
}

/** Harvest the child's emitted `(fingerprint, matchKey)` off the wire —
 *  the props ride the PEB wrapper in declaration order. */
function lotWireIdentity(flight: string): { fp: string; mk: string } {
  const m =
    /"partialId":"lot","partialFingerprint":"([0-9a-f]+)","partialMatchKey":"([0-9a-f]*)"/.exec(
      flight,
    )
  expect(m, "lot's wrapper props not found on the wire").not.toBeNull()
  return { fp: m![1]!, mk: m![2]! }
}

/** Await-based structural walk (TEST-side only): collect every text
 *  node, wrapper id, and bare placeholder id reachable in a rendered
 *  tree, following fulfilled/settling thenables and lazies the way
 *  React's own render would. */
async function collectDeep(
  node: ReactNode,
  out: { text: string[]; wrappers: string[]; holes: string[] },
): Promise<void> {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const c of node) await collectDeep(c as ReactNode, out)
    return
  }
  if (typeof node === "object" && typeof (node as PromiseLike<unknown>).then === "function") {
    await collectDeep((await (node as PromiseLike<unknown>)) as ReactNode, out)
    return
  }
  const n = node as { $$typeof?: symbol; _payload?: unknown; props?: { children?: ReactNode } }
  if (typeof n.$$typeof === "symbol" && n.$$typeof.toString() === "Symbol(react.lazy)") {
    const payload = n._payload
    if (payload != null && typeof (payload as PromiseLike<unknown>).then === "function") {
      await collectDeep((await (payload as PromiseLike<unknown>)) as ReactNode, out)
    }
    return
  }
  const el = node as ReactElement
  if (isPlaceholder(el)) {
    const id = getPlaceholderId(el)
    if (id) out.holes.push(id)
    return
  }
  if (isPartialWrapper(el)) {
    const id = getPartialId(el)
    if (id) out.wrappers.push(id)
  }
  const inner = (el.props as { children?: ReactNode } | undefined)?.children
  if (inner != null) await collectDeep(inner, out)
}

async function collect(node: ReactNode) {
  const out = { text: [] as string[], wrappers: [] as string[], holes: [] as string[] }
  await collectDeep(node, out)
  return { ...out, joined: out.text.join("") }
}

/** Await-based extraction (TEST-side only): find a partial wrapper by
 *  id anywhere in a decoded payload, following thenables/lazies. Used
 *  to lift the child's wrapper out of a whole-tree decode so it can be
 *  committed exactly the way the browser commits the child's own lane
 *  body (whose root IS the wrapper). */
async function findWrapper(node: ReactNode, id: string): Promise<ReactElement | null> {
  if (node == null || typeof node === "boolean") return null
  if (typeof node === "string" || typeof node === "number") return null
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = await findWrapper(c as ReactNode, id)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === "object" && typeof (node as PromiseLike<unknown>).then === "function") {
    return findWrapper((await (node as PromiseLike<unknown>)) as ReactNode, id)
  }
  const n = node as { $$typeof?: symbol; _payload?: unknown }
  if (typeof n.$$typeof === "symbol" && n.$$typeof.toString() === "Symbol(react.lazy)") {
    const payload = n._payload
    if (payload != null && typeof (payload as PromiseLike<unknown>).then === "function") {
      return findWrapper((await (payload as PromiseLike<unknown>)) as ReactNode, id)
    }
    return null
  }
  const el = node as ReactElement
  if (isPartialWrapper(el) && getPartialId(el) === id) return el
  const inner = (el.props as { children?: ReactNode } | undefined)?.children
  return inner != null ? findWrapper(inner, id) : null
}

beforeEach(() => {
  clearRegistry("all")
  pruneToLive(new Map())
})

// ─── The geometry ───────────────────────────────────────────────────

describe("async-body parent — outlined promise children", () => {
  it("serializes the parent wrapper's children as an outlined $@ promise row", async () => {
    const { text } = await renderBoth("http://t/?v=1")
    // The load-bearing wire fact: the async body crosses as a promise
    // ref, not inline children and not a $L lazy. If this moves, the
    // merge layer's thenable handling is what to re-verify.
    expect(text).toMatch(/"children":"\$@[0-9a-f]+"/)
  })

  it("the whole-payload commit walk caches the nested child behind the promise", async () => {
    const { payload } = await renderBoth("http://t/?v=1")
    _commitPartonLane(payload, null, "async-parent")
    const cache = getCurrentPagePartials()
    expect(cache.get("async-parent"), "parent wrapper must be cached").toBeDefined()
    expect(
      cache.get("lot"),
      "nested child behind the async parent's promise children must get its own cache entry",
    ).toBeDefined()
  })

  it("a nested child's live update heals through a committed async parent lane", async () => {
    // 1. Cold visit at v=1 — the page the client is looking at.
    const r1 = await renderBoth("http://t/?v=1")
    _commitPartonLane(r1.payload, null, "async-parent")

    // 2. The child's OWN lane delivers fresh v=2 content (the cell
    //    write's lane in the auction-lot geometry). A lane body's root
    //    is the child's wrapper itself — lift it out of a v=2 decode
    //    and commit it the way the browser commits the lane.
    const r2 = await renderBoth("http://t/?v=2")
    const lotLaneBody = await findWrapper(r2.payload, "lot")
    expect(lotLaneBody, "the child's fresh wrapper must exist in the v=2 render").not.toBeNull()
    _commitPartonLane(lotLaneBody, null, "lot")
    const { fp, mk } = lotWireIdentity(r2.text)
    const lotSlot = getCurrentPagePartials().get("lot")?.get(mk)
    expect(lotSlot, "the child's lane content must be in the cache").toBeDefined()

    // 3. The parent's lane commits around it: the server credits the
    //    child's fp (the client just committed those bytes), so the
    //    parent's fresh body carries the child as an fp-skip HOLE —
    //    inside the outlined promise row.
    const r3 = await renderBoth(`http://t/?v=2&cached=lot:${mk}:${fp}`)
    expect(r3.text, "the parent lane must fp-skip the child to a hole").toContain(
      '"data-partial-id":"lot"',
    )
    expect(r3.text).not.toContain("lot-v")
    _commitPartonLane(r3.payload, null, "async-parent")

    // 4. The template re-render a lane commit notifies — the real
    //    client path: derive the structural template from the payload,
    //    render it against the cache, `substituteNested` fills holes.
    const rendered = renderTemplate(deriveTemplate(r3.payload), getCurrentPagePartials())
    const seen = await collect(rendered)

    // The child's committed content must be reachable in the rendered
    // tree — the hole healed from the cache slot its own lane filled.
    expect(
      seen.joined,
      "the child's lane content never reached the rendered tree — the hole did not heal",
    ).toContain("lot-v2")
    expect(
      seen.holes,
      "a bare un-substituted placeholder for the child survived into the rendered tree",
    ).not.toContain("lot")
  })
})
