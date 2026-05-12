/**
 * Server-side data cache for partials.
 *
 * Caches GraphQL response data keyed by query hash. Each partial
 * can opt in to caching via the `cache` prop (TTL in seconds).
 *
 * The cache key is the compiled query string — this naturally varies
 * by user when the component reads cookies/headers for query arguments
 * (e.g., cart_id). No explicit "vary" needed for the common case.
 *
 * Tag-based invalidation: server actions return { invalidate: { tags: ["cart"] } },
 * which purges all cache entries tagged with "cart". Partials tagged
 * with "cart" are then re-rendered with fresh data.
 *
 * This is the ESI model: compose pages from independently cached
 * fragments, fetch only what's stale.
 *
 * ── Scoping ─────────────────────────────────────────────────────────
 * The cache is scoped per request (`getScope()` — "default" in prod,
 * `x-test-scope` header in dev). Playwright workers > 1 get isolated
 * buckets so their entries don't cross-contaminate.
 */

import { getScope } from "../runtime/context.ts"
import { hash as hashQuery } from "./hash.ts"

interface CacheEntry {
  data: Record<string, unknown>
  query: string
  tags: string[]
  expiresAt: number
}

// CATEGORY C (docs/internals/server-isolation.md) — shared GraphQL response cache.
// Entries keyed by query hash + variables within a scope; safe to share
// across users for anonymous queries, and authenticated queries should
// not end up here.
const scopes = new Map<string, Map<string, CacheEntry>>()

function bucket(scope: string = getScope()): Map<string, CacheEntry> {
  let b = scopes.get(scope)
  if (!b) {
    b = new Map()
    scopes.set(scope, b)
  }
  return b
}

/**
 * Look up cached response data for a query.
 * Returns the data if found and not expired, null otherwise.
 */
export function getCachedData(query: string): Record<string, unknown> | null {
  const key = hashQuery(query)
  const b = bucket()
  const entry = b.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    b.delete(key)
    return null
  }
  return entry.data
}

/**
 * Store response data in the cache.
 * @param query   The compiled GraphQL query (used as cache key)
 * @param data    The response data
 * @param ttl     Time-to-live in seconds
 * @param tags    Invalidation tags for this entry
 */
export function setCachedData(
  query: string,
  data: Record<string, unknown>,
  ttl: number,
  tags: string[] = [],
): void {
  const key = hashQuery(query)
  bucket().set(key, {
    data,
    query,
    tags,
    expiresAt: Date.now() + ttl * 1000,
  })
}

/**
 * Invalidate all cache entries matching any of the given tags within
 * the current request's scope. Called from server actions via
 * entry.rsc.tsx.
 */
export function invalidateByTags(tags: string[]): number {
  const tagSet = new Set(tags)
  let purged = 0
  const b = bucket()
  for (const [key, entry] of b) {
    if (entry.tags.some((t) => tagSet.has(t))) {
      b.delete(key)
      purged++
    }
  }
  return purged
}

/**
 * Clear cache entries. With no argument (or `"all"`), clears every
 * scope — used by HMR dispose hooks. Pass a specific scope to clear
 * just that worker's entries (the `/__test/clear-caches` endpoint
 * does this per-request).
 */
export function clearCache(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    scopes.clear()
    return
  }
  scopes.delete(scope)
}

/** Get cache stats for the current request's scope. Useful for debugging. */
export function getCacheStats(): {
  size: number
  entries: Array<{ query: string; tags: string[]; ttlRemaining: number }>
} {
  const now = Date.now()
  const b = bucket()
  return {
    size: b.size,
    entries: [...b.values()].map((e) => ({
      query: e.query.slice(0, 80) + (e.query.length > 80 ? "..." : ""),
      tags: e.tags,
      ttlRemaining: Math.max(0, Math.round((e.expiresAt - now) / 1000)),
    })),
  }
}
