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
import { Partial, type PartialProps } from "./partial-component.tsx";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { getRequest } from "../framework/context.ts";
import { djb2 as hashFingerprint } from "./hash.ts";

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
  /** Suspense fallback for streaming */
  fallback: ReactNode;
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
): ReactNode[] {
  const result: ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      result.push(child);
      return;
    }
    if (isPartialElement(child)) {
      const { id, fallback } = child.props;
      // Apply __inputs override (from usePartial().refetch({...})) to the
      // Partial's content (which is a single child element in the common case).
      const override = overrides[id];
      let content = override ? applyInputs(child.props.children, override) : child.props.children;
      // Recurse into content to handle nested Partials
      const transformedContent = transformForStreaming(content, counter, overrides, version);
      const inner = transformedContent.length === 1 ? transformedContent[0] : transformedContent;

      if (fallback != null) {
        // Empty version ⇒ bare key (revalidate mode): client adopts the
        // previously cached stamped key so React reconciles in place.
        const suspenseKey = version ? `${id}#${version}` : id;
        result.push(
          <Suspense
            key={suspenseKey}
            fallback={
              <PartialErrorBoundary partialId={id}>
                {fallback}
              </PartialErrorBoundary>
            }
          >
            <PartialErrorBoundary partialId={id}>
              {inner}
            </PartialErrorBoundary>
          </Suspense>,
        );
      } else {
        result.push(
          <PartialErrorBoundary key={id} partialId={id}>
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

  // Compute fingerprints for all partials (cheap — walks element tree, no rendering)
  const fingerprints = new Map<string, string>();
  for (const entry of allPartials) {
    fingerprints.set(
      entry.id,
      hashFingerprint(fingerprintElement(entry.content)),
    );
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

  // ── Determine rendering mode ──────────────────────────────────────
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
  const hasGlobalFilter = partialsParam != null || tagsParam != null;
  const populateCache = requestUrl.searchParams.has("__populateCache");
  const isPartialRefetch = hasGlobalFilter || populateCache;

  // Revalidate mode: use bare Suspense keys so the client reconciles in
  // place (instead of remounting). Combined with a transition on the
  // client, this preserves old content while fresh content loads — no
  // fallback flash on the cart badge, etc.
  const isRevalidate = requestUrl.searchParams.has("revalidate");

  // Per-request version stamp used in Suspense keys. See streamVersion doc.
  const streamVersion = isRevalidate
    ? ""
    : `${requestUrl.searchParams.get("n") ?? ""}-${Date.now()}`;

  // When populateCache is set, override filters to render all partials.
  const effectiveRequestedIds = populateCache ? null : requestedIds;

  const activeEntries = allPartials.filter((e) => {
    if (effectiveRequestedIds && !effectiveRequestedIds.has(e.id)) return false;
    if (partialInputs[e.id]) return true; // __inputs override → always render
    return true;
  });

  const freshIds = activeEntries.map((e) => e.id);

  // Apply partial input overrides, strip nested partials from content.
  const activeChildren = activeEntries.map((e) => {
    const overrides = partialInputs[e.id];
    let content = overrides ? applyInputs(e.content, overrides) : e.content;
    const stripped = nestedIds.has(e.id) ? content : stripNested(content, nestedIds);
    return { id: e.id, content: stripped, fallback: e.fallback };
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

  // Structural template shared across both modes: preserves keyless wrappers,
  // partials become placeholders. PartialsClient fills placeholders from its
  // cache in both streaming and cache modes so the rendered tree shape is
  // identical across the streaming→cache transition (no fallback flash on
  // the first user interaction after a streaming render).
  const template = buildTemplate(children);

  // ── Streaming mode (full render) ──────────────────────────────────
  if (!isPartialRefetch || populateCache) {
    return (
      <PartialsClient
        mode="streaming"
        template={template}
        freshIds={freshIds}
        fingerprints={fpObject}
        debug={debug}
        fetchMs={0}
      >
        {transformForStreaming(children, { v: 0 }, partialInputs, streamVersion)}
      </PartialsClient>
    );
  }

  // ── Cache mode (partial refetch) ───────────────────────────────────

  // Wrap each fresh partial to match streaming-mode wrapping exactly so
  // that the client reconciles in place across mode switches.
  const wrappedChildren = activeChildren.map(({ id, content, fallback }) => {
    if (fallback != null) {
      const suspenseKey = isRevalidate ? id : `${id}#${streamVersion}`;
      return (
        <Suspense
          key={suspenseKey}
          fallback={
            <PartialErrorBoundary partialId={id}>
              {fallback}
            </PartialErrorBoundary>
          }
        >
          <PartialErrorBoundary partialId={id}>{content}</PartialErrorBoundary>
        </Suspense>
      );
    }
    return (
      <PartialErrorBoundary key={id} partialId={id}>
        {content}
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
