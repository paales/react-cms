/**
 * Tests for the block catalog prerender. Uses a fabricated block
 * registry so we don't depend on the app's real catalog.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _clearBlockRegistry, registerBlock } from "../cms-runtime.ts"
import { getText, getEnum, getNumber, getReference } from "../context.ts"
import {
  _invalidateCatalogManifest,
  buildCatalogManifest,
  getCatalogManifest,
  prerenderBlock,
} from "../cms-prerender.ts"

beforeEach(() => {
  _clearBlockRegistry()
  _invalidateCatalogManifest()
})

afterEach(() => {
  _clearBlockRegistry()
  _invalidateCatalogManifest()
})

describe("prerenderBlock", () => {
  it("returns null for an unregistered type", async () => {
    expect(await prerenderBlock("nope")).toBeNull()
  })

  it("captures content-field reads that fire at the top of a sync block", async () => {
    registerBlock("hero", {
      tags: [".hero"],
      component: () => {
        getText("headline")
        getText("subhead")
        getEnum("tone", ["calm", "loud"] as const)
        getNumber("count")
        return null
      },
    })
    const manifest = await prerenderBlock("hero")
    expect(manifest).not.toBeNull()
    expect(manifest?.tags).toEqual([".hero"])
    expect(manifest?.contentFields).toEqual({
      headline: "text",
      subhead: "text",
      tone: "enum",
      count: "number",
    })
  })

  it("captures reference declarations", async () => {
    registerBlock("showcase", {
      tags: [".showcase"],
      component: () => {
        getReference("featured", "product")
        getReference("also", "collection")
        return null
      },
    })
    const manifest = await prerenderBlock("showcase")
    expect(manifest?.references).toEqual({
      featured: "product",
      also: "collection",
    })
  })

  it("survives a block that throws synchronously", async () => {
    registerBlock("broken", {
      tags: [".broken"],
      component: () => {
        getText("before")
        throw new Error("kaboom")
      },
    })
    const manifest = await prerenderBlock("broken")
    expect(manifest).not.toBeNull()
    // The accessor that fired before the throw still landed in the
    // manifest; the throw itself was swallowed.
    expect(manifest?.contentFields).toEqual({ before: "text" })
  })

  it("captures pre-await reads on an async block", async () => {
    registerBlock("async-block", {
      tags: [".async"],
      component: async () => {
        getText("syncField")
        await Promise.resolve()
        getText("postAwaitField")
        return null
      },
    })
    const manifest = await prerenderBlock("async-block")
    // Both reads happened in a successful run (we await the promise).
    expect(manifest?.contentFields).toEqual({
      syncField: "text",
      postAwaitField: "text",
    })
  })
})

describe("buildCatalogManifest", () => {
  it("returns an entry per registered block", async () => {
    registerBlock("a", {
      tags: [".a"],
      component: () => {
        getText("headline")
        return null
      },
    })
    registerBlock("b", {
      tags: [".b"],
      component: () => {
        getNumber("count")
        return null
      },
    })
    const catalog = await buildCatalogManifest()
    expect(Object.keys(catalog).sort()).toEqual(["a", "b"])
    expect(catalog.a.contentFields).toEqual({ headline: "text" })
    expect(catalog.b.contentFields).toEqual({ count: "number" })
  })

  it("getCatalogManifest caches across calls", async () => {
    registerBlock("cached", {
      tags: [".cached"],
      component: () => {
        getText("h")
        return null
      },
    })
    const first = await getCatalogManifest()
    const second = await getCatalogManifest()
    // Same object reference — cached promise.
    expect(first).toBe(second)
  })

  it("_invalidateCatalogManifest forces a rebuild on the next call", async () => {
    registerBlock("x", {
      tags: [".x"],
      component: () => {
        getText("h")
        return null
      },
    })
    const first = await getCatalogManifest()
    _invalidateCatalogManifest()
    const second = await getCatalogManifest()
    expect(second).not.toBe(first)
    expect(second.x.contentFields).toEqual({ h: "text" })
  })
})
