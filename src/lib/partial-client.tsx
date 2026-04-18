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
/**
 * Return true if the node looks like the outermost wrapper a
 * `<Partial>` renders — a keyed `<Suspense>` (partial with fallback)
 * or a keyed `<PartialErrorBoundary>` (partial without fallback).
 *
 * We can't reliably compare `node.type` against the PartialErrorBoundary
 * class identity — in SSR the class reference can differ from the
 * one this module imports (different module graphs across the RSC /
 * SSR boundary). Instead we detect by the `partialId` prop the Partial
 * component always sets on its wrapper. For the Suspense branch, the
 * key is the partial id and Suspense wraps a PartialErrorBoundary that
 * also carries `partialId` — we detect via `type === Suspense`.
 */
function isPartialWrapper(node: React.ReactElement): boolean {
  if (node.key == null) return false;
  if (node.type === Suspense) return true;
  const props = node.props as { partialId?: unknown };
  return typeof props?.partialId === "string";
}

/**
 * Extract the partial id from a wrapper node.
 *
 * Prefer the `partialId` prop over `node.key`. Flight combines the
 * outer `.map()` key with a client-component's own `key` into a
 * composite string like "page-1,page-1" when a `<Partial>` is
 * produced inside a `.map()`. The `partialId` prop stays clean and
 * is always the source of truth.
 *
 * Suspense (a React built-in) doesn't get double-keyed and doesn't
 * carry `partialId` itself — but its child is the PartialErrorBoundary
 * that does. Fall back to the Suspense `key` (which stays clean) or
 * peek at the direct child's `partialId`.
 */
function getPartialId(node: React.ReactElement): string | null {
  const props = node.props as { partialId?: unknown; children?: unknown };
  if (typeof props.partialId === "string") return props.partialId;
  if (node.type === Suspense) {
    const child = props.children;
    if (isValidElement(child)) {
      const cp = (child as React.ReactElement).props as { partialId?: unknown };
      if (typeof cp.partialId === "string") return cp.partialId;
    }
    if (node.key != null) return String(node.key);
  }
  return null;
}

/** Dispatch a single target — batched via microtask in PartialsClient */
type DispatchFn = (
  target: {
    id: string;
    props?: Record<string, unknown>;
    disableTransition?: boolean;
  },
) => Promise<void>;

/** Options for `usePartial().refetch(props, options)` */
export interface PartialRefetchOptions {
  /**
   * Disable the transition wrapper on commit.
   *
   * Default (`false`): the client wraps the response commit in
   * `startTransition`, so React keeps the current UI visible until
   * the new content is fully ready. No Suspense fallback flash, no
   * per-chunk streaming — the whole refetch appears as one atomic
   * swap. Good for "just swap values" UX (cart badge, prices).
   *
   * `true`: commit without a transition. React shows Suspense
   * fallbacks for pending children and commits Flight chunks as
   * they arrive, giving per-row progressive streaming. Good for
   * search / filter results where per-row reveal improves perceived
   * latency.
   */
  disableTransition?: boolean;
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

  // Placeholder: substitute from cache (placeholders carry the id on key).
  if (node.key != null && isPlaceholder(node)) {
    const id = String(node.key);
    if (id !== skipId) return cache.get(id) ?? node;
  }

  // Partial-shape wrapper: substitute with the cache entry if it
  // differs (this is how nested Partials inside a cached ancestor get
  // refreshed with newer content on refetch). Don't descend into the
  // wrapper's own children — they may be unresolved Flight lazies.
  if (isPartialWrapper(node)) {
    const id = getPartialId(node);
    if (id && id !== skipId) {
      const fresh = cache.get(id);
      if (fresh && fresh !== node) return fresh;
      return node;
    }
  }

  const children = (node.props as any).children;
  if (children == null) return node;
  const newChildren = substituteNested(children, cache, skipId);
  if (newChildren === children) return node;
  // Spread arrays as variadic — see the matching comment in
  // cache.tsx#resolveLazies. Flight-decoded children are arrays
  // even for static JSX siblings, and a bare `cloneElement(node,
  // {}, arr)` triggers React's "unique key" warning.
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren);
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

/**
 * Walk the streamed children tree and cache partial contents by id.
 *
 * Partials are recognized by their outermost wrapper shape (see
 * `isPartialWrapper`): a keyed `<Suspense>` or keyed
 * `<PartialErrorBoundary>`. The key is the partial id. Once we cache
 * a partial, we do NOT descend into it — children may be unresolved
 * Flight lazies.
 *
 * Placeholders (`<i data-partial hidden key={id}>`) are skipped too —
 * the existing cache entry from a prior render backs the template.
 * Everything else recurses normally.
 */
function cacheFromStreamingChildren(
  node: ReactNode,
  cache: Map<string, ReactNode>,
): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache);
    }
    return;
  }
  const unwrapped = unwrapLazy(node);
  if (unwrapped !== node) {
    cacheFromStreamingChildren(unwrapped as ReactNode, cache);
    return;
  }
  if (!isValidElement(node)) return;

  if (isPartialWrapper(node)) {
    const id = getPartialId(node);
    if (id) cache.set(id, node);
    return; // don't descend — children may be lazy refs
  }
  if (isPlaceholder(node)) {
    // Placeholder means "server skipped this partial; client keeps
    // its existing cache entry." Don't overwrite and don't descend.
    return;
  }

  const inner = (node.props as any)?.children;
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache);
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
 * Register a partial's fingerprint from the client side.
 *
 * Called by `<PartialErrorBoundary>` during its render, which is how
 * each `<Partial>`'s fingerprint gets into `_fingerprints` without a
 * server prop round-trip. Later `getCachedPartialIds()` reads from
 * here to tell the server what's already cached.
 */
export function registerClientPartial(id: string, fingerprint: string): void {
  _fingerprints.set(id, fingerprint);
}

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
        disableTransition: options?.disableTransition,
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
  debug,
  fetchMs,
  children,
}: PartialsClientProps) {
  const cache = _cache;

  // ── Microtask-batched dispatch ────────────────────────────────────
  const batchRef = useRef<
    Array<{
      id: string;
      props?: Record<string, unknown>;
      disableTransition?: boolean;
    }>
  >([]);
  const flushRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);

  const flush = useCallback(
    async (
      targets: Array<{
        id: string;
        props?: Record<string, unknown>;
        disableTransition?: boolean;
      }>,
    ) => {
      const url = new URL(window.location.href);

      if (targets.some((t) => t.disableTransition)) {
        url.searchParams.set("disableTransition", "1");
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

      if (_cache.size === 0) {
        // First refetch after streaming render: cache is empty.
        // Request ALL partials to populate the cache.
        const allIds = [..._fingerprints.keys()];
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
  //
  // Cache is populated from the streamed children by walking for keyed
  // `<Suspense>` elements — that's what `<Partial>` emits. Placeholders
  // (`<i data-partial hidden>`) are left alone so the existing cache
  // entry from a prior render still backs the template.
  //
  // Fingerprints land in `_fingerprints` via `PartialErrorBoundary`'s
  // render-time `registerClientPartial` call — no props plumbing here.
  if (mode === "streaming") {
    cacheFromStreamingChildren(children, cache);
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
    if (!isValidElement(child)) return;
    const id = isPartialWrapper(child) ? getPartialId(child) : (child.key != null ? String(child.key) : null);
    if (id) cache.set(id, child);
  });

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
