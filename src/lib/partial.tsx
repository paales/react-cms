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
 * The `<Partial>` wrapper carries metadata (id, tags, cache, fallback)
 * and wraps the actual content. <PartialRoot> statically walks its
 * children tree to discover Partial elements — they can be nested inside
 * any keyless structural JSX (html, head, body, div, Fragment) or inside
 * function-component wrappers that forward `children`.
 *
 * Partial ids are global per page. Duplicates throw.
 *
 * Nested Partials are first-class: <Partial id="header"><Partial id="cart"/></Partial>
 * renders cart independently of its parent. Refreshing "header" re-renders
 * the header layout but keeps the cached cart. Refreshing "cart" patches
 * just the cart into the cached header. All partials render as flat
 * siblings — JSX nesting is a layout declaration, not a render tree.
 *
 * On full page render: all partials render.
 * On partial re-fetch (?partials=hero,stats): only those partials render.
 * The client PartialsClient merges fresh partials with its cache,
 * so non-requested partials remain visible.
 */

import React, { Suspense, type ReactNode } from "react";
import {
  PartialsClient,
  type PartialDebugEntry,
} from "./partial-client.tsx";
import {
  Partial,
  type PartialProps,
} from "./partial-component.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getRequest } from "../framework/context.ts";
import { djb2 as hashFingerprint } from "./hash.ts";
import {
  getRouteSnapshots,
  lookupPartial,
  registerPartial,
} from "./partial-registry.ts";

export { Partial, type PartialProps };

interface PartialRootProps {
  children: ReactNode;
}

interface PartialEntry {
  id: string;
  /** The children of <Partial> — the actual content to render. */
  content: ReactNode;
  depth: number;
  tags: string[];
  /** Data cache TTL in seconds (0 = no cache, default) */
  cacheTtl: number;
  /** Suspense fallback (for loading states). */
  fallback: ReactNode;
  /** Error boundary fallback. `undefined` means use the default card. */
  errorWith: ReactNode | undefined;
}

function isPartialElement(
  node: unknown,
): node is React.ReactElement<PartialProps> {
  return React.isValidElement(node) && (node as any).type === Partial;
}

/**
 * Compute a lightweight fingerprint of a React element tree.
 *
 * Walks the element structure as plain data — no component functions
 * are called. Inspects type (tag name or component name), key, and
 * non-children scalar props. Recurses into children.
 *
 * Used to detect when a cached partial's content shape has changed
 * between pages (e.g., header gains controls on the detail page).
 */
function fingerprintElement(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(fingerprintElement).join(",");
  if (!React.isValidElement(node)) return "";

  const type =
    typeof node.type === "string"
      ? node.type
      : (node.type as any).displayName ||
        (node.type as any).name ||
        "Anonymous";

  const props = node.props as Record<string, unknown>;
  const parts: string[] = [type];

  if (node.key != null) parts.push(`k=${node.key}`);

  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue;
    if (typeof v === "function") continue;
    if (typeof v === "object" && v !== null) continue;
    parts.push(`${k}=${v}`);
  }

  if (props.children != null) {
    parts.push(`(${fingerprintElement(props.children as React.ReactNode)})`);
  }

  return parts.join("|");
}

/**
 * Walk the children tree to collect all <Partial> elements at any depth.
 * Descends through keyless structural wrappers (html, body, div,
 * Fragment) and into the `children` prop of any element — including
 * function components that forward their children.
 *
 * Throws on duplicate id.
 */
function collectPartials(
  children: ReactNode,
  seen: Set<string>,
  depth = 0,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (isPartialElement(child)) {
      const props = child.props;
      const id = props.id;
      if (seen.has(id)) {
        throw new Error(
          `Duplicate partial id "${id}". Partial ids must be unique per page.`,
        );
      }
      seen.add(id);
      entries.push({
        id,
        content: props.children,
        depth,
        tags: props.tags ?? [],
        cacheTtl: props.cache ?? 0,
        fallback: props.fallback ?? null,
        errorWith: props.errorWith,
      });
      // Recurse into the content to find nested Partials
      entries.push(...collectPartials(props.children, seen, depth + 1));
    } else if ((child.props as Record<string, unknown>).children) {
      entries.push(
        ...collectPartials(
          (child.props as Record<string, unknown>).children as ReactNode,
          seen,
          depth,
        ),
      );
    }
  });
  return entries;
}

/**
 * Apply __inputs overrides to a Partial's content.
 *
 * If content is a single React element, clone it with the overrides as
 * new props. Otherwise returns content unchanged — __inputs overrides
 * require a single root child.
 */
function applyInputs(
  content: ReactNode,
  overrides: Record<string, unknown>,
): ReactNode {
  if (React.isValidElement(content)) {
    return React.cloneElement(content, overrides);
  }
  return content;
}

/**
 * Build a structural template from the children tree: keyless wrappers
 * are preserved, <Partial> elements are replaced with placeholders.
 * The client fills these placeholders from its cache.
 */
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
      // Partial placeholder — client fills from cache
      result.push(
        React.createElement("i", {
          key: child.props.id,
          hidden: true,
          "data-partial": true,
        }),
      );
    } else if ((child.props as Record<string, unknown>).children) {
      // Structural wrapper — preserve layout, assign counter key.
      // Must match transformForStreaming's key scheme for React reconciliation.
      const wrapKey = `_${counter.v++}`;
      result.push(
        React.cloneElement(
          child,
          { key: wrapKey },
          ...buildTemplate(
            (child.props as Record<string, unknown>).children as ReactNode,
            counter,
          ),
        ),
      );
    } else {
      // Keyless leaf — assign counter key matching transformForStreaming
      result.push(React.cloneElement(child, { key: `_${counter.v++}` }));
    }
  });
  return result;
}

/**
 * Replace nested <Partial> elements inside content with placeholders.
 * This allows parent partials to render without triggering rendering
 * of their nested children — those render independently as flat siblings.
 */
function stripNested(
  content: ReactNode,
  nestedIds: Set<string>,
): ReactNode {
  if (content == null || typeof content === "boolean") return content;
  if (typeof content === "string" || typeof content === "number") return content;
  if (Array.isArray(content)) {
    let changed = false;
    const mapped = content.map((c) => {
      const s = stripNested(c, nestedIds);
      if (s !== c) changed = true;
      return s;
    });
    return changed ? mapped : content;
  }
  if (!React.isValidElement(content)) return content;

  if (isPartialElement(content)) {
    if (nestedIds.has(content.props.id)) {
      return React.createElement("i", { key: content.props.id, hidden: true });
    }
    return content;
  }

  const children = (content.props as any).children;
  if (children == null) return content;
  const newChildren = stripNested(children, nestedIds);
  if (newChildren === children) return content;
  return React.cloneElement(content, {}, newChildren);
}

/**
 * Transform the children tree for streaming mode (full render).
 *
 * Walks the tree in-place, preserving nesting:
 * - <Partial> elements with a `fallback` prop → wrapped in Suspense (streams)
 * - <Partial> elements without `fallback` → wrapped in PartialErrorBoundary (sync)
 * - <Partial>'s content is recursed into to wrap further nested Partials
 * - Keyless wrappers (main, footer, Fragment) are preserved structurally
 */
function transformForStreaming(
  children: ReactNode,
  counter = { v: 0 },
  overrides: Record<string, Record<string, unknown>> = {},
  version: string = "0",
  explicitIds: Set<string> | null = null,
): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (isPartialElement(child)) {
      const { id, fallback, errorWith } = child.props;
      const override = overrides[id];
      const isExplicit =
        (explicitIds != null && explicitIds.has(id)) || override != null;

      // Apply __inputs override (from usePartial().refetch({...})) to the
      // Partial's content (which is a single child element in the common case).
      const content = override
        ? applyInputs(child.props.children, override)
        : child.props.children;
      // Recurse into content to handle nested Partials
      const transformedContent = transformForStreaming(
        content,
        counter,
        overrides,
        version,
        explicitIds,
      );
      const inner =
        transformedContent.length === 1
          ? transformedContent[0]
          : transformedContent;

      if (fallback != null) {
        // Empty version ⇒ bare key (revalidate mode): client adopts the
        // previously cached stamped key so React reconciles in place.
        const suspenseKey = version ? `${id}#${version}` : id;
        result.push(
          <Suspense
            key={suspenseKey}
            fallback={
              <PartialErrorBoundary partialId={id} fallback={errorWith}>
                {fallback}
              </PartialErrorBoundary>
            }
          >
            <PartialErrorBoundary partialId={id} fallback={errorWith}>
              {inner}
            </PartialErrorBoundary>
          </Suspense>,
        );
      } else {
        result.push(
          <PartialErrorBoundary key={id} partialId={id} fallback={errorWith}>
            {inner}
          </PartialErrorBoundary>,
        );
      }
      return;
    }
    if ((child.props as any).children) {
      // Keyless wrapper — recurse, assign counter key matching buildTemplate's scheme
      // so React preserves the subtree when switching from streaming to cache mode.
      const wrapKey = `_${counter.v++}`;
      const inner = transformForStreaming(
        (child.props as any).children,
        counter,
        overrides,
        version,
        explicitIds,
      );
      result.push(
        React.cloneElement(child, { key: wrapKey }, ...inner),
      );
    } else {
      // Keyless leaf — assign counter key matching buildTemplate
      result.push(React.cloneElement(child, { key: `_${counter.v++}` }));
    }
  });
  return result;
}

// ─── PartialRoot ───────────────────────────────────────────────────────
// Pure orchestrator: walks children for <Partial> elements, filters,
// templates, client merge. No data fetching — partial contents are
// responsible for their own data.

export async function PartialRoot({ children }: PartialRootProps) {
  const requestUrl = new URL(getRequest().url);
  const partialsParam = requestUrl.searchParams.get("partials");
  const tagsParam = requestUrl.searchParams.get("tags");
  const cached = requestUrl.searchParams.get("cached");
  const inputsParam = requestUrl.searchParams.get("__inputs");
  let partialInputs: Record<string, Record<string, unknown>> = {};
  if (inputsParam) {
    try {
      partialInputs = JSON.parse(inputsParam);
    } catch {
      // Malformed __inputs — ignore and render with default props
    }
  }

  // Collect all <Partial> elements (top-level and nested, through keyless wrappers).
  // Throws on duplicate ids.
  const allPartials = collectPartials(children, new Set());
  const nestedIds = new Set(
    allPartials.filter((e) => e.depth > 0).map((e) => e.id),
  );

  // Populate the route-scoped registry for statically-discovered partials
  // so subsequent refetches can resolve their content directly from the
  // registry (see `lookupPartial` below). Dynamic partials (those the
  // static walker can't see through opaque function components) are
  // registered by `Partial` self-wrapping with `<PartialBoundary>` as it
  // renders.
  const routePath = requestUrl.pathname;
  for (const entry of allPartials) {
    registerPartial(routePath, entry.id, {
      content: entry.content,
      fallback: entry.fallback,
      errorWith: entry.errorWith,
      tags: entry.tags,
    });
  }

  // Build tag → partial ID mapping for tag-based invalidation.
  // Include both statically-discovered partials (from `collectPartials`)
  // and dynamically-produced partials captured in the route registry
  // on a prior full render. Without the registry lookup, `?tags=price`
  // would never match a `ProductList.map(p => <Partial
  // id={`price-${p.sku}`} tags={["price"]}>…)` pattern because those
  // ids are invisible to the static walker.
  const tagIndex = new Map<string, Set<string>>();
  const addTag = (tag: string, id: string) => {
    let ids = tagIndex.get(tag);
    if (!ids) {
      ids = new Set();
      tagIndex.set(tag, ids);
    }
    ids.add(id);
  };
  for (const entry of allPartials) {
    for (const tag of entry.tags) addTag(tag, entry.id);
  }
  const routeSnapshots = getRouteSnapshots(requestUrl.pathname);
  if (routeSnapshots) {
    for (const [id, snap] of routeSnapshots) {
      for (const tag of snap.tags) addTag(tag, id);
    }
  }

  // Resolve ?tags= to partial IDs via the tag index.
  const tagResolvedIds = (() => {
    if (!tagsParam) return null;
    const ids = new Set(
      tagsParam
        .split(",")
        .map((t) => t.trim())
        .flatMap((tag) => {
          const matched = tagIndex.get(tag);
          return matched ? [...matched] : [];
        }),
    );
    return ids.size > 0 ? ids : null;
  })();

  // Resolve ?partials= to raw partial IDs
  const partialResolvedIds = partialsParam
    ? new Set(
        partialsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      )
    : null;

  const partialFilterApplies =
    partialResolvedIds != null && partialResolvedIds.size > 0;

  // Merge applicable filters. If neither filter applies, render all.
  const requestedIds =
    partialFilterApplies || tagResolvedIds
      ? new Set([
          ...(partialFilterApplies ? partialResolvedIds : []),
          ...(tagResolvedIds ?? []),
        ])
      : null;

  // ── Determine rendering mode ──────────────────────────────────────
  // Pulled up ahead of fingerprinting so the registry-supplement step
  // (which depends on `effectiveRequestedIds` and `populateCache`) can
  // feed its entries into both fingerprints and debug output.
  const hasGlobalFilter = partialsParam != null || tagsParam != null;
  const populateCache = requestUrl.searchParams.has("__populateCache");
  // `effectiveRequestedIds` is set after the registry-miss check below,
  // because a miss needs to drop the filter to render all partials as
  // fresh (navigation-like fallback). Declared via `let` so the
  // miss-case override is expressible.
  let effectiveRequestedIds = populateCache ? null : requestedIds;

  // Supplement statically-discovered partials with the route-scoped
  // registry, for ids that `collectPartials` couldn't see (dynamic
  // Partials produced inside opaque function components, e.g.
  // `ProductList.map(p => <Partial id={`price-${p.sku}`}>…</Partial>)`).
  // The registry gets populated by `PartialBoundary` on each full render.
  //
  // A requested id that is neither static nor in the registry is a
  // genuine "this partial doesn't exist on this route anymore" case —
  // we fall back to a full render (navigation-like) and let the client
  // reconcile against the fresh tree.
  const staticIds = new Set(allPartials.map((e) => e.id));
  const route = requestUrl.pathname;
  const registrySupplement: PartialEntry[] = [];
  let registryMiss = false;
  if (effectiveRequestedIds && !populateCache) {
    for (const id of effectiveRequestedIds) {
      if (staticIds.has(id)) continue;
      const snap = lookupPartial(route, id);
      if (snap) {
        registrySupplement.push({
          id,
          content: snap.content,
          depth: 0,
          tags: [],
          cacheTtl: 0,
          fallback: snap.fallback,
          errorWith: snap.errorWith,
        });
      } else {
        registryMiss = true;
        break;
      }
    }
  }

  // Registry miss: drop the filter so the subsequent streaming mode
  // renders everything fresh. Same shape as `__populateCache`.
  if (registryMiss) {
    effectiveRequestedIds = null;
  }

  // Compute fingerprints for all partials (cheap — walks element tree, no rendering).
  // Registry supplements are included so the client can detect shape
  // changes on dynamic partials the same way as static ones.
  const fingerprints = new Map<string, string>();
  for (const entry of allPartials) {
    fingerprints.set(
      entry.id,
      hashFingerprint(fingerprintElement(entry.content)),
    );
  }
  for (const entry of registrySupplement) {
    if (!fingerprints.has(entry.id)) {
      fingerprints.set(
        entry.id,
        hashFingerprint(fingerprintElement(entry.content)),
      );
    }
  }

  // Parse cached entries: "id:fingerprint,id:fingerprint" or legacy "id,id"
  const cachedFingerprints = new Map<string, string | null>();
  if (cached) {
    for (const token of cached.split(",").map((s) => s.trim())) {
      const colonIdx = token.indexOf(":");
      let id: string;
      let fp: string | null;
      if (colonIdx > 0) {
        id = token.slice(0, colonIdx);
        fp = token.slice(colonIdx + 1);
      } else {
        id = token;
        fp = null;
      }
      cachedFingerprints.set(id, fp);
    }
  }

  // ── Rendering modes ───────────────────────────────────────────────
  //
  // Two modes:
  // 1. Streaming (full render): render children directly in the server tree
  //    so Suspense boundaries can stream.
  // 2. Cache (partial refetch): PartialsClient in "cache" mode uses template
  //    + cache merge. Only requested partials are fresh; rest from cache.
  //
  // __populateCache is set by entry.rsc.tsx when a server action has
  // invalidation but the client's PartialsClient cache is empty (first
  // action after a streaming render). Forces streaming mode with ALL partials
  // to populate the client cache.
  const isPartialRefetch = hasGlobalFilter || populateCache;

  // ── Suspense key-stamping: what the `fallback` prop on <Partial> is really for ──
  //
  // When a <Partial fallback={…}> is refetched, the framework wraps its
  // content in <Suspense key={`${id}#${streamVersion}`}>. The version
  // changes per request, so React treats the new boundary as a fresh
  // element, unmounts the old one, and mounts the new one. Mounting a
  // fresh Suspense means: its fallback shows immediately, each inner
  // Suspense boundary starts pending, and as Flight chunks arrive from
  // the server each inner boundary commits its content independently.
  //
  // This is the ONLY way we've found to get **progressive streaming on
  // refetch** through React's current concurrent-rendering model. Without
  // a key change:
  //   - In flushSync mode: inner fallbacks still flash, but the outer
  //     subtree reconciles in place — might work, but less predictable.
  //   - In startTransition mode: React waits for the whole new subtree
  //     to be ready before committing. You lose per-inner-boundary
  //     streaming entirely — it's all-or-nothing.
  //
  // So the key stamp is not about "UX: flash a spinner on refetch" —
  // it's about preserving streaming semantics through the refetch
  // pipeline. A product list with N async rows streams in row-by-row
  // as server chunks arrive, instead of waiting for the whole list.
  //
  // The **revalidate mode** bare key (id without version stamp) gives
  // the opposite behavior: reconcile in place, no progressive streaming,
  // no fallback flash. Appropriate for cases like the cart badge where
  // you want the old value visible while the new one loads (paired with
  // a client-side transition to show an isPending spinner on the
  // trigger button). Opt in via `?revalidate=1` on the refetch URL.
  //
  // If we ever want users to control this per-partial (e.g. write their
  // own <Suspense> inside without the framework wrap), we'd expose the
  // stream version as a hook so they can key their own Suspense — the
  // stamping mechanism stays, the wrapping location moves.
  const isRevalidate = requestUrl.searchParams.has("revalidate");

  const streamVersion = isRevalidate
    ? ""
    : `${requestUrl.searchParams.get("n") ?? ""}-${Date.now()}`;

  const activeEntries = [
    ...allPartials.filter((e) => {
      if (effectiveRequestedIds && !effectiveRequestedIds.has(e.id)) return false;
      if (partialInputs[e.id]) return true; // __inputs override → always render
      return true;
    }),
    ...registrySupplement,
  ];

  const freshIds = activeEntries.map((e) => e.id);

  // Build the set of partial ids the client explicitly asked for. Used to
  // decide whether a `renderOn`-deferred partial should render its real
  // content (explicit request → yes) or the DeferredPartial placeholder
  // (initial render / unrelated refetch → yes).
  const explicitIds = new Set<string>();
  if (requestedIds) for (const id of requestedIds) explicitIds.add(id);
  for (const id of Object.keys(partialInputs)) explicitIds.add(id);

  // Apply partial input overrides and strip nested partials from content.
  const activeChildren = activeEntries.map((e) => {
    const overrides = partialInputs[e.id];
    const content = overrides ? applyInputs(e.content, overrides) : e.content;
    const stripped = nestedIds.has(e.id) ? content : stripNested(content, nestedIds);
    return {
      id: e.id,
      content: stripped,
      fallback: e.fallback,
      errorWith: e.errorWith,
    };
  });

  // Debug entries — include registry-supplement ids so the dev panel
  // shows dynamic partials that aren't in the static tree.
  const activeIdSet = new Set(freshIds);
  const debugIds = [
    ...allPartials.map((e) => e.id),
    ...registrySupplement.map((e) => e.id),
  ];
  const debug: PartialDebugEntry[] = debugIds.map((id) => ({
    id,
    status: activeIdSet.has(id) ? "fresh" : "cached",
    fingerprint: fingerprints.get(id) ?? "",
    query: null,
  }));

  const fpObject = Object.fromEntries(fingerprints);

  // Structural template shared across both modes: preserves keyless wrappers,
  // partials become placeholders. PartialsClient fills placeholders from its
  // cache in both streaming and cache modes so the rendered tree shape is
  // identical across the streaming→cache transition (no fallback flash on
  // the first user interaction after a streaming render).
  const template = buildTemplate(children);

  // ── Streaming mode (full render) ──────────────────────────────────
  // `registryMiss` means a requested partial id exists neither in the
  // static tree nor the registry (e.g. a previously-present dynamic
  // Partial that's been conditionally removed). Fall back to a full
  // render so the client reconciles against a fresh tree.
  if (!isPartialRefetch || populateCache || registryMiss) {
    return (
      <PartialsClient
        mode="streaming"
        template={template}
        freshIds={freshIds}
        fingerprints={fpObject}
        debug={debug}
        fetchMs={0}
      >
        {transformForStreaming(children, { v: 0 }, partialInputs, streamVersion, explicitIds)}
      </PartialsClient>
    );
  }

  // ── Cache mode (partial refetch) ───────────────────────────────────

  // Wrap each fresh partial to match streaming-mode wrapping exactly so
  // that the client reconciles in place across mode switches.
  const wrappedChildren = activeChildren.map(({ id, content, fallback, errorWith }) => {
    const inner = content;
    if (fallback != null) {
      const suspenseKey = isRevalidate ? id : `${id}#${streamVersion}`;
      return (
        <Suspense
          key={suspenseKey}
          fallback={
            <PartialErrorBoundary partialId={id} fallback={errorWith}>
              {fallback}
            </PartialErrorBoundary>
          }
        >
          <PartialErrorBoundary partialId={id} fallback={errorWith}>
            {inner}
          </PartialErrorBoundary>
        </Suspense>
      );
    }
    return (
      <PartialErrorBoundary key={id} partialId={id} fallback={errorWith}>
        {inner}
      </PartialErrorBoundary>
    );
  });

  return (
    <PartialsClient
      mode="cache"
      template={template}
      freshIds={freshIds}
      fingerprints={fpObject}
      debug={debug}
      fetchMs={0}
    >
      {wrappedChildren}
    </PartialsClient>
  );
}
