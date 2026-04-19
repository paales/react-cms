/**
 * Route-scoped partial snapshot registry.
 *
 * Captures each `<Partial>`'s *content descriptor* (the JSX inside it,
 * as a React element) the first time it actually renders. Keyed by
 * `(route path, partial id)`.
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
 */
import type { ReactNode } from "react";
import type { CacheOptions } from "./cache-options.ts";

export interface PartialSnapshot {
  /** Content JSX as it appeared inside `<Partial>` at capture time. */
  content: ReactNode;
  /** The fallback prop on the Partial (for Suspense wrapping). */
  fallback: ReactNode;
  /** The errorWith prop on the Partial (for ErrorBoundary fallback). */
  errorWith: ReactNode | undefined;
  /** Tags declared on the Partial — used to resolve `?tags=X` refetches
   *  against dynamic partials that the bootstrap walk can't see. */
  tags: string[];
  /** Cache options if the Partial declared `cache={…}`. Stored so
   *  cache-mode refetches re-apply the same cache semantics. */
  cache?: CacheOptions;
}

const registry = new Map<string, Map<string, PartialSnapshot>>();

function routeBucket(route: string): Map<string, PartialSnapshot> {
  let bucket = registry.get(route);
  if (!bucket) {
    bucket = new Map();
    registry.set(route, bucket);
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
  return registry.get(route)?.get(id);
}

/**
 * Return all partial snapshots registered on a given route. Used by
 * `PartialRoot` to augment its tag index with dynamic partials when
 * resolving `?tags=` refetches.
 */
export function getRouteSnapshots(
  route: string,
): Map<string, PartialSnapshot> | undefined {
  return registry.get(route);
}

/**
 * Drop all snapshots for a route. Called at the start of every
 * streaming render so the registry reflects ONLY the partials the
 * current layout produced — stale entries from prior renders (e.g.
 * `page-2` registered when `?end=2` was visited earlier) do not
 * linger and cause future refetches to take the cache-mode path
 * when they should fall back to streaming.
 */
export function clearRoute(route: string): void {
  registry.delete(route);
}

export function clearRegistry(): void {
  registry.clear();
}

export function _registryStats(): {
  routes: number;
  partials: number;
  byRoute: Record<string, string[]>;
} {
  const byRoute: Record<string, string[]> = {};
  let partials = 0;
  for (const [route, bucket] of registry) {
    byRoute[route] = [...bucket.keys()];
    partials += bucket.size;
  }
  return { routes: registry.size, partials, byRoute };
}

// HMR: snapshotted React elements reference component functions whose
// module identities change across edits. Clearing on update prevents
// stale references from being re-rendered.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry());
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry());
}
