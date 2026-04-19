/**
 * Server-side render-output caching.
 *
 * `<Cache>` wraps a subtree; on miss it renders the children to Flight
 * bytes (via plugin-rsc's `renderToReadableStream`), stores the bytes
 * keyed by a hash derived from the Partial's access manifest (the set
 * of request-state keys the content reads through tracked accessors)
 * plus any `vary` scalars declared on the cache options. The bytes are
 * also decoded back into a React element tree (via
 * `createFromReadableStream`) which it returns to the outer render.
 * On hit it retrieves the stored bytes, decodes into a tree, and
 * returns that.
 *
 * Cache is an internal detail of `<Partial cache={...}>`: authors
 * don't render it directly.
 *
 * ── Access manifest ────────────────────────────────────────────────
 *
 * The manifest is a per-`<Cache>` Set<string> populated during render
 * by tracked accessors (`getCookie`, `getHeader`, `getSearchParam`,
 * `getPathname` — see `src/framework/context.ts`). Each call pushes
 * `"kind:name"` into the manifest. The manifest is the cache key
 * surface: on subsequent requests we resolve the same keys against
 * the current request, hash the values, and look up the entry.
 *
 * Manifest membership must be stable across renders of the same
 * `(id, fingerprint)`. Conditional reads — one render touches cookie
 * A, another touches cookie B — would produce different manifests
 * across requests, thrashing the cache. We throw a hoisting-violation
 * error when a render's manifest disagrees with the stored one. See
 * `notes/AUTO_TRACKED_CACHE_KEYS.md`.
 *
 * ── Composition with <Partial> ────────────────────────────────────
 *
 * Cached Flight bytes capture the rendered subtree as-is. If the
 * subtree contains a `<Partial>`, the partial's content would be
 * frozen in those bytes — refetching the partial wouldn't refresh
 * until the Cache entry expires. To make Cache and Partial compose
 * orthogonally, Cache strips inner partials to placeholders before
 * serializing. On output, Cache re-injects the *current* live partial
 * elements. Result: Cache captures the stable scaffolding, partials
 * stay live.
 *
 * Partial ids that live inside the subtree are folded into the cache
 * key so adding/removing a partial inside a Cache invalidates
 * automatically.
 */

import {
  Suspense,
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
import { Partial, PartialBoundary } from "./partial-component.tsx";
import {
  getCurrentCacheManifest,
  getRequest,
  resolveManifest,
  runWithCacheManifest,
  type ManifestScope,
} from "../framework/context.ts";
import {
  lookupPartial,
  registerPartial,
  type PartialSnapshot,
} from "./partial-registry.ts";
import type { CacheOptions } from "./cache-options.ts";

// ─── Store ─────────────────────────────────────────────────────────────

interface Entry {
  bytes: Uint8Array;
  /** Fresh until this timestamp (ms epoch); Infinity = never expire. */
  expiresAt: number;
  /** Servable (as stale) until this timestamp. If > expiresAt, we have
   *  a stale-while-revalidate window: serve cached, kick off async
   *  refresh. */
  staleUntil: number;
}

interface CacheStore {
  get(key: string): Promise<Entry | undefined>;
  set(key: string, entry: Entry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<{ size: number; keys: string[] }>;
}

class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<Entry | undefined> {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  async set(key: string, entry: Entry): Promise<void> {
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async stats(): Promise<{ size: number; keys: string[] }> {
    return { size: this.map.size, keys: [...this.map.keys()] };
  }
}

const store: CacheStore = new MemoryCacheStore();

// Process-local side-table holding dynamic-partial snapshots per
// cache key. Populated on miss, read on hit. See the long explanation
// retained from the previous version: dynamic partial snapshots
// reference live React element functions that can't serialize, so
// they stay in-process.
const snapshotIndex = new Map<string, Map<string, PartialSnapshot>>();
const SNAPSHOT_INDEX_MAX = 10_000;

function setSnapshots(key: string, snaps: Map<string, PartialSnapshot>): void {
  snapshotIndex.delete(key);
  snapshotIndex.set(key, snaps);
  while (snapshotIndex.size > SNAPSHOT_INDEX_MAX) {
    const oldest = snapshotIndex.keys().next().value;
    if (oldest === undefined) break;
    snapshotIndex.delete(oldest);
  }
}

/**
 * Manifest side-table: `(id, fingerprint, ids-hash)` → the Set of
 * tracked accessor keys read during the Partial's body execution.
 *
 * Lives alongside `snapshotIndex` — process-local, in-memory. Doesn't
 * need to cross process boundaries (a fresh process rebuilds it on
 * first render). Never serialized.
 */
const manifestStore = new Map<string, Set<string>>();

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

function hashParts(...parts: unknown[]): string {
  return djb2(stableStringify(parts));
}

function manifestToSorted(m: Set<string>): string[] {
  return [...m].sort();
}

function manifestsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ─── Lazy-ref resolution ───────────────────────────────────────────────
//
// `createFromReadableStream` returns a tree whose nested chunks may
// still be represented as Flight lazy refs. We force resolution here
// so both cache-hit and cache-miss paths return an equivalent, fully
// materialized tree. See `notes/SERVER_CACHE_NOTES.md` for the full
// explanation.

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
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren);
}

// ─── Partial strip / reinject ──────────────────────────────────────────

function placeholderFor(id: string): ReactElement {
  return createElement("i", {
    key: id,
    hidden: true,
    "data-partial": true,
    "data-partial-id": id,
  });
}

function isExistingPlaceholder(node: ReactElement): boolean {
  return (
    node.type === "i" &&
    (node.props as Record<string, unknown>)["data-partial"] === true
  );
}

function placeholderIdOf(node: ReactElement): string | null {
  const props = node.props as { ["data-partial-id"]?: unknown };
  if (typeof props["data-partial-id"] === "string") {
    return props["data-partial-id"];
  }
  return node.key != null ? String(node.key) : null;
}

function partialIdOf(node: ReactElement, route: string): string | null {
  if (node.key == null) return null;
  const keyStr = String(node.key);
  const hashIdx = keyStr.indexOf("#");
  const candidate = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr;
  return lookupPartial(route, candidate) ? candidate : null;
}

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
    const id = placeholderIdOf(node);
    if (id) {
      const live = partials.get(id);
      if (live) return live;
    }
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

// ─── Dynamic partial strip / reinject ────────────────────────────────────

function renderedWrapperId(node: ReactElement): string | null {
  const props = node.props as { partialId?: unknown };
  if (typeof props.partialId === "string") return props.partialId;
  if (node.type === Suspense && node.key != null) {
    return String(node.key);
  }
  return null;
}

function stripDynamicWrappers(
  node: ReactNode,
  skipIds: Set<string>,
): { stripped: ReactNode; snapshots: Map<string, PartialSnapshot> } {
  const snapshots = new Map<string, PartialSnapshot>();
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

    const wid = renderedWrapperId(n);
    if (wid && !skipIds.has(wid)) {
      const snap = lookupPartial(route, wid);
      if (snap) {
        snapshots.set(wid, snap);
        return placeholderFor(wid);
      }
    }

    const kids = (n.props as { children?: ReactNode }).children;
    if (kids == null) return n;
    const nk = walk(kids);
    if (nk === kids) return n;
    return Array.isArray(nk)
      ? cloneElement(n, {}, ...nk)
      : cloneElement(n, {}, nk);
  };

  return { stripped: walk(node), snapshots };
}

function reinjectDynamic(
  node: ReactNode,
  snapshots: Map<string, PartialSnapshot>,
): ReactNode {
  if (snapshots.size === 0) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((c) => {
      const r = reinjectDynamic(c, snapshots);
      if (r !== c) changed = true;
      return r;
    });
    return changed ? out : node;
  }
  if (!isValidElement(node)) return node;

  if (isExistingPlaceholder(node)) {
    const id = placeholderIdOf(node);
    if (id) {
      const snap = snapshots.get(id);
      if (snap) {
        return createElement(
          Partial,
          {
            id,
            fallback: snap.fallback ?? undefined,
            errorWith: snap.errorWith,
            tags: snap.tags,
            cache: snap.cache,
          },
          snap.content,
        );
      }
    }
    return node;
  }

  const kids = (node.props as { children?: ReactNode }).children;
  if (kids == null) return node;
  const nk = reinjectDynamic(kids, snapshots);
  if (nk === kids) return node;
  return Array.isArray(nk)
    ? cloneElement(node, {}, ...nk)
    : cloneElement(node, {}, nk);
}

function registerDynamicSnapshots(
  route: string,
  snapshots: Map<string, PartialSnapshot>,
): void {
  for (const [sId, snap] of snapshots) {
    registerPartial(route, sId, snap);
  }
}

// ─── Cache component ────────────────────────────────────────────────────

interface CacheProps {
  /** Partial id. Forms the stable half of the cache key. */
  id: string;
  /** Structural fingerprint of the Partial's children (from Partial). */
  fingerprint: string;
  /** Cache-Control-shaped options: maxAge, swr, vary, bypass. */
  options: CacheOptions;
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
  fingerprint,
  options,
  children,
}: CacheProps): Promise<ReactNode> {
  if (options.bypass) return children;

  // Pre-compute the stored manifest so accessor calls can throw
  // synchronously when a new key is introduced (vs. the stored set).
  const baseKeyPrefix = `${id}:${fingerprint}:`;
  const scope: ManifestScope = {
    current: new Set(),
    stored: null,
    partialId: id,
  };
  // We can't know the baseKey (which includes `ids` hash) until
  // stripPartials runs, but the `(id, fp)` prefix is enough to find
  // the stored manifest for this Partial. The `ids` component only
  // changes when partials inside are added/removed, which would
  // produce a different stored manifest entry — fall through to miss
  // either way.
  const prior = findStoredManifestByPrefix(baseKeyPrefix);
  if (prior) scope.stored = prior;

  return runWithCacheManifest(scope, async () =>
    cacheImpl(id, fingerprint, options, children, scope),
  );
}

function findStoredManifestByPrefix(prefix: string): Set<string> | undefined {
  for (const [k, v] of manifestStore) {
    if (k.startsWith(prefix)) return v;
  }
  return undefined;
}

async function cacheImpl(
  id: string,
  fingerprint: string,
  options: CacheOptions,
  children: ReactNode,
  scope: ManifestScope,
): Promise<ReactNode> {
  const manifest = scope.current;
  // Strip statically-visible partials. Placeholders go into the cached
  // bytes; live elements are re-injected on the way out so partials
  // stay live inside a cached region.
  const { stripped, partials, ids } = stripPartials(children);

  // The "stable" half of the key — same across all snapshots of this
  // Partial. Includes ids so adding/removing an inner Partial
  // invalidates automatically.
  const baseKey = `${id}:${fingerprint}:${djb2(ids.join(","))}`;
  const now = Date.now();
  const route = new URL(getRequest().url).pathname;

  const storedManifest = manifestStore.get(baseKey);
  // `scope.stored` was set eagerly by `Cache` (without knowing the
  // `ids`-component); narrow it to the exact base-key entry here so
  // the synchronous hoisting check matches the post-render one.
  scope.stored = storedManifest ?? null;

  // ── Hit path ────────────────────────────────────────────────────
  //
  // Only reachable when we have a stored manifest: without it we don't
  // know which request-state values participate in the key, so we
  // can't look anything up. First render of a Partial is always a
  // miss in this sense.
  if (storedManifest) {
    const values = resolveManifest(storedManifest);
    const key = `${baseKey}:${hashParts(values, options.vary ?? null)}`;

    const existing = await store.get(key);
    const existingSnapshots = existing ? snapshotIndex.get(key) : undefined;
    if (existing && existingSnapshots) {
      if (existing.expiresAt > now || existing.staleUntil > now) {
        registerDynamicSnapshots(route, existingSnapshots);
        if (existing.expiresAt <= now && !refreshing.has(key)) {
          refreshing.add(key);
          void refreshEntry(
            baseKey,
            key,
            stripped,
            ids,
            options,
            id,
          )
            .catch((err) =>
              console.error(`[cache] SWR refresh failed for ${key}:`, err),
            )
            .finally(() => refreshing.delete(key));
        }
        const decoded = await createFromReadableStream<ReactNode>(
          bytesToStream(existing.bytes),
        );
        const resolved = await resolveLazies(decoded);
        const withStatic = reinject(resolved, partials);
        return reinjectDynamic(withStatic, existingSnapshots);
      }
    }
    // Entry past staleUntil, absent, or lost its snapshots → miss.
  }

  // ── Miss path ───────────────────────────────────────────────────
  //
  // Render the stripped subtree. The manifest ALS is already active
  // (opened in the `Cache` wrapper above); tracked accessor calls
  // inside the render populate `manifest`. After the render finishes
  // we verify the manifest matches any previously-stored one and
  // store the entry under the key derived from its resolved values.
  const staticIdSet = new Set(ids);

  // Dedupe concurrent misses for the same Partial (same baseKey). The
  // first caller renders; others await the same result.
  let pending = inFlightMiss.get(baseKey);
  if (!pending) {
    pending = renderMissAndStore(
      baseKey,
      id,
      stripped,
      staticIdSet,
      ids,
      options,
      manifest,
      storedManifest,
    ).finally(() => inFlightMiss.delete(baseKey));
    inFlightMiss.set(baseKey, pending);
  }
  const { liveTree } = await pending;

  return reinject(liveTree, partials);
}

// ─── Miss helpers ──────────────────────────────────────────────────────

const inFlightMiss = new Map<
  string,
  Promise<{ liveTree: ReactNode; dynamicSnapshots: Map<string, PartialSnapshot> }>
>();

async function renderMissAndStore(
  baseKey: string,
  id: string,
  stripped: ReactNode,
  staticIds: Set<string>,
  ids: string[],
  options: CacheOptions,
  manifest: Set<string>,
  storedManifest: Set<string> | undefined,
): Promise<{ liveTree: ReactNode; dynamicSnapshots: Map<string, PartialSnapshot> }> {
  // Render to Flight ONCE, then tee:
  //   • user branch → decoded immediately, returned to outer render.
  //     Inner Suspense boundaries stay lazy so the client paints
  //     fallbacks until they stream in.
  //   • storage branch → buffered, fully resolved, stripped of dynamic
  //     partial wrappers, re-encoded, stored. Runs in the background.
  //
  // The manifest ALS was opened in the `Cache` wrapper, so tracked
  // accessor calls inside the inner render populate `manifest` via
  // async_hooks inheritance even though the consumer of the stream
  // (this function) sits outside the immediate `als.run` scope.
  const stream = renderToReadableStream(stripped);
  const [userBranch, storageBranch] = stream.tee();

  const storagePromise = (async () => {
    const rawBytes = await readAll(storageBranch);
    // At this point the inner render has completed — every accessor
    // call has fired — so `manifest` is final. Verify against any
    // stored manifest. Added-key violations already threw synchronously
    // during render; here we catch the "missing-key" case (stored had
    // X, current didn't touch X). That's a soft failure: log + preserve
    // the old entry. Overwriting would flip the cache shape.
    if (storedManifest && !manifestsEqual(storedManifest, manifest)) {
      console.error(
        `[cache] manifest mismatch on miss for "${id}" — preserving old entry.`,
        {
          previous: manifestToSorted(storedManifest),
          current: manifestToSorted(manifest),
        },
      );
      return new Map<string, PartialSnapshot>();
    }

    const rawDecoded = await createFromReadableStream<ReactNode>(
      bytesToStream(rawBytes),
    );
    const rawResolved = await resolveLazies(rawDecoded);

    const { stripped: holeTree, snapshots } = stripDynamicWrappers(
      rawResolved,
      staticIds,
    );

    const cleanBytes = await renderAndBuffer(holeTree);

    // Derive the entry key from the (now verified) manifest.
    const values = resolveManifest(manifest);
    const key = `${baseKey}:${hashParts(values, options.vary ?? null)}`;

    manifestStore.set(baseKey, new Set(manifest));
    await store.set(
      key,
      freshEntry(cleanBytes, options.maxAge, options.staleWhileRevalidate, Date.now()),
    );
    setSnapshots(key, snapshots);
    return snapshots;
  })();

  storagePromise.catch((err) => {
    console.error(`[cache] storage finalize failed for ${baseKey}:`, err);
  });

  const liveTree = await createFromReadableStream<ReactNode>(userBranch);
  // `ids` kept around so TS doesn't prune the parameter — it's folded
  // into baseKey by the caller before we're invoked.
  void ids;
  return { liveTree, dynamicSnapshots: new Map() };
}

async function refreshEntry(
  baseKey: string,
  _oldKey: string,
  stripped: ReactNode,
  ids: string[],
  options: CacheOptions,
  partialId: string,
): Promise<void> {
  // SWR refresh runs in a separate async chain; open its own manifest
  // scope so accessor calls during re-render go into the right bucket.
  const storedManifest = manifestStore.get(baseKey);
  const scope: ManifestScope = {
    current: new Set(),
    stored: storedManifest ?? null,
    partialId,
  };

  await runWithCacheManifest(scope, async () => {
    const stream = renderToReadableStream(stripped);
    const bytes = await readAll(stream);

    const manifest = scope.current;
    if (storedManifest && !manifestsEqual(storedManifest, manifest)) {
      // Log and preserve the existing entry rather than overwriting
      // with the conflicting one.
      console.error(
        `[cache] SWR refresh for ${baseKey}: manifest mismatch, preserving old entry.`,
        {
          previous: manifestToSorted(storedManifest),
          current: manifestToSorted(manifest),
        },
      );
      return;
    }

    const decoded = await createFromReadableStream<ReactNode>(
      bytesToStream(bytes),
    );
    const resolved = await resolveLazies(decoded);
    const { stripped: holeTree, snapshots } = stripDynamicWrappers(
      resolved,
      new Set(ids),
    );
    const cleanBytes = await renderAndBuffer(holeTree);

    const values = resolveManifest(manifest);
    const key = `${baseKey}:${hashParts(values, options.vary ?? null)}`;

    manifestStore.set(baseKey, new Set(manifest));
    await store.set(
      key,
      freshEntry(cleanBytes, options.maxAge, options.staleWhileRevalidate, Date.now()),
    );
    setSnapshots(key, snapshots);
  });
}

function freshEntry(
  bytes: Uint8Array,
  maxAge: number | undefined,
  swr: number | undefined,
  now: number,
): Entry {
  const expiresAt =
    maxAge != null ? now + maxAge * 1000 : Number.POSITIVE_INFINITY;
  const staleUntil =
    swr != null && maxAge != null ? expiresAt + swr * 1000 : expiresAt;
  return { bytes, expiresAt, staleUntil };
}

// ─── Dev / debugging helpers ────────────────────────────────────────────

export function _cacheStats(): Promise<{ size: number; keys: string[] }> {
  return store.stats();
}

export async function _clearCache(): Promise<void> {
  await store.clear();
  snapshotIndex.clear();
  manifestStore.clear();
  inFlightMiss.clear();
  refreshing.clear();
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => {
    void _clearCache();
  });
  import.meta.hot.on("vite:beforeFullReload", () => {
    void _clearCache();
  });
}

// `getCurrentCacheManifest` is re-exported so tests can introspect.
export { getCurrentCacheManifest };
