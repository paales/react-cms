/**
 * Variant-keyed partial registry.
 *
 * Snapshots are deduplicated by structural placement: the same spec
 * mounted under the same parent (same parentPath, parentFrameChain,
 * frameUrl, id) hashes to one variant key, regardless of which
 * route triggered the registration. Concurrent users on the same
 * route register byte-identical snapshots → idempotent overwrite.
 * Users hitting different routes where the same id is mounted under
 * different parents register distinct variants → both coexist.
 *
 * A hint table maps `(routeKey, id) → variantKey` so cache-mode
 * refetches can find the right variant for the current request. The
 * routeKey is a hash of which registered URLPatterns match the current
 * URL — NOT the literal pathname — so 50k product URLs that all match
 * `/p/:slug` collapse to a single hint entry, and spam traffic to
 * arbitrary URLs that hit the same pattern can't displace real hot
 * entries. The table is LRU-bounded by routeKey count.
 *
 * The snapshot does NOT capture the spec's `varyResult` — vary is
 * recomputed per-request inside the spec component, and no consumer of
 * the snapshot reads it. Per-user variation (A/B tests, cookie-based
 * personalization) flows through tracked reads, not the registry.
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
} from "../runtime/context.ts"
import type { CacheOptions } from "./cache-options.ts"
import type { WakeHints } from "./current-parton.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"

export interface PartialSnapshot {
  /** Spec catalog type tag (so cache-mode lookup can find the spec
   *  Component when the effective id was per-instance, e.g. slot
   *  blocks rendered with a content-key override). */
  type: string
  fallback: ReactNode
  /** Refetch labels carried by this rendered instance. Selectors are
   *  flat — `reload({selector: "foo"})` hits every snapshot whose
   *  `labels` contains "foo" (or whose id is "foo"). */
  labels: string[]
  cache?: CacheOptions
  /** The frame chain this spec was rendered under — populated from
   *  the `parent.frameChain` flowing in from a `<Frame>` ancestor (or
   *  empty when not framed). Used for session-frame lookups + debug. */
  framePath: readonly string[]
  /** Same as `framePath` after the frame-opening branch on specs was
   *  removed; kept as a separate field for cache-mode reconstruction
   *  (passed back in as `parent.frameChain` when re-rendering). */
  parentFrameChain: readonly string[]
  parentPath: readonly string[]
  /** Call-site JSX props captured during the streaming render. Cache-
   *  mode partial-refetch reads them back so a child spec rendered
   *  via a parent wrapper still receives `flavor={...}` etc. when
   *  the framework re-invokes it without going through the wrapper.
   *
   *  Per-scope (per-user-session) state: concurrent requests from the
   *  same scope with different prop values for the same partial id
   *  could race. For typical single-tab users this is fine; the
   *  proper fix is wiring props through the client so refetches
   *  carry the props they were originally rendered with. */
  props?: Record<string, unknown>
  /** Bound-cell args resolved during this spec's render — captured
   *  from both the `schema` callback (request-derived cell args) and
   *  top-level JSX props (`.with(args)` placements). Merged into the
   *  descendant-fold's constraint surface so partition-scoped
   *  invalidation signals (`cell:<id>?<args>`) can match descendants
   *  via their snapshot, not just via match-params/vary. */
  constraintArgs?: Record<string, unknown>
  /** Hash of the spec's varyResult on its most-recent render —
   *  feeds the descendant-fp fold so an ancestor's fingerprint
   *  reflects every descendant's deps. Without it, a wrapper whose
   *  own JSX is unchanged would fp-skip and starve its descendants
   *  of a re-evaluation, even when their URL/CMS deps just changed. */
  varyKey?: string
  /** Request-dimension dependency keys recorded by tracked hooks
   *  (`cookie()`, `searchParam()`) during this render — e.g.
   *  `"cookie:cart_id"`. The auto-tracked analogue of `varyKey`: the
   *  next render (own fp) and the descendant fold re-read each key's
   *  current value and fold it, so a tracked read moves the fp without
   *  a declaration. The live Set is stored, so reads after the
   *  render's awaits are captured by the time the next render reads it.
   *  Absent/empty for any spec that never calls a tracked hook. */
  deps?: ReadonlySet<string>
  /** Variant key — `hash(stableStringify(matchParams))` for specs
   *  with their own named match params, otherwise the closest match-
   *  bearing ancestor's matchKey, otherwise `ROOT_MATCH_KEY`. Stored
   *  so the fp-trailer's `recomputeFp` doesn't have to re-derive it
   *  from the catalog/URL after the ALS context has unwound. */
  matchKey?: string
  /** `|schema=<hash>` term the spec folded into its own structural fp
   *  on this render — the resolved-cell surface (`cellId:partition:value`
   *  for each cell read in `schema` or via cell-bearing props). It can't
   *  be recomputed at flush (that would mean re-resolving cells from
   *  storage), so it's snapshotted here for the fp-trailer's `recomputeFp`
   *  to fold back in. Empty/absent for any spec that resolves no cells. */
  schemaKey?: string
  /** The full fingerprint the spec emitted in this render — the value
   *  baked into the `<PartialErrorBoundary>`'s `partialFingerprint`
   *  prop that the client registered. Used by the fp-trailer flush
   *  step: at end-of-render we recompute the fp with the now-populated
   *  descendant fold; if it differs from `emittedFp`, we ship both old
   *  and new fps to the client so the next visit fp-skips against the
   *  warm value rather than mismatching against the cold one. */
  emittedFp?: string
  /** Origin annotation for selector-targeted refetch routing.
   *
   *  Default (`undefined`) — the snapshot was registered by a
   *  local render; `partialFromSnapshot` looks up the spec
   *  Component in the local catalog and re-renders.
   *
   *  `{ kind: "remote", origin, capability? }` — the snapshot was
   *  registered by `<RemoteFrame>` from a remote endpoint's
   *  trailer. `partialFromSnapshot` returns a fresh `<RemoteFrame>`
   *  pointed at `<origin>/__remote/<id>` (carrying the original
   *  capability), so refetch routes back to the remote rather
   *  than rendering locally. Server-only field; not serialized
   *  over the wire (the host stamps it when consuming a remote's
   *  trailer). */
  source?: SnapshotSource
  /** Live wake-hint box written by the `expires()` / `staleUntil()`
   *  hooks during this render. Render-body writes land AFTER the
   *  boundary registered this snapshot, so wake consumers read through
   *  `effectiveExpiresAt` / `effectiveStaleUntil` at arm/decision
   *  time. Two consumers: the segment driver (races against
   *  `min(expiresAt)` across route snapshots so live connections wake
   *  on time) and the fp-skip TTL gate (a snapshot past its boundary
   *  is never served from the client's cache). On a pass where Render
   *  didn't run (fp-skip, defer), the boundary threads the PRIOR
   *  snapshot's box through, so a hook-declared wake survives the
   *  skip. Absent boundary → no time-based wake; fp moves only via
   *  `refreshSelector` (CRUD path). */
  wakeHints?: WakeHints
}

/** This snapshot's freshness boundary — the live box `expires()` wrote
 *  during the render. Absent → no time-based wake. */
export function effectiveExpiresAt(snap: PartialSnapshot): number | undefined {
  return snap.wakeHints?.expiresAt
}

/** This snapshot's stale-while-revalidate boundary — the live box
 *  `staleUntil()` wrote. See `effectiveExpiresAt`. */
export function effectiveStaleUntil(snap: PartialSnapshot): number | undefined {
  return snap.wakeHints?.staleUntil
}

/** Per-snapshot origin annotation. See `PartialSnapshot.source`. */
export type SnapshotSource = {
  kind: "remote"
  origin: string
  capability?: Record<string, unknown>
  /** Bare spec id at the remote endpoint. The host may register the
   *  snapshot under a namespaced id (`magento:stocks`) for selector
   *  hygiene + collision-avoidance, but the refetch URL needs the
   *  remote's own id (`stocks`). Stored separately so
   *  `partialFromSnapshot` can rebuild the right URL. */
  remoteId: string
}

const HINT_LRU_MAX = 10_000

interface ScopeStore {
  /** id → variantKey → snapshot. Variants are bounded by spec topology
   *  (placement combinations), not by request content — so no LRU. */
  partials: Map<string, Map<string, PartialSnapshot>>
  /** routeKey → id → variantKey. LRU on the outer Map by insertion
   *  order; inner Map bounded by partials-per-page. */
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
  return hash(stableStringify([snap.parentPath, snap.parentFrameChain]))
}

function touchHint(store: ScopeStore, routeKey: string, hint: Map<string, string>): void {
  store.hints.delete(routeKey)
  store.hints.set(routeKey, hint)
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
  /** Pattern-signature key for the current request — NOT the literal
   *  pathname. See `computeRouteKey` in `partial.tsx`. */
  routeKey: string
  mode: RegistryMode
  pendingWrites: Map<string, PartialSnapshot>
  pendingHints: Map<string, string>
  invalidations: Set<string>
  committed: boolean
  deferred: boolean
  /** Promises the commit must wait for. `<RemoteFrame>` registers
   *  one here that resolves when the remote's snapshot trailer has
   *  arrived and its snapshots have been written to this registry.
   *  Stream wrappers `Promise.allSettled` this list before firing
   *  commit, so the canonical hint table sees the remote's snapshots
   *  before client-side selector refetch can hit a registry miss. */
  pendingDefers: Promise<unknown>[]
  /** Memoized descendant-fold base — the canonical hint snapshots for
   *  the route with invalidations applied, built once per pass by
   *  `getFoldBaseSnapshots`. Keyed by the canonical store identity +
   *  routeKey so a re-enter under a different store/route rebuilds it.
   *  See `getFoldBaseSnapshots` for why the overlay is deliberately
   *  excluded. */
  _foldBase?: {
    store: ScopeStore | undefined
    routeKey: string | undefined
    map: Map<string, PartialSnapshot>
  }
  /** Per-pass descendant-fold scratch owned by `partial.tsx`: the
   *  ancestor→descendants index and the per-descendant contribution
   *  memo. Opaque here (an arbitrary object the fold sets and reads) so
   *  it lives and dies with the pass without coupling the registry to
   *  the fold's internals. */
  foldScratch?: unknown
}

const registryAls = new AsyncLocalStorage<RequestRegistry>()

export function enterRequestRegistry(routeKey: string, mode: RegistryMode): RequestRegistry {
  const scope = getScope()
  const ctx: RequestRegistry = {
    scope,
    routeKey,
    mode,
    pendingWrites: new Map(),
    pendingHints: new Map(),
    invalidations: new Set(),
    committed: false,
    deferred: false,
    pendingDefers: [],
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

/**
 * Add a promise to the current request's commit-defer list. The
 * stream-wrapping helpers that fire `commitRequestRegistry` await
 * `Promise.allSettled` of this list first, so the snapshot writes the
 * promise's resolver performs are already in `pendingWrites` /
 * `pendingHints` when commit runs. Used by `<RemoteFrame>` to hold
 * commit open until the remote's snapshot trailer has been parsed
 * and registered — without this the trailer's `.then` callback can
 * fire after commit and the route-hint write is lost.
 *
 * No-op outside a request registry context. Multiple deferrers
 * compose: the wrapper waits for all of them.
 */
export function deferCommitUntil(promise: Promise<unknown>): void {
  const ctx = registryAls.getStore()
  if (!ctx) return
  ctx.pendingDefers.push(promise)
}

/**
 * Snapshot + clear the current request's pending defers. The stream
 * wrappers call this from their flush callback so each commit fires
 * once, with the full set of promises that were registered by the
 * time the stream ended.
 */
export function _drainPendingDefers(): Promise<unknown>[] {
  const ctx = registryAls.getStore()
  if (!ctx) return []
  const drained = ctx.pendingDefers
  ctx.pendingDefers = []
  return drained
}

/**
 * Best-effort routeKey accessor. In normal request flow `ctx` is always
 * set by `enterRequestRegistry` before any read happens, so this hits
 * the first branch. The pathname fallback is for edge cases (HMR-time
 * registrations, catalog prerender) that shouldn't be doing lookups
 * anyway — it returns a string that won't match any committed routeKey,
 * so lookups fall through to streaming-mode. Same effect as today.
 */
function activeRouteKey(ctx: RequestRegistry | undefined): string | undefined {
  if (ctx) return ctx.routeKey
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

    // Eagerly publish to the canonical store so a CONCURRENT request
    // can see this partial before our commit fires. Without this, an
    // activator-driven refetch that lands while the initial page's
    // RSC stream is still flushing falls into `registryMiss` territory
    // and the server returns a streaming-mode (full-render) response
    // instead of resolving the targeted partial from its snapshot — the
    // activation doesn't land and the fallback persists in the DOM. The
    // atomic-prune at commit time
    // (in `commitRequestRegistry`) still owns the FINAL hint shape;
    // the eager publish is purely additive ("this id is live for this
    // routeKey, with this variantKey") so concurrent reads succeed.
    const store = scopeStore(ctx.scope)
    let variants = store.partials.get(id)
    if (!variants) {
      variants = new Map()
      store.partials.set(id, variants)
    }
    variants.set(variantKey, snapshot)
    const existing = store.hints.get(ctx.routeKey)
    if (existing) {
      existing.set(id, variantKey)
      // Re-touch so the LRU keeps this routeKey hot.
      store.hints.delete(ctx.routeKey)
      store.hints.set(ctx.routeKey, existing)
    } else {
      const hint = new Map<string, string>([[id, variantKey]])
      touchHint(store, ctx.routeKey, hint)
    }
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

  const routeKey = activeRouteKey(ctx)
  if (routeKey === undefined) return undefined
  const hint = store.hints.get(routeKey)
  const variantKey = hint?.get(id)
  if (!variantKey) return undefined
  return store.partials.get(id)?.get(variantKey)
}

/**
 * Committed tracked-read evidence for a spec id, across EVERY variant
 * in the scope's canonical store (all routes):
 *
 *   - `"unknown"` — no committed variant anywhere (cold process, or the
 *     id has never rendered). The spec's read set is unknowable.
 *   - `"deps"`    — some committed variant recorded tracked reads. The
 *     spec's fp is only trustworthy when computed against a dep record.
 *   - `"depless"` — every committed variant recorded an EMPTY read set.
 *     Under the tracking invariant (reads are conditioned only on
 *     tracked inputs), an empty read set is a fixed point — no tracked
 *     input exists that could make a future render start reading — so
 *     a dep-less fp for this spec is complete evidence.
 *
 * Consumed by the fp-skip cold-record gate in partial.tsx: a spec
 * may only skip against a dep-less fp when
 * the evidence says `"depless"`.
 */
export function committedDepsEvidence(id: string): "unknown" | "depless" | "deps" {
  const ctx = registryAls.getStore()
  const scope = ctx?.scope ?? getScope()
  const variants = canonical.get(scope)?.partials.get(id)
  if (!variants || variants.size === 0) return "unknown"
  for (const snap of variants.values()) {
    if (snap.deps && snap.deps.size > 0) return "deps"
  }
  return "depless"
}

function buildHintSnapshots(
  store: ScopeStore | undefined,
  routeKey: string | undefined,
): Map<string, PartialSnapshot> {
  const merged = new Map<string, PartialSnapshot>()
  if (store && routeKey !== undefined) {
    const hint = store.hints.get(routeKey)
    if (hint) {
      for (const [id, vk] of hint) {
        const snap = store.partials.get(id)?.get(vk)
        if (snap) merged.set(id, snap)
      }
    }
  }
  return merged
}

export function getRouteSnapshots(): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const routeKey = activeRouteKey(ctx)

  const merged = buildHintSnapshots(store, routeKey)
  if (ctx) {
    for (const id of ctx.invalidations) merged.delete(id)
    for (const [id, snap] of ctx.pendingWrites) merged.set(id, snap)
  }
  return merged.size > 0 ? merged : undefined
}

/**
 * The descendant-fold base: the canonical hint snapshots for the
 * current route with this request's id-wide invalidations removed.
 * It carries NO `pendingWrites` overlay — and that omission is exactly
 * what makes it the right base for `computeDescendantFold`.
 *
 * React renders top-down, so every ancestor computes its fold BEFORE
 * any of its this-pass descendants register into `pendingWrites`. An
 * ancestor's fold therefore only ever reads its descendants from the
 * prior commit (the canonical hints) — a descendant's re-registration
 * this pass is invisible to it. Folding the overlay in would be a
 * no-op for descendant lookups and only risks divergence, so the base
 * stays canonical-only.
 *
 * The canonical store object is immutable within a request (writes
 * buffer into `pendingWrites`/`invalidations` and commit at request
 * exit), and `invalidations` is not mutated during the live render
 * path, so the base is stable for the whole pass. It's memoized on the
 * ctx keyed by the canonical store identity + routeKey; a re-enter
 * with a different store/route rebuilds it.
 */
export function getFoldBaseSnapshots(): Map<string, PartialSnapshot> {
  const ctx = registryAls.getStore()
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const routeKey = activeRouteKey(ctx)

  if (ctx) {
    const cached = ctx._foldBase
    if (cached && cached.store === store && cached.routeKey === routeKey) {
      return cached.map
    }
  }

  const merged = buildHintSnapshots(store, routeKey)
  if (ctx) for (const id of ctx.invalidations) merged.delete(id)

  if (ctx) ctx._foldBase = { store, routeKey, map: merged }
  return merged
}

/**
 * Read the canonical snapshot set for a given (scope, routeKey)
 * without depending on the registry ALS. Used by the fp-trailer
 * flush hook in `lib/fp-trailer.ts` — flush fires after the
 * request's ALS contexts have unwound, but the scope + URL captured
 * at wrap time are enough to locate the same snapshot set the
 * commit just wrote.
 */
export function _readSnapshotsForRoute(
  scope: string,
  routeKey: string,
): Map<string, PartialSnapshot> {
  const store = canonical.get(scope)
  if (!store) return new Map()
  const hint = store.hints.get(routeKey)
  if (!hint) return new Map()
  const snapshots = new Map<string, PartialSnapshot>()
  for (const [id, vk] of hint) {
    const snap = store.partials.get(id)?.get(vk)
    if (snap) snapshots.set(id, snap)
  }
  return snapshots
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

  // Both streaming and cache-mode commits MERGE pendingHints into the
  // existing routeKey hint. Wholesale replace looks tempting for the
  // streaming-mode case (where the whole page just rendered, so the
  // pendingHints are an authoritative snapshot of what's on the page),
  // but it breaks the fp-skip cascade: when an ancestor spec fp-skips,
  // the skip path's `<PartialBoundary>` registers the ancestor BUT the
  // body never runs, so descendants never get a chance to register.
  // Their entries from the prior commit are then absent from
  // pendingHints — and replace would wipe them. The next request reads
  // an eroded canonical (missing the descendants of any fp-skipped
  // ancestor), `computeDescendantFold` returns a partial value, the
  // ancestor's fp drifts away from what the trailer shipped, and
  // shouldSkip starts mis-firing further up the tree. Merging keeps
  // the prior commit's descendant entries alive as long as the
  // ancestor stays on the page.
  //
  // Stale entries that legitimately need removal (a CMS edit drops a
  // block from a slot, a partial's match no longer fires for any URL
  // on this route) flow through `ctx.invalidations` and are pruned by
  // the loop above.
  const existing = store.hints.get(ctx.routeKey)
  const hint = existing ? new Map(existing) : new Map<string, string>()
  for (const id of ctx.invalidations) hint.delete(id)
  for (const [id, vk] of ctx.pendingHints) hint.set(id, vk)
  touchHint(store, ctx.routeKey, hint)
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
    for (const [routeKey, hint] of store.hints) byRoute[routeKey] = [...hint.keys()]
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
  // ONLY clear on a true full reload — `vite:beforeUpdate` fires for
  // every incremental HMR (any imported module changing, including
  // unrelated stylesheets and other test-worker activity), and
  // wiping every scope's registry on each one creates cross-test
  // pollution under parallel `yarn test:e2e`. Stale snapshots after
  // an HMR self-heal on the next render — their effective ids and
  // fingerprints are recomputed, and the variant store overwrites
  // idempotently.
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry())
}
