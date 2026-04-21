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
 *
 * Client API surface: `useNavigation()` returns a handle whose
 * `navigate(url, opts)` / `reload(opts)` methods drive every
 * refetch on the page. Targeted refetches are expressed through the
 * `ids` / `tags` options — see {@link NavigateOptions}. There is no
 * `usePartial` or `__inputs`: state must land in a URL (page URL or
 * frame URL), and the client never sends prop overrides.
 */

import React, {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  getNavigation,
  type FrameEntryState,
  type FrameNavigationHistoryEntry,
  type FrameworkNavigateOptions,
  type FrameworkNavigation,
  type FrameworkNavigationResult,
  type FrameworkReloadOptions,
  type NavigateTarget,
} from "../framework/navigation-api.ts";

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
 * streaming on refetch. See notes/archive/STREAMING_DEBUG_NOTES.md §7-8.
 */
function isPlaceholder(child: React.ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true;
}

/**
 * Id for a placeholder `<i>`. Prefer the `data-partial-id` prop, which
 * is stable, over `node.key`, which Flight can composite with an outer
 * `.map()` key into `"outer,inner"` for dynamic Partials.
 */
function getPlaceholderId(node: React.ReactElement): string | null {
  const props = node.props as { ["data-partial-id"]?: unknown };
  if (typeof props["data-partial-id"] === "string") {
    return props["data-partial-id"];
  }
  return node.key != null ? String(node.key) : null;
}

/**
 * Collect the ids of all `<i data-partial>` placeholders in a derived
 * template. `deriveTemplate` replaces every live Partial wrapper (fresh
 * OR previously-skipped) with a placeholder keyed by id, so this set is
 * exactly the top-level Partial ids present on the current page. Used
 * to prune `_cache` entries left over from prior routes.
 */
function collectTemplateIds(node: ReactNode, out: Set<string>): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) collectTemplateIds(child as ReactNode, out);
    return;
  }
  if (!isValidElement(node)) return;
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node);
    if (id) out.add(id);
    return;
  }
  const inner = (node.props as any)?.children;
  if (inner != null) collectTemplateIds(inner, out);
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

  // Placeholder: substitute from cache. Id comes from the
  // `data-partial-id` prop (stable), not the key (Flight composites).
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node);
    if (id && id !== skipId) return cache.get(id) ?? node;
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
 * `<PartialErrorBoundary>`. The key is the partial id.
 *
 * We cache the wrapper AND descend into its children looking for
 * NESTED partial wrappers. Nested partials need their own top-level
 * entries so that after a parent-only refetch (which emits a
 * placeholder for the nested partial inside the parent's new
 * content), the client can still find the nested partial's content
 * by id — otherwise `substituteNested` produces an empty hole.
 *
 * Why we can descend safely: during streaming, inner async chunks
 * arrive as Flight lazies. Walking past a lazy forces React's
 * lazy-init — which is fine because the lazy will resolve
 * eventually, and our walk of the lazy's contents just searches for
 * more partial wrappers (no side effects). `unwrapLazy` returns
 * null for pending lazies, so we stop cleanly if a lazy hasn't
 * resolved yet.
 *
 * Placeholders (`<i data-partial hidden>`) are skipped — the
 * existing cache entry from a prior render is the thing we want.
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
    if (unwrapped == null) return;
    cacheFromStreamingChildren(unwrapped as ReactNode, cache);
    return;
  }
  if (!isValidElement(node)) return;

  if (isPartialWrapper(node)) {
    const id = getPartialId(node);
    if (id) {
      cache.set(id, node);
    }
    // Descend: nested partial wrappers need their own top-level cache
    // entries so subsequent parent-only refetches with inner
    // placeholders can fill the holes.
    const inner = (node.props as any)?.children;
    if (inner != null) cacheFromStreamingChildren(inner, cache);
    return;
  }
  if (isPlaceholder(node)) {
    // Placeholder means "server skipped this partial; client keeps
    // its existing cache entry." Don't overwrite.
    return;
  }

  const inner = (node.props as any)?.children;
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache);
  }
}

/**
 * Walk the streamed children tree and produce a structural template:
 * DOM wrappers and non-partial elements preserved with stable keys,
 * partial wrappers replaced with `<i data-partial hidden key={id}>`
 * placeholders.
 *
 * This is the client-side replacement for the old server-side
 * `buildTemplate` walk. Running on the client means we see the tree
 * AFTER `<Partial>` bodies have decided fresh-vs-skip, so opaque
 * server components only execute once (via the streamed `children`
 * path). No more "Partial inside an opaque component must be wrapped
 * at the callsite" invariant.
 *
 * Same lazy-safety rule as `cacheFromStreamingChildren`: stop at
 * partial wrappers (don't descend into their children, which may be
 * unresolved Flight lazies). Everything non-partial walks freely.
 */
function deriveTemplate(node: ReactNode): ReactNode {
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    return node.map((c) => deriveTemplate(c as ReactNode));
  }
  const unwrapped = unwrapLazy(node);
  if (unwrapped !== node) {
    return deriveTemplate(unwrapped as ReactNode);
  }
  if (!isValidElement(node)) return node;

  if (isPartialWrapper(node)) {
    const id = getPartialId(node);
    return id ? <i key={id} hidden data-partial data-partial-id={id} /> : node;
  }
  if (isPlaceholder(node)) {
    // Already a placeholder (server emitted a fingerprint-match skip);
    // re-emit with a clean key derived from `data-partial-id` to
    // undo any Flight key-composite artifacts (e.g. "page-1,page-1"
    // for .map()-produced placeholders).
    const id = getPlaceholderId(node);
    return id ? <i key={id} hidden data-partial data-partial-id={id} /> : node;
  }

  const inner = (node.props as any)?.children;
  if (inner == null) return node;
  const newInner = deriveTemplate(inner);
  if (newInner === inner) return node;
  return Array.isArray(newInner)
    ? cloneElement(node, {}, ...newInner)
    : cloneElement(node, {}, newInner);
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
    if (isPlaceholder(child)) {
      const id = getPlaceholderId(child);
      if (id) {
        const cached = cache.get(id);
        if (cached) result.push(substituteNested(cached, cache, id));
      }
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
 * Structural layout skeleton, derived from the most recent full-payload
 * render via `deriveTemplate`. Persisted across refetches so the server
 * doesn't need to ship the template bytes on every partial refetch.
 * Re-derived whenever a full payload arrives (covers layout changes
 * across route navigations).
 *
 * Keyed by route (pathname + search). Same-URL refetches reuse the
 * cached template; different-URL navigations re-derive.
 */
let _template: ReactNode = null;

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
 * Module-level accessor for cached partial tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 *
 * Source of truth is `_fingerprints`, not `_cache`. Every rendered
 * Partial — top-level OR deep (`.map()`-generated, nested inside an
 * ancestor's subtree) — registers its fingerprint client-side as its
 * wrapper mounts via `PartialErrorBoundary`. Reporting from
 * `_fingerprints` means the skip-on-unchanged optimization applies
 * uniformly across the entire tree; deep Partials that live inside
 * an ancestor's `_cache` entry (rather than as a standalone key) are
 * reported correctly. See `notes/PARTIAL_ARCHITECTURE.md`.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = [];
  for (const [id, fp] of _fingerprints) {
    out.push(`${id}:${fp}`);
  }
  return out;
}

// ─── Framework-internal navigation info ───────────────────────────
//
// The Navigation API's `info` option is a one-shot payload delivered
// on the resulting `navigate` event. Unlike `state` it is not
// persisted on the history entry, so it's a natural channel for
// signalling intent from initiator to listener.
//
// Two framework-internal navigations need the page-level intercept to
// stand down:
//   - window-scoped silent nav (URL-only update, or caller dispatches
//     its own targeted refetch via `enqueueRefetch`)
//   - frame nav (caller dispatches `_dispatchFrameRefetch` itself)
//
// Both stamp a branded info payload. The listener in
// `entry.browser.tsx` calls `event.intercept()` to declare
// same-document and returns — no refetch.
//
// Any non-framework-branded `info` (user-provided via
// `navigate(url, { info })`) passes straight through as a normal
// page-level navigation.

interface FrameworkSilentInfo {
  __framework: "silent-navigate";
  mode: "window" | "frame";
  name?: string;
}

function makeSilentInfo(
  mode: "window" | "frame",
  name?: string,
): FrameworkSilentInfo {
  return { __framework: "silent-navigate", mode, name };
}

export function isFrameworkSilentInfo(
  info: unknown,
): info is FrameworkSilentInfo {
  return (
    info != null &&
    typeof info === "object" &&
    (info as { __framework?: unknown }).__framework === "silent-navigate"
  );
}

// ─── Microtask-batched targeted-refetch dispatcher ────────────────
//
// Multiple `reload` / `navigate({ids, tags})` calls in the same tick
// coalesce into one refetch request. Keeps tag-fanout and multi-id
// event handlers cheap: three buttons clicked in the same frame
// produce one request with `?partials=a,b,c`.

interface RefetchBatchEntry {
  ids: string[];
  tags: string[];
  disableTransition: boolean;
}

let _batchRef: RefetchBatchEntry[] = [];
let _batchPromise: { promise: Promise<void>; resolve: () => void } | null =
  null;

async function flushRefetchBatch(batch: RefetchBatchEntry[]): Promise<void> {
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (url: string) => Promise<void>;
    }
  ).__rsc_partial_refetch;
  if (!handler) return;

  const ids = new Set<string>();
  const tags = new Set<string>();
  let disableTransition = false;
  for (const entry of batch) {
    for (const id of entry.ids) ids.add(id);
    for (const tag of entry.tags) tags.add(tag);
    if (entry.disableTransition) disableTransition = true;
  }

  const url = new URL(window.location.href);
  if (ids.size > 0) url.searchParams.set("partials", [...ids].join(","));
  if (tags.size > 0) url.searchParams.set("tags", [...tags].join(","));
  if (disableTransition) url.searchParams.set("disableTransition", "1");

  // Send cached fingerprints for the non-target set so the server can
  // skip the unchanged ones via fingerprint-match placeholders.
  if (ids.size > 0) {
    const targetPrefixes = [...ids].map((id) => `${id}:`);
    const cached = getCachedPartialIds().filter(
      (t) => !targetPrefixes.some((p) => t.startsWith(p)),
    );
    if (cached.length > 0) url.searchParams.set("cached", cached.join(","));
  }

  await handler(url.toString());
}

/**
 * Enqueue a targeted refetch. Multiple calls in the same microtask
 * coalesce into one request. Returns a Promise that resolves when
 * the flush completes.
 */
function enqueueRefetch(entry: RefetchBatchEntry): Promise<void> {
  _batchRef.push(entry);
  if (!_batchPromise) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    _batchPromise = { promise, resolve };
    queueMicrotask(() => {
      const batch = _batchRef;
      const done = _batchPromise!.resolve;
      _batchRef = [];
      _batchPromise = null;
      flushRefetchBatch(batch).then(done);
    });
  }
  return _batchPromise.promise;
}

// ─── Frame navigation ─────────────────────────────────────────────

/**
 * Cached frame URLs on the client, keyed by frame name. Updated on
 * each `useNavigation(name).navigate(url)` call so `.currentUrl`
 * can return a synchronous value without a server round-trip. The
 * server session is authoritative — this is a cache for UX.
 */
const _frameUrls = new Map<string, string>();

/**
 * Client-side context carrying the ambient frame name. Populated by
 * `<FrameNameProvider>` (rendered as part of `<Partial frame="X">`).
 * Lets `useNavigation()` default to "the enclosing frame" without every
 * caller having to pass the name explicitly.
 */
export const FrameNameContext = createContext<string | null>(null);

/**
 * Multi-frame URL snapshot carried on each navigation entry. Every
 * pushed entry stores the URL of every known frame so browser
 * back/forward can diff two entries and dispatch refetches for the
 * frames that changed. See `notes/FRAMES.md`.
 */
const FRAMES_KEY = "__frames";

interface FramesSnapshot {
  [frameName: string]: { url: string };
}

/**
 * Read the per-frame URL snapshot from a navigation entry's state.
 * Exported for `entry.browser.tsx`'s traverse listener.
 */
export function _readFramesSnapshot(state: unknown): FramesSnapshot {
  if (state == null || typeof state !== "object") return {};
  const v = (state as Record<string, unknown>)[FRAMES_KEY];
  if (v == null || typeof v !== "object") return {};
  return v as FramesSnapshot;
}

// Local alias for the exported reader.
const readFramesSnapshot = _readFramesSnapshot;

function writeFramesSnapshot(
  priorState: unknown,
  snapshot: FramesSnapshot,
): Record<string, unknown> {
  const base = (priorState as Record<string, unknown> | null) ?? {};
  return { ...base, [FRAMES_KEY]: snapshot };
}

/**
 * Wraps descendants so `useNavigation()` calls inside them bind to this
 * frame by default. Also seeds the current navigation entry's state
 * with this frame's URL on first mount — so browser-back from a
 * later entry can find a "restore to initial" target for the frame.
 */
export function FrameNameProvider({
  name,
  initialUrl,
  children,
}: {
  name: string;
  initialUrl: string;
  children: ReactNode;
}) {
  useEffect(() => {
    // Client cache: so `useNavigation(name).currentUrl` is non-null on cold load.
    if (!_frameUrls.has(name)) {
      _frameUrls.set(name, initialUrl);
    }
    const nav = getNavigation();
    if (!nav) return;
    const current = nav.currentEntry?.getState() ?? null;
    const snap = readFramesSnapshot(current);
    if (!snap[name]) {
      nav.updateCurrentEntry({
        state: writeFramesSnapshot(current, {
          ...snap,
          [name]: { url: initialUrl },
        }),
      });
    }
  }, [name, initialUrl]);
  return <FrameNameContext value={name}>{children}</FrameNameContext>;
}

/**
 * Runs a frame refetch end-to-end: writes the cached URL, builds the
 * refetch URL with `__frame` + `__frameUrl`, dispatches to the RSC
 * refetch handler. Shared between `frame.navigate()` and the browser-
 * traverse listener (which re-invokes it for each frame whose URL
 * differs between the destination entry and the current one).
 */
export async function _dispatchFrameRefetch(
  name: string,
  url: string,
  options?: FrameworkNavigateOptions,
): Promise<void> {
  _frameUrls.set(name, url);
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (url: string) => Promise<void>;
    }
  ).__rsc_partial_refetch;
  if (!handler) return;
  const refetchUrl = new URL(window.location.href);
  refetchUrl.searchParams.set("__frame", name);
  refetchUrl.searchParams.set("__frameUrl", url);
  refetchUrl.searchParams.set("partials", name);
  if (options?.disableTransition) {
    refetchUrl.searchParams.set("disableTransition", "1");
  }
  await handler(refetchUrl.toString());
}

/**
 * Per-frame key for custom state in a Navigation entry's state
 * object. We scope user-provided `updateCurrentEntry` data under
 * `__frameState[name]` so multiple frames can coexist on one entry
 * without clobbering each other.
 */
const FRAME_STATE_KEY = "__frameState";

/**
 * True when some earlier / later entry's frames-snapshot has a
 * different URL for `name` than the current entry does. The user
 * can traverse there to restore that URL.
 */
function computeCanTraverse(
  nav: Navigation,
  name: string,
  direction: "back" | "forward",
): boolean {
  const entries = nav.entries();
  const currentIdx = nav.currentEntry?.index ?? -1;
  if (currentIdx < 0) return false;
  const currentUrl = readFramesSnapshot(entries[currentIdx].getState())[name]
    ?.url;
  const walk =
    direction === "back"
      ? (i: number) => i >= 0 && i < currentIdx
      : (i: number) => i > currentIdx && i < entries.length;
  const step = direction === "back" ? -1 : 1;
  const start = currentIdx + step;
  for (let i = start; walk(i); i += step) {
    const url = readFramesSnapshot(entries[i].getState())[name]?.url;
    if (url && url !== currentUrl) return true;
  }
  return false;
}

function findFrameEntry(
  nav: Navigation,
  name: string,
  direction: "back" | "forward",
): NavigationHistoryEntry | null {
  const entries = nav.entries();
  const currentIdx = nav.currentEntry?.index ?? -1;
  if (currentIdx < 0) return null;
  const currentUrl = readFramesSnapshot(entries[currentIdx].getState())[name]
    ?.url;
  const step = direction === "back" ? -1 : 1;
  const inBounds =
    direction === "back"
      ? (i: number) => i >= 0
      : (i: number) => i < entries.length;
  for (let i = currentIdx + step; inBounds(i); i += step) {
    const url = readFramesSnapshot(entries[i].getState())[name]?.url;
    if (url && url !== currentUrl) return entries[i];
  }
  return null;
}

// ─── NavigateTarget resolution ────────────────────────────────────
//
// `FrameworkNavigation.navigate(target, ...)` accepts a URL string, a
// URL instance, or an updater function `(current: URL) => URL | string`.
// Both handle scopes synthesize an absolute URL for the updater so
// authors write the same code regardless of whether they hold a page
// or frame handle. For frames, the origin is the page origin (frame
// URLs are same-origin by construction) and a cross-origin result
// from the updater throws a hard error — frame refetches have no
// meaning outside the page's origin.

/** Resolve a `NavigateTarget` against a base URL. */
function applyTarget(target: NavigateTarget, base: URL): URL {
  if (typeof target === "function") {
    const result = target(new URL(base.href));
    return typeof result === "string" ? new URL(result, base) : result;
  }
  if (target instanceof URL) return new URL(target.href);
  return new URL(target, base);
}

function resolveWindowTarget(target: NavigateTarget): string {
  const base = new URL(window.location.href);
  return applyTarget(target, base).href;
}

function resolveFrameTarget(target: NavigateTarget, frameName: string): string {
  const base = new URL(
    _frameUrls.get(frameName) ?? "/",
    window.location.origin,
  );
  const next = applyTarget(target, base);
  if (next.origin !== base.origin) {
    throw new Error(
      `frame "${frameName}" cannot navigate cross-origin (got ${next.origin})`,
    );
  }
  return next.pathname + next.search + next.hash;
}

// ─── FrameworkNavigationResult plumbing ───────────────────────────

/**
 * Tighten TS 6's optional `committed` / `finished` by supplying a
 * fallback resolution. Our handle always fills both — so the
 * `NavigationHistoryEntry | null` union collapses to a non-null entry
 * by the time the caller awaits.
 */
function tightenResult(
  result: NavigationResult,
  fallbackEntry: () => NavigationHistoryEntry,
): FrameworkNavigationResult {
  return {
    committed: result.committed ?? Promise.resolve(fallbackEntry()),
    finished: result.finished ?? Promise.resolve(fallbackEntry()),
  };
}

/**
 * Synthesize a `FrameworkNavigationResult` when the framework is
 * doing work that the browser `Navigation` object doesn't cover
 * (targeted refetch without a URL change, frame reload). `commit`
 * resolves immediately with the current entry; `finished` resolves
 * after the supplied work completes.
 */
function syntheticResult(
  nav: Navigation,
  work: Promise<unknown>,
): FrameworkNavigationResult {
  const entry = () => {
    const e = nav.currentEntry;
    if (!e) throw new Error("navigation has no current entry");
    return e;
  };
  const committed = Promise.resolve().then(entry);
  const finished = work.then(entry);
  return { committed, finished };
}

/**
 * Compose a browser `NavigationResult` with extra framework work
 * (refetch dispatch). `committed` passes through; `finished` waits
 * for both the browser commit and the framework work.
 */
function composeResult(
  result: NavigationResult,
  fallbackEntry: () => NavigationHistoryEntry,
  extraWork: () => Promise<unknown>,
): FrameworkNavigationResult {
  const committed = result.committed ?? Promise.resolve(fallbackEntry());
  const baseFinished = result.finished ?? Promise.resolve(fallbackEntry());
  const finished = (async () => {
    const entry = await baseFinished;
    await extraWork();
    return entry;
  })();
  return { committed, finished };
}

function hasRefetchFilter(
  options: FrameworkNavigateOptions | FrameworkReloadOptions | undefined,
): boolean {
  if (!options) return false;
  return (options.ids?.length ?? 0) > 0 || (options.tags?.length ?? 0) > 0;
}

// ─── Frame entry projection ───────────────────────────────────────

/**
 * Project a window `NavigationHistoryEntry` into a frame-scoped
 * `FrameNavigationHistoryEntry`: `url` reports the frame's URL
 * (absolute, against the page origin); `getState()` returns just the
 * `__frameState[name]` bucket, not the whole window state.
 */
function projectEntryForFrame(
  entry: NavigationHistoryEntry | null,
  frameName: string,
): FrameNavigationHistoryEntry | null {
  if (!entry) return null;
  const snap = readFramesSnapshot(entry.getState());
  const framePath = snap[frameName]?.url ?? _frameUrls.get(frameName) ?? "/";
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://_";
  const absoluteUrl = new URL(framePath, origin).href;
  return new Proxy(entry, {
    get(target, prop, receiver) {
      if (prop === "url") return absoluteUrl;
      if (prop === "getState") {
        return function getState(): FrameEntryState | null {
          const state = target.getState();
          if (state == null || typeof state !== "object") return null;
          const bucket = (state as Record<string, unknown>)[FRAME_STATE_KEY];
          if (bucket == null || typeof bucket !== "object") return null;
          const forName = (bucket as Record<string, unknown>)[frameName];
          if (forName == null || typeof forName !== "object") return null;
          return forName as FrameEntryState;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FrameNavigationHistoryEntry;
}

// ─── SSR / no-Navigation stub ─────────────────────────────────────
//
// `useNavigation()` is a hook that must run in React's render phase,
// but RSC renders happen server-side where `globalThis.navigation` is
// undefined. Return a stub that type-checks as `FrameworkNavigation`
// with no-op behavior — any actual invocation only happens on the
// client after hydration.

function nullNavigation(name: string | null): FrameworkNavigation {
  const stubEntry = null as unknown as NavigationHistoryEntry;
  const stubResult: FrameworkNavigationResult = {
    committed: Promise.resolve(stubEntry),
    finished: Promise.resolve(stubEntry),
  };
  const stubNavResult = stubResult as unknown as NavigationResult;
  return {
    name,
    currentEntry: null,
    canGoBack: false,
    canGoForward: false,
    transition: null,
    activation: null,
    entries: () => [],
    navigate: () => stubResult,
    reload: () => stubResult,
    back: () => stubNavResult,
    forward: () => stubNavResult,
    traverseTo: () => stubNavResult,
    updateCurrentEntry: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    oncurrententrychange: null,
    onnavigate: null,
    onnavigateerror: null,
    onnavigatesuccess: null,
  } as unknown as FrameworkNavigation;
}

// ─── Handle builders ──────────────────────────────────────────────

/**
 * Window-scoped handle — a Proxy over `window.navigation` with
 * `name: null`, an extended `navigate()` (updater callback, targeted
 * refetch via `ids`/`tags`, `silent` URL-only updates) and an
 * extended `reload()` (targeted refetch without a URL change).
 * Everything else passes straight through to the browser.
 */
function buildWindowNavigationHandle(): FrameworkNavigation {
  const nav = getNavigation();
  if (!nav) return nullNavigation(null);

  const windowNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): FrameworkNavigationResult => {
    const url = resolveWindowTarget(target);
    const filtered = hasRefetchFilter(options);
    const silent = options?.silent === true;
    if (filtered || silent) {
      // URL-only update — the page-level listener sees the branded
      // info and declines to intercept, so no refetch fires from its
      // side. If we have id/tag filters, dispatch the targeted
      // refetch ourselves after commit.
      const result = nav.navigate(url, {
        history: options?.history ?? "push",
        state: options?.state ?? null,
        info: makeSilentInfo("window"),
      });
      if (silent) return tightenResult(result, () => nav.currentEntry!);
      return composeResult(
        result,
        () => nav.currentEntry!,
        () =>
          enqueueRefetch({
            ids: options?.ids ?? [],
            tags: options?.tags ?? [],
            disableTransition: options?.disableTransition ?? false,
          }),
      );
    }
    return tightenResult(
      nav.navigate(url, {
        history: options?.history,
        state: options?.state,
        info: options?.info,
      }),
      () => nav.currentEntry!,
    );
  };

  const windowReload = (
    options?: FrameworkReloadOptions,
  ): FrameworkNavigationResult => {
    if (hasRefetchFilter(options)) {
      return syntheticResult(
        nav,
        enqueueRefetch({
          ids: options?.ids ?? [],
          tags: options?.tags ?? [],
          disableTransition: options?.disableTransition ?? false,
        }),
      );
    }
    return tightenResult(
      nav.reload({ state: options?.state, info: options?.info }),
      () => nav.currentEntry!,
    );
  };

  return new Proxy(nav, {
    get(target, prop, receiver) {
      if (prop === "name") return null;
      if (prop === "navigate") return windowNavigate;
      if (prop === "reload") return windowReload;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as FrameworkNavigation;
}

/**
 * Frame-scoped handle — a Proxy over `window.navigation` with
 * frame-scoped overrides: `currentEntry` / `entries()` project the
 * frame URL and state, `canGoBack` / `canGoForward` scan for
 * per-frame URL diffs across entries, `back` / `forward` traverse to
 * the nearest differing entry, `navigate` writes a new frames
 * snapshot and dispatches a refetch, `reload` dispatches a refetch
 * at the current frame URL, `updateCurrentEntry` merges under
 * `__frameState[name]`.
 */
function buildFrameHandle(frameName: string): FrameworkNavigation {
  const nav = getNavigation();
  if (!nav) return nullNavigation(frameName);

  const frameNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): FrameworkNavigationResult => {
    const url = resolveFrameTarget(target, frameName);
    // Carry forward other frames' URLs; overwrite this frame's.
    // User `state` merges next to the snapshot, not inside it.
    const priorState =
      (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {};
    const priorSnap = readFramesSnapshot(priorState);
    const nextSnap: FramesSnapshot = {
      ...priorSnap,
      [frameName]: { url },
    };
    const userState =
      (options?.state as Record<string, unknown> | null) ?? null;
    const nextState = writeFramesSnapshot(
      { ...priorState, ...(userState ?? {}) },
      nextSnap,
    );
    // Seed the client-side frame-URL cache BEFORE `nav.navigate` —
    // the call fires the `navigate` event synchronously, which bumps
    // reactive consumers; waiting until `committed` would have them
    // read a stale URL.
    _frameUrls.set(frameName, url);
    const result = nav.navigate(window.location.href, {
      history: options?.history ?? "push",
      state: nextState,
      info: makeSilentInfo("frame", frameName),
    });
    return composeResult(
      result,
      () => nav.currentEntry!,
      () => _dispatchFrameRefetch(frameName, url, options),
    );
  };

  const frameReload = (
    options?: FrameworkReloadOptions,
  ): FrameworkNavigationResult => {
    const url = _frameUrls.get(frameName);
    if (!url) return syntheticResult(nav, Promise.resolve());
    return syntheticResult(
      nav,
      _dispatchFrameRefetch(frameName, url, options),
    );
  };

  const frameTraverse = (
    direction: "back" | "forward",
  ): NavigationResult => {
    const dest = findFrameEntry(nav, frameName, direction);
    if (!dest) {
      const stub = null as unknown as NavigationHistoryEntry;
      return {
        committed: Promise.resolve(stub),
        finished: Promise.resolve(stub),
      };
    }
    return nav.traverseTo(dest.key);
  };

  const frameUpdateCurrentEntry = (
    options: NavigationUpdateCurrentEntryOptions,
  ): void => {
    const current =
      (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {};
    const bucket =
      (current[FRAME_STATE_KEY] as Record<string, unknown> | null) ?? {};
    const patch = options.state as Record<string, unknown> | null;
    const merged = {
      ...current,
      [FRAME_STATE_KEY]: {
        ...bucket,
        [frameName]: {
          ...((bucket[frameName] as object | undefined) ?? {}),
          ...(patch ?? {}),
        },
      },
    };
    nav.updateCurrentEntry({ state: merged });
  };

  return new Proxy(nav, {
    get(target, prop, receiver) {
      if (prop === "name") return frameName;
      if (prop === "navigate") return frameNavigate;
      if (prop === "reload") return frameReload;
      if (prop === "back") return () => frameTraverse("back");
      if (prop === "forward") return () => frameTraverse("forward");
      if (prop === "canGoBack") return computeCanTraverse(target, frameName, "back");
      if (prop === "canGoForward")
        return computeCanTraverse(target, frameName, "forward");
      if (prop === "currentEntry")
        return projectEntryForFrame(target.currentEntry, frameName);
      if (prop === "entries") {
        return () =>
          target
            .entries()
            .map((e) => projectEntryForFrame(e, frameName))
            .filter((e): e is FrameNavigationHistoryEntry => e !== null);
      }
      if (prop === "updateCurrentEntry") return frameUpdateCurrentEntry;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as FrameworkNavigation;
}

/**
 * Framework-internal plain-function handle for a frame.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_frame()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach).
 */
export function _frame(name: string): FrameworkNavigation {
  return buildFrameHandle(name);
}

/**
 * Framework-internal plain-function handle for the window.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_windowNav()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach). A
 * subscribe callback needs the handle threaded in as a parameter
 * from the component's render, not fetched here.
 *
 * Always pick this over reaching into `window.navigation` directly:
 * it respects the framework's silent-info convention so internal URL
 * syncs don't trigger a full page refetch.
 */
export function _windowNav(): FrameworkNavigation {
  return buildWindowNavigationHandle();
}

/**
 * React hook returning a {@link FrameworkNavigation} handle.
 *
 *   useNavigation()          // no name + inside <Partial frame=X> → X
 *   useNavigation()          // no name + outside any frame → window
 *   useNavigation("cart")    // explicit name → cart frame
 *
 * The handle's live getters (`currentEntry`, `canGoBack`, `canGoForward`)
 * subscribe to `navigation` events, so they stay reactive across any
 * navigation on the page.
 *
 * Always returns a handle — never throws. Outside a frame it's a
 * small Proxy over `window.navigation`; inside a frame it's a Proxy
 * with frame-scoped overrides. The same code (a "back" button, a
 * "reload" icon) works at the page level and per-frame.
 */
export function useNavigation(name?: string): FrameworkNavigation {
  const ambient = useContext(FrameNameContext);
  const resolved = name ?? ambient;
  // Bump on any navigation so computed getters (`currentUrl`,
  // `canGoBack`, `entryState`) re-read after a commit. Runs for all
  // navigation types — framework-silent window navs and frame navs
  // alike — because both surface new client-side state that reactive
  // consumers (e.g. a header button reading `frameNav.currentUrl`)
  // need to pick up.
  const [, tick] = useState(0);
  useEffect(() => {
    const nav = getNavigation();
    if (!nav) return;
    const bump = () => tick((n) => n + 1);
    nav.addEventListener("currententrychange", bump);
    nav.addEventListener("navigate", bump);
    return () => {
      nav.removeEventListener("currententrychange", bump);
      nav.removeEventListener("navigate", bump);
    };
  }, []);
  // Memoize the handle so a consumer effect that depends on it
  // doesn't re-run on every render. The handle's getters read live
  // state, so memoizing doesn't stale the values — and keeping the
  // reference stable means effects whose dep array includes the
  // handle only re-run when the bound name changes, not on every
  // navigation commit. (Pre-memoization, a targeted-refetch activator
  // could fire twice: the first nav's commit would bump React, the
  // handle would become a new object, the effect would re-run and
  // re-register its trigger before the server response had propagated
  // fresh props.)
  return useMemo(
    () =>
      resolved ? buildFrameHandle(resolved) : buildWindowNavigationHandle(),
    [resolved],
  );
}

/**
 * Activator building block. Subscribe a client-side trigger to a
 * Partial's activation refetch.
 *
 * Typical use inside an activator component:
 *
 *   useActivate(partialId, (fire) => {
 *     const obs = new IntersectionObserver(
 *       (e) => e.some(x => x.isIntersecting) && fire(),
 *       { rootMargin },
 *     );
 *     obs.observe(node);
 *     return () => obs.disconnect();
 *   });
 *
 * `fire()` triggers a targeted reload for `partialId` via
 * `useNavigation().reload({ ids: [partialId] })`. Calling `fire` more
 * than once is a no-op by default (one-shot activation). Pass
 * `{once: false}` if you need an activator that can fire repeatedly.
 *
 * `subscribe` is registered once per mount and is captured via ref, so
 * the latest closure is used when the subscription fires. The effect
 * itself does not re-run when `subscribe` changes — if you need to
 * re-subscribe on prop changes, remount the activator by setting a
 * `key` that changes with those props.
 *
 * Note: activators no longer pass prop overrides to the Partial.
 * If the activated content needs dynamic data, the activator should
 * write that data to a URL (page URL via `useNavigation().navigate`
 * or a frame URL via `useNavigation("name").navigate`) so the server reads
 * it via tracked accessors on re-render.
 */
export function useActivate(
  partialId: string,
  subscribe: (fire: () => void) => (() => void) | void,
  opts?: { once?: boolean },
): void {
  const once = opts?.once ?? true;
  const firedRef = useRef(false);
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    const cleanup = subscribeRef.current(() => {
      if (once && firedRef.current) return;
      firedRef.current = true;
      void enqueueRefetch({
        ids: [partialId],
        tags: [],
        disableTransition: false,
      });
    });
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
  }, [partialId, once]);
}

export function PartialsClient({
  mode = "cache",
  debug,
  fetchMs,
  children,
}: PartialsClientProps) {
  const cache = _cache;

  // ── Streaming mode ──────────────────────────────────────────────────
  //
  // Cache is populated from the streamed children by walking for keyed
  // `<Suspense>` elements — that's what `<Partial>` emits. Placeholders
  // (`<i data-partial hidden>`) are left alone so the existing cache
  // entry from a prior render still backs the template.
  //
  // Template is DERIVED on the client from the rendered children (not
  // built server-side). The derived template is persisted in module
  // state so subsequent cache-mode refetches can reuse it without a
  // server round-trip.
  //
  // Fingerprints land in `_fingerprints` via `PartialErrorBoundary`'s
  // render-time `registerClientPartial` call — no props plumbing here.
  if (mode === "streaming") {
    cacheFromStreamingChildren(children, cache);
    const derived = deriveTemplate(children);
    _template = derived;
    _debug = [];

    // Drop entries carried over from a prior route. The derived template
    // lists exactly the Partial ids present on the current page; anything
    // still in `_cache` / `_fingerprints` but not in that set is a leak
    // from a previous navigation. `_fingerprints` is fully rewritten by
    // `PartialErrorBoundary` renders in this pass (including deep/dynamic
    // Partials that live inside cached ancestors), so clearing it here
    // is safe and simpler than the selective walk `_cache` needs.
    const liveIds = new Set<string>();
    collectTemplateIds(derived, liveIds);
    for (const id of [..._cache.keys()]) {
      if (!liveIds.has(id)) _cache.delete(id);
    }
    _fingerprints.clear();

    const rendered = renderTemplate(derived, cache);
    return renderWithDebugPanel(rendered, debug, fetchMs);
  }

  // ── Cache mode ──────────────────────────────────────────────────────
  //
  // Reuses the client-derived `_template` from the most recent
  // streaming render. Cache-mode is always preceded by a full render
  // (initial HTML load), so `_template` is guaranteed to be populated.
  //
  // We descend into each refetched partial's content looking for
  // NESTED partials so they get their own top-level cache entries
  // too. Without this, a frame refetch that introduces a brand-new
  // inner partial would cache only the outer wrapper; a subsequent
  // same-URL refetch (which emits a placeholder for the inner) would
  // find no top-level cache entry to fill the placeholder.
  cacheFromStreamingChildren(children, cache);

  const freshDebugIds = new Set(debug.map((d) => d.id));
  _debug = [
    ..._debug.filter((d) => !freshDebugIds.has(d.id) && cache.has(d.id)),
    ...debug,
  ];

  const rendered = renderTemplate(_template, cache);
  return renderWithDebugPanel(rendered, _debug, fetchMs);
}

/**
 * Return `<>{...rendered}<PartialDebugPanel/></>`, but built via
 * `React.createElement` so the array is spread as positional children.
 * `<>{rendered}</>` passes the array as a single children prop, which
 * makes React enforce the unique-key rule on every item — and the
 * cached partial elements carry intentional non-keys (adding one would
 * trigger Flight's outer/inner key composite, remounting client state
 * on refetch; see `partialFromSnapshot`).
 */
function renderWithDebugPanel(
  rendered: ReactNode[],
  debug: PartialDebugEntry[],
  fetchMs: number,
): ReactNode {
  return React.createElement(
    React.Fragment,
    null,
    ...rendered,
    React.createElement(PartialDebugPanel, {
      entries: debug,
      fetchMs,
      key: "__partial-debug-panel",
    }),
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
  const dataCachedCount = entries.filter(
    (e) => e.status === "data-cached",
  ).length;
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
              <span
                style={{
                  color: "#444",
                  fontSize: "0.7rem",
                  marginLeft: "auto",
                }}
              >
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
