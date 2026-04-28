import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getCachedData,
  setCachedData,
  invalidateByTags,
  clearCache,
  getCacheStats,
} from "../partial-cache.ts"

afterEach(() => {
  clearCache()
})

describe("partial-cache", () => {
  it("returns null for cache miss", () => {
    expect(getCachedData("{ pokemon { name } }")).toBeNull()
  })

  it("stores and retrieves cached data", () => {
    const query = "{ pokemon { name } }"
    const data = { pokemon: { name: "bulbasaur" } }
    setCachedData(query, data, 60)
    expect(getCachedData(query)).toEqual(data)
  })

  it("returns null after TTL expires", () => {
    const query = "{ pokemon { id } }"
    const data = { pokemon: { id: 1 } }

    vi.useFakeTimers()
    setCachedData(query, data, 5) // 5 seconds TTL
    expect(getCachedData(query)).toEqual(data)

    vi.advanceTimersByTime(6000) // 6 seconds
    expect(getCachedData(query)).toBeNull()
    vi.useRealTimers()
  })

  it("returns data within TTL window", () => {
    const query = "{ pokemon { id } }"
    const data = { pokemon: { id: 1 } }

    vi.useFakeTimers()
    setCachedData(query, data, 10)

    vi.advanceTimersByTime(9000) // 9 seconds — still within TTL
    expect(getCachedData(query)).toEqual(data)
    vi.useRealTimers()
  })

  it("overwrites existing entry for same query", () => {
    const query = "{ cart { total } }"
    setCachedData(query, { cart: { total: 10 } }, 60)
    setCachedData(query, { cart: { total: 20 } }, 60)
    expect(getCachedData(query)).toEqual({ cart: { total: 20 } })
  })

  describe("invalidateByTags", () => {
    it("purges entries matching a tag", () => {
      setCachedData("query-a", { a: 1 }, 60, ["cart"])
      setCachedData("query-b", { b: 2 }, 60, ["products"])

      const purged = invalidateByTags(["cart"])
      expect(purged).toBe(1)
      expect(getCachedData("query-a")).toBeNull()
      expect(getCachedData("query-b")).toEqual({ b: 2 })
    })

    it("purges entries matching any of multiple tags", () => {
      setCachedData("query-a", { a: 1 }, 60, ["cart"])
      setCachedData("query-b", { b: 2 }, 60, ["products"])
      setCachedData("query-c", { c: 3 }, 60, ["wishlist"])

      const purged = invalidateByTags(["cart", "products"])
      expect(purged).toBe(2)
      expect(getCachedData("query-a")).toBeNull()
      expect(getCachedData("query-b")).toBeNull()
      expect(getCachedData("query-c")).toEqual({ c: 3 })
    })

    it("purges entry with multiple tags when one matches", () => {
      setCachedData("query-a", { a: 1 }, 60, ["cart", "header"])
      const purged = invalidateByTags(["header"])
      expect(purged).toBe(1)
      expect(getCachedData("query-a")).toBeNull()
    })

    it("returns 0 when no entries match", () => {
      setCachedData("query-a", { a: 1 }, 60, ["cart"])
      const purged = invalidateByTags(["nonexistent"])
      expect(purged).toBe(0)
      expect(getCachedData("query-a")).toEqual({ a: 1 })
    })

    it("returns 0 on empty cache", () => {
      expect(invalidateByTags(["cart"])).toBe(0)
    })
  })

  describe("clearCache", () => {
    it("removes all entries", () => {
      setCachedData("query-a", { a: 1 }, 60)
      setCachedData("query-b", { b: 2 }, 60)
      clearCache()
      expect(getCachedData("query-a")).toBeNull()
      expect(getCachedData("query-b")).toBeNull()
    })
  })

  describe("getCacheStats", () => {
    it("reports correct size", () => {
      expect(getCacheStats().size).toBe(0)
      setCachedData("query-a", { a: 1 }, 60, ["cart"])
      setCachedData("query-b", { b: 2 }, 30)
      const stats = getCacheStats()
      expect(stats.size).toBe(2)
      expect(stats.entries).toHaveLength(2)
    })

    it("includes tags in entries", () => {
      setCachedData("query-a", { a: 1 }, 60, ["cart", "header"])
      const stats = getCacheStats()
      expect(stats.entries[0].tags).toEqual(["cart", "header"])
    })

    it("reports TTL remaining", () => {
      vi.useFakeTimers()
      setCachedData("query-a", { a: 1 }, 60)
      vi.advanceTimersByTime(10000)
      const stats = getCacheStats()
      expect(stats.entries[0].ttlRemaining).toBe(50)
      vi.useRealTimers()
    })

    it("truncates long queries", () => {
      const longQuery = "{ " + "a".repeat(200) + " }"
      setCachedData(longQuery, { a: 1 }, 60)
      const stats = getCacheStats()
      expect(stats.entries[0].query.length).toBeLessThanOrEqual(83) // 80 + "..."
      expect(stats.entries[0].query.endsWith("...")).toBe(true)
    })
  })
})
