/**
 * Server-side render-output caching.
 *
 * `<Cache>` wraps a spec's body with the spec's `varyResult` as the
 * cache-key surface. On miss it renders to Flight bytes and stores
 * them; on hit it decodes the stored bytes back into a tree.
 *
 * Cache is an internal detail of `ReactCms.partial(...)` when the
 * spec sets `cache={…}`. Authors don't render `<Cache>` directly.
 *
 * ── Composition with partials ─────────────────────────────────────
 *
 * Cached Flight bytes capture the rendered subtree as-is. If the
 * subtree contains a `<PartialBoundary>`, the partial's content gets
 * frozen in the bytes — refetching the partial wouldn't refresh until
 * the cache entry expires. To make Cache and Partial compose, we strip
 * inner partials to placeholders before serializing and re-inject the
 * current live elements on the way out. Result: cache captures the
 * stable scaffolding, partials stay live.
 */

import {
  Fragment,
  Suspense,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"
import { createFromReadableStream, renderToReadableStream } from "./flight-runtime.ts"
import { djb2 } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { PartialBoundary, getSpecComponentById } from "./partial.tsx"
import { getScope } from "../framework/context.ts"
import { lookupPartial, registerPartial, type PartialSnapshot } from "./partial-registry.ts"
import type { CacheOptions } from "./cache-options.ts"

// ─── Store ─────────────────────────────────────────────────────────────

interface Entry {
  bytes: Uint8Array
  expiresAt: number
  staleUntil: number
}

interface CacheStore {
  get(key: string): Promise<Entry | undefined>
  set(key: string, entry: Entry): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<{ size: number; keys: string[] }>
}

class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Entry>()
  private readonly maxEntries: number

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries
  }

  async get(key: string): Promise<Entry | undefined> {
    const entry = this.map.get(key)
    if (entry !== undefined) {
      this.map.delete(key)
      this.map.set(key, entry)
    }
    return entry
  }

  async set(key: string, entry: Entry): Promise<void> {
    this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async clear(): Promise<void> {
    this.map.clear()
  }

  async stats(): Promise<{ size: number; keys: string[] }> {
    return { size: this.map.size, keys: [...this.map.keys()] }
  }
}

const SNAPSHOT_INDEX_MAX = 10_000

interface ScopeState {
  store: CacheStore
  snapshotIndex: Map<string, Map<string, PartialSnapshot>>
  refreshing: Set<string>
  inFlightMiss: Map<
    string,
    Promise<{ liveTree: ReactNode; dynamicSnapshots: Map<string, PartialSnapshot> }>
  >
}

const scopes = new Map<string, ScopeState>()

function state(scope: string = getScope()): ScopeState {
  let s = scopes.get(scope)
  if (!s) {
    s = {
      store: new MemoryCacheStore(),
      snapshotIndex: new Map(),
      refreshing: new Set(),
      inFlightMiss: new Map(),
    }
    scopes.set(scope, s)
  }
  return s
}

function setSnapshots(key: string, snaps: Map<string, PartialSnapshot>): void {
  const { snapshotIndex } = state()
  snapshotIndex.delete(key)
  snapshotIndex.set(key, snaps)
  while (snapshotIndex.size > SNAPSHOT_INDEX_MAX) {
    const oldest = snapshotIndex.keys().next().value
    if (oldest === undefined) break
    snapshotIndex.delete(oldest)
  }
}

function hashParts(...parts: unknown[]): string {
  return djb2(stableStringify(parts))
}

// ─── Lazy-ref resolution ───────────────────────────────────────────────

const LAZY_SYMBOL_STR = "Symbol(react.lazy)"

async function awaitLazy(node: unknown): Promise<unknown> {
  const n = node as {
    $$typeof?: symbol
    _payload?: { _status?: number; _result?: unknown }
    _init?: (payload: unknown) => unknown
  }
  if (typeof n.$$typeof !== "symbol") return node
  if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node
  const payload = n._payload
  if (payload && payload._status === 1) return payload._result
  try {
    const init = n._init
    if (typeof init === "function") return init(payload)
  } catch (pending) {
    if (pending && typeof (pending as { then?: unknown }).then === "function") {
      await pending
      const init = n._init
      if (typeof init === "function") {
        try {
          return init(payload)
        } catch (err) {
          if (err && typeof (err as { then?: unknown }).then === "function") {
            await err
            return n._init?.(payload)
          }
          throw err
        }
      }
    }
    throw pending
  }
  return node
}

async function resolveLazies(node: ReactNode): Promise<ReactNode> {
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    const out = await Promise.all(node.map((c) => resolveLazies(c)))
    return out
  }
  if (typeof node === "object" && node !== null) {
    const n = node as { $$typeof?: symbol }
    if (typeof n.$$typeof === "symbol" && n.$$typeof.toString() === LAZY_SYMBOL_STR) {
      const resolved = await awaitLazy(node)
      return resolveLazies(resolved as ReactNode)
    }
  }
  if (!isValidElement(node)) return node

  const children = (node.props as { children?: ReactNode }).children
  if (children == null) return node
  const newChildren = await resolveLazies(children)
  if (newChildren === children) return node
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren)
}

// ─── Partial strip / reinject ──────────────────────────────────────────

function placeholderFor(id: string): ReactElement {
  return createElement("i", {
    key: id,
    hidden: true,
    "data-partial": true,
    "data-partial-id": id,
  })
}

function isExistingPlaceholder(node: ReactElement): boolean {
  return node.type === "i" && (node.props as Record<string, unknown>)["data-partial"] === true
}

function placeholderIdOf(node: ReactElement): string | null {
  const props = node.props as { ["data-partial-id"]?: unknown }
  if (typeof props["data-partial-id"] === "string") return props["data-partial-id"]
  return node.key != null ? String(node.key) : null
}

function partialIdOf(node: ReactElement): string | null {
  if (node.key == null) return null
  const keyStr = String(node.key)
  const hashIdx = keyStr.indexOf("#")
  const candidate = hashIdx >= 0 ? keyStr.slice(0, hashIdx) : keyStr
  return lookupPartial(candidate) ? candidate : null
}

function stripPartials(node: ReactNode): {
  stripped: ReactNode
  partials: Map<string, ReactElement>
  ids: string[]
} {
  const partials = new Map<string, ReactElement>()

  const walk = (n: ReactNode): ReactNode => {
    if (n == null || typeof n === "boolean") return n
    if (typeof n === "string" || typeof n === "number") return n
    if (Array.isArray(n)) {
      let changed = false
      const out = n.map((c) => {
        const w = walk(c)
        if (w !== c) changed = true
        return w
      })
      return changed ? out : n
    }
    if (!isValidElement(n)) return n

    if (n.type === PartialBoundary) {
      const id = (n.props as { id: string }).id
      partials.set(id, n)
      return placeholderFor(id)
    }

    if (isExistingPlaceholder(n)) {
      partials.set(String(n.key), n)
      return n
    }

    const partialId = partialIdOf(n)
    if (partialId != null && !partials.has(partialId)) {
      partials.set(partialId, n)
      return placeholderFor(partialId)
    }

    const kids = (n.props as { children?: ReactNode }).children
    if (kids == null) return n
    const nk = walk(kids)
    if (nk === kids) return n
    return Array.isArray(nk) ? cloneElement(n, {}, ...nk) : cloneElement(n, {}, nk)
  }

  const stripped = walk(node)
  return { stripped, partials, ids: [...partials.keys()].sort() }
}

function reinject(node: ReactNode, partials: Map<string, ReactElement>): ReactNode {
  if (partials.size === 0) return node
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    let changed = false
    const out = node.map((c) => {
      const r = reinject(c, partials)
      if (r !== c) changed = true
      return r
    })
    return changed ? out : node
  }
  if (!isValidElement(node)) return node

  if (isExistingPlaceholder(node)) {
    const id = placeholderIdOf(node)
    if (id) {
      const live = partials.get(id)
      if (live) return live
    }
    return node
  }

  const kids = (node.props as { children?: ReactNode }).children
  if (kids == null) return node
  const nk = reinject(kids, partials)
  if (nk === kids) return node
  return Array.isArray(nk) ? cloneElement(node, {}, ...nk) : cloneElement(node, {}, nk)
}

// ─── Dynamic partial strip / reinject ────────────────────────────────────

function renderedWrapperId(node: ReactElement): string | null {
  const props = node.props as { partialId?: unknown }
  if (typeof props.partialId === "string") return props.partialId
  if (node.type === Suspense && node.key != null) return String(node.key)
  return null
}

function stripDynamicWrappers(
  node: ReactNode,
  skipIds: Set<string>,
): { stripped: ReactNode; snapshots: Map<string, PartialSnapshot> } {
  const snapshots = new Map<string, PartialSnapshot>()

  const walk = (n: ReactNode): ReactNode => {
    if (n == null || typeof n === "boolean") return n
    if (typeof n === "string" || typeof n === "number") return n
    if (Array.isArray(n)) {
      let changed = false
      const out = n.map((c) => {
        const w = walk(c)
        if (w !== c) changed = true
        return w
      })
      return changed ? out : n
    }
    if (!isValidElement(n)) return n

    const wid = renderedWrapperId(n)
    if (wid && !skipIds.has(wid)) {
      const snap = lookupPartial(wid)
      if (snap) {
        snapshots.set(wid, snap)
        return placeholderFor(wid)
      }
    }

    const kids = (n.props as { children?: ReactNode }).children
    if (kids == null) return n
    const nk = walk(kids)
    if (nk === kids) return n
    return Array.isArray(nk) ? cloneElement(n, {}, ...nk) : cloneElement(n, {}, nk)
  }

  return { stripped: walk(node), snapshots }
}

function reinjectDynamic(node: ReactNode, snapshots: Map<string, PartialSnapshot>): ReactNode {
  if (snapshots.size === 0) return node
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    let changed = false
    const out = node.map((c) => {
      const r = reinjectDynamic(c, snapshots)
      if (r !== c) changed = true
      return r
    })
    return changed ? out : node
  }
  if (!isValidElement(node)) return node

  if (isExistingPlaceholder(node)) {
    const id = placeholderIdOf(node)
    if (id) {
      const snap = snapshots.get(id)
      if (snap) {
        // Use the spec component registry to reconstruct.
        const Component = getSpecComponentById(id)
        if (Component) {
          const parent = { path: snap.parentPath, frameChain: snap.parentFrameChain }
          return createElement(Fragment, { key: node.key ?? id }, createElement(Component, { parent }))
        }
      }
    }
    return node
  }

  const kids = (node.props as { children?: ReactNode }).children
  if (kids == null) return node
  const nk = reinjectDynamic(kids, snapshots)
  if (nk === kids) return node
  return Array.isArray(nk) ? cloneElement(node, {}, ...nk) : cloneElement(node, {}, nk)
}

function registerDynamicSnapshots(snapshots: Map<string, PartialSnapshot>): void {
  for (const [sId, snap] of snapshots) registerPartial(sId, snap)
}

// ─── Cache component ────────────────────────────────────────────────────

interface CacheProps {
  id: string
  fingerprint: string
  options: CacheOptions
  /** vary result from the spec — IS the cache-key surface. */
  varyResult: unknown
  children: ReactNode
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function renderAndBuffer(children: ReactNode): Promise<Uint8Array> {
  const stream = renderToReadableStream(children)
  return await readAll(stream)
}

export async function Cache({
  id,
  fingerprint,
  options,
  varyResult,
  children,
}: CacheProps): Promise<ReactNode> {
  if (options.bypass) return children
  return cacheImpl(id, fingerprint, options, varyResult, children)
}

async function cacheImpl(
  id: string,
  fingerprint: string,
  options: CacheOptions,
  varyResult: unknown,
  children: ReactNode,
): Promise<ReactNode> {
  const { store, snapshotIndex, refreshing, inFlightMiss } = state()

  const { stripped, partials, ids } = stripPartials(children)
  const baseKey = `${id}:${fingerprint}:${djb2(ids.join(","))}`
  const key = `${baseKey}:${hashParts(varyResult, options.vary ?? null)}`
  const now = Date.now()

  // ── Hit path ──
  const existing = await store.get(key)
  const existingSnapshots = existing ? snapshotIndex.get(key) : undefined
  if (existing && existingSnapshots) {
    if (existing.expiresAt > now || existing.staleUntil > now) {
      registerDynamicSnapshots(existingSnapshots)
      if (existing.expiresAt <= now && !refreshing.has(key)) {
        refreshing.add(key)
        void refreshEntry(baseKey, key, stripped, ids, options, varyResult)
          .catch((err) => console.error(`[cache] SWR refresh failed for ${key}:`, err))
          .finally(() => refreshing.delete(key))
      }
      const decoded = await createFromReadableStream<ReactNode>(bytesToStream(existing.bytes))
      const resolved = await resolveLazies(decoded)
      const withStatic = reinject(resolved, partials)
      return reinjectDynamic(withStatic, existingSnapshots)
    }
  }

  // ── Miss path ──
  const staticIdSet = new Set(ids)
  let pending = inFlightMiss.get(baseKey)
  if (!pending) {
    pending = renderMissAndStore(key, stripped, staticIdSet, options).finally(() =>
      inFlightMiss.delete(baseKey),
    )
    inFlightMiss.set(baseKey, pending)
  }
  const { liveTree } = await pending
  return reinject(liveTree, partials)
}

async function renderMissAndStore(
  key: string,
  stripped: ReactNode,
  staticIds: Set<string>,
  options: CacheOptions,
): Promise<{ liveTree: ReactNode; dynamicSnapshots: Map<string, PartialSnapshot> }> {
  const { store } = state()
  const stream = renderToReadableStream(stripped)
  const [userBranch, storageBranch] = stream.tee()

  const storagePromise = (async () => {
    const rawBytes = await readAll(storageBranch)
    const rawDecoded = await createFromReadableStream<ReactNode>(bytesToStream(rawBytes))
    const rawResolved = await resolveLazies(rawDecoded)

    const { stripped: holeTree, snapshots } = stripDynamicWrappers(rawResolved, staticIds)
    const cleanBytes = await renderAndBuffer(holeTree)

    await store.set(
      key,
      freshEntry(cleanBytes, options.maxAge, options.staleWhileRevalidate, Date.now()),
    )
    setSnapshots(key, snapshots)
    return snapshots
  })()

  storagePromise.catch((err) => {
    console.error(`[cache] storage finalize failed for ${key}:`, err)
  })

  const liveTree = await createFromReadableStream<ReactNode>(userBranch)
  return { liveTree, dynamicSnapshots: new Map() }
}

async function refreshEntry(
  _baseKey: string,
  key: string,
  stripped: ReactNode,
  ids: string[],
  options: CacheOptions,
  _varyResult: unknown,
): Promise<void> {
  const { store } = state()
  const stream = renderToReadableStream(stripped)
  const bytes = await readAll(stream)
  const decoded = await createFromReadableStream<ReactNode>(bytesToStream(bytes))
  const resolved = await resolveLazies(decoded)
  const { stripped: holeTree, snapshots } = stripDynamicWrappers(resolved, new Set(ids))
  const cleanBytes = await renderAndBuffer(holeTree)
  await store.set(
    key,
    freshEntry(cleanBytes, options.maxAge, options.staleWhileRevalidate, Date.now()),
  )
  setSnapshots(key, snapshots)
}

function freshEntry(
  bytes: Uint8Array,
  maxAge: number | undefined,
  swr: number | undefined,
  now: number,
): Entry {
  const expiresAt = maxAge != null ? now + maxAge * 1000 : Number.POSITIVE_INFINITY
  const staleUntil = swr != null && maxAge != null ? expiresAt + swr * 1000 : expiresAt
  return { bytes, expiresAt, staleUntil }
}

export function _cacheStats(): Promise<{ size: number; keys: string[] }> {
  return state().store.stats()
}

export async function _clearCache(scope?: string | "all"): Promise<void> {
  if (scope === undefined || scope === "all") {
    const all = [...scopes.values()]
    scopes.clear()
    await Promise.all(all.map((s) => s.store.clear()))
    return
  }
  const s = scopes.get(scope)
  if (!s) return
  scopes.delete(scope)
  await s.store.clear()
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => {
    void _clearCache()
  })
  import.meta.hot.on("vite:beforeFullReload", () => {
    void _clearCache()
  })
}
