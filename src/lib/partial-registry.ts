/**
 * Variant-keyed partial registry.
 *
 * Snapshots are deduplicated by structural placement: the same spec
 * mounted under the same parent (same parentPath, parentFrameChain,
 * frameUrl, cmsId) hashes to one variant key, regardless of which
 * route triggered the registration. Concurrent users on the same
 * route register byte-identical snapshots → idempotent overwrite.
 * Users hitting different routes where the same id is mounted under
 * different parents register distinct variants → both coexist.
 *
 * A per-route hint table maps `(route, id) → variantKey` so cache-mode
 * refetches can find the right variant for the current request without
 * paying the per-route snapshot storage cost the previous design did.
 * The hint table is LRU-bounded by route count.
 *
 * The snapshot does NOT capture the spec's `varyResult` — vary is
 * recomputed per-request inside the spec component, and no consumer of
 * the snapshot reads it. Per-user variation (A/B tests, cookie-based
 * personalization) flows through `vary`, not through the registry.
 *
 * Per-request transactional view: pendingWrites + pendingHints +
 * invalidations isolated per ALS context, atomic commit at end of
 * render.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import {
  _deferRegistryCommit,
  _setRegistryCommit,
  getRequest,
  getScope,
} from "../framework/context.ts"
import type { CacheOptions } from "./cache-options.ts"
import { djb2 } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"

export interface PartialSnapshot {
  /** Spec catalog type tag (so cache-mode lookup can find the spec
   *  Component when the effective id was per-instance, e.g. slot
   *  blocks rendered with a cmsId override). */
  type: string
  fallback: ReactNode
  errorWith: ReactNode | undefined
  uniqueTokens: string[]
  sharedTokens: string[]
  cache?: CacheOptions
  /** The spec's own frame chain — equals `parentFrameChain` for
   *  non-frame-opening specs, or `[...parentFrameChain, opts.frame]`
   *  for frame-opening ones. Used for debug + session-frame lookups. */
  framePath: readonly string[]
  /** The parent's frame chain. Cache-mode reconstruction passes this
   *  back in as `parent.frameChain` so the spec component re-derives
   *  `ourFrameChain` correctly regardless of whether it opens a frame. */
  parentFrameChain: readonly string[]
  frameUrl?: string
  parentPath: readonly string[]
  cmsId?: string
}

const HINT_LRU_MAX = 10_000

interface ScopeStore {
  /** id → variantKey → snapshot. Variants are bounded by spec topology
   *  (placement combinations), not by request content — so no LRU. */
  partials: Map<string, Map<string, PartialSnapshot>>
  /** route → id → variantKey. LRU on the outer Map by insertion order;
   *  inner Map bounded by partials-per-page. */
  hints: Map<string, Map<string, string>>
}

const canonical = new Map<string, ScopeStore>()

function scopeStore(scope: string): ScopeStore {
  let s = canonical.get(scope)
  if (!s) {
    s = { partials: new Map(), hints: new Map() }
    canonical.set(scope, s)
  }
  return s
}

function variantKeyOf(snap: PartialSnapshot): string {
  return djb2(
    stableStringify([
      snap.parentPath,
      snap.parentFrameChain,
      snap.frameUrl ?? null,
      snap.cmsId ?? null,
    ]),
  )
}

function touchHint(store: ScopeStore, route: string, hint: Map<string, string>): void {
  store.hints.delete(route)
  store.hints.set(route, hint)
  while (store.hints.size > HINT_LRU_MAX) {
    const oldest = store.hints.keys().next().value
    if (oldest === undefined) break
    store.hints.delete(oldest)
  }
}

// ─── Per-request registry context (ALS) ─────────────────────────────────

export type RegistryMode = "streaming" | "cache"

export interface RequestRegistry {
  scope: string
  route: string
  mode: RegistryMode
  pendingWrites: Map<string, PartialSnapshot>
  pendingHints: Map<string, string>
  invalidations: Set<string>
  committed: boolean
  deferred: boolean
}

const registryAls = new AsyncLocalStorage<RequestRegistry>()

export function enterRequestRegistry(route: string, mode: RegistryMode): RequestRegistry {
  const scope = getScope()
  const ctx: RequestRegistry = {
    scope,
    route,
    mode,
    pendingWrites: new Map(),
    pendingHints: new Map(),
    invalidations: new Set(),
    committed: false,
    deferred: false,
  }
  registryAls.enterWith(ctx)
  _setRegistryCommit(() => commitRequestRegistry(ctx))
  return ctx
}

export function getActiveRegistry(): RequestRegistry | null {
  return registryAls.getStore() ?? null
}

export function deferRequestRegistryCommit(): void {
  const ctx = registryAls.getStore()
  if (ctx) ctx.deferred = true
  _deferRegistryCommit()
}

function activeRoute(ctx: RequestRegistry | undefined): string | undefined {
  if (ctx) return ctx.route
  try {
    return new URL(getRequest().url).pathname
  } catch {
    return undefined
  }
}

// ─── Public registry API ────────────────────────────────────────────────

export function registerPartial(id: string, snapshot: PartialSnapshot): void {
  const variantKey = variantKeyOf(snapshot)
  const ctx = registryAls.getStore()
  if (ctx) {
    ctx.invalidations.delete(id)
    ctx.pendingWrites.set(id, snapshot)
    ctx.pendingHints.set(id, variantKey)
    return
  }
  // No active request context — write straight to canonical (HMR /
  // catalog-prerender path). Hint table is not touched here because
  // there's no route to attribute the registration to.
  const store = scopeStore(getScope())
  let variants = store.partials.get(id)
  if (!variants) {
    variants = new Map()
    store.partials.set(id, variants)
  }
  variants.set(variantKey, snapshot)
}

export function lookupPartial(id: string): PartialSnapshot | undefined {
  const ctx = registryAls.getStore()
  // Check pending state first — a partial registered in this same
  // request must be visible BEFORE the canonical store is consulted,
  // because the canonical store may not yet contain anything for this
  // scope (first request after a clear, etc).
  if (ctx) {
    if (ctx.invalidations.has(id)) return undefined
    const pending = ctx.pendingWrites.get(id)
    if (pending) return pending
  }

  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  if (!store) return undefined

  if (ctx) {
    const pendingVk = ctx.pendingHints.get(id)
    if (pendingVk) {
      const snap = store.partials.get(id)?.get(pendingVk)
      if (snap) return snap
    }
  }

  const route = activeRoute(ctx)
  if (route === undefined) return undefined
  const hint = store.hints.get(route)
  const variantKey = hint?.get(id)
  if (!variantKey) return undefined
  return store.partials.get(id)?.get(variantKey)
}

export function getRouteSnapshots(): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const route = activeRoute(ctx)

  const merged = new Map<string, PartialSnapshot>()
  if (store && route !== undefined) {
    const hint = store.hints.get(route)
    if (hint) {
      for (const [id, vk] of hint) {
        const snap = store.partials.get(id)?.get(vk)
        if (snap) merged.set(id, snap)
      }
    }
  }
  if (ctx) {
    for (const id of ctx.invalidations) merged.delete(id)
    for (const [id, snap] of ctx.pendingWrites) merged.set(id, snap)
  }
  return merged.size > 0 ? merged : undefined
}

/** Snapshots from the previous render — alias for `getRouteSnapshots`,
 *  kept for back-compat with `cache.tsx`. */
export function getPreviousRouteSnapshots(): Map<string, PartialSnapshot> | undefined {
  return getRouteSnapshots()
}

export function invalidateSnapshot(id: string): void {
  const ctx = registryAls.getStore()
  if (ctx) {
    ctx.pendingWrites.delete(id)
    ctx.pendingHints.delete(id)
    ctx.invalidations.add(id)
    return
  }
  const store = canonical.get(getScope())
  if (!store) return
  store.partials.delete(id)
  for (const hint of store.hints.values()) hint.delete(id)
}

export function commitRequestRegistry(ctx: RequestRegistry): void {
  if (ctx.committed) return
  ctx.committed = true
  const store = scopeStore(ctx.scope)

  // Merge pending snapshots into the variant store. Same structural
  // placement → same variant key → idempotent overwrite under
  // concurrent commits.
  for (const [id, snap] of ctx.pendingWrites) {
    if (ctx.invalidations.has(id)) continue
    const variantKey = ctx.pendingHints.get(id)
    if (variantKey === undefined) continue
    let variants = store.partials.get(id)
    if (!variants) {
      variants = new Map()
      store.partials.set(id, variants)
    }
    variants.set(variantKey, snap)
  }

  // Apply id-wide invalidations: drop every variant for the id and
  // every hint pointing at it. Server actions request id-wide
  // invalidation; content has changed across all placements.
  if (ctx.invalidations.size > 0) {
    for (const id of ctx.invalidations) {
      store.partials.delete(id)
    }
    for (const hint of store.hints.values()) {
      for (const id of ctx.invalidations) hint.delete(id)
    }
  }

  if (ctx.mode === "streaming") {
    // Whole-page render: replace the route's hint wholesale. Removes
    // hints for ids no longer on the page.
    touchHint(store, ctx.route, new Map(ctx.pendingHints))
  } else {
    // Cache-mode refetch: patch the hint for ids touched this render.
    const existing = store.hints.get(ctx.route)
    const hint = existing ? new Map(existing) : new Map<string, string>()
    for (const id of ctx.invalidations) hint.delete(id)
    for (const [id, vk] of ctx.pendingHints) hint.set(id, vk)
    touchHint(store, ctx.route, hint)
  }
}

export function clearRegistry(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    canonical.clear()
    return
  }
  canonical.delete(scope)
}

export function _registryStats(): {
  routes: number
  partials: number
  variants: number
  byRoute: Record<string, string[]>
} {
  const store = canonical.get(getScope())
  const byRoute: Record<string, string[]> = {}
  let variants = 0
  if (store) {
    for (const [route, hint] of store.hints) byRoute[route] = [...hint.keys()]
    for (const v of store.partials.values()) variants += v.size
  }
  return {
    routes: store?.hints.size ?? 0,
    partials: store?.partials.size ?? 0,
    variants,
    byRoute,
  }
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry())
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry())
}
