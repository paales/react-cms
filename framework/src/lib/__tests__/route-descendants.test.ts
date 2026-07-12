/**
 * The route's parent→children index (`_readRouteDescendants`) — the
 * inverse of the child→ancestors relation snapshots carry, maintained
 * incrementally on the `_readSnapshotsForRoute` memo.
 *
 * The contract under test is EQUIVALENCE with the subtree filter it
 * replaced: for every ancestor id, `{withinId} ∪ descendants(withinId)`
 * must select exactly the snapshots the old
 * `id === withinId || snap.parentPath.includes(withinId)` walk over the
 * whole bucket selected — asserted on a nested fixture across
 * registration, re-registration (same and MOVED placement),
 * invalidation, and a same-size add+drop commit (the membership case a
 * size check alone would miss).
 */

import { afterEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import {
  _readRouteDescendants,
  _readSnapshotsForRoute,
  clearRegistry,
  commitRequestRegistry,
  enterRequestRegistry,
  invalidateSnapshot,
  registerPartial,
  type PartialSnapshot,
} from "../partial-registry.ts"

const SCOPE = "default"
const ROUTE = "/nested"

function snap(parentPath: readonly string[]): PartialSnapshot {
  return {
    type: "test",
    fallback: null,
    labels: ["t"],
    framePath: [],
    parentFrameChain: [],
    parentPath,
  }
}

async function runRequest(fn: () => void | Promise<void>): Promise<void> {
  await runWithRequestAsync(new Request("http://t/nested"), async () => {
    const ctx = enterRequestRegistry(ROUTE, "streaming")
    await fn()
    commitRequestRegistry(ctx)
  })
}

/** The retired filter — ground truth for the equivalence assert. */
function subtreeByFilter(withinId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of _readSnapshotsForRoute(SCOPE, ROUTE)) {
    if (id === withinId || s.parentPath.includes(withinId)) out.add(id)
  }
  return out
}

/** The indexed subtree, shaped like the callers consume it. */
function subtreeByIndex(withinId: string): Set<string> {
  const snapshots = _readSnapshotsForRoute(SCOPE, ROUTE)
  const out = new Set<string>()
  if (snapshots.has(withinId)) out.add(withinId)
  const ids = _readRouteDescendants(SCOPE, ROUTE).get(withinId)
  if (ids) for (const id of ids) if (snapshots.has(id)) out.add(id)
  return out
}

function expectEquivalence(): void {
  const snapshots = _readSnapshotsForRoute(SCOPE, ROUTE)
  const withinIds = new Set<string>(snapshots.keys())
  for (const s of snapshots.values()) for (const a of s.parentPath) withinIds.add(a)
  for (const withinId of withinIds) {
    expect(subtreeByIndex(withinId), `subtree of ${withinId}`).toEqual(subtreeByFilter(withinId))
  }
}

afterEach(() => {
  clearRegistry("all")
})

describe("route descendants index — equivalence with the parentPath filter", () => {
  it("resolves nested subtrees identically to the whole-bucket filter", async () => {
    await runRequest(() => {
      registerPartial("root", snap([]))
      registerPartial("mid-a", snap(["root"]))
      registerPartial("mid-b", snap(["root"]))
      registerPartial("leaf-a1", snap(["root", "mid-a"]))
      registerPartial("leaf-a2", snap(["root", "mid-a"]))
      registerPartial("leaf-b1", snap(["root", "mid-b"]))
      registerPartial("deep", snap(["root", "mid-b", "leaf-b1"]))
    })
    expectEquivalence()
    expect(subtreeByIndex("mid-a")).toEqual(new Set(["mid-a", "leaf-a1", "leaf-a2"]))
    expect(subtreeByIndex("mid-b")).toEqual(new Set(["mid-b", "leaf-b1", "deep"]))
    expect(subtreeByIndex("leaf-b1")).toEqual(new Set(["leaf-b1", "deep"]))
    // An id with no snapshot and no descendants resolves empty on both.
    expect(subtreeByIndex("ghost")).toEqual(subtreeByFilter("ghost"))
  })

  it("tracks re-registration in place, a MOVED placement, and invalidation", async () => {
    await runRequest(() => {
      registerPartial("root", snap([]))
      registerPartial("mid", snap(["root"]))
      registerPartial("leaf", snap(["root", "mid"]))
    })
    expectEquivalence()

    // Same placement re-render: a fresh snapshot object, same path.
    await runRequest(() => {
      registerPartial("leaf", snap(["root", "mid"]))
    })
    expectEquivalence()
    expect(subtreeByIndex("mid")).toEqual(new Set(["mid", "leaf"]))

    // Moved placement: the leaf re-registers under a different parent —
    // the old ancestor's set must shed it.
    await runRequest(() => {
      registerPartial("mid2", snap(["root"]))
      registerPartial("leaf", snap(["root", "mid2"]))
    })
    expectEquivalence()
    expect(subtreeByIndex("mid")).toEqual(new Set(["mid"]))
    expect(subtreeByIndex("mid2")).toEqual(new Set(["mid2", "leaf"]))

    // Invalidation drops the id from route and index alike.
    await runRequest(() => {
      invalidateSnapshot("leaf")
    })
    expectEquivalence()
    expect(subtreeByIndex("mid2")).toEqual(new Set(["mid2"]))
  })

  it("a same-size add+drop commit updates membership (not just size)", async () => {
    await runRequest(() => {
      registerPartial("root", snap([]))
      registerPartial("old-child", snap(["root"]))
    })
    expect(subtreeByIndex("root")).toEqual(new Set(["root", "old-child"]))

    // One commit drops old-child and adds new-child: the bucket keeps
    // its size while membership changes.
    await runRequest(() => {
      invalidateSnapshot("old-child")
      registerPartial("new-child", snap(["root"]))
    })
    expectEquivalence()
    expect(subtreeByIndex("root")).toEqual(new Set(["root", "new-child"]))
  })
})
