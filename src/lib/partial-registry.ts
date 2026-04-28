/**
 * Route-scoped Partial snapshot registry.
 *
 * Two-layer model:
 *
 *   - **Canonical tree** (module-global, mutated only by atomic
 *     `commitRequestRegistry` calls). Source of truth for what
 *     Partials have ever rendered on a given route. Cache-mode
 *     refetches and the editor tree pane read from it.
 *   - **Per-request view** (ALS-isolated, opened by `<PartialRoot>`).
 *     Holds a frozen `previousView` snapshot of the canonical tree
 *     taken at request entry, plus a `pendingWrites` buffer for
 *     this render's registrations. On commit, pendingWrites merge
 *     into canonical based on the request's mode.
 *
 * Why per-request: with two concurrent requests on the same route,
 * mutating one shared map made "previous" reads observe in-flight
 * writes from the other request. The shared manifest sets aliased
 * across requests, which races against accessor mutations and
 * fingerprint compares against an empty (or wrong) stored manifest.
 * Per-request isolation gives each request a point-in-time view to
 * compare against, regardless of what other requests are doing.
 *
 * Two commit modes:
 *
 *   - **streaming** — pendingWrites *replace* canonical[route]. The
 *     full tree was just rendered; ids that didn't re-register are
 *     stale and should disappear. Subsumes the old `clearRoute`.
 *   - **cache** — pendingWrites *overlay* canonical[route]. Only some
 *     ids re-rendered (the explicitly-requested ones); preserve the
 *     rest.
 *
 * Commit timing: `entry.rsc.tsx` wraps the response stream so the
 * commit fires when the stream is fully consumed (i.e. after every
 * `<PartialBoundary>` registration has fired). `runWithRequestAsync`
 * provides a fallback auto-commit for callers that finish synchronous
 * rendering without producing a stream (test fixtures).
 *
 * ── Scoping ─────────────────────────────────────────────────────────
 * Keyed by `getScope()` — Playwright workers > 1 get isolated route
 * maps so snapshots registered by worker A don't resolve for worker
 * B. Production uses the default scope for every request.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import { _deferRegistryCommit, _setRegistryCommit, getScope } from "../framework/context.ts"
import type { CacheOptions } from "./cache-options.ts"

export interface PartialSnapshot {
  /** Content JSX as it appeared inside `<Partial>` at capture time. */
  content: ReactNode
  /** The fallback prop on the Partial (for Suspense wrapping). */
  fallback: ReactNode
  /** The errorWith prop on the Partial (for ErrorBoundary fallback). */
  errorWith: ReactNode | undefined
  /** `#`-token names from the Partial's selector (without the `#` prefix).
   *  Used to resolve `?partials=X` refetches against dynamic Partials
   *  that the bootstrap walk can't see. A Partial's effective id is
   *  derived from these (single token → that name; multiple → sorted-join). */
  uniqueTokens: string[]
  /** `.`-token names from the Partial's selector (without the `.` prefix).
   *  Used to resolve `?tags=X` refetches with union semantics. */
  sharedTokens: string[]
  /** Cache options if the Partial declared `cache={…}`. Stored so
   *  cache-mode refetches re-apply the same cache semantics. */
  cache?: CacheOptions
  /** Canonical frame path if the Partial declared `frame="…"` — the
   *  dotted join of every enclosing `frame` ancestor plus this local
   *  name. Two `<Partial frame="list">`s under different parent
   *  frames thus resolve to distinct paths (`"products.list"` vs
   *  `"blog.list"`), which the session store, navigation state, and
   *  `?__frame=` wire param all key off. Empty array means the
   *  Partial doesn't open a frame. */
  framePath: readonly string[]
  /** The author-provided `frameUrl` fallback. Session overrides it
   *  when present; kept here as the cold-session default. */
  frameUrl?: string
  /** Outer-first chain of ancestor partial ids, captured from the
   *  Partial's `parent` prop. `[]` for top-level Partials. Lets
   *  server-side logic reason about the full hierarchy (nested
   *  frames, selector scoping, invalidation cascades) without the
   *  client-side tree reconstruction that was necessary while the
   *  hierarchy could only be inferred post-render. */
  parentPath: readonly string[]
  /** Stable storage key for CMS-authored content, from the Partial's
   *  `cmsId` prop. Preserved in the snapshot so cache-mode refetches
   *  re-open the same CMS scope when rendering from this snapshot.
   *  Absent on Partials that aren't CMS-aware. */
  cmsId?: string
  /** Auto-collected manifest of tracked-accessor reads the Partial's
   *  body + descendants performed during the previous render. Each
   *  entry is `"<kind>:<name>"` (e.g. `"url:config"`, `"cookie:user"`,
   *  `"pathname:/p/:slug"`). Resolved against the current request
   *  on the NEXT render and folded into the structural fingerprint —
   *  same shape `<Cache>` uses for its key, lifted up so non-cached
   *  Partials get the same auto-invalidation contract.
   *
   *  In `pendingWrites` (the request-scoped buffer) the field may
   *  alias the rendering Partial's live `manifestScope.current` Set
   *  — that's safe because pendingWrites is only ever read by the
   *  request that wrote it, and only AFTER the registering body's
   *  descendants have completed. At commit time, manifests are
   *  copied by value into canonical so other requests' subsequent
   *  `previousView` snapshots see immutable Sets. */
  manifest?: ReadonlySet<string>
}

type RouteMap = Map<string, PartialSnapshot>

// ─── Canonical tree (module-global) ────────────────────────────────────
//
// CATEGORY C (docs-dev/server-isolation.md). Outer key is the per-request
// `scope`. Two parallel inner maps:
//
//   - `live`: state including this scope/route's most recent commit
//     (streaming or cache). What `lookupPartial` /
//     `getRouteSnapshots` resolve through. Cache-mode commits overlay
//     here without disturbing the baseline.
//   - `baseline`: snapshot of `live` taken AT a streaming commit,
//     before the new streaming render replaces it. What request
//     bodies see as `manifestScope.stored` and what
//     `getPreviousRouteSnapshots` returns.
//
// Why two: cache-mode bodies' hoisting check needs to compare against
// a manifest that "doesn't move" mid-flight as concurrent cache
// renders accumulate keys. Master's `previousScopes` (only updated by
// streaming-render `clearRoute`) had this property by accident; we
// preserve it deliberately so a Partial whose `<SearchArea>`-style
// dependency-after-conditional pattern stayed accidentally-correct
// on master keeps working on the per-request-isolated registry.
//
// The strictness improvement (cache-mode also enforces the full
// manifest discovered by prior cache renders) is left for a follow-
// up — turning it on requires auditing every `<Partial>` body for
// the conditional-read-after-early-return idiom.
//
// Mutated ONLY by `commitRequestRegistry` — every other path either
// reads via the per-request view or registers into pendingWrites.
interface RouteState {
  live: RouteMap
  baseline: RouteMap
}
const canonical = new Map<string, Map<string, RouteState>>()

const EMPTY_VIEW: ReadonlyMap<string, PartialSnapshot> = new Map()

function canonicalRouteState(scope: string, route: string): RouteState {
  let routes = canonical.get(scope)
  if (!routes) {
    routes = new Map()
    canonical.set(scope, routes)
  }
  let state = routes.get(route)
  if (!state) {
    state = { live: new Map(), baseline: new Map() }
    routes.set(route, state)
  }
  return state
}

function snapshotBaseline(scope: string, route: string): ReadonlyMap<string, PartialSnapshot> {
  const state = canonical.get(scope)?.get(route)
  if (!state || state.baseline.size === 0) return EMPTY_VIEW
  // Shallow-copy so subsequent commits (concurrent requests) don't
  // disturb this view. Snapshot manifests are immutable post-commit
  // via `freezeManifest`, so reference-sharing the inner snapshots
  // is safe.
  return new Map(state.baseline)
}

// ─── Per-request registry context (ALS) ─────────────────────────────────

export type RegistryMode = "streaming" | "cache"

export interface RequestRegistry {
  scope: string
  /** Pathname this context is bound to. Set by `<PartialRoot>` when
   *  it opens the context. */
  route: string
  /** Streaming or cache mode. Decides commit semantics. */
  mode: RegistryMode
  /** Frozen view of `canonical[scope][route]` at context entry.
   *  Reads are stable for the duration of this request even if other
   *  requests commit in the meantime. */
  previousView: ReadonlyMap<string, PartialSnapshot>
  /** Snapshots written during this render. Each may alias a live
   *  `manifestScope.current` Set; the commit step copies them by
   *  value before transferring to canonical. */
  pendingWrites: Map<string, PartialSnapshot>
  /** Ids that this request invalidated (typically via the manifest
   *  scope's `onViolation` self-recovery hook). Excluded from
   *  canonical at commit. */
  invalidations: Set<string>
  /** Set true once `commitRequestRegistry` has run. Subsequent calls
   *  no-op. */
  committed: boolean
  /** Set by callers (entry.rsc.tsx's stream wrapper) that take
   *  ownership of when to commit — `runWithRequestAsync`'s fallback
   *  auto-commit honors this flag and stays out of the way. */
  deferred: boolean
}

const registryAls = new AsyncLocalStorage<RequestRegistry>()

/**
 * Open a request-scoped registry context bound to `route` in `mode`.
 * Called by `<PartialRoot>` once it has resolved the request.
 *
 * Uses `enterWith` (not `run`) so React's rendering of the returned
 * tree — happening in the caller's continuation, outside any single
 * `run`'s scope — inherits the context.
 *
 * Returns the context object so the caller can pass it to
 * `commitRequestRegistry` later (e.g. from a stream-flush hook).
 */
export function enterRequestRegistry(route: string, mode: RegistryMode): RequestRegistry {
  const scope = getScope()
  if (mode === "streaming") {
    // Rotate baseline := snapshot of current live AT this entry —
    // the equivalent of master's `clearRoute(route)` moving current
    // into previous before a new streaming render begins. Cache-mode
    // entries skip this; their bodies should still see the older
    // streaming baseline (the one that survived the conditional-
    // read-after-early-return idiom on master).
    const state = canonicalRouteState(scope, route)
    state.baseline = new Map(state.live)
  }
  const ctx: RequestRegistry = {
    scope,
    route,
    mode,
    previousView: snapshotBaseline(scope, route),
    pendingWrites: new Map(),
    invalidations: new Set(),
    committed: false,
    deferred: false,
  }
  registryAls.enterWith(ctx)
  // Register the commit callback on the request store so
  // `runWithRequestAsync` fires it on exit. Stream-based callers
  // call `deferRequestRegistryCommit()` to take ownership.
  _setRegistryCommit(() => commitRequestRegistry(ctx))
  return ctx
}

/** Read the active request registry, if one has been opened. */
export function getActiveRegistry(): RequestRegistry | null {
  return registryAls.getStore() ?? null
}

/**
 * Mark the active context as deferring its commit to a downstream
 * trigger (typically a stream-flush hook). `runWithRequestAsync`'s
 * fallback auto-commit checks this flag and skips the commit.
 *
 * Idempotent. No-op when no context is active.
 */
export function deferRequestRegistryCommit(): void {
  const ctx = registryAls.getStore()
  if (ctx) ctx.deferred = true
  _deferRegistryCommit()
}

// ─── Public registry API ────────────────────────────────────────────────
//
// All operations check the ALS context first and fall back to direct
// canonical access. The fallback exists for code paths that run outside
// a request context (test fixtures that registerPartial directly,
// module-init code, HMR hooks).

function freezeManifest(snap: PartialSnapshot): PartialSnapshot {
  if (snap.manifest === undefined) return snap
  return { ...snap, manifest: new Set(snap.manifest) }
}

export function registerPartial(route: string, id: string, snapshot: PartialSnapshot): void {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    ctx.invalidations.delete(id)
    // Store the snapshot AS-IS in pendingWrites (manifest may alias
    // the body's still-mutating manifestScope.current). Per-request
    // isolation makes the alias safe here; commit copies by value.
    ctx.pendingWrites.set(id, snapshot)
    return
  }
  // Outside a request context (or wrong route): write directly to
  // canonical with a frozen manifest. Test fixtures hit this path.
  const scope = ctx?.scope ?? getScope()
  canonicalRouteState(scope, route).live.set(id, freezeManifest(snapshot))
}

export function lookupPartial(route: string, id: string): PartialSnapshot | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    if (ctx.invalidations.has(id)) return undefined
    // In-request: pendingWrites overrides everything; otherwise fall
    // through to the canonical live map (which holds prior streaming
    // + cache-mode overlays this request might want to see). Note
    // this is DIFFERENT from `previousView` — `previousView` is the
    // older streaming-baseline; `live` is everything-so-far including
    // the latest cache overlays.
    if (ctx.pendingWrites.has(id)) return ctx.pendingWrites.get(id)
    const live = canonical.get(ctx.scope)?.get(route)?.live
    return live?.get(id)
  }
  const scope = ctx?.scope ?? getScope()
  return canonical.get(scope)?.get(route)?.live.get(id)
}

/**
 * Union view of pending + previous snapshots for the given route.
 * Used by selector resolution and the editor tree pane to enumerate
 * "what Partials live on this page."
 *
 * pendingWrites override previousView on key collision; entries in
 * `invalidations` are excluded.
 *
 * Returns `undefined` when the union is empty (preserves callers
 * that distinguish "no entries yet" from "empty Map").
 */
export function getRouteSnapshots(route: string): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    // Live view = canonical.live + this request's pendingWrites,
    // minus invalidations. Mirrors master's `getRouteSnapshots`
    // which read the single shared current map (current = prior
    // streaming + cache overlays).
    const live = canonical.get(ctx.scope)?.get(route)?.live
    if ((!live || live.size === 0) && ctx.pendingWrites.size === 0) return undefined
    const merged: Map<string, PartialSnapshot> = live ? new Map(live) : new Map()
    for (const id of ctx.invalidations) merged.delete(id)
    for (const [id, snap] of ctx.pendingWrites) merged.set(id, snap)
    return merged.size > 0 ? merged : undefined
  }
  const scope = ctx?.scope ?? getScope()
  const live = canonical.get(scope)?.get(route)?.live
  if (!live || live.size === 0) return undefined
  return new Map(live)
}

/**
 * Snapshots from before this request's render started — the
 * structural-fingerprint pass folds these in to capture descendant
 * URL/cookie deps inside an ancestor's fp.
 *
 * Inside a request context: returns the frozen `previousView`.
 * Outside: returns the canonical state (no in-flight render to
 * distinguish a "previous" from a "current").
 *
 * Over-folding bias: a descendant that USED to live under an
 * ancestor but no longer does still contributes to the ancestor's fp
 * until the next streaming-mode commit replaces canonical. Extra
 * re-renders, never stale subtrees.
 */
export function getPreviousRouteSnapshots(route: string): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    if (ctx.previousView.size === 0) return undefined
    return new Map(ctx.previousView)
  }
  const scope = ctx?.scope ?? getScope()
  const baseline = canonical.get(scope)?.get(route)?.baseline
  if (!baseline || baseline.size === 0) return undefined
  return new Map(baseline)
}

/**
 * Drop one Partial's snapshot from this request's view. Called by
 * the manifest-scope `onViolation` hook when `recordAccess` throws —
 * without it, the bad manifest captured before the throw would
 * persist as the "stored" set on every subsequent render and the
 * same comparison would loop.
 *
 * Inside a request context: removes from pendingWrites AND records
 * an invalidation so commit excludes the id from canonical.
 *
 * Outside a request context (test cleanup): drops directly from
 * canonical.
 */
export function invalidateSnapshot(route: string, partialId: string): void {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    ctx.pendingWrites.delete(partialId)
    ctx.invalidations.add(partialId)
    return
  }
  const scope = ctx?.scope ?? getScope()
  const state = canonical.get(scope)?.get(route)
  if (state) {
    state.live.delete(partialId)
    state.baseline.delete(partialId)
  }
}

/**
 * Atomically merge this request's pendingWrites into the canonical
 * tree. Idempotent.
 *
 *   - **streaming mode**: canonical[route] is *replaced* by
 *     pendingWrites. Snapshots that didn't re-register are dropped.
 *     Subsumes the old `clearRoute(route)`-then-write pattern.
 *   - **cache mode**: pendingWrites *overlay* canonical[route]. Ids
 *     that didn't re-render keep their prior snapshots intact.
 *
 * Manifests are copied by value during the merge so canonical's
 * snapshots don't alias any request's still-live `manifestScope`.
 */
export function commitRequestRegistry(ctx: RequestRegistry): void {
  if (ctx.committed) return
  ctx.committed = true

  const state = canonicalRouteState(ctx.scope, ctx.route)

  if (ctx.mode === "streaming") {
    // baseline was already rotated at `enterRequestRegistry`. Replace
    // live wholesale with this render's pendingWrites — ids that
    // didn't re-register are stale and should disappear.
    state.live = new Map()
    for (const [id, snap] of ctx.pendingWrites) {
      if (ctx.invalidations.has(id)) continue
      state.live.set(id, freezeManifest(snap))
    }
    return
  }

  // Cache mode: overlay onto live; baseline untouched. Cache-mode
  // bodies on subsequent requests still see the older streaming
  // baseline as `manifestScope.stored` — which is what master did,
  // and what keeps the conditional-read-after-early-return idiom
  // (e.g. `<SearchArea>`) working. The strictness improvement
  // (cache-mode also enforces the latest manifest) is left for a
  // follow-up.
  for (const id of ctx.invalidations) state.live.delete(id)
  for (const [id, snap] of ctx.pendingWrites) {
    state.live.set(id, freezeManifest(snap))
  }
}

/**
 * Clear registry entries. No argument (or `"all"`): every scope is
 * wiped — used by HMR dispose hooks. Pass a scope to target a single
 * worker's entries.
 *
 * Doesn't touch any active per-request registry contexts: those
 * stay valid for their owning render. New contexts opened after
 * the clear simply see an empty `previousView`.
 */
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
  byRoute: Record<string, string[]>
} {
  const byRoute: Record<string, string[]> = {}
  let partials = 0
  const m = canonical.get(getScope())
  if (m) {
    for (const [route, state] of m) {
      byRoute[route] = [...state.live.keys()]
      partials += state.live.size
    }
  }
  return { routes: m?.size ?? 0, partials, byRoute }
}

// HMR: snapshotted React elements reference component functions whose
// module identities change across edits. Clear everything (all scopes)
// on update to prevent stale references from being re-rendered.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry())
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry())
}
