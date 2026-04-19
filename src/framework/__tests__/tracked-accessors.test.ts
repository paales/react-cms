/**
 * Tests for the tracked-accessor surface: getCookie / getHeader /
 * getSearchParam / getPathname populate a cache access manifest, and
 * adding a previously-unseen key while a stored manifest is active
 * throws a HoistingViolationError.
 *
 * These exercise `src/framework/context.ts` directly without going
 * through `<Cache>` — the accessor contract is independent of the
 * Cache component that consumes it.
 */
import { describe, expect, it } from "vitest";
import {
  HoistingViolationError,
  getCookie,
  getHeader,
  getPathname,
  getSearchParam,
  runWithCacheManifest,
  runWithRequestAsync,
  type ManifestScope,
} from "../context.ts";

function fakeRequest(
  url = "http://localhost/test?q=pika&page=2",
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

function freshScope(partialId = "test"): ManifestScope {
  return { current: new Set(), stored: null, partialId };
}

describe("tracked accessors", () => {
  it("no-ops when no manifest scope is open", async () => {
    await runWithRequestAsync(fakeRequest(), async () => {
      // No runWithCacheManifest wrapping — the call should still
      // return the value, just without tracking.
      expect(getSearchParam("q")).toBe("pika");
    });
  });

  it("populates manifest with url: keys on getSearchParam", async () => {
    const scope = freshScope();
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        expect(getSearchParam("q")).toBe("pika");
        expect(getSearchParam("page")).toBe("2");
      });
    });
    expect([...scope.current].sort()).toEqual(["url:page", "url:q"]);
  });

  it("populates manifest with cookie: keys on getCookie", async () => {
    const scope = freshScope();
    await runWithRequestAsync(
      fakeRequest("http://localhost/", { cookie: "cart=abc; tenant=foo" }),
      async () => {
        await runWithCacheManifest(scope, async () => {
          expect(getCookie("cart")).toBe("abc");
          expect(getCookie("tenant")).toBe("foo");
        });
      },
    );
    expect([...scope.current].sort()).toEqual([
      "cookie:cart",
      "cookie:tenant",
    ]);
  });

  it("populates manifest with header: keys on getHeader (lowercased)", async () => {
    const scope = freshScope();
    await runWithRequestAsync(
      fakeRequest("http://localhost/", { "X-Region": "eu" }),
      async () => {
        await runWithCacheManifest(scope, async () => {
          expect(getHeader("X-Region")).toBe("eu");
        });
      },
    );
    expect([...scope.current]).toEqual(["header:x-region"]);
  });

  it("populates manifest with url:_pathname on getPathname", async () => {
    const scope = freshScope();
    await runWithRequestAsync(
      fakeRequest("http://localhost/products/abc"),
      async () => {
        await runWithCacheManifest(scope, async () => {
          expect(getPathname()).toBe("/products/abc");
        });
      },
    );
    expect([...scope.current]).toEqual(["url:_pathname"]);
  });

  it("nested runWithCacheManifest attributes reads to the inner scope", async () => {
    const outer = freshScope("outer");
    const inner = freshScope("inner");
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(outer, async () => {
        getSearchParam("q");
        await runWithCacheManifest(inner, async () => {
          getSearchParam("page");
        });
        // reads after the inner scope returns go back into outer
        getCookie("foo");
      });
    });
    expect([...outer.current].sort()).toEqual(["cookie:foo", "url:q"]);
    expect([...inner.current]).toEqual(["url:page"]);
  });
});

describe("hoisting violation", () => {
  it("throws when a render accesses a key not in the stored manifest", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: new Set(["cookie:cart"]),
      partialId: "cart-widget",
    };
    const { result } = await runWithRequestAsync(
      fakeRequest("http://localhost/", { cookie: "cart=abc" }),
      async () => {
        return await runWithCacheManifest(scope, async () => {
          getCookie("cart"); // allowed — in stored
          try {
            getSearchParam("promo"); // NOT in stored → throw
            return null;
          } catch (e) {
            return e as HoistingViolationError;
          }
        });
      },
    );
    expect(result).toBeTruthy();
    expect((result as Error).name).toBe("HoistingViolationError");
    const e = result as HoistingViolationError;
    expect(e.partialId).toBe("cart-widget");
    expect(e.newKey).toBe("url:promo");
    expect(e.previousKeys).toEqual(["cookie:cart"]);
    expect(e.message).toContain("cart-widget");
    expect(e.message).toContain("url:promo");
    expect(e.message).toContain("unconditionally");
    expect(e.message).toContain("cache.vary");
  });

  it("does NOT throw on the first render (stored is null)", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: null,
      partialId: "fresh",
    };
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        // Both reads fine — no baseline yet.
        expect(() => getSearchParam("q")).not.toThrow();
        expect(() => getSearchParam("page")).not.toThrow();
      });
    });
    expect([...scope.current].sort()).toEqual(["url:page", "url:q"]);
  });

  it("does NOT re-throw when the same key is read twice", async () => {
    const scope: ManifestScope = {
      current: new Set(),
      stored: new Set(["url:q"]),
      partialId: "dup",
    };
    await runWithRequestAsync(fakeRequest(), async () => {
      await runWithCacheManifest(scope, async () => {
        expect(() => getSearchParam("q")).not.toThrow();
        expect(() => getSearchParam("q")).not.toThrow();
      });
    });
    expect([...scope.current]).toEqual(["url:q"]);
  });
});
