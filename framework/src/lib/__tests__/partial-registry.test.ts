/**
 * Variant-keyed registry — direct semantics tests.
 *
 * Exercises register / lookup / commit / invalidate without going
 * through React rendering, so the storage shape and concurrency
 * behaviour can be asserted in isolation.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  _registryStats,
  clearRegistry,
  commitRequestRegistry,
  enterRequestRegistry,
  invalidateSnapshot,
  lookupPartial,
  registerPartial,
  type PartialSnapshot,
} from "../partial-registry.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"

function snap(parentPath: readonly string[], extra: Partial<PartialSnapshot> = {}): PartialSnapshot {
  return {
    type: extra.type ?? "test",
    fallback: null,
    labels: extra.labels ?? ["t"],
    framePath: extra.framePath ?? [],
    parentFrameChain: extra.parentFrameChain ?? [],
    parentPath,
  }
}

async function runRequest(url: string, route: string, mode: "streaming" | "cache", fn: () => void | Promise<void>): Promise<void> {
  await runWithRequestAsync(new Request(url), async () => {
    const ctx = enterRequestRegistry(route, mode)
    await fn()
    commitRequestRegistry(ctx)
  })
}

afterEach(() => {
  clearRegistry("all")
})

describe("partial-registry — variant-keyed storage", () => {
  it("dedupes same id with same structural placement across routes", async () => {
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("hdr", snap(["page-root"]))
    })
    await runRequest("http://t/b", "/b", "streaming", () => {
      registerPartial("hdr", snap(["page-root"]))
    })

    const stats = _registryStats()
    expect(stats.routes).toBe(2)
    expect(stats.partials).toBe(1)
    expect(stats.variants).toBe(1)
  })

  it("keeps distinct variants when same id has different parent placements", async () => {
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("hdr", snap(["page-root"]))
    })
    await runRequest("http://t/b", "/b", "streaming", () => {
      registerPartial("hdr", snap(["editor-shell", "page-root"]))
    })

    const stats = _registryStats()
    expect(stats.partials).toBe(1)
    expect(stats.variants).toBe(2)
    expect(stats.routes).toBe(2)
  })

  it("lookup resolves to the route-specific variant via the hint table", async () => {
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("hdr", snap(["page-root"]))
    })
    await runRequest("http://t/b", "/b", "streaming", () => {
      registerPartial("hdr", snap(["editor-shell", "page-root"]))
    })

    await runRequest("http://t/a", "/a", "cache", () => {
      const hit = lookupPartial("hdr")
      expect(hit?.parentPath).toEqual(["page-root"])
    })
    await runRequest("http://t/b", "/b", "cache", () => {
      const hit = lookupPartial("hdr")
      expect(hit?.parentPath).toEqual(["editor-shell", "page-root"])
    })
  })

  it("isolates pending writes across concurrent ALS contexts on the same route", async () => {
    // Two parallel ALS contexts register the same id with different
    // parent placements on the same route. Isolation means each context
    // sees its own pending write during the await, and commit writes
    // BOTH variants to the deduplicated store.
    const seenAlpha: string[] = []
    const seenBeta: string[] = []
    await Promise.all([
      runWithRequestAsync(new Request("http://t/a"), async () => {
        const ctx = enterRequestRegistry("/a", "streaming")
        registerPartial("x", snap(["alpha"]))
        await new Promise((r) => setTimeout(r, 10))
        const seen = lookupPartial("x")
        if (seen) seenAlpha.push(...seen.parentPath)
        commitRequestRegistry(ctx)
      }),
      runWithRequestAsync(new Request("http://t/a"), async () => {
        const ctx = enterRequestRegistry("/a", "streaming")
        registerPartial("x", snap(["beta"]))
        await new Promise((r) => setTimeout(r, 10))
        const seen = lookupPartial("x")
        if (seen) seenBeta.push(...seen.parentPath)
        commitRequestRegistry(ctx)
      }),
    ])

    expect(seenAlpha).toEqual(["alpha"])
    expect(seenBeta).toEqual(["beta"])

    // Both structural placements survive in the deduplicated variant store.
    const stats = _registryStats()
    expect(stats.variants).toBe(2)
  })

  it("invalidateSnapshot drops every variant of an id, leaves others intact", async () => {
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("hdr", snap(["page-root"]))
      registerPartial("ftr", snap(["page-root"]))
    })
    await runRequest("http://t/b", "/b", "streaming", () => {
      registerPartial("hdr", snap(["editor-shell", "page-root"]))
    })

    expect(_registryStats().partials).toBe(2)
    expect(_registryStats().variants).toBe(3)

    await runRequest("http://t/a", "/a", "cache", () => {
      invalidateSnapshot("hdr")
    })

    const after = _registryStats()
    expect(after.partials).toBe(1)
    expect(after.variants).toBe(1)

    // /b's hint no longer resolves hdr (id-wide invalidation reaches every route).
    await runRequest("http://t/b", "/b", "cache", () => {
      expect(lookupPartial("hdr")).toBeUndefined()
    })
    // /a's ftr is intact.
    await runRequest("http://t/a", "/a", "cache", () => {
      expect(lookupPartial("ftr")).toBeDefined()
    })
  })

  it("streaming-mode commit merges into the route hint (keeps fp-skipped descendants)", async () => {
    // Background: fp-skipping an ancestor means its body never runs, so
    // its descendants don't get a chance to re-register. Their hint
    // entries from the prior commit must survive the new streaming
    // commit, otherwise `computeDescendantFold` reads an eroded
    // canonical and the ancestor's fp drifts. See the merge rationale
    // in `commitRequestRegistry`.
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("a", snap(["root"]))
      registerPartial("b", snap(["root"]))
    })

    await runRequest("http://t/a", "/a", "cache", () => {
      expect(lookupPartial("a")).toBeDefined()
      expect(lookupPartial("b")).toBeDefined()
    })

    // Re-render the page without re-registering 'b' — merge semantics
    // mean the existing hint entry stays put. Removal flows through
    // `invalidateSnapshot`, not through "absence from pendingHints".
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("a", snap(["root"]))
    })

    await runRequest("http://t/a", "/a", "cache", () => {
      expect(lookupPartial("a")).toBeDefined()
      expect(lookupPartial("b")).toBeDefined()
    })
  })

  it("cache-mode commit patches existing hint without dropping untouched ids", async () => {
    await runRequest("http://t/a", "/a", "streaming", () => {
      registerPartial("a", snap(["root"]))
      registerPartial("b", snap(["root"]))
    })

    // A cache-mode refetch only re-registers 'a'. 'b' must survive.
    await runRequest("http://t/a", "/a", "cache", () => {
      registerPartial("a", snap(["root"]))
    })

    await runRequest("http://t/a", "/a", "cache", () => {
      expect(lookupPartial("a")).toBeDefined()
      expect(lookupPartial("b")).toBeDefined()
    })
  })
})

describe("freshness-guarded canonical writes", () => {
  it("a late commit from an older registration does not clobber a fresher record", async () => {
    // The live-connection shape: request A registers first but commits
    // LAST (the connection closes late); request B registers a fresher
    // record (more dep keys) and commits in between. A's late commit
    // must not clobber B's record.
    let ctxA!: ReturnType<typeof enterRequestRegistry>
    await runWithRequestAsync(new Request("http://t/a"), async () => {
      ctxA = enterRequestRegistry("/a", "streaming")
      registerPartial("guarded", snap(["page-root"]))
    })
    await runWithRequestAsync(new Request("http://t/a"), async () => {
      const ctxB = enterRequestRegistry("/a", "streaming")
      const fresher = snap(["page-root"])
      fresher.deps = new Set(["search:config"])
      registerPartial("guarded", fresher)
      commitRequestRegistry(ctxB)
    })
    await runWithRequestAsync(new Request("http://t/a"), async () => {
      commitRequestRegistry(ctxA)
    })
    await runWithRequestAsync(new Request("http://t/a"), async () => {
      enterRequestRegistry("/a", "cache")
      const committed = lookupPartial("guarded")
      expect([...(committed?.deps ?? [])]).toContain("search:config")
    })
  })
})
