/**
 * Storage backend for the CMS published + draft stores.
 *
 * The runtime (`cms-runtime.ts`) keeps an in-memory cache of the two
 * stores and consults it on every read. The backend is what actually
 * persists those stores — to a JSON file by default, but pluggable so
 * a deployment can substitute a database / KV / HTTP fetcher without
 * touching the runtime.
 *
 * Why this is its own module:
 *   - Sync reads from cache (Partial bodies are sync) need a non-async
 *     way to look up. The cache layer is in `cms-runtime.ts`.
 *   - Async loads + writes go here. The async API is the canonical
 *     one. A separate sync method exists ONLY for the cold-start
 *     lazy-load path (test setup, first request before any async
 *     warm-up has run); it's marked deprecated and will be dropped
 *     once every caller awaits a startup hook.
 *   - The runtime imports the backend lazily via `getCmsStorage()` so
 *     tests can inject a different backend with `setCmsStorage()`
 *     before any runtime code reads.
 *
 * Path resolution: `JsonFileStorage`'s default path is
 * `process.env.CMS_DATA_DIR` (resolved against cwd) or `src/cms/`
 * relative to cwd. `yarn dev` and `yarn preview` both run from the
 * project root so the default works for both. Real deployments set
 * `CMS_DATA_DIR=/var/lib/cms` (or wherever the JSON files live).
 */

import { existsSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from "node:fs"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { CmsStore } from "./cms-runtime.ts"

/** Loaded store + the mtime tag used for cache invalidation. */
export interface LoadedStore {
  store: CmsStore
  /** Storage-defined freshness tag. For file-system backends this is
   *  the file's `mtimeMs`; other backends can use any monotonic value
   *  that changes when the underlying data changes. The runtime
   *  treats it as opaque — it just compares to the cached value to
   *  decide whether to rebuild the index. */
  mtime: number
}

/**
 * Storage backend — async API is canonical. The sync variants exist
 * for cold-start lazy reads from the runtime cache (Partial bodies
 * are sync; if the request entry forgot to await `warmCmsCache()`,
 * the cache lazy-loads via the sync method to keep rendering
 * deterministic).
 */
export interface CmsStorage {
  loadPublished(): Promise<LoadedStore | null>
  loadPublishedSync(): LoadedStore | null
  savePublished(store: CmsStore): Promise<void>
  loadDraft(): Promise<LoadedStore | null>
  loadDraftSync(): LoadedStore | null
  saveDraft(store: CmsStore): Promise<void>
  deleteDraft(): Promise<void>
}

/**
 * Default backend — reads / writes JSON files at the configured
 * paths. Atomic writes (temp file + rename) so a mid-write crash
 * doesn't corrupt the on-disk state.
 */
export class JsonFileStorage implements CmsStorage {
  constructor(
    public readonly publishedPath: string,
    public readonly draftPath: string,
  ) {}

  async loadPublished(): Promise<LoadedStore | null> {
    return this.#loadAsync(this.publishedPath)
  }

  loadPublishedSync(): LoadedStore | null {
    return this.#loadSync(this.publishedPath)
  }

  async savePublished(store: CmsStore): Promise<void> {
    await this.#writeAtomic(this.publishedPath, store)
  }

  async loadDraft(): Promise<LoadedStore | null> {
    return this.#loadAsync(this.draftPath)
  }

  loadDraftSync(): LoadedStore | null {
    return this.#loadSync(this.draftPath)
  }

  async saveDraft(store: CmsStore): Promise<void> {
    await this.#writeAtomic(this.draftPath, store)
  }

  async deleteDraft(): Promise<void> {
    if (existsSync(this.draftPath)) await unlink(this.draftPath)
  }

  async #loadAsync(path: string): Promise<LoadedStore | null> {
    try {
      const text = await readFile(path, "utf8")
      const store = JSON.parse(text) as CmsStore
      // We use `Date.now()` instead of stat because:
      //   1. Two file ops (stat + read) are racy — the file could
      //      change between them, leaving the cache with stale bytes
      //      and a fresh mtime.
      //   2. Async readers don't need the mtime to BE the file mtime;
      //      they just need a value that changes when the bytes do.
      //      The async path is hit at request entry; freshness is
      //      established by re-reading.
      return { store, mtime: Date.now() }
    } catch {
      return null
    }
  }

  #loadSync(path: string): LoadedStore | null {
    try {
      const stat = fsStatSync(path)
      const text = fsReadFileSync(path, "utf8")
      const store = JSON.parse(text) as CmsStore
      return { store, mtime: stat.mtimeMs }
    } catch {
      return null
    }
  }

  async #writeAtomic(path: string, store: CmsStore): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    // Tmp suffix needs to be unique across concurrent writes within
    // the same process — two `writeDraftNode` calls in quick
    // succession can land on the same `Date.now()`. Append a random
    // segment so the two writes always pick distinct temp files.
    const rand = Math.random().toString(36).slice(2, 10)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${rand}`
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8")
    await rename(tmp, path)
  }
}

/**
 * Resolve the default CMS data directory.
 *
 *   1. `process.env.CMS_DATA_DIR` if set — absolute or cwd-relative.
 *   2. `src/cms` relative to cwd — works for `yarn dev` and
 *      `yarn preview` because both run from the project root.
 *
 * Production deployments either set `CMS_DATA_DIR` explicitly or
 * keep `src/cms/content.json` next to the runtime cwd. Static-import
 * bundling is no longer necessary; the JSON is read at runtime.
 */
export function defaultCmsDataDir(): string {
  const env = process.env.CMS_DATA_DIR
  if (env) return resolve(env)
  return resolve(process.cwd(), "src/cms")
}

let _instance: CmsStorage | null = null

/** Lazy singleton — created on first access. Tests / advanced
 *  callers can swap the backend via `setCmsStorage()` before the
 *  first read. */
export function getCmsStorage(): CmsStorage {
  if (!_instance) {
    const dir = defaultCmsDataDir()
    _instance = new JsonFileStorage(resolve(dir, "content.json"), resolve(dir, "draft.json"))
  }
  return _instance
}

/** Replace the singleton storage. Drops any cache the runtime might
 *  have for the old backend — call `_invalidateCmsStoreCache()` from
 *  cms-runtime if you want a clean slate after the swap. */
export function setCmsStorage(backend: CmsStorage): void {
  _instance = backend
}

/** Reset to default-resolved JsonFileStorage. Test cleanup helper. */
export function _resetCmsStorage(): void {
  _instance = null
}
