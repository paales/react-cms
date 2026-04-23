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
  /** Frame name if the Partial declared `frame="…"`. Stored so
   *  cache-mode refetches re-open the frame scope with the current
   *  session URL (not the URL baked on first render), and so the
   *  server can resolve `?__frame=X` back to this snapshot. */
  frame?: string;
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
}

type RouteMap = Map<string, Map<string, PartialSnapshot>>;

// CATEGORY C (notes/SERVER_ISOLATION.md) — route-scoped snapshot store,
// outer key is the per-request `scope` (test-worker isolation; always
// "default" in prod). Inner: route → partial id → snapshot. Rebuilt on
// HMR / process restart; cleared on full streaming renders via
// clearRoute(route).
const scopes = new Map<string, RouteMap>();

function scopeMap(scope: string = getScope()): RouteMap {
  let m = scopes.get(scope);
  if (!m) {
    m = new Map();
    scopes.set(scope, m);
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
 * Drop all snapshots for a route within the current scope. Called at
 * the start of every streaming render so the registry reflects ONLY
 * the partials the current layout produced — stale entries from
 * prior renders (e.g. `page-2` registered when `?end=2` was visited
 * earlier) do not linger and cause future refetches to take the
 * cache-mode path when they should fall back to streaming.
 */
export function clearRoute(route: string): void {
  scopeMap().delete(route);
}

/**
 * Clear registry entries. No argument (or `"all"`): every scope is
 * wiped — used by HMR dispose hooks. Pass a scope to target a single
 * worker's entries.
 */
export function clearRegistry(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    scopes.clear();
    return;
  }
  scopes.delete(scope);
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
