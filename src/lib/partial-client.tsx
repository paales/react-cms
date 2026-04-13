"use client";

/**
 * Client-side partial merge coordinator.
 *
 * Receives a structural template (layout with partial placeholders)
 * and fresh partial content. Caches partials across renders and fills
 * the template from cache on every render.
 *
 * On full renders: all partials are fresh → cache fully populated.
 * On partial renders: only requested partials update the cache.
 * The template is always the same structural layout (main, footer, etc.),
 * so keyless wrappers are preserved across partial updates.
 *
 * Nested partials are supported: if "cart" is nested inside "header",
 * refreshing "header" re-renders the header layout but keeps cached
 * cart. Refreshing "cart" patches just the cart into cached header.
 */

import React, {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useState,
  useRef,
  type ReactNode,
} from "react";

type RefetchFn = (
  partialId: string,
  props?: Record<string, unknown>,
) => Promise<void>;

const PartialRefetchContext = createContext<RefetchFn>(async () => {
  throw new Error("usePartial must be used inside a Partials");
});

const PartialNamespaceContext = createContext<string>("");

export interface PartialDebugEntry {
  id: string;
  status: "fresh" | "cached" | "data-cached";
  fingerprint: string;
  query: string | null;
}

interface PartialsClientProps {
  /**
   * Rendering mode:
   * - "streaming": passthrough — renders children directly in the tree.
   *   Used on full page renders so Suspense boundaries stay in the server
   *   component tree and can stream.
   * - "cache": template + cache merge — the existing behavior.
   *   Used on partial re-fetches where only requested partials are fresh
   *   and the rest are served from the client cache.
   */
  mode?: "streaming" | "cache";
  template: ReactNode;
  namespace: string;
  freshIds: string[];
  /** Partial fingerprints: { partialId: hash } — used for cache invalidation */
  fingerprints: Record<string, string>;
  /** Per-partial debug metadata */
  debug: PartialDebugEntry[];
  /** Total fetch time for all parallel queries */
  fetchMs: number;
  children: ReactNode;
}

/**
 * Clone an element tree, replacing any keyed child whose cache entry
 * differs from the current child. Recurses into replacements to handle
 * deeply nested partials (e.g., header > nav > cart).
 */
function patchNested(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  visited = new Set<string>(),
): ReactNode {
  if (!isValidElement(node) || !(node.props as any).children) return node;

  let changed = false;
  const patched: ReactNode[] = [];

  Children.forEach((node.props as any).children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const key = String(child.key);
      const cached = cache.get(key);
      if (cached && cached !== child && !visited.has(key)) {
        // Replace with cached version, then recurse to patch ITS nested partials.
        // Track the key to prevent infinite recursion when error boundary
        // wrappers share the same key as their inner partial child.
        visited.add(key);
        patched.push(patchNested(cached, cache, visited));
        changed = true;
        return;
      }
    }
    const p = patchNested(child, cache, visited);
    if (p !== child) changed = true;
    patched.push(p);
  });

  return changed ? cloneElement(node, {}, ...patched) : node;
}

/**
 * Walk the structural template, filling partial placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached partial content.
 */
function isPlaceholder(child: React.ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true;
}

function renderTemplate(
  template: ReactNode,
  cache: Map<string, ReactNode>,
): ReactNode[] {
  const result: ReactNode[] = [];

  Children.forEach(template, (child) => {
    if (isValidElement(child) && child.key != null && isPlaceholder(child)) {
      // Partial placeholder — fill from cache, then patch nested partials
      const cached = cache.get(String(child.key));
      if (cached) {
        result.push(patchNested(cached, cache));
      }
    } else if (isValidElement(child) && (child.props as any).children) {
      // Structural wrapper (html, body, main, footer) — recurse into it
      const inner = renderTemplate((child.props as any).children, cache);
      result.push(cloneElement(child, {}, ...inner));
    } else {
      result.push(child);
    }
  });

  return result;
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 */
/**
 * Module-level registry of cached partial tokens across ALL PartialsClient
 * instances. Each instance registers its tokens keyed by namespace.
 * getCachedPartialIds() merges them into a single list for ?cached=.
 */
const _tokensByNamespace = new Map<string, string[]>();
export function getCachedPartialIds(): string[] {
  return [..._tokensByNamespace.values()].flat();
}

/**
 * Hook to interact with a partial from any client component.
 *
 * Returns `refetch(props?)`:
 *   - With props: re-render the partial with overridden props (query-like)
 *   - Without props: re-render with current/default props (invalidation)
 *
 * `isPending` is true while the server is rendering the partial.
 */
export function usePartial(partialId: string) {
  const refetchFn = useContext(PartialRefetchContext);
  const namespace = useContext(PartialNamespaceContext);
  const [isPending, setIsPending] = useState(false);

  // Apply namespace prefix — the server expects namespaced IDs in URL params
  const namespacedId = `${namespace}/${partialId}`;

  const refetch = useCallback(
    (props?: Record<string, unknown>) => {
      setIsPending(true);
      refetchFn(namespacedId, props).finally(() => setIsPending(false));
    },
    [namespacedId, refetchFn],
  );

  return { refetch, isPending };
}

export function PartialsClient({
  mode = "cache",
  template,
  namespace,
  fingerprints,
  debug,
  fetchMs,
  children,
}: PartialsClientProps) {
  const cacheRef = useRef(new Map<string, ReactNode>());
  const fpRef = useRef(new Map<string, string>());
  const debugRef = useRef<PartialDebugEntry[]>([]);

  // Namespace prefix for cache tokens exposed to the browser entry
  const prefix = `${namespace}/`;

  // Refetch handler: builds a URL with ?partials=id and optional __inputs,
  // then triggers a fetch through the browser entry's RSC pipeline.
  //
  // On the first refetch after a streaming render, the cache is empty.
  // We detect this and request ALL partial IDs to populate the cache.
  // Subsequent refetches use the populated cache normally.
  const refetchPartial: RefetchFn = useCallback(
    async (partialId, props) => {
      const url = new URL(window.location.href);
      if (props) {
        url.searchParams.set(
          "__inputs",
          JSON.stringify({ [partialId]: props }),
        );
      }

      if (cacheRef.current.size === 0) {
        // First refetch after streaming render: cache is empty.
        // Request ALL partials for this namespace to populate the cache.
        // getCachedPartialIds() is also empty (streaming mode cleared
        // _tokensByNamespace), so fetchRscPayload won't add ?cached=.
        const allIds = [...fpRef.current.keys()].map(
          (id) => `${prefix}${id}`,
        );
        url.searchParams.set("partials", allIds.join(","));
      } else {
        // Normal refetch: request only the target partial.
        // Excludes the target from ?cached= so the server re-renders it.
        url.searchParams.set("partials", partialId);
        const cached = getCachedPartialIds().filter(
          (t) => !t.startsWith(`${partialId}:`),
        );
        if (cached.length > 0) {
          url.searchParams.set("cached", cached.join(","));
        }
      }

      const handler = (window as any).__rsc_partial_refetch as
        | ((url: string) => Promise<void>)
        | undefined;
      if (handler) await handler(url.toString());
    },
    [prefix],
  );

  // ── Streaming mode ──────────────────────────────────────────────────
  // Passthrough: children are rendered directly in the tree so Suspense
  // boundaries stay in the server component tree and can stream.
  // We update fingerprints (for the refetch handler) but do NOT register
  // tokens in _tokensByNamespace — the cache isn't populated yet, so
  // getCachedPartialIds() returns nothing until the first cache-mode
  // render populates it via __populateCache.
  //
  // NOTE: RSC-serialized children contain lazy references that cannot be
  // cached and reused in renderTemplate. The __populateCache mechanism
  // in entry.rsc.tsx handles the transition by rendering ALL partials in
  // cache mode on the first action after streaming.
  if (mode === "streaming") {
    for (const [id, fp] of Object.entries(fingerprints)) {
      fpRef.current.set(id, fp);
    }

    // Clear any stale tokens from a previous cache-mode render
    _tokensByNamespace.delete(namespace);

    return (
      <PartialRefetchContext value={refetchPartial}>
        <PartialNamespaceContext value={namespace}>
          {children}
          <PartialDebugPanel entries={debug} fetchMs={fetchMs} />
        </PartialNamespaceContext>
      </PartialRefetchContext>
    );
  }

  // ── Cache mode ──────────────────────────────────────────────────────
  // Template + cache merge: fresh children update the cache, the template
  // is filled from cache. Used on partial re-fetches.

  // Index fresh partials by key (direct children only — nested partials
  // arrive as their own independent entries, not buried inside parents)
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      cacheRef.current.set(String(child.key), child);
    }
  });

  // Update fingerprints — always take the server's latest fingerprints
  for (const [id, fp] of Object.entries(fingerprints)) {
    fpRef.current.set(id, fp);
  }

  // Merge debug info: fresh entries replace, cached entries persist
  const freshDebugIds = new Set(debug.map((d) => d.id));
  debugRef.current = [
    // Keep previous entries for partials not in this render
    ...debugRef.current.filter(
      (d) => !freshDebugIds.has(d.id) && cacheRef.current.has(d.id),
    ),
    // Add/update entries from this render
    ...debug,
  ];

  // Register this instance's cached tokens by namespace
  _tokensByNamespace.set(
    namespace,
    [...cacheRef.current.keys()].map((id) => {
      const fp = fpRef.current.get(id);
      return fp ? `${prefix}${id}:${fp}` : `${prefix}${id}`;
    }),
  );

  // Fill the structural template with cached partials
  return (
    <PartialRefetchContext value={refetchPartial}>
      <PartialNamespaceContext value={namespace}>
        {renderTemplate(template, cacheRef.current)}
        <PartialDebugPanel entries={debugRef.current} fetchMs={fetchMs} />
      </PartialNamespaceContext>
    </PartialRefetchContext>
  );
}

function PartialDebugPanel({
  entries,
  fetchMs,
}: {
  entries: PartialDebugEntry[];
  fetchMs: number;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const freshCount = entries.filter((e) => e.status === "fresh").length;
  const dataCachedCount = entries.filter((e) => e.status === "data-cached").length;
  const cachedCount = entries.filter((e) => e.status === "cached").length;
  const queryCount = entries.filter((e) => e.query).length;

  return (
    <details
      style={{
        background: "#111",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "1rem",
        marginTop: "2rem",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          color: "#888",
          fontSize: "0.85rem",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <span>Partials</span>
        <span style={{ color: "#8b8" }}>{freshCount} fresh</span>
        {dataCachedCount > 0 && (
          <span style={{ color: "#8bd" }}>{dataCachedCount} data-cached</span>
        )}
        {cachedCount > 0 && (
          <span style={{ color: "#bb8" }}>{cachedCount} cached</span>
        )}
        <span style={{ color: "#88b" }}>
          {queryCount} {queryCount === 1 ? "query" : "queries"}
        </span>
        <span style={{ color: "#666" }}>{fetchMs}ms</span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              borderTop: "1px solid #222",
              padding: "0.5rem 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                cursor: entry.query ? "pointer" : "default",
              }}
              onClick={() =>
                entry.query &&
                setExpandedId(expandedId === entry.id ? null : entry.id)
              }
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    entry.status === "fresh"
                      ? "#48bb78"
                      : entry.status === "data-cached"
                        ? "#63b3ed"
                        : "#ecc94b",
                  flexShrink: 0,
                }}
              />
              <code style={{ color: "#ededed", fontSize: "0.8rem" }}>
                {entry.id}
              </code>
              <span style={{ color: "#666", fontSize: "0.75rem" }}>
                {entry.status}
              </span>
              <span style={{ color: "#444", fontSize: "0.7rem", marginLeft: "auto" }}>
                fp:{entry.fingerprint}
              </span>
              {entry.query && (
                <span style={{ color: "#555", fontSize: "0.75rem" }}>
                  {expandedId === entry.id ? "\u25BC" : "\u25B6"}
                </span>
              )}
            </div>
            {expandedId === entry.id && entry.query && (
              <pre
                style={{
                  fontSize: "0.7rem",
                  color: "#8b8",
                  whiteSpace: "pre-wrap",
                  marginTop: "0.5rem",
                  padding: "0.5rem",
                  background: "#0a0a0a",
                  borderRadius: 4,
                  maxHeight: 300,
                  overflow: "auto",
                }}
              >
                {entry.query}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
