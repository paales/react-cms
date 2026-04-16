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
  Suspense,
  useCallback,
  useContext,
  useState,
  useRef,
  type ReactNode,
} from "react";

/** Dispatch a single target — batched via microtask in PartialsClient */
type DispatchFn = (
  target: {
    id: string;
    props?: Record<string, unknown>;
    revalidate?: boolean;
  },
) => Promise<void>;

/** Options for `usePartial().refetch(props, options)` */
export interface PartialRefetchOptions {
  /**
   * Revalidate mode: preserve the current Suspense content while fresh
   * content loads (no fallback flash). Default: false (fresh mount — fallback
   * shows immediately). Overrides the action-level default.
   */
  revalidate?: boolean;
}

const PartialRefetchContext = createContext<DispatchFn>(async () => {
  throw new Error("usePartial must be used inside a PartialRoot");
});

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
 * Walk the structural template, filling partial placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached partial content.
 *
 * IMPORTANT: cached partials are pushed as-is with NO traversal of their
 * own children. The Suspense boundaries inside cached partials have lazy
 * refs (from the RSC Flight stream) as `props.children`; any `React.Children.*`
 * helper on those thenables causes React to resolve them during reconcile
 * instead of showing a fallback on remount, which breaks progressive
 * streaming on refetch. See STREAMING_DEBUG_NOTES.md §7-8.
 */
function isPlaceholder(child: React.ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true;
}

/**
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that partial id.
 */
function substituteNested(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  skipId: string,
): ReactNode {
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((c) => {
      const s = substituteNested(c, cache, skipId);
      if (s !== c) changed = true;
      return s;
    });
    return changed ? mapped : node;
  }

  // Flight lazy refs appear as children of cached client-component
  // boundaries (e.g. `<PartialErrorBoundary>{lazyRef}</PartialErrorBoundary>`
  // where the server was still streaming when the cache was
  // populated). By the time a refetch lands they've been resolved —
  // unwrap so we can descend into the nested tree and find keyed
  // partials to swap. Pending / errored lazies return null; we treat
  // them as opaque and leave the original node in place.
  const unwrapped = unwrapLazy(node);
  if (unwrapped !== node) {
    if (unwrapped == null) return node;
    return substituteNested(unwrapped as ReactNode, cache, skipId);
  }

  if (!isValidElement(node)) return node;

  const keyStr = node.key != null ? String(node.key) : null;
  if (keyStr) {
    const hashIdx = keyStr.indexOf("#");
    const partialId = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
    if (partialId !== skipId) {
      if (isPlaceholder(node)) {
        return cache.get(partialId) ?? node;
      }
      const fresh = cache.get(partialId);
      if (fresh && fresh !== node) return fresh;
    }
  }

  // Don't walk into Suspense — children may be lazy RSC refs
  if (node.type === Suspense) return node;

  const children = (node.props as any).children;
  if (children == null) return node;
  const newChildren = substituteNested(children, cache, skipId);
  if (newChildren === children) return node;
  return cloneElement(node, {}, newChildren);
}

const LAZY_SYMBOL_STR = "Symbol(react.lazy)";

/**
 * Unwrap a raw lazy reference at the tree level.
 */
function unwrapLazy(node: unknown): unknown {
  if (node == null || typeof node !== "object") return node;
  const n = node as any;
  if (typeof n.$$typeof !== "symbol") return node;
  if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node;
  const payload = n._payload;
  if (payload && payload._status === 1) return payload._result;
  try {
    const init = n._init;
    if (typeof init === "function") return init(payload);
  } catch {
    // Pending/errored — treat as opaque
  }
  return null;
}

function cacheFromStreamingChildren(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  freshIds: Set<string>,
): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache, freshIds);
    }
    return;
  }
  const unwrapped = unwrapLazy(node);
  if (unwrapped !== node) {
    cacheFromStreamingChildren(unwrapped as ReactNode, cache, freshIds);
    return;
  }
  if (!isValidElement(node)) return;

  const keyStr = node.key != null ? String(node.key) : null;
  if (keyStr) {
    const hashIdx = keyStr.indexOf("#");
    const partialId = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
    if (freshIds.has(partialId)) {
      cache.set(partialId, node);
      if (node.type === Suspense) return;
    }
  }

  const inner = (node.props as any)?.children;
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache, freshIds);
  }
}

function renderTemplate(
  template: ReactNode,
  cache: Map<string, ReactNode>,
): ReactNode[] {
  const result: ReactNode[] = [];

  Children.forEach(template, (child) => {
    if (!isValidElement(child)) {
      result.push(child);
      return;
    }
    if (child.key != null && isPlaceholder(child)) {
      const id = String(child.key);
      const cached = cache.get(id);
      if (cached) result.push(substituteNested(cached, cache, id));
      return;
    }
    if ((child.props as any).children != null) {
      const inner = renderTemplate((child.props as any).children, cache);
      result.push(cloneElement(child, {}, ...inner));
    } else {
      result.push(child);
    }
  });

  return result;
}

/**
 * Module-level global state.
 *
 * Lives outside the React tree so it survives the two-phase void→payload
 * remount in entry.browser.tsx. Without this, each refetch would wipe the
 * cache and force every partial to re-render.
 */
const _cache = new Map<string, ReactNode>();
const _fingerprints = new Map<string, string>();
let _debug: PartialDebugEntry[] = [];

/**
 * Transient search-params for the next partial refetch.
 * Written via `usePartialParams`, consumed (and cleared) by `flush`.
 *
 * Purpose: give Partial-mode callers the same server-side effect as URL
 * mode (server reads `?q=p` from the request URL and evaluates JSX gates
 * against it) without mutating `window.location` or the browser history.
 *
 * A `null` value deletes the param; a string sets it.
 */
let _transientParams: Record<string, string | null> | null = null;

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = [];
  for (const id of _cache.keys()) {
    const fp = _fingerprints.get(id);
    out.push(fp ? `${id}:${fp}` : id);
  }
  return out;
}

/**
 * Hook: set transient search-params for the next partial refetch.
 *
 * Returned setter writes params into a transient store; the next refetch
 * picks them up, merges them into its fetch URL, and clears the store.
 * Never touches `window.location` or `history`.
 */
export function usePartialParams(): (
  params: Record<string, string | null>,
) => void {
  return useCallback((params: Record<string, string | null>) => {
    _transientParams = { ...(_transientParams ?? {}), ...params };
  }, []);
}

/**
 * Hook to interact with a partial — like useActionState for sections.
 *
 * Binds to one partial by ID. Returns [dispatch, isPending]:
 *
 *   const [dispatch, isPending] = usePartial("search");
 *   dispatch({ query: "bulba" });
 */
export function usePartial(
  partialId: string,
): [
  (
    props?: Record<string, unknown>,
    options?: PartialRefetchOptions,
  ) => Promise<void>,
  boolean,
] {
  const dispatchFn = useContext(PartialRefetchContext);
  const [isPending, setIsPending] = useState(false);

  const dispatch = useCallback(
    (
      props?: Record<string, unknown>,
      options?: PartialRefetchOptions,
    ): Promise<void> => {
      setIsPending(true);
      const p = dispatchFn({
        id: partialId,
        props,
        revalidate: options?.revalidate,
      }).finally(() => setIsPending(false));
      return p;
    },
    [partialId, dispatchFn],
  );

  return [dispatch, isPending];
}

export function PartialsClient({
  mode = "cache",
  template,
  freshIds,
  fingerprints,
  debug,
  fetchMs,
  children,
}: PartialsClientProps) {
  const cache = _cache;
  const fps = _fingerprints;

  // ── Microtask-batched dispatch ────────────────────────────────────
  const batchRef = useRef<
    Array<{
      id: string;
      props?: Record<string, unknown>;
      revalidate?: boolean;
    }>
  >([]);
  const flushRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);

  const flush = useCallback(
    async (
      targets: Array<{
        id: string;
        props?: Record<string, unknown>;
        revalidate?: boolean;
      }>,
    ) => {
      const url = new URL(window.location.href);

      if (targets.some((t) => t.revalidate)) {
        url.searchParams.set("revalidate", "1");
      }

      // Apply (and clear) any transient search-params set via usePartialParams.
      if (_transientParams) {
        for (const [k, v] of Object.entries(_transientParams)) {
          if (v == null) url.searchParams.delete(k);
          else url.searchParams.set(k, v);
        }
        _transientParams = null;
      }

      const inputs: Record<string, Record<string, unknown>> = {};
      for (const t of targets) {
        if (t.props) inputs[t.id] = t.props;
      }
      if (Object.keys(inputs).length > 0) {
        url.searchParams.set("__inputs", JSON.stringify(inputs));
      }

      const targetIds = targets.map((t) => t.id);

      if (cache.size === 0) {
        // First refetch after streaming render: cache is empty.
        // Request ALL partials to populate the cache.
        const allIds = [...fps.keys()];
        url.searchParams.set("partials", allIds.join(","));
      } else {
        url.searchParams.set("partials", targetIds.join(","));
        const targetPrefixes = targetIds.map((id) => `${id}:`);
        const cached = getCachedPartialIds().filter(
          (t) => !targetPrefixes.some((p) => t.startsWith(p)),
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
    [],
  );

  const dispatchFn: DispatchFn = useCallback(
    (target) => {
      batchRef.current.push(target);

      if (!flushRef.current) {
        let resolve: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        flushRef.current = { promise, resolve: resolve! };

        queueMicrotask(() => {
          const targets = batchRef.current;
          const { resolve: done } = flushRef.current!;
          batchRef.current = [];
          flushRef.current = null;
          flush(targets).then(done);
        });
      }

      return flushRef.current.promise;
    },
    [flush],
  );

  // ── Streaming mode ──────────────────────────────────────────────────
  if (mode === "streaming") {
    for (const [id, fp] of Object.entries(fingerprints)) {
      fps.set(id, fp);
    }
    const prevCache = new Map(cache);
    cache.clear();
    cacheFromStreamingChildren(children, cache, new Set(freshIds));
    for (const [id, node] of cache) {
      if (!isValidElement(node) || node.key == null) continue;
      const rawKey = String(node.key);
      if (rawKey.indexOf("#") >= 0) continue;
      const prev = prevCache.get(id);
      if (
        prev &&
        isValidElement(prev) &&
        prev.key != null &&
        prev.key !== node.key
      ) {
        cache.set(id, cloneElement(node, { key: prev.key }));
      }
    }
    _debug = [];

    const rendered = renderTemplate(template, cache);
    return (
      <PartialRefetchContext value={dispatchFn}>
        {rendered}
        <PartialDebugPanel entries={debug} fetchMs={fetchMs} />
      </PartialRefetchContext>
    );
  }

  // ── Cache mode ──────────────────────────────────────────────────────
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const rawKey = String(child.key);
      const hashIdx = rawKey.indexOf("#");
      const partialId = hashIdx >= 0 ? rawKey.slice(0, hashIdx) : rawKey;

      let toCache = child;
      if (hashIdx < 0) {
        const prev = cache.get(partialId);
        if (
          prev &&
          isValidElement(prev) &&
          prev.key != null &&
          prev.key !== child.key
        ) {
          toCache = cloneElement(child, { key: prev.key });
        }
      }
      cache.set(partialId, toCache);
    }
  });

  for (const [id, fp] of Object.entries(fingerprints)) {
    fps.set(id, fp);
  }

  const freshDebugIds = new Set(debug.map((d) => d.id));
  _debug = [
    ..._debug.filter((d) => !freshDebugIds.has(d.id) && cache.has(d.id)),
    ...debug,
  ];

  const rendered = renderTemplate(template, cache);
  return (
    <PartialRefetchContext value={dispatchFn}>
      {rendered}
      <PartialDebugPanel entries={_debug} fetchMs={fetchMs} />
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
