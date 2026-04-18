/**
 * Server-side render-output caching.
 *
 * `<Cache dep={...}>` wraps a subtree; on miss it renders the children
 * to Flight bytes (via plugin-rsc's `renderToReadableStream`), stores
 * the bytes keyed by `hash(dep)`, and also decodes them back into a
 * React element tree (via `createFromReadableStream`) which it returns
 * to the outer render. On hit it retrieves the stored bytes, decodes
 * into a tree, and returns that.
 *
 * The outer render serializes the returned tree to Flight normally —
 * no row-id splicing, no module-id remapping. React's reconciler and
 * the plugin-rsc manifest take care of all coherence.
 *
 * Why not just cache the React element tree directly?
 *   An async server component returns a Promise<ReactElement>. React
 *   renders that element, which may contain further async server
 *   components and lazy client references. Capturing the *final*
 *   resolved tree from userland isn't exposed by React — we can't
 *   observe what React produces. Going through Flight is what lets
 *   us "snapshot" a subtree after it has fully resolved.
 *
 * ── Composition with <Partial> ─────────────────────────────────────
 *
 * Cached Flight bytes capture the rendered subtree as-is. If the
 * subtree contains a <Partial>, the partial's content would be frozen
 * in those bytes — refetching the partial wouldn't refresh until the
 * Cache entry expires. To make Cache and Partial compose orthogonally,
 * Cache strips inner partials to placeholders before serializing
 * (recognized by their PartialBoundary wrapper or by the existing
 * `<i data-partial>` placeholder shape used by buildTemplate). The
 * placeholders are what go into the cached bytes; on output, Cache
 * re-injects the *current* live partial elements. Result: Cache
 * captures the stable scaffolding, partials stay live.
 *
 * Partial ids that live inside the subtree are folded into the cache
 * key so adding/removing a partial inside a Cache invalidates
 * automatically.
 */

import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  createFromReadableStream,
  renderToReadableStream,
} from "@vitejs/plugin-rsc/rsc";
import { djb2 } from "./hash.ts";
import { PartialBoundary } from "./partial-component.tsx";
import { getRequest } from "../framework/context.ts";
import { lookupPartial } from "./partial-registry.ts";

// ─── Store ─────────────────────────────────────────────────────────────

interface Entry {
  bytes: Uint8Array;
  /** Fresh until this timestamp (ms epoch); Infinity = never expire. */
  expiresAt: number;
  /** Servable (as stale) until this timestamp. If > expiresAt, we have a
   *  stale-while-revalidate window: serve cached, kick off async refresh. */
  staleUntil: number;
}

const MAX_ENTRIES = 10_000;
const store = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Uint8Array>>();
/** Async SWR refreshes currently in progress. Prevents duplicate
 *  refreshes when many requests hit a stale entry concurrently. */
const refreshing = new Set<string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function hashDep(dep: unknown): string {
  return djb2(stableStringify(dep));
}

function touch(key: string): void {
  // Re-insert to bump LRU order.
  const entry = store.get(key);
  if (entry) {
    store.delete(key);
    store.set(key, entry);
  }
}

function evictIfNeeded(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// ─── Lazy-ref resolution ───────────────────────────────────────────────
//
// `createFromReadableStream` returns a tree whose nested chunks may
// still be represented as Flight lazy refs (`$$typeof ===
// Symbol(react.lazy)`). When our outer render serializes that tree
// back into its own Flight stream, any unresolved lazy ref gets
// re-emitted as a lazy chunk in the outer stream. That cascades:
// downstream walkers like `cacheFromStreamingChildren` call
// `unwrapLazy` on the client component's children and hit the
// pending-chunk case, which silently returns `null` — truncating the
// walk and wiping out every keyed partial beyond that point.
//
// On a cache *miss* the bytes are produced inline, so by the time we
// decode they're already fully resolved synchronously. On a cache
// *hit* (bytes come from storage and `createFromReadableStream` reads
// them through `bytesToStream`) the nested chunks sometimes surface
// to userland before they've been fully parsed. Forcing resolution
// here — by walking the tree and awaiting every lazy ref's init
// thenable — guarantees that both paths return an equivalent, fully-
// resolved React element tree.
//
// We only unwrap *chunk* lazies (elements whose `$$typeof` is
// `Symbol(react.lazy)`). Client components are serialized as regular
// elements whose `type` is a module reference; those stay untouched.

const LAZY_SYMBOL_STR = "Symbol(react.lazy)";

async function awaitLazy(node: unknown): Promise<unknown> {
  const n = node as {
    $$typeof?: symbol;
    _payload?: { _status?: number; _result?: unknown };
    _init?: (payload: unknown) => unknown;
  };
  if (typeof n.$$typeof !== "symbol") return node;
  if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node;
  const payload = n._payload;
  if (payload && payload._status === 1) return payload._result;
  try {
    const init = n._init;
    if (typeof init === "function") return init(payload);
  } catch (pending) {
    // React's lazy `_init` throws a thenable while the chunk is still
    // pending. Await it, then re-invoke.
    if (pending && typeof (pending as { then?: unknown }).then === "function") {
      await pending;
      const init = n._init;
      if (typeof init === "function") {
        try {
          return init(payload);
        } catch (err) {
          if (err && typeof (err as { then?: unknown }).then === "function") {
            await err;
            return n._init?.(payload);
          }
          throw err;
        }
      }
    }
    throw pending;
  }
  return node;
}

async function resolveLazies(node: ReactNode): Promise<ReactNode> {
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    const out = await Promise.all(node.map((c) => resolveLazies(c)));
    return out;
  }
  if (typeof node === "object" && node !== null) {
    const n = node as { $$typeof?: symbol };
    if (
      typeof n.$$typeof === "symbol" &&
      n.$$typeof.toString() === LAZY_SYMBOL_STR
    ) {
      const resolved = await awaitLazy(node);
      return resolveLazies(resolved as ReactNode);
    }
  }
  if (!isValidElement(node)) return node;

  const children = (node.props as { children?: ReactNode }).children;
  if (children == null) return node;
  const newChildren = await resolveLazies(children);
  if (newChildren === children) return node;
  // Spread arrays as variadic so React treats each child as a
  // positional sibling (implicit key) rather than an explicit
  // array member (requires `key=`). Flight serializes static JSX
  // siblings like `<a><img/><h2/><div/></a>` as an array on the
  // children prop, so without this the decoded tree would trip
  // React's "each child in a list should have a unique key" warning
  // every time the cloned element is committed on the client.
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren);
}

// ─── Partial strip / reinject ──────────────────────────────────────────

/**
 * Marker element used in cached bytes wherever a Partial lived. Same
 * shape the framework's buildTemplate uses, so `PartialsClient` fills
 * it through a single code path regardless of whether the placeholder
 * came from a Cache hit or a refetch template.
 */
function placeholderFor(id: string): ReactElement {
  return createElement("i", {
    key: id,
    hidden: true,
    "data-partial": true,
  });
}

function isExistingPlaceholder(node: ReactElement): boolean {
  return (
    node.type === "i" &&
    (node.props as Record<string, unknown>)["data-partial"] === true &&
    node.key != null
  );
}

/**
 * Extract the partial id from a keyed element, if the key matches a
 * known partial in the current route's registry. Keys look like `id`
 * (sync) or `id#version` (versioned Suspense on refetch). Returns
 * `null` if the element's key doesn't resolve to a registered partial.
 */
function partialIdOf(node: ReactElement, route: string): string | null {
  if (node.key == null) return null;
  const keyStr = String(node.key);
  const hashIdx = keyStr.indexOf("#");
  const candidate = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
  return lookupPartial(route, candidate) ? candidate : null;
}

/**
 * Walk children, replace any partial-bearing subtree with a placeholder.
 * A subtree is partial-bearing when it's a `<PartialBoundary>` (emitted
 * by `<Partial>` during render), an existing `<i data-partial>`
 * placeholder (cache-mode refetch templates), or any keyed element
 * whose key matches a registered partial id (the streaming-mode
 * Suspense / PartialErrorBoundary wrapper).
 *
 * Returns the stripped tree, a map of partialId → live element (used
 * to re-inject after decode), and the sorted ids (folded into the
 * cache key).
 *
 * Limitation: only finds partials reachable through the static
 * `children` chain. Partials produced inside opaque function components
 * within a Cache whose id isn't yet in the registry won't be stripped —
 * first render bakes them in, subsequent full renders populate the
 * registry, and the HMR/deploy-triggered registry clear keeps this
 * from going stale.
 */
function stripPartials(node: ReactNode): {
  stripped: ReactNode;
  partials: Map<string, ReactElement>;
  ids: string[];
} {
  const partials = new Map<string, ReactElement>();
  const route = new URL(getRequest().url).pathname;

  const walk = (n: ReactNode): ReactNode => {
    if (n == null || typeof n === "boolean") return n;
    if (typeof n === "string" || typeof n === "number") return n;
    if (Array.isArray(n)) {
      let changed = false;
      const out = n.map((c) => {
        const w = walk(c);
        if (w !== c) changed = true;
        return w;
      });
      return changed ? out : n;
    }
    if (!isValidElement(n)) return n;

    if (n.type === PartialBoundary) {
      const id = (n.props as { id: string }).id;
      partials.set(id, n);
      return placeholderFor(id);
    }

    if (isExistingPlaceholder(n)) {
      partials.set(String(n.key), n);
      return n;
    }

    const partialId = partialIdOf(n, route);
    if (partialId != null && !partials.has(partialId)) {
      partials.set(partialId, n);
      return placeholderFor(partialId);
    }

    const kids = (n.props as { children?: ReactNode }).children;
    if (kids == null) return n;
    const nk = walk(kids);
    if (nk === kids) return n;
    return Array.isArray(nk) ? cloneElement(n, {}, ...nk) : cloneElement(n, {}, nk);
  };

  const stripped = walk(node);
  return { stripped, partials, ids: [...partials.keys()].sort() };
}

/**
 * Walk a decoded tree and replace `<i data-partial key={id}>` placeholders
 * with the live element captured during the most recent strip. No-op if
 * `partials` is empty (cache-mode call: there's nothing live to put back,
 * the placeholders themselves are the desired output).
 */
function reinject(
  node: ReactNode,
  partials: Map<string, ReactElement>,
): ReactNode {
  if (partials.size === 0) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((c) => {
      const r = reinject(c, partials);
      if (r !== c) changed = true;
      return r;
    });
    return changed ? out : node;
  }
  if (!isValidElement(node)) return node;

  if (isExistingPlaceholder(node)) {
    const live = partials.get(String(node.key));
    if (live) return live;
    return node;
  }

  const kids = (node.props as { children?: ReactNode }).children;
  if (kids == null) return node;
  const nk = reinject(kids, partials);
  if (nk === kids) return node;
  return Array.isArray(nk)
    ? cloneElement(node, {}, ...nk)
    : cloneElement(node, {}, nk);
}

// ─── Cache component ────────────────────────────────────────────────────

interface CacheProps {
  /** Unique identifier for this cache boundary. Pair with dep for the key. */
  id: string;
  /** Inputs the cached subtree depends on. Hashed for the cache key. */
  dep: unknown;
  /** Seconds until expiry. Default: never expire (rely on LRU eviction). */
  ttl?: number;
  /** Additional seconds after `ttl` during which the stale entry is served
   *  while an async background refresh repopulates the cache. Default: 0.
   *  Total servable lifetime is `ttl + staleWhileRevalidate` seconds. */
  staleWhileRevalidate?: number;
  /** Skip caching for this render. Useful for preview/dev. */
  bypass?: boolean;
  children: ReactNode;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function renderAndBuffer(children: ReactNode): Promise<Uint8Array> {
  const stream = renderToReadableStream(children);
  return await readAll(stream);
}

export async function Cache({
  id,
  dep,
  ttl,
  staleWhileRevalidate,
  bypass,
  children,
}: CacheProps): Promise<ReactNode> {
  if (bypass) return children;

  // Strip inner partials before hashing/rendering. The cached bytes
  // contain placeholders, never partial content; the live partial
  // elements get re-injected on output so the outer render still
  // executes them fresh.
  const { stripped, partials, ids } = stripPartials(children);
  const key = `${id}:${hashDep([dep, ids])}`;
  const now = Date.now();

  const existing = store.get(key);
  if (existing) {
    if (existing.expiresAt > now) {
      // Fresh hit. Decode, fully resolve lazies, reinject live partials.
      touch(key);
      const decoded = await createFromReadableStream<ReactNode>(
        bytesToStream(existing.bytes),
      );
      const resolved = await resolveLazies(decoded);
      return reinject(resolved, partials);
    }
    if (existing.staleUntil > now) {
      // SWR: serve the stale bytes, kick off a background refresh if
      // one isn't already in progress for this key. The refresh runs
      // outside this render's await so the response isn't delayed.
      // The refresh re-renders the *stripped* subtree (placeholders
      // only) — partial content is intentionally not part of the
      // cached snapshot.
      touch(key);
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Fire-and-forget. Errors during refresh: log, keep the stale
        // entry (next request serves stale again until it expires).
        void renderAndBuffer(stripped)
          .then((fresh) => {
            const t = Date.now();
            store.set(key, freshEntry(fresh, ttl, staleWhileRevalidate, t));
            evictIfNeeded();
          })
          .catch((err) => {
            console.error(`[cache] SWR refresh failed for ${key}:`, err);
          })
          .finally(() => refreshing.delete(key));
      }
      const decoded = await createFromReadableStream<ReactNode>(
        bytesToStream(existing.bytes),
      );
      const resolved = await resolveLazies(decoded);
      return reinject(resolved, partials);
    }
    // Past staleUntil — treat as miss.
  }

  // Miss or fully expired. Dedupe concurrent misses so only one render runs.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = renderAndBuffer(stripped).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const bytes = await pending;

  store.set(key, freshEntry(bytes, ttl, staleWhileRevalidate, now));
  evictIfNeeded();

  const decoded = await createFromReadableStream<ReactNode>(bytesToStream(bytes));
  const resolved = await resolveLazies(decoded);
  return reinject(resolved, partials);
}

function freshEntry(
  bytes: Uint8Array,
  ttl: number | undefined,
  swr: number | undefined,
  now: number,
): Entry {
  const expiresAt =
    ttl != null ? now + ttl * 1000 : Number.POSITIVE_INFINITY;
  const staleUntil =
    swr != null && ttl != null
      ? expiresAt + swr * 1000
      : expiresAt;
  return { bytes, expiresAt, staleUntil };
}

// ─── Dev / debugging helpers ────────────────────────────────────────────

export function _cacheStats(): { size: number; keys: string[] } {
  return { size: store.size, keys: [...store.keys()] };
}

export function _clearCache(): void {
  store.clear();
  inFlight.clear();
  refreshing.clear();
}

// Dev: invalidate the whole cache on HMR. Cached Flight bytes
// reference client-component module ids that Vite may reassign
// between updates; rather than try to detect stale ids, we just
// blow it away and let misses repopulate.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => _clearCache());
  import.meta.hot.on("vite:beforeFullReload", () => _clearCache());
}
