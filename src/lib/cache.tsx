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
 */

import type { ReactNode } from "react";
import {
  createFromReadableStream,
  renderToReadableStream,
} from "@vitejs/plugin-rsc/rsc";
import { djb2 } from "./hash.ts";

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

  const key = `${id}:${hashDep(dep)}`;
  const now = Date.now();

  const existing = store.get(key);
  if (existing) {
    if (existing.expiresAt > now) {
      // Fresh hit. Decode and return.
      touch(key);
      return await createFromReadableStream<ReactNode>(
        bytesToStream(existing.bytes),
      );
    }
    if (existing.staleUntil > now) {
      // SWR: serve the stale bytes, kick off a background refresh if
      // one isn't already in progress for this key. The refresh runs
      // outside this render's await so the response isn't delayed.
      touch(key);
      if (!refreshing.has(key)) {
        refreshing.add(key);
        // Fire-and-forget. Errors during refresh: log, keep the stale
        // entry (next request serves stale again until it expires).
        void renderAndBuffer(children)
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
      return await createFromReadableStream<ReactNode>(
        bytesToStream(existing.bytes),
      );
    }
    // Past staleUntil — treat as miss.
  }

  // Miss or fully expired. Dedupe concurrent misses so only one render runs.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = renderAndBuffer(children).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const bytes = await pending;

  store.set(key, freshEntry(bytes, ttl, staleWhileRevalidate, now));
  evictIfNeeded();

  return await createFromReadableStream<ReactNode>(bytesToStream(bytes));
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
