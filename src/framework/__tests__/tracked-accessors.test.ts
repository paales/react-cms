/**
 * Tests for the tracked-accessor surface: getCookie / getHeader /
 * getSearchParam / getRoute populate a cache access manifest, and
 * adding a previously-unseen key while a stored manifest is active
 * throws a HoistingViolationError.
 *
 * These exercise `src/framework/context.ts` directly without going
 * through `<Cache>` — the accessor contract is independent of the
 * Cache component that consumes it.
 */
import { describe, expect, it } from "vitest"
import {
  HoistingViolationError,
  getCookie,
  getHeader,
  getPathname,
  getSearchParam,
  matchRoutePattern,
  resolveManifest,
  runWithCacheManifest,
  runWithRequestAsync,
  type ManifestScope,
} from "../context.ts"

function fakeRequest(
  url = "http://localhost/test?q=pika&page=2",
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers })
}

function freshScope(partialId = "test"): ManifestScope {
  return { current: new Set(), stored: null, partialId }
}

describe("tracked accessors", () => {
  it("no-ops when no manifest scope is open", async () => {
    await runWithRequestAsync(fakeRequest(), async () => {
      // No runWithCacheManifest wrapping — the call should still
      // return the value, just without tracking.
      expect(getSearchParam("q")).toBe("pika")
    })
  })

  it("populates manifest with url: keys on getSearchParam", async () => {
    const scope = freshScope()
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        expect(getSearchParam("q")).toBe("pika")
        expect(getSearchParam("page")).toBe("2")
      })
    })
    expect([...scope.current].sort()).toEqual(["url:page", "url:q"])
  })

  it("populates manifest with cookie: keys on getCookie", async () => {
    const scope = freshScope()
    await runWithRequestAsync(
      fakeRequest("http://localhost/", { cookie: "cart=abc; tenant=foo" }),
      async () => {
        await runWithCacheManifest(scope, async () => {
          expect(getCookie("cart")).toBe("abc")
          expect(getCookie("tenant")).toBe("foo")
        })
      },
    )
    expect([...scope.current].sort()).toEqual(["cookie:cart", "cookie:tenant"])
  })

  it("populates manifest with header: keys on getHeader (lowercased)", async () => {
    const scope = freshScope()
    await runWithRequestAsync(fakeRequest("http://localhost/", { "X-Region": "eu" }), async () => {
      await runWithCacheManifest(scope, async () => {
        expect(getHeader("X-Region")).toBe("eu")
      })
    })
    expect([...scope.current]).toEqual(["header:x-region"])
  })

  it("nested runWithCacheManifest attributes reads to the inner scope", async () => {
    const outer = freshScope("outer")
    const inner = freshScope("inner")
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(outer, async () => {
        getSearchParam("q")
        await runWithCacheManifest(inner, async () => {
          getSearchParam("page")
        })
        // reads after the inner scope returns go back into outer
        getCookie("foo")
      })
    })
    expect([...outer.current].sort()).toEqual(["cookie:foo", "url:q"])
    expect([...inner.current]).toEqual(["url:page"])
  })
})

describe("hoisting violation", () => {
  it("throws when a render accesses a key not in the stored manifest", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: new Set(["cookie:cart"]),
      partialId: "cart-widget",
    }
    const { result } = await runWithRequestAsync(
      fakeRequest("http://localhost/", { cookie: "cart=abc" }),
      async () => {
        return await runWithCacheManifest(scope, async () => {
          getCookie("cart") // allowed — in stored
          try {
            getSearchParam("promo") // NOT in stored → throw
            return null
          } catch (e) {
            return e as HoistingViolationError
          }
        })
      },
    )
    expect(result).toBeTruthy()
    expect((result as Error).name).toBe("HoistingViolationError")
    const e = result as HoistingViolationError
    expect(e.partialId).toBe("cart-widget")
    expect(e.newKey).toBe("url:promo")
    expect(e.previousKeys).toEqual(["cookie:cart"])
    expect(e.message).toContain("cart-widget")
    expect(e.message).toContain("url:promo")
    // Message names both common causes — the original "conditional
    // read" path and the cell-drift case introduced when the
    // manifest scope was lifted from `<Cache>`-only to every Partial.
    expect(e.message).toContain("conditional")
    expect(e.message).toContain("Cell drift")
    expect(e.message).toContain("cache.vary")
  })

  it("does NOT throw on the first render (stored is null)", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: null,
      partialId: "fresh",
    }
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        // Both reads fine — no baseline yet.
        expect(() => getSearchParam("q")).not.toThrow()
        expect(() => getSearchParam("page")).not.toThrow()
      })
    })
    expect([...scope.current].sort()).toEqual(["url:page", "url:q"])
  })

  it("calls onViolation hook AND clears stored before throwing (self-recovery)", async () => {
    let recoveryFired = false
    const scope: ManifestScope = {
      current: new Set(),
      stored: new Set(["cookie:cart"]),
      partialId: "cart-widget",
      onViolation: () => {
        recoveryFired = true
      },
    }
    await runWithRequestAsync(
      fakeRequest("http://localhost/", { cookie: "cart=abc" }),
      async () => {
        await runWithCacheManifest(scope, async () => {
          try {
            getSearchParam("promo")
          } catch {
            // expected
          }
          // After the throw, stored has been nulled out so the next
          // accessor read in the SAME render doesn't keep throwing —
          // just records the new key into current. Without this, a
          // body that reads multiple unhoisted keys would throw on
          // every one and spam the error log.
          expect(scope.stored).toBe(null)
          expect(() => getCookie("session")).not.toThrow()
        })
      },
    )
    expect(recoveryFired).toBe(true)
  })

  it("does NOT re-throw when the same key is read twice", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: new Set(["url:q"]),
      partialId: "dup",
    }
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        expect(() => getSearchParam("q")).not.toThrow()
        expect(() => getSearchParam("q")).not.toThrow()
      })
    })
    expect([...scope.current]).toEqual(["url:q"])
  })
})

describe("matchRoutePattern", () => {
  it("extracts :name segments", () => {
    expect(matchRoutePattern("/p/bulbasaur", "/p/:slug")).toEqual({
      slug: "bulbasaur",
    })
  })

  it("extracts multiple :name segments", () => {
    expect(matchRoutePattern("/shop/bulbasaur/reviews/2", "/shop/:slug/reviews/:page")).toEqual({
      slug: "bulbasaur",
      page: "2",
    })
  })

  it("returns null on segment-count mismatch", () => {
    expect(matchRoutePattern("/p", "/p/:slug")).toBeNull()
    expect(matchRoutePattern("/p/x/y", "/p/:slug")).toBeNull()
  })

  it("returns null on static-segment mismatch", () => {
    expect(matchRoutePattern("/q/bulbasaur", "/p/:slug")).toBeNull()
  })

  it("decodes url-encoded segments", () => {
    expect(matchRoutePattern("/p/hello%20world", "/p/:slug")).toEqual({
      slug: "hello world",
    })
  })

  it("normalizes leading/trailing slashes", () => {
    expect(matchRoutePattern("/p/a/", "/p/:slug")).toEqual({ slug: "a" })
    expect(matchRoutePattern("p/a", "/p/:slug")).toEqual({ slug: "a" })
  })

  it("root path matches root pattern", () => {
    expect(matchRoutePattern("/", "/")).toEqual({})
    expect(matchRoutePattern("/x", "/")).toBeNull()
  })
})

describe("getPathname", () => {
  it("returns matched params from the current pathname", async () => {
    await runWithRequestAsync(new Request("http://localhost/p/bulbasaur"), async () => {
      expect(getPathname("/p/:slug")).toEqual({ slug: "bulbasaur" })
    })
  })

  it("returns null when the pattern doesn't match", async () => {
    await runWithRequestAsync(new Request("http://localhost/other"), async () => {
      expect(getPathname("/p/:slug")).toBeNull()
    })
  })

  it("tracks access with `pathname:<pattern>` manifest key", async () => {
    const scope = freshScope()
    await runWithRequestAsync(new Request("http://localhost/p/bulbasaur"), async () => {
      await runWithCacheManifest(scope, async () => {
        getPathname("/p/:slug")
      })
    })
    expect([...scope.current]).toEqual(["pathname:/p/:slug"])
  })

  it("resolveManifest produces distinct values for different matched params", async () => {
    const manifest = new Set(["pathname:/p/:slug"])

    const v1 = await runWithRequestAsync(new Request("http://localhost/p/bulbasaur"), async () =>
      resolveManifest(manifest),
    )
    const v2 = await runWithRequestAsync(new Request("http://localhost/p/charizard"), async () =>
      resolveManifest(manifest),
    )
    expect(v1.result["pathname:/p/:slug"]).toBe('{"slug":"bulbasaur"}')
    expect(v2.result["pathname:/p/:slug"]).toBe('{"slug":"charizard"}')
    expect(v1.result["pathname:/p/:slug"]).not.toBe(v2.result["pathname:/p/:slug"])
  })

  it("resolveManifest emits empty string on pattern miss", async () => {
    const manifest = new Set(["pathname:/p/:slug"])
    const v = await runWithRequestAsync(new Request("http://localhost/elsewhere"), async () =>
      resolveManifest(manifest),
    )
    expect(v.result["pathname:/p/:slug"]).toBe("")
  })

  it("serializes matched params with sorted keys", async () => {
    const manifest = new Set(["pathname:/a/:y/:x"])
    const v = await runWithRequestAsync(new Request("http://localhost/a/second/first"), async () =>
      resolveManifest(manifest),
    )
    // `x` comes first alphabetically, so the serialized object puts
    // `x` before `y`.
    expect(v.result["pathname:/a/:y/:x"]).toBe('{"x":"first","y":"second"}')
  })
})
