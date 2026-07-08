/**
 * Cell storage backend.
 *
 * Mirrors the CMS storage pattern (`cms-storage.ts`) — pluggable
 * interface, JSON-file default, atomic writes (temp + rename). The
 * runtime calls `read()` synchronously from inside `parton`'s render
 * path, so the canonical read is sync against an in-memory map; the
 * file is the persistence layer that survives HMR + dev restarts.
 *
 * ── Scope bucketing ─────────────────────────────────────────────────
 * Per-scope storage isolates parallel Playwright workers (each scoped
 * via `x-test-scope`) so test state doesn't leak across workers and
 * so production state doesn't leak into test runs. Layout:
 *
 *   scopes: Map<scope, Map<cellId, Map<partitionKey, value>>>
 *
 * Only the **default** scope persists to disk. Test scopes stay in
 * memory and disappear when the process exits (or the test suite
 * fires `/__test/clear-caches`). Production never sees a non-default
 * scope.
 *
 * ── Debounced flush ─────────────────────────────────────────────────
 * Writes go to memory immediately and schedule a flush for ~100ms
 * later. Rapid-fire writes (the streaming-demo's per-second tick,
 * an autosave-on-keystroke form) coalesce into one disk write per
 * window. On process exit a sync flush attempt drains the pending
 * write — best-effort; if the process is killed harder, the most
 * recent few writes can be lost, but cells are not the right
 * primitive for durability-critical state.
 */

import {
  existsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { _getRequestEphemeralStorage } from "./context.ts"

export type CellPartitionKey = string

/**
 * Pluggable storage interface. Reads are sync — `parton.schema`
 * resolution happens synchronously inside the render path. Writes
 * are sync at the API boundary; durability is a property of the
 * adapter (in-memory adapters are instant; JsonFileCellStorage debounces).
 *
 * Per-scope methods take the active request scope (`getScope()`).
 * Adapters that span scopes (e.g. a Redis driver with a `parton:`
 * key prefix) compose the key as `<scope>:<cellId>:<partitionKey>`.
 */
export interface CellStorage {
  /** Read a single cell value. Returns `undefined` on miss; the cell
   *  runtime substitutes `cell.defaultValue` in that case. */
  read(scope: string, cellId: string, partitionKey: CellPartitionKey): unknown
  /** Write a single cell value. Synchronous from the caller's POV;
   *  persistence may be deferred (JsonFileCellStorage debounces). */
  write(scope: string, cellId: string, partitionKey: CellPartitionKey, value: unknown): void
  /** Wipe stored values. No-arg / "all" → every scope. Otherwise the
   *  named scope only. */
  clear(scope?: string | "all"): void
  /** Force any pending in-memory writes to durable storage. No-op
   *  for in-memory adapters. */
  flush?(): Promise<void>
}

// ─── In-memory adapter ────────────────────────────────────────────────

/**
 * Memory-only adapter. No persistence. Used directly in tests and as
 * the per-scope bucket for `JsonFileCellStorage`'s non-default scopes.
 */
export class MemoryCellStorage implements CellStorage {
  #scopes = new Map<string, Map<string, Map<string, unknown>>>()

  read(scope: string, cellId: string, partitionKey: string): unknown {
    return this.#scopes.get(scope)?.get(cellId)?.get(partitionKey)
  }

  write(scope: string, cellId: string, partitionKey: string, value: unknown): void {
    let cellMap = this.#scopes.get(scope)
    if (!cellMap) {
      cellMap = new Map()
      this.#scopes.set(scope, cellMap)
    }
    let partMap = cellMap.get(cellId)
    if (!partMap) {
      partMap = new Map()
      cellMap.set(cellId, partMap)
    }
    partMap.set(partitionKey, value)
  }

  clear(scope?: string | "all"): void {
    if (scope === undefined || scope === "all") {
      this.#scopes.clear()
      return
    }
    this.#scopes.delete(scope)
  }

  /** Internal — snapshot the default scope for disk serialization. */
  _snapshot(scope: string): Record<string, Record<string, unknown>> | null {
    const cellMap = this.#scopes.get(scope)
    if (!cellMap || cellMap.size === 0) return null
    const out: Record<string, Record<string, unknown>> = {}
    for (const [cellId, partMap] of cellMap) {
      const partRec: Record<string, unknown> = {}
      for (const [partKey, value] of partMap) partRec[partKey] = value
      out[cellId] = partRec
    }
    return out
  }

  /** Internal — seed from a disk snapshot. */
  _hydrate(scope: string, snapshot: Record<string, Record<string, unknown>>): void {
    const cellMap = new Map<string, Map<string, unknown>>()
    for (const [cellId, partRec] of Object.entries(snapshot)) {
      const partMap = new Map<string, unknown>()
      for (const [partKey, value] of Object.entries(partRec)) partMap.set(partKey, value)
      cellMap.set(cellId, partMap)
    }
    this.#scopes.set(scope, cellMap)
  }
}

// ─── JSON-file adapter ────────────────────────────────────────────────

const DEFAULT_SCOPE = "default"
const FLUSH_DEBOUNCE_MS = 100

/**
 * JSON file storage. The default scope writes through to disk;
 * non-default scopes (Playwright workers) stay in memory only so
 * test runs don't pollute the on-disk store.
 *
 * Disk shape:
 *
 *   {
 *     "<cellId>": {
 *       "<partitionKeyHash>": <jsonValue>,
 *       …
 *     },
 *     …
 *   }
 *
 * Loaded eagerly on first instantiation via `loadSync` so the first
 * request can read its cells without an async warm-up step.
 */
export class JsonFileCellStorage implements CellStorage {
  readonly path: string
  readonly #memory = new MemoryCellStorage()
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #pending = false
  #writing = false

  constructor(path: string) {
    this.path = path
    this.#loadSync()
    // Best-effort flush on process exit so the last debounced write
    // doesn't get lost on a clean shutdown. Won't run on SIGKILL.
    const flushOnExit = () => this.#flushSync()
    process.once("exit", flushOnExit)
    process.once("SIGINT", () => {
      flushOnExit()
      process.exit(130)
    })
    process.once("SIGTERM", () => {
      flushOnExit()
      process.exit(143)
    })
  }

  read(scope: string, cellId: string, partitionKey: string): unknown {
    return this.#memory.read(scope, cellId, partitionKey)
  }

  write(scope: string, cellId: string, partitionKey: string, value: unknown): void {
    this.#memory.write(scope, cellId, partitionKey, value)
    if (scope === DEFAULT_SCOPE) this.#scheduleFlush()
  }

  clear(scope?: string | "all"): void {
    this.#memory.clear(scope)
    if (scope === undefined || scope === "all" || scope === DEFAULT_SCOPE) {
      this.#scheduleFlush()
    }
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    this.#pending = false
    await this.#writeAtomic()
  }

  // ─── Internals ────────────────────────────────────────────────────

  #loadSync(): void {
    if (!existsSync(this.path)) return
    try {
      const text = fsReadFileSync(this.path, "utf8")
      const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>
      this.#memory._hydrate(DEFAULT_SCOPE, parsed)
    } catch {
      // Malformed file — treat as empty. Author can delete or fix.
    }
  }

  #scheduleFlush(): void {
    this.#pending = true
    if (this.#flushTimer) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      if (!this.#pending) return
      void this.#writeAtomic()
    }, FLUSH_DEBOUNCE_MS)
  }

  async #writeAtomic(): Promise<void> {
    if (this.#writing) {
      // Reschedule — another write is in flight; the next tick will
      // pick up the merged state.
      this.#pending = true
      this.#scheduleFlush()
      return
    }
    this.#writing = true
    this.#pending = false
    try {
      const snapshot = this.#memory._snapshot(DEFAULT_SCOPE) ?? {}
      await mkdir(dirname(this.path), { recursive: true })
      const rand = Math.random().toString(36).slice(2, 10)
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${rand}`
      await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8")
      await rename(tmp, this.path)
    } finally {
      this.#writing = false
      // If a write came in while we were flushing, schedule another.
      if (this.#pending) this.#scheduleFlush()
    }
  }

  /** Synchronous flush for process-exit hooks. Best-effort — sync IO
   *  inside a Node exit handler. Skips if nothing pending. */
  #flushSync(): void {
    if (!this.#pending) return
    this.#pending = false
    try {
      const snapshot = this.#memory._snapshot(DEFAULT_SCOPE) ?? {}
      fsWriteFileSync(this.path, JSON.stringify(snapshot, null, 2) + "\n", "utf8")
    } catch {
      // Best-effort.
    }
  }
}

// ─── Resolver + singleton ─────────────────────────────────────────────

/**
 * Resolve the default cells data file path.
 *
 *   1. `process.env.CELLS_DATA_PATH` if set — absolute or cwd-relative.
 *   2. `<CMS_DATA_DIR or cms/data>/cells.json` (sits next to
 *      content.json / draft.json).
 */
export function defaultCellsPath(): string {
  const env = process.env.CELLS_DATA_PATH
  if (env) return resolve(env)
  const dir = process.env.CMS_DATA_DIR
    ? resolve(process.env.CMS_DATA_DIR)
    : resolve(process.cwd(), "cms/data")
  return resolve(dir, "cells.json")
}

let _instance: CellStorage | null = null

/**
 * The PERSISTENT cell storage singleton. Backs `localCell`. By
 * default a `JsonFileCellStorage` that writes to disk at
 * `cms/data/cells.json` (or `$CELLS_DATA_PATH`). Survives process
 * restart.
 *
 * Test/advanced callers can swap the backend via `setCellStorage()`.
 */
export function getCellStorage(): CellStorage {
  if (!_instance) _instance = new JsonFileCellStorage(defaultCellsPath())
  return _instance
}

/** Replace the persistent singleton storage. */
export function setCellStorage(backend: CellStorage): void {
  _instance = backend
}

/** Reset to the default-resolved JsonFileCellStorage. Test cleanup helper. */
export function _resetCellStorage(): void {
  _instance = null
}

/**
 * Outside-request fallback for the ephemeral storage. Used only
 * when `_getRequestEphemeralStorage` returns `null` (test bootstrap
 * paths, framework-internal callers without a request scope). Each
 * fallback instance is a fresh `MemoryCellStorage` — there's no
 * shared global to leak between tests.
 *
 * NOT a singleton — calling this returns a brand-new instance every
 * time. Use only when there's truly no request context to attach to.
 * Production cell reads/writes ALWAYS run inside a request context,
 * so they ALWAYS get the per-request storage.
 */
function _newEphemeralFallback(): CellStorage {
  return new MemoryCellStorage()
}

/**
 * Look up the active connection's ephemeral cell storage. Backs
 * `gqlCell` and `fragmentCell` reads/writes for the lifetime of one
 * ALS request context — which in this framework is one HTTP
 * connection (a streaming heartbeat's segment loop shares one
 * context across all its segments). Discarded when the connection
 * closes.
 *
 * Cross-connection caching (when we eventually want it) is a
 * separate layer; this primitive intentionally lives only as long
 * as the connection that opened it.
 */
export function getEphemeralCellStorage(): CellStorage {
  const store = _getRequestEphemeralStorage(_newEphemeralFallback)
  // Outside-request fallback only used for tests/bootstrap; framework
  // call sites always have a request context.
  return store ?? _newEphemeralFallback()
}
