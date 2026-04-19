/**
 * PartialRoot Architecture
 *
 * Pages are composed of independently re-renderable partials declared
 * with the <Partial> wrapper:
 *
 *   <PartialRoot>
 *     <html>
 *       <Partial id="head"><head>...</head></Partial>
 *       <body>
 *         <Partial id="nav"><nav>...</nav></Partial>
 *         <Partial id="cart" tags={["cart"]} fallback={<Spinner/>}>
 *           <CartBadge/>
 *         </Partial>
 *       </body>
 *     </html>
 *   </PartialRoot>
 *
 * `<PartialRoot>` is a thin orchestrator: it parses the request
 * params, sets up the request-scoped state that each `<Partial>`
 * reads during render, decides whether we're in streaming mode (full
 * page) or cache mode (partial refetch), and wraps the output in
 * `<PartialsClient>`.
 *
 * Every decision about an individual partial — "render fresh?",
 * "emit placeholder because the fingerprint matched?", "apply an
 * __inputs override?" — lives in the `Partial` component itself.
 * There is no static walker; each Partial discovers itself by
 * running. Deep Partials produced inside `.map()` loops or other
 * opaque component bodies are first-class: they register themselves
 * on every render.
 */

import React, { type ReactNode } from "react";
import {
  PartialsClient,
  type PartialDebugEntry,
} from "./partial-client.tsx";
import {
  Partial,
  PartialBoundary,
  type PartialProps,
} from "./partial-component.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getRequest } from "../framework/context.ts";
import {
  clearRoute,
  getRouteSnapshots,
  lookupPartial,
  registerPartial,
  type PartialSnapshot,
} from "./partial-registry.ts";
import {
  enterPartialState,
  type PartialRequestState,
} from "./partial-request-state.ts";

export { Partial, type PartialProps };

interface PartialRootProps {
  children: ReactNode;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isPartialElement(
  node: unknown,
): node is React.ReactElement<PartialProps> {
  return (
    React.isValidElement(node) && (node as { type?: unknown }).type === Partial
  );
}

/**
 * Walk the current request's JSX tree and overwrite existing registry
 * snapshots with the fresh content/fallback/tags for each
 * statically-visible `<Partial>`.
 *
 * Why: snapshots captured during an earlier render may have stale
 * closure state (`<Cache dep={{searchQuery}}>`, async component props
 * read from the URL via `getRequest()`). A cache-mode refetch of the
 * same id served from a stale snapshot would re-execute with the old
 * bindings. `__inputs` can't fix this — `cloneElement` only overrides
 * props on the outermost JSX element, and can't reach through a
 * `<Cache>` wrapper to the inner component.
 *
 * This walk is a PARTIAL refresh: it updates only ids already in the
 * registry. New ids are NOT added — that would make registry-miss
 * detection too optimistic and break shape-change refetches (e.g.
 * scrolling to page-N when page-N wasn't rendered last time).
 * Dynamic Partials (generated inside opaque components, invisible to
 * this walk) register via `<PartialBoundary>` as they run; they
 * already get fresh bindings that way.
 */
function refreshRegistry(children: ReactNode, route: string): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (isPartialElement(child)) {
      const props = child.props;
      if (lookupPartial(route, props.id)) {
        registerPartial(route, props.id, {
          content: props.children,
          fallback: props.fallback ?? null,
          errorWith: props.errorWith,
          tags: props.tags ?? [],
          cache: props.cache,
        });
      }
      refreshRegistry(props.children, route);
    } else if ((child.props as { children?: ReactNode }).children != null) {
      refreshRegistry(
        (child.props as { children?: ReactNode }).children as ReactNode,
        route,
      );
    }
  });
}

function parseCachedFingerprints(raw: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!raw) return out;
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (!token) continue;
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      out.set(token.slice(0, colonIdx), token.slice(colonIdx + 1));
    } else {
      out.set(token, null);
    }
  }
  return out;
}

function parseRequestedIds(raw: string | null): Set<string> | null {
  if (!raw) return null;
  const ids = new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return ids.size > 0 ? ids : null;
}

function resolveTagsToIds(
  tagsParam: string | null,
  route: string,
): Set<string> | null {
  if (!tagsParam) return null;
  const tagList = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
  if (tagList.length === 0) return null;

  const snapshots = getRouteSnapshots(route);
  if (!snapshots) return null;

  const ids = new Set<string>();
  for (const [id, snap] of snapshots) {
    for (const tag of snap.tags) {
      if (tagList.includes(tag)) {
        ids.add(id);
        break;
      }
    }
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Reconstruct a `<Partial>` element from a registry snapshot. Used
 * in cache mode to render each explicitly-requested partial without
 * re-executing any ancestor component.
 */
function partialFromSnapshot(id: string, snap: PartialSnapshot): ReactNode {
  return React.createElement(
    Partial,
    {
      id,
      fallback: snap.fallback ?? undefined,
      errorWith: snap.errorWith,
      tags: snap.tags,
      cache: snap.cache,
    },
    snap.content,
  );
}

// ─── PartialRoot ───────────────────────────────────────────────────────

export async function PartialRoot({ children }: PartialRootProps) {
  const requestUrl = new URL(getRequest().url);
  const partialsParam = requestUrl.searchParams.get("partials");
  const tagsParam = requestUrl.searchParams.get("tags");
  const cachedParam = requestUrl.searchParams.get("cached");
  const inputsParam = requestUrl.searchParams.get("__inputs");
  const populateCache = requestUrl.searchParams.has("__populateCache");

  let partialInputs: Record<string, Record<string, unknown>> = {};
  if (inputsParam) {
    try {
      partialInputs = JSON.parse(inputsParam);
    } catch {
      // Malformed — ignore.
    }
  }

  const route = requestUrl.pathname;

  // Refresh snapshots for statically-visible Partials from the current
  // request's JSX. Only updates ids that already have a registry
  // entry — new ids are added by `<PartialBoundary>` as children
  // render (streaming mode). See `refreshRegistry` for why.
  refreshRegistry(children, route);

  const partialIds = parseRequestedIds(partialsParam);
  const tagIds = resolveTagsToIds(tagsParam, route);
  const requestedIds =
    partialIds || tagIds
      ? new Set<string>([...(partialIds ?? []), ...(tagIds ?? [])])
      : null;

  const hasGlobalFilter = partialsParam != null || tagsParam != null;
  const isPartialRefetch = hasGlobalFilter || populateCache;

  // Explicit ids are never skipped on a fingerprint match or filter
  // — they're what the caller asked for.
  const explicitIds = new Set<string>();
  if (requestedIds) for (const id of requestedIds) explicitIds.add(id);
  for (const id of Object.keys(partialInputs)) explicitIds.add(id);

  const state: PartialRequestState = {
    requestedIds: populateCache ? null : requestedIds,
    isPartialRefetch: isPartialRefetch && !populateCache,
    populateCache,
    partialInputs,
    cachedFingerprints: parseCachedFingerprints(cachedParam),
    explicitIds,
    seenIds: new Set(),
  };

  // Registry-miss fallback: a requested id that isn't in the registry
  // (e.g. a stale client-side button for a partial that no longer
  // exists on this route) drops the filter and does a full render.
  // Gives the client a fresh tree to reconcile against.
  let registryMiss = false;
  if (state.isPartialRefetch && state.requestedIds) {
    for (const id of state.requestedIds) {
      if (!lookupPartial(route, id)) {
        registryMiss = true;
        break;
      }
    }
  }


  // ── Streaming mode (full render) ──────────────────────────────────
  if (!state.isPartialRefetch || registryMiss) {
    // Reset to streaming semantics — every Partial renders itself
    // (minus fingerprint-match skips) and each is a live element in
    // the streamed tree.
    //
    // Clear any prior snapshots for this route so the registry
    // reflects ONLY the partials the current layout produces.
    // Otherwise stale entries (e.g. `page-2` registered when the
    // user previously visited `?end=2`, but the current render only
    // has `page-1`) would make future refetches resolve to
    // cache-mode against a template the client never saw.
    clearRoute(route);
    const streamState: PartialRequestState = {
      ...state,
      requestedIds: null,
      isPartialRefetch: false,
    };
    enterPartialState(streamState);

    // Debug entries aren't known ahead of time (deep partials
    // register as they render). The debug panel will show whatever
    // entries the next cache-mode refetch surfaces.
    const debug: PartialDebugEntry[] = [];

    // No server-side template: the client derives it from the
    // rendered children in `PartialsClient`, removing the need for
    // `buildTemplate`'s static walk (and the "opaque components can't
    // contain a Partial" invariant that walk imposed).
    return (
      <PartialsClient mode="streaming" debug={debug} fetchMs={0}>
        {children}
      </PartialsClient>
    );
  }

  // ── Cache mode (partial refetch) ───────────────────────────────────
  //
  // Render each explicitly-requested partial from its registry
  // snapshot, as a flat sibling list. Each runs the `<Partial>` body,
  // which re-registers, applies `__inputs`, and wraps in Suspense +
  // ErrorBoundary. No ancestor components execute — we've lifted the
  // snapshot out of the registry and rendered it directly.
  //
  // No server-side template: the client re-renders against the
  // `_template` it derived during the most recent streaming render.
  enterPartialState(state);

  const activeIds = [...(state.requestedIds ?? [])];
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(route, id);
      if (!snap) return null;
      return partialFromSnapshot(id, snap);
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const debug: PartialDebugEntry[] = activeIds.map((id) => ({
    id,
    status: "fresh",
    fingerprint: "",
    query: null,
  }));

  return (
    <PartialsClient
      mode="cache"
      debug={debug}
      fetchMs={0}
    >
      {wrappedChildren}
    </PartialsClient>
  );
}

// Re-export PartialBoundary + PartialErrorBoundary so existing
// imports elsewhere (notably cache.tsx, which walks for PartialBoundary
// as a type marker) keep working.
export { PartialBoundary };
// PartialErrorBoundary is client-only but some server-only code paths
// reference its type; re-export for convenience.
export type { PartialErrorBoundary };
