/**
 * Partial Architecture
 *
 * Pages are flat lists of partials. Each partial is independently
 * re-renderable — like Shopify's section rendering for React.
 *
 * <Partials namespace="pokemon">
 *   <header key="header">static content</header>
 *   <HeroPartial key="hero" pokemonId={1} />
 *   <main>
 *     <ProductGrid key="products" search={search} />
 *   </main>
 * </Partials>
 *
 * The `key` of each child is its partial ID. Keyless elements like
 * <main> and <footer> are structural wrappers — preserved in layout
 * but transparent to the partial system.
 *
 * Nested partials are first-class: `<div key="header"><Cart key="cart" /></div>`
 * renders cart independently of its parent. Refreshing "header" re-renders
 * the header layout but keeps the cached cart. Refreshing "cart" patches
 * just the cart into the cached header. Refreshing both updates everything.
 *
 * All partials render as flat siblings — the JSX nesting is a layout
 * declaration, not a render tree. This enforces isolation: a parent
 * partial can never provide React context to a nested child partial.
 *
 * On full page render: all partials render.
 * On partial re-fetch (?partials=hero,stats): only those partials render.
 * The client PartialsClient merges fresh partials with its cache,
 * so non-requested partials remain visible.
 *
 * Namespace: when multiple Partials instances are nested and may share
 * key names, use the `namespace` prop to disambiguate. IDs are prefixed
 * with `namespace/` in all communication (URL params, cache, debug).
 */

import React, { Suspense, type ReactNode } from "react";
import {
  PartialsClient,
  type PartialDebugEntry,
} from "./partial-client.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getRequest } from "../framework/context.ts";

interface PartialsProps {
  children: ReactNode;
  /** Namespace prefix for partial IDs — required to disambiguate nested Partials instances */
  namespace: string;
}

/**
 * Reserved props accepted by partial elements.
 * Stripped by the orchestrator before rendering the component.
 *
 * Use at the call site to allow `tags` and `cache` on your component:
 *
 *   function CartBadge(props: PartialProps<{ quantity: number }>) { ... }
 *   <CartBadge key="cart" quantity={3} tags={["cart"]} cache={60} />
 */
export type PartialProps<P = {}> = P & {
  tags?: string[];
  cache?: number;
  fallback?: ReactNode;
};

/** Props reserved by the Partials system — stripped before rendering the component. */
const RESERVED_PROPS = new Set(["tags", "cache", "fallback"]);

interface PartialEntry {
  id: string;
  element: React.ReactElement;
  depth: number;
  /** Invalidation tags declared via `tags` prop */
  tags: string[];
  /** Data cache TTL in seconds (0 = no cache, default) */
  cacheTtl: number;
  /** Suspense fallback for streaming */
  fallback: ReactNode;
}

/**
 * Compute a lightweight fingerprint of a React element tree.
 *
 * Walks the element structure as plain data — no component functions
 * are called. Inspects type (tag name or component name), key, and
 * non-children props. Recurses into children.
 *
 * Used to detect when a cached partial's shape has changed between
 * pages (e.g., header gains controls on the detail page).
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

  // Include non-children props that affect shape (skip event handlers, objects, reserved)
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || RESERVED_PROPS.has(k)) continue;
    if (typeof v === "function") continue;
    if (typeof v === "object" && v !== null) continue;
    parts.push(`${k}=${v}`);
  }

  // Recurse into children
  if (props.children != null) {
    parts.push(`(${fingerprintElement(props.children as React.ReactNode)})`);
  }

  return parts.join("|");
}

/** Hash a fingerprint string into a short hex digest. */
function hashFingerprint(fp: string): string {
  // djb2 — fast, non-crypto, sufficient for change detection
  let hash = 5381;
  for (let i = 0; i < fp.length; i++) {
    hash = ((hash << 5) + hash + fp.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Walk the children tree to collect all keyed elements at any depth.
 * Keyless wrappers (main, footer, div without key) are transparent —
 * we recurse into them without incrementing depth.
 */
function collectPartials(children: ReactNode, depth = 0): PartialEntry[] {
  const entries: PartialEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.key != null) {
      const props = child.props as Record<string, unknown>;
      const tags = Array.isArray(props.tags) ? (props.tags as string[]) : [];
      const cacheTtl = typeof props.cache === "number" ? props.cache : 0;
      const fallback = props.fallback != null ? (props.fallback as ReactNode) : null;
      entries.push({
        id: String(child.key),
        element: child,
        depth,
        tags,
        cacheTtl,
        fallback,
      });
      if (props.children) {
        entries.push(...collectPartials(props.children as ReactNode, depth + 1));
      }
    } else if ((child.props as Record<string, unknown>).children) {
      entries.push(...collectPartials((child.props as Record<string, unknown>).children as ReactNode, depth));
    }
  });
  return entries;
}

/**
 * Strip reserved props (tags, cache) from an element before rendering.
 * These are consumed by the Partials orchestrator, not by the component.
 */
function stripReservedProps(element: React.ReactElement): React.ReactElement {
  const props = element.props as Record<string, unknown>;
  const hasReserved = Object.keys(props).some((k) => RESERVED_PROPS.has(k));
  if (!hasReserved) return element;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!RESERVED_PROPS.has(k)) clean[k] = v;
  }
  return React.createElement(element.type as any, {
    ...clean,
    key: element.key,
  });
}

/**
 * Build a structural template from the children tree: keyless wrappers
 * are preserved, keyed partials are replaced with placeholders.
 * The client fills these placeholders from its cache.
 */
function buildTemplate(children: ReactNode, counter = { v: 0 }): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null) {
      // Partial placeholder — client fills from cache
      result.push(
        React.createElement("i", {
          key: child.key,
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
          ...buildTemplate((child.props as Record<string, unknown>).children as ReactNode, counter),
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
 * Replace nested partials inside an element with keyed placeholders.
 * This allows parent partials to render without triggering rendering
 * of their nested children — those render independently.
 */
function stripNested(
  element: React.ReactElement,
  nestedIds: Set<string>,
): React.ReactElement {
  const children = (element.props as Record<string, unknown>).children as ReactNode;
  if (!children) return element;

  let changed = false;
  const result: ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement(child) &&
      child.key != null &&
      nestedIds.has(String(child.key))
    ) {
      result.push(React.createElement("i", { key: child.key, hidden: true }));
      changed = true;
    } else if (React.isValidElement(child)) {
      const stripped = stripNested(child, nestedIds);
      if (stripped !== child) changed = true;
      result.push(stripped);
    } else {
      result.push(child);
    }
  });

  return changed ? React.cloneElement(element, {}, ...result) : element;
}

/**
 * Transform the children tree for streaming mode (full render).
 *
 * Walks the tree in-place, preserving nesting:
 * - Keyed elements with a `fallback` prop → wrapped in Suspense (streams)
 * - Keyed elements without `fallback` → rendered directly (sync)
 * - All keyed elements have reserved props stripped
 * - Nested partials stay in-place (unlike cache mode which extracts them).
 *   On full render, the whole tree renders, so extraction isn't needed.
 * - Keyless wrappers (main, footer) are preserved structurally
 */
function transformForStreaming(children: ReactNode, counter = { v: 0 }): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null) {
      const props = child.props as Record<string, unknown>;
      const fallback = props.fallback as ReactNode | undefined;
      let stripped = stripReservedProps(child);
      // Recurse into children to handle nested keyed elements
      if ((stripped.props as any).children) {
        const inner = transformForStreaming((stripped.props as any).children, counter);
        stripped = React.cloneElement(stripped, {}, ...inner);
      }
      const id = String(child.key);
      if (fallback != null) {
        result.push(
          <Suspense
            key={child.key}
            fallback={
              <PartialErrorBoundary partialId={id}>
                {fallback}
              </PartialErrorBoundary>
            }
          >
            <PartialErrorBoundary partialId={id}>
              {stripped}
            </PartialErrorBoundary>
          </Suspense>,
        );
      } else {
        result.push(
          <PartialErrorBoundary key={child.key} partialId={id}>
            {stripped}
          </PartialErrorBoundary>,
        );
      }
    } else if ((child.props as any).children) {
      // Keyless wrapper — recurse, assign counter key matching buildTemplate's scheme
      // so React preserves the subtree when switching from streaming to cache mode.
      const wrapKey = `_${counter.v++}`;
      const inner = transformForStreaming((child.props as any).children, counter);
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

// ─── Partials ──────────────────────────────────────────────────────────
// Pure orchestrator: collects partials, filters, templates, client merge.
// No data fetching — components are responsible for their own data.

export async function Partials({ children, namespace }: PartialsProps) {
  // Read partials, tags, cached, and partial inputs from the current request URL
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

  // Collect all keyed elements (top-level and nested, through keyless wrappers)
  const allPartials = collectPartials(children);
  const nestedIds = new Set(
    allPartials.filter((e) => e.depth > 0).map((e) => e.id),
  );

  // Build tag → partial ID mapping for tag-based invalidation
  const tagIndex = new Map<string, Set<string>>();
  for (const entry of allPartials) {
    for (const tag of entry.tags) {
      let ids = tagIndex.get(tag);
      if (!ids) {
        ids = new Set();
        tagIndex.set(tag, ids);
      }
      ids.add(entry.id);
    }
  }

  // URL params use namespaced IDs (e.g., ?partials=pokemon/hero).
  // Strip the namespace prefix to match against raw child keys.
  const prefix = `${namespace}/`;

  // Resolve ?tags= to partial IDs via the tag index.
  // Returns null if no tags matched this instance's index (triggers pass-through).
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

  // Resolve ?partials= (by ID) — only IDs matching this namespace
  const partialResolvedIds = partialsParam
    ? new Set(
        partialsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.startsWith(prefix))
          .map((s) => s.slice(prefix.length)),
      )
    : null;

  // If ?partials= was set but no IDs matched our namespace prefix,
  // the filter targets a different namespace → pass through (render all)
  // so nested Partials instances with other namespaces can handle it.
  const partialFilterApplies =
    partialResolvedIds != null && partialResolvedIds.size > 0;

  // Merge applicable filters. Tags are always local (resolved against
  // this instance's tag index). If neither filter applies, render all.
  const requestedIds =
    partialFilterApplies || tagResolvedIds
      ? new Set([
          ...(partialFilterApplies ? partialResolvedIds : []),
          ...(tagResolvedIds ?? []),
        ])
      : null;

  // Strip namespace from __inputs keys
  const resolvedInputs: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(partialInputs)) {
    const rawKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    resolvedInputs[rawKey] = value;
  }

  // Compute fingerprints for all partials (cheap — walks element tree, no rendering)
  const fingerprints = new Map<string, string>();
  for (const entry of allPartials) {
    fingerprints.set(
      entry.id,
      hashFingerprint(fingerprintElement(entry.element)),
    );
  }

  // Parse cached entries: "id:fingerprint,id:fingerprint" or legacy "id,id"
  // Strip namespace prefix from cached tokens too.
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
      // Only process tokens belonging to this namespace
      if (!id.startsWith(prefix)) continue;
      id = id.slice(prefix.length);
      cachedFingerprints.set(id, fp);
    }
  }

  // Pass-through detection: a global filter exists (?partials= or ?tags=) but
  // no IDs matched this namespace → we must render so nested Partials can run.
  const hasGlobalFilter = partialsParam != null || tagsParam != null;
  const isPassthrough = hasGlobalFilter && requestedIds === null;

  // Active entries: partials to render.
  //
  // Three modes:
  // 1. Full navigation (no filter): render all — URL changes can affect output.
  // 2. Explicit filter (?partials=ns/id): only render requested partials.
  // 3. Pass-through (filter targets different namespace): render component-type
  //    partials (which might contain nested Partials) and skip HTML-type partials
  //    whose fingerprint matches (pure markup that can't depend on context).
  // ── Determine rendering mode ──────────────────────────────────────
  //
  // Two modes:
  // 1. Streaming (full render): render children directly in the server tree
  //    so Suspense boundaries can stream. PartialsClient in "streaming" mode
  //    is a thin passthrough that provides refetch context.
  // 2. Cache (partial refetch): PartialsClient in "cache" mode uses template
  //    + cache merge. Only requested partials are fresh; rest from cache.
  //
  // __populateCache is set by entry.rsc.tsx when a server action has
  // invalidation but the client's PartialsClient cache is empty (first
  // action after a streaming render). Forces cache mode with ALL partials
  // to populate the client cache.
  const populateCache = requestUrl.searchParams.has("__populateCache");
  const isPartialRefetch = hasGlobalFilter || populateCache;

  // When populateCache is set, override filters to render all partials.
  const effectiveRequestedIds = populateCache ? null : requestedIds;

  const activeEntries = allPartials.filter((e) => {
    if (effectiveRequestedIds && !effectiveRequestedIds.has(e.id)) return false;
    if (resolvedInputs[e.id]) return true; // __inputs override → always render
    if (isPassthrough && cachedFingerprints.has(e.id)) {
      // HTML elements (div, header, nav, head) can't contain nested Partials
      // or read request context — safe to skip if fingerprint matches.
      // Component types (PokemonPage, MagentoPage) might contain inner Partials
      // or depend on URL params — must always render.
      const isHtmlElement = typeof e.element.type === "string";
      if (isHtmlElement) {
        const clientFp = cachedFingerprints.get(e.id);
        const serverFp = fingerprints.get(e.id);
        if (clientFp != null && clientFp === serverFp) return false;
      }
    }
    return true;
  });

  const freshIds = activeEntries.map((e) => e.id);

  // Apply partial input overrides (from usePartial().refetch({ ... })),
  // strip reserved props (tags, cache), then strip nested partials.
  const activeChildren = activeEntries.map((e) => {
    const overrides = resolvedInputs[e.id];
    let element = overrides
      ? React.cloneElement(e.element, overrides)
      : e.element;
    element = stripReservedProps(element);
    return nestedIds.has(e.id) ? element : stripNested(element, nestedIds);
  });

  // Debug entries
  const activeIdSet = new Set(freshIds);
  const debug: PartialDebugEntry[] = allPartials.map((entry) => ({
    id: entry.id,
    status: activeIdSet.has(entry.id) ? "fresh" : "cached",
    fingerprint: fingerprints.get(entry.id) ?? "",
    query: null,
  }));

  const fpObject = Object.fromEntries(fingerprints);

  // ── Streaming mode (full render) ───────────────────────────────────
  // Render the filled tree directly in the server component tree.
  // Suspense boundaries wrap partials with fallbacks → they stream.
  // PartialsClient in "streaming" mode passes children through.
  if (!isPartialRefetch) {
    return (
      <PartialsClient
        mode="streaming"
        template={null}
        namespace={namespace}
        freshIds={freshIds}
        fingerprints={fpObject}
        debug={debug}
        fetchMs={0}
      >
        {transformForStreaming(children)}
      </PartialsClient>
    );
  }

  // ── Cache mode (partial refetch) ───────────────────────────────────
  // Structural template: preserves keyless wrappers, partials become placeholders.
  // PartialsClient fills placeholders from its cache + fresh children.
  const template = buildTemplate(children);

  const wrappedChildren = activeChildren.map((child) => {
    if (child.key == null) return child;
    const id = String(child.key);
    return (
      <PartialErrorBoundary key={child.key} partialId={id}>
        {child}
      </PartialErrorBoundary>
    );
  });

  return (
    <PartialsClient
      mode="cache"
      template={template}
      namespace={namespace}
      freshIds={freshIds}
      fingerprints={fpObject}
      debug={debug}
      fetchMs={0}
    >
      {wrappedChildren}
    </PartialsClient>
  );
}
