/**
 * Route-scoped partial snapshot registry.
 *
 * Captures each `<Partial>`'s *content descriptor* (the JSX inside it,
 * as a React element) the first time it actually renders. Keyed by
 * `(scope, route path, partial id)`.
 *
 * Why: the only "static walk" of the JSX children chain is `seedRegistry`
 * in `PartialRoot` — it bootstraps the registry from statically-visible
 * Partials so a first-request cache-mode refetch can resolve. A Partial
 * produced inside an opaque function component (the canonical example
 * is `ProductList.map(p => <ProductItem price={<Partial><GoldPrice
 * sku={p.sku}/></Partial>}/>)`) is invisible to that bootstrap walk.
 *
 * Every `<Partial>` self-registers on every render via `<PartialBoundary>`.
 * That means dynamic Partials land in the registry on their first render
 * pass. A subsequent refetch for that id can render its snapshot directly,
 * skipping ancestor execution entirely (no `ProductList`, no 49 sibling
 * items). The partial's props are already bound in the captured element,
 * so the registered snapshot is complete on its own.
 *
 * Lifetime: module-level. Cleared on HMR so stale module references
 * in snapshotted elements don't leak across edits.
 *
 * Stale-shape safety: the snapshot is the content as it appeared on
 * the *last* full render of that route. If a subsequent full render
 * changes the shape (different props, different component), the
 * snapshot is overwritten on that render. If no full render happens
 * between code change and refetch, the snapshot is stale — but HMR
 * clears the registry, and in production a deploy spins a new
 * process. Either way: new code path → empty registry → first
 * request repopulates.
 *
 * ── Scoping ─────────────────────────────────────────────────────────
 * Keyed by `getScope()` first — Playwright workers > 1 get isolated
 * route maps so snapshots registered by worker A don't resolve for
 * worker B. Production uses the default scope for every request.
 */
import type { ReactNode } from "react";
import { getScope } from "../framework/context.ts";
import type { CacheOptions } from "./cache-options.ts";

export interface PartialSnapshot {
  /** Content JSX as it appeared inside `<Partial>` at capture time. */
  content: ReactNode;
  /** The fallback prop on the Partial (for Suspense wrapping). */
  fallback: ReactNode;
  /** The errorWith prop on the Partial (for ErrorBoundary fallback). */
  errorWith: ReactNode | undefined;
  /** `#`-token names from the Partial's selector (without the `#` prefix).
   *  Used to resolve `?partials=X` refetches against dynamic Partials
   *  that the bootstrap walk can't see. A Partial's effective id is
   *  derived from these (single token → that name; multiple → sorted-join). */
  uniqueTokens: string[];
  /** `.`-token names from the Partial's selector (without the `.` prefix).
   *  Used to resolve `?tags=X` refetches with union semantics. */
  sharedTokens: string[];
  /** Cache options if the Partial declared `cache={…}`. Stored so
   *  cache-mode refetches re-apply the same cache semantics. */
  cache?: CacheOptions;
  /** Canonical frame path if the Partial declared `frame="…"` — the
   *  dotted join of every enclosing `frame` ancestor plus this local
   *  name. Two `<Partial frame="list">`s under different parent
   *  frames thus resolve to distinct paths (`"products.list"` vs
   *  `"blog.list"`), which the session store, navigation state, and
   *  `?__frame=` wire param all key off. Empty array means the
   *  Partial doesn't open a frame. */
  framePath: readonly string[];
  /** The author-provided `frameUrl` fallback. Session overrides it
   *  when present; kept here as the cold-session default. */
  frameUrl?: string;
  /** Outer-first chain of ancestor partial ids, captured from the
   *  Partial's `parent` prop. `[]` for top-level Partials. Lets
   *  server-side logic reason about the full hierarchy (nested
   *  frames, selector scoping, invalidation cascades) without the
   *  client-side tree reconstruction that was necessary while the
   *  hierarchy could only be inferred post-render. */
  parentPath: readonly string[];
  /** Stable storage key for CMS-authored content, from the Partial's
   *  `cmsId` prop. Preserved in the snapshot so cache-mode refetches
   *  re-open the same CMS scope when rendering from this snapshot.
   *  Absent on Partials that aren't CMS-aware. */
  cmsId?: string;
  /** Declared request-state dependencies (URL params, cookies,
   *  headers, pathname patterns) the Partial's content depends on.
   *  Each entry is a tracked-accessor spec like `"url:config"`,
   *  `"cookie:session"`, `"header:x-foo"`, `"pathname:/p/:slug"`.
   *  Resolved against the Partial's effective request (own frame /
   *  ambient frame / page) to fold into the structural fingerprint —
   *  so a same-route nav that changes any declared key produces a
   *  distinct fp and the fp-skip handshake doesn't serve stale bytes.
   *  Preserved on the snapshot so cache-mode replay re-resolves
   *  with the current request. Absent / empty when the Partial
   *  doesn't declare deps. */
  varyOn?: readonly string[];
}

type RouteMap = Map<string, Map<string, PartialSnapshot>>;

// CATEGORY C (notes/SERVER_ISOLATION.md) — route-scoped snapshot store,
// outer key is the per-request `scope` (test-worker isolation; always
// "default" in prod). Inner: route → partial id → snapshot. Rebuilt on
// HMR / process restart; cleared on full streaming renders via
// clearRoute(route).
const scopes = new Map<string, RouteMap>();

// Parallel "previous render" snapshot store. `clearRoute(route)` moves
// the current entries here before wiping `scopes` so the NEW render
// can look up the LAST render's tree shape — used by the structural-
// fingerprint pass to fold in each Partial's transitively-reachable
// descendant `varyOn` declarations. Without this, an ancestor's fp
// captures only its own JSX structure, doesn't reflect descendant
// URL/cookie deps, and an ancestor fp-skip serves a stale subtree
// when only the descendant's input changed.
//
// Approximation: "previous" reflects the most recent COMPLETED render
// of this route (potentially with different URL params); stale Partial
// shapes that no longer appear in the current render still contribute
// to ancestor fp until the current render completes and swaps in.
// That's safe — over-folding produces over-invalidation (more re-
// renders than strictly needed), never under-invalidation. Empty on
// first-render-of-a-route and after process restarts.
const previousScopes = new Map<string, RouteMap>();

function scopeMap(scope: string = getScope()): RouteMap {
  let m = scopes.get(scope);
  if (!m) {
    m = new Map();
    scopes.set(scope, m);
  }
  return m;
}

function previousScopeMap(scope: string = getScope()): RouteMap {
  let m = previousScopes.get(scope);
  if (!m) {
    m = new Map();
    previousScopes.set(scope, m);
  }
  return m;
}

function routeBucket(route: string): Map<string, PartialSnapshot> {
  const m = scopeMap();
  let bucket = m.get(route);
  if (!bucket) {
    bucket = new Map();
    m.set(route, bucket);
  }
  return bucket;
}

export function registerPartial(
  route: string,
  id: string,
  snapshot: PartialSnapshot,
): void {
  routeBucket(route).set(id, snapshot);
}

export function lookupPartial(
  route: string,
  id: string,
): PartialSnapshot | undefined {
  return scopeMap().get(route)?.get(id);
}

/**
 * Return all partial snapshots registered on a given route. Used by
 * `PartialRoot` to augment its tag index with dynamic partials when
 * resolving `?tags=` refetches.
 */
export function getRouteSnapshots(
  route: string,
): Map<string, PartialSnapshot> | undefined {
  return scopeMap().get(route);
}

/**
 * Move all current snapshots for a route into the "previous" slot,
 * then clear the current slot. Called at the start of every streaming
 * render: the new render starts with an empty current map (so stale
 * entries from prior renders — e.g. `page-2` registered when `?end=2`
 * was visited earlier — don't linger and cause future refetches to
 * take the cache-mode path when they should fall back to streaming),
 * but the previous map remains queryable for the duration of the
 * render. Structural-fingerprint computation reads it via
 * `getPreviousRouteSnapshots` to fold descendant `varyOn`
 * declarations into ancestor fps.
 */
export function clearRoute(route: string): void {
  const sm = scopeMap();
  const current = sm.get(route);
  const psm = previousScopeMap();
  if (current && current.size > 0) {
    psm.set(route, current);
  } else {
    psm.delete(route);
  }
  sm.delete(route);
}

/**
 * Snapshots from the most recent completed render of this route.
 * Empty until at least one full render has finished. Used by the
 * Partial body's fingerprint pass to look up descendant Partials and
 * fold their `varyOn` declarations into the ancestor's fp — so an
 * ancestor that fp-skips can't serve a stale subtree when a
 * descendant's URL dependency changes.
 *
 * This is intentionally NOT the same map as `getRouteSnapshots`: that
 * one reflects what the CURRENT render has registered so far, which
 * is incomplete because descendants haven't run yet at the moment
 * their ancestor computes its fp. Using the previous-render snapshot
 * gives the ancestor a complete (if slightly-stale) view of its
 * subtree — accurate enough to fold transitive deps, with the
 * over-folding bias (any Partial that USED to live under this
 * ancestor still contributes its varyOn) producing over-invalidation
 * rather than under.
 */
export function getPreviousRouteSnapshots(
  route: string,
): Map<string, PartialSnapshot> | undefined {
  return previousScopeMap().get(route);
}

/**
 * Clear registry entries. No argument (or `"all"`): every scope is
 * wiped — used by HMR dispose hooks. Pass a scope to target a single
 * worker's entries.
 */
export function clearRegistry(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    scopes.clear();
    previousScopes.clear();
    return;
  }
  scopes.delete(scope);
  previousScopes.delete(scope);
}

export function _registryStats(): {
  routes: number;
  partials: number;
  byRoute: Record<string, string[]>;
} {
  const byRoute: Record<string, string[]> = {};
  let partials = 0;
  const m = scopeMap();
  for (const [route, bucket] of m) {
    byRoute[route] = [...bucket.keys()];
    partials += bucket.size;
  }
  return { routes: m.size, partials, byRoute };
}

// HMR: snapshotted React elements reference component functions whose
// module identities change across edits. Clear everything (all scopes)
// on update to prevent stale references from being re-rendered.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry());
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry());
}
