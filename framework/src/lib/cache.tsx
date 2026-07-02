/**
 * Server-side render-output caching.
 *
 * `<Cache>` wraps a spec's body with the spec's `varyResult` as the
 * cache-key surface. On miss it renders the body to Flight bytes,
 * strips every inner-parton boundary to an `<i hidden data-partial-id>`
 * placeholder (`flight-graph.stripHoles`), and stores the lean
 * scaffolding. On hit it streams the scaffolding back and splices a
 * freshly-rendered parton at each placeholder (`flight-graph.spliceHoles`)
 * — so the cached frame is byte-replayed (Suspense pacing intact) while
 * its dynamic holes re-render live per request.
 *
 * Cache is an internal detail of `parton(...)` when the spec sets
 * `cache={…}`. Authors don't render `<Cache>` directly.
 *
 * ── One path ──────────────────────────────────────────────────────────
 *
 * There's a single store + replay path. A region with no inner partons
 * strips to zero holes; `spliceHoles` then degenerates to passing the
 * stored bytes straight through (the streaming-preservation case). A
 * region with inner partons gets each one spliced live. No decode /
 * `resolveLazies` / re-encode round-trip — the rewrite is row-level, so
 * inner Suspense never flattens.
 */

import type { ReactNode } from "react"
import { createFromReadableStream, renderToReadableStream } from "./flight-runtime.ts"
import { spliceHoles, stripHoles, type HoleRef, type SpliceMeta } from "./flight-graph.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { partialFromSnapshot } from "./partial.tsx"
import { ParentContext, type PartialCtx } from "./partial-context.ts"
import { getScope } from "../runtime/context.ts"
import { lookupPartial, registerPartial, type PartialSnapshot } from "./partial-registry.ts"
import type { CacheOptions } from "./cache-options.ts"
import { getServerContext } from "./server-context.ts"

// ─── Store ─────────────────────────────────────────────────────────────

/** An inner parton hole, enriched at store time with the snapshot the
 *  hit path needs: its `parentPath` / `frameChain` drive the fresh
 *  render, and re-registering the snapshot keeps the parton addressable
 *  for selector refetches even though its producer didn't run. */
interface StoredHole extends HoleRef {
  snapshot: PartialSnapshot
}

interface Entry {
  /** Stripped scaffolding bytes (holes are inert placeholders). */
  bytes: Uint8Array
  /** Inner partons to splice live on a hit, in document order. */
  holes: StoredHole[]
  /** Renumber/dedup facts the splice needs without rebuffering. */
  meta: SpliceMeta
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

interface ScopeState {
  store: CacheStore
  refreshing: Set<string>
  inFlightMiss: Map<string, Promise<{ liveTree: ReactNode }>>
}

const scopes = new Map<string, ScopeState>()

function state(scope: string = getScope()): ScopeState {
  let s = scopes.get(scope)
  if (!s) {
    s = {
      store: new MemoryCacheStore(),
      refreshing: new Set(),
      inFlightMiss: new Map(),
    }
    scopes.set(scope, s)
  }
  return s
}

function hashParts(...parts: unknown[]): string {
  return hash(stableStringify(parts))
}

// ─── Stream helpers ─────────────────────────────────────────────────────

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

/**
 * Dev-only. Emits stored bytes in fixed-size chunks separated by
 * `perChunkMs`. Feeds the splice's scaffold stream slowly so the hit
 * path acts as a throttled source — the same shape a `<RemoteFrame>`
 * sees from a slow cross-origin Flight payload, and what the
 * `/cache-streaming-demo` page exercises end-to-end.
 */
function slowBytesToStream(
  bytes: Uint8Array,
  perChunkMs: number,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let offset = 0
  const total = bytes.byteLength
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkBytes, total)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
      await new Promise((r) => setTimeout(r, perChunkMs))
    },
  })
}

// ─── Hole render / replay ────────────────────────────────────────────────

/** Enrich the byte-level holes with their registry snapshot, captured
 *  while the producing render is still warm. A hole whose spec didn't
 *  register (shouldn't happen for a rendered parton) is dropped — its
 *  placeholder then stays inert on replay. */
function enrichHoles(holes: HoleRef[]): StoredHole[] {
  const out: StoredHole[] = []
  for (const h of holes) {
    const snapshot = lookupPartial(h.partialId)
    if (!snapshot) continue
    out.push({ ...h, snapshot })
  }
  return out
}

/** Render one hole fresh to its own Flight stream. `partialFromSnapshot`
 *  reconstructs the parton from stored data exactly as an isolated
 *  partial-refetch does — right Component (via `type` fallback), parent
 *  from the snapshot (no live ancestor on a hit), props replay, and
 *  `__instanceId` so the re-render keeps its per-instance wire id. A spec
 *  absent from this process resolves to `null` → an inert seam. */
function renderHoleStream(hole: StoredHole): ReadableStream<Uint8Array> {
  return renderToReadableStream(partialFromSnapshot(hole.partialId, hole.snapshot))
}

async function replayEntry(entry: Entry, options: CacheOptions): Promise<ReactNode> {
  // Re-register every hole so `reload({selector})` + cache-mode reads
  // resolve it even though the cached spec's body was short-circuited.
  for (const hole of entry.holes) registerPartial(hole.partialId, hole.snapshot)

  const feed = options.slowSource
    ? slowBytesToStream(
        entry.bytes,
        options.slowSource.perChunkMs,
        options.slowSource.chunkBytes ?? 64,
      )
    : bytesToStream(entry.bytes)
  const spliced = spliceHoles(feed, entry.holes, entry.meta, renderHoleStream)
  return await createFromReadableStream<ReactNode>(spliced)
}

// ─── Cache component ────────────────────────────────────────────────────

interface CacheProps {
  id: string
  fingerprint: string
  /** Store-time fingerprint. Called AFTER the body has rendered, so it
   *  folds the LIVE tracked-read set — an entry is never keyed
   *  dep-less unless the body truly reads nothing. The pre-render
   *  `fingerprint` (folding the prior dep record) stays the lookup
   *  key: a lookup either hits a deps-complete entry or misses into a
   *  fresh render, so a cold record over-fetches, never serves stale
   *  bytes keyed under different read values. */
  writeFingerprint: () => string
  options: CacheOptions
  /** vary result from the spec — IS the cache-key surface (minus
   *  `expiresAt` / `staleUntil` reserved keys, which the framework
   *  strips before feeding fp and cache lookups). */
  varyResult: unknown
  children: ReactNode
}

export async function Cache({
  id,
  fingerprint,
  writeFingerprint,
  options,
  varyResult,
  children,
}: CacheProps): Promise<ReactNode> {
  // Capture the cached parton's context synchronously here (the `<Cache>`
  // element is rendered inside the parton's body, so its ambient parent IS
  // the parton's child context). The isolated body renders are seeded with
  // it so their partons thread correctly.
  const bodyParent = getServerContext(ParentContext)
  return cacheImpl(id, fingerprint, writeFingerprint, options, varyResult, children, bodyParent)
}

async function cacheImpl(
  id: string,
  fingerprint: string,
  writeFingerprint: () => string,
  options: CacheOptions,
  varyResult: unknown,
  children: ReactNode,
  bodyParent: PartialCtx,
): Promise<ReactNode> {
  const { store, refreshing, inFlightMiss } = state()

  // The fingerprint already folds vary + schema + props + invalidation +
  // descendant deps, so it carries the cache-key surface; `varyResult` is
  // appended for legibility / a stable explicit axis.
  const baseKey = `${id}:${fingerprint}`
  const key = `${baseKey}:${hashParts(varyResult)}`
  // Store-time key — evaluated lazily, once the body's tracked reads
  // have all landed. On a warm record it equals `key`.
  const storeKeyOf = () => `${id}:${writeFingerprint()}:${hashParts(varyResult)}`
  const now = Date.now()

  // ── Hit path ──
  const existing = await store.get(key)
  if (existing && (existing.expiresAt > now || existing.staleUntil > now)) {
    if (existing.expiresAt <= now && !refreshing.has(key)) {
      refreshing.add(key)
      void refreshEntry(storeKeyOf, children, options, bodyParent)
        .catch((err) => console.error(`[cache] SWR refresh failed for ${key}:`, err))
        .finally(() => refreshing.delete(key))
    }
    return replayEntry(existing, options)
  }

  // ── Miss path ──
  let pending = inFlightMiss.get(baseKey)
  if (!pending) {
    pending = renderMissAndStore(storeKeyOf, children, options, bodyParent).finally(() =>
      inFlightMiss.delete(baseKey),
    )
    inFlightMiss.set(baseKey, pending)
  }
  const { liveTree } = await pending
  return liveTree
}

async function renderMissAndStore(
  storeKeyOf: () => string,
  children: ReactNode,
  options: CacheOptions,
  bodyParent: PartialCtx,
): Promise<{ liveTree: ReactNode }> {
  const { store } = state()
  const stream = renderToReadableStream(<ParentContext value={bodyParent}>{children}</ParentContext>)
  const [userBranch, storageBranch] = stream.tee()

  // Storage: buffer the rendered bytes, strip holes, capture snapshots.
  // Runs in the background — doesn't block the user-facing render. The
  // store key is computed HERE, after readAll — the render has settled,
  // so the write fingerprint folds the complete read set.
  const storagePromise = (async () => {
    const rawBytes = await readAll(storageBranch)
    const { bytes, holes, meta } = stripHoles(rawBytes)
    await store.set(
      storeKeyOf(),
      freshEntry(
        bytes,
        enrichHoles(holes),
        meta,
        options.maxAge,
        options.staleWhileRevalidate,
        Date.now(),
      ),
    )
  })()
  storagePromise.catch((err) => {
    console.error(`[cache] storage finalize failed for ${storeKeyOf()}:`, err)
  })

  // User branch: decode immediately and return the live tree. Inner
  // Suspense stays lazy so the client paints fallbacks while async work
  // resolves — the cold render streams exactly like an uncached one.
  const liveTree = await createFromReadableStream<ReactNode>(userBranch)
  return { liveTree }
}

async function refreshEntry(
  storeKeyOf: () => string,
  children: ReactNode,
  options: CacheOptions,
  bodyParent: PartialCtx,
): Promise<void> {
  const { store } = state()
  const rawBytes = await readAll(
    renderToReadableStream(<ParentContext value={bodyParent}>{children}</ParentContext>),
  )
  const { bytes, holes, meta } = stripHoles(rawBytes)
  await store.set(
    storeKeyOf(),
    freshEntry(
      bytes,
      enrichHoles(holes),
      meta,
      options.maxAge,
      options.staleWhileRevalidate,
      Date.now(),
    ),
  )
}

function freshEntry(
  bytes: Uint8Array,
  holes: StoredHole[],
  meta: SpliceMeta,
  maxAge: number | undefined,
  swr: number | undefined,
  now: number,
): Entry {
  const expiresAt = maxAge != null ? now + maxAge * 1000 : Number.POSITIVE_INFINITY
  const staleUntil = swr != null && maxAge != null ? expiresAt + swr * 1000 : expiresAt
  return { bytes, holes, meta, expiresAt, staleUntil }
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
  // See partial-registry.ts — only clear on a true full reload.
  // `vite:beforeUpdate` fires for every incremental HMR update and
  // would wipe every scope's cache on each one, polluting parallel
  // tests.
  import.meta.hot.on("vite:beforeFullReload", () => {
    void _clearCache()
  })
}
