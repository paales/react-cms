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

import React, { Suspense, type ReactNode } from "react";
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

/**
 * Build a structural template from the children tree: keyless wrappers
 * are preserved, `<Partial>` elements are replaced with placeholders.
 * The client fills those placeholders from its cache on every render
 * (both streaming and cache modes), so non-requested partials stay
 * visible without re-rendering.
 *
 * This still walks the input JSX — but only for *statically-visible*
 * `<Partial>` elements at the top level. Deep Partials are invisible
 * to this walk (same as before). That's fine: they don't need their
 * own top-level placeholder in the template; they live inside their
 * ancestor's content instead.
 */
function isPartialElement(
  node: unknown,
): node is React.ReactElement<PartialProps> {
  return React.isValidElement(node) && (node as { type?: unknown }).type === Partial;
}

/**
 * Seed the route-scoped registry from the JSX tree.
 *
 * This walks `children` looking for `<Partial>` elements visible
 * through the static chain — keyless structural wrappers and the
 * `children` prop of any element, including function components that
 * forward their children. It does NOT see Partials produced inside
 * opaque component bodies (e.g. `.map(p => <Partial/>)`); those get
 * registered by their own render via `<PartialBoundary>`.
 *
 * The purpose is purely to bootstrap the registry so the very first
 * request to a route — even if it's a cache-mode refetch — can
 * resolve requested ids without having to fall back to a full
 * render. Everything else (fingerprints, filter decisions, __inputs,
 * duplicate detection) is handled at render time by `<Partial>` itself.
 */
function seedRegistry(children: ReactNode, route: string): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (isPartialElement(child)) {
      const props = child.props;
      registerPartial(route, props.id, {
        content: props.children,
        fallback: props.fallback ?? null,
        errorWith: props.errorWith,
        tags: props.tags ?? [],
      });
      seedRegistry(props.children, route);
    } else if ((child.props as { children?: ReactNode }).children != null) {
      seedRegistry(
        (child.props as { children?: ReactNode }).children as ReactNode,
        route,
      );
    }
  });
}

function buildTemplate(
  children: ReactNode,
  counter = { v: 0 },
): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (isPartialElement(child)) {
      result.push(
        React.createElement("i", {
          key: child.props.id,
          hidden: true,
          "data-partial": true,
        }),
      );
    } else if ((child.props as { children?: ReactNode }).children != null) {
      const wrapKey = `_${counter.v++}`;
      result.push(
        React.cloneElement(
          child,
          { key: wrapKey },
          ...buildTemplate(
            (child.props as { children?: ReactNode }).children as ReactNode,
            counter,
          ),
        ),
      );
    } else {
      result.push(React.cloneElement(child, { key: `_${counter.v++}` }));
    }
  });
  return result;
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

  // Seed the registry from the static JSX tree. This is the only
  // static walk in the whole pipeline; everything else is driven by
  // runtime registration via `<PartialBoundary>`.
  seedRegistry(children, route);

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

  const template = buildTemplate(children);

  // ── Streaming mode (full render) ──────────────────────────────────
  if (!state.isPartialRefetch || registryMiss) {
    // Reset to streaming semantics — every Partial renders itself
    // (minus fingerprint-match skips) and each is a live element in
    // the streamed tree.
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

    return (
      <PartialsClient
        mode="streaming"
        template={template}
        debug={debug}
        fetchMs={0}
      >
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
      template={template}
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
