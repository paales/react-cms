/**
 * Framework-level session store.
 *
 * A cookie (`__frame_sid`) carries a session ID; the server holds the
 * per-session state in an in-memory map (swap for Redis/KV later
 * behind the same interface). State: frame URLs keyed by the frame's
 * dotted PATH (every `<Partial frame="…">` ancestor joined with `.`),
 * so nested frames live alongside each other without name collisions.
 * The session is the **source of truth** for "what scene is the user
 * looking at" — the window URL is a shareable projection over it
 * (see `docs/internals/frame-scope.md`).
 *
 *   cookie `__frame_sid=abc123` → store[abc123] = {
 *     frames: {
 *       "cart": { url: "/cart/checkout" },
 *       "menu": { url: "/menu/about" },
 *       "products.list": { url: "/products/list?page=3" },
 *     }
 *   }
 *
 * A page refresh re-reads the session, so the user sees the same
 * scene. Closing the browser, reopening, and hitting the same URL
 * gets the same scene — as long as the cookie is still there and
 * the server hasn't evicted the session.
 *
 * ── Scoping ─────────────────────────────────────────────────────────
 * The store is bucketed per request scope (`getScope()`). In prod,
 * every user maps to the default scope and sessions are looked up
 * cookie-to-state as before. In dev, Playwright workers supply a
 * per-worker `x-test-scope` header so parallel test workers don't
 * trample each other's session state.
 */

import { _readCookieUntracked, getScope, setCookie } from "./context.ts"

export interface FrameSessionState {
  url: string
}

export interface SessionState {
  /** Keys are dotted frame paths (e.g. `"cart"` or `"products.list"`). */
  frames: Record<string, FrameSessionState>
  /** Per-key session values written via `setSessionValue` and read in
   *  `vary` through the `session.*` surface. Values are
   *  JSON-serialisable. */
  values: Record<string, unknown>
}

/**
 * Canonical string key for a frame path. Empty path throws — a frame
 * always has at least one name (the Partial's local `frame` prop).
 */
function pathKey(path: readonly string[]): string {
  if (path.length === 0) {
    throw new Error("session: frame path must be non-empty")
  }
  return path.join(".")
}

const SESSION_COOKIE = "__frame_sid"

// CATEGORY C (docs/internals/server-isolation.md) — intentional shared map,
// now nested under a per-scope bucket. Inner map keyed by opaque
// session ID; different users don't collide within a scope.
const scopes = new Map<string, Map<string, SessionState>>()

function store(scope: string = getScope()): Map<string, SessionState> {
  let b = scopes.get(scope)
  if (!b) {
    b = new Map()
    scopes.set(scope, b)
  }
  return b
}

function generateSessionId(): string {
  return crypto.randomUUID()
}

/**
 * Return the session ID from the cookie, or `null` if none. Does NOT
 * create a new session.
 */
export function getSessionId(): string | null {
  // Untracked: the session cookie is framework-internal plumbing
  // (every request that resolves a frame URL reads it). Attributing
  // it to the Partial that triggered the lookup would force every
  // page's manifest to include `cookie:__frame_sid`, and the
  // hoisting check would refuse the first request that introduces
  // any frame at all (the manifest grows). See the comment on
  // `_readCookieUntracked` in `framework/context.ts`.
  return _readCookieUntracked(SESSION_COOKIE) ?? null
}

/**
 * Ensure a session exists. If the cookie is missing, generate a new
 * session ID and `Set-Cookie` it for the response. Returns the ID.
 *
 * Side-effect: writes to the response's Set-Cookie accumulator on
 * first use. Subsequent calls in the same request are idempotent.
 */
export function ensureSessionId(): string {
  const existing = getSessionId()
  if (existing) return existing
  const fresh = generateSessionId()
  setCookie(SESSION_COOKIE, fresh)
  return fresh
}

/**
 * Read the full session state, or an empty state if there's no
 * session yet (or the session ID points to nothing — e.g. cleared
 * between processes).
 */
export function getSessionState(): SessionState {
  const id = getSessionId()
  if (!id) return { frames: {}, values: {} }
  return store().get(id) ?? { frames: {}, values: {} }
}

/**
 * Look up one frame's URL in the session. Returns `null` if no
 * session or no entry for this frame. `path` is the dotted frame
 * path (every `<Partial frame>` ancestor from root, inner-most last).
 */
export function getSessionFrameUrl(path: readonly string[]): string | null {
  return getSessionState().frames[pathKey(path)]?.url ?? null
}

/**
 * Set (or overwrite) a frame's URL in the session. Creates the
 * session (and Set-Cookies the ID) if it doesn't exist yet.
 */
export function setSessionFrameUrl(path: readonly string[], url: string): void {
  const id = ensureSessionId()
  const b = store()
  const existing = b.get(id) ?? { frames: {}, values: {} }
  existing.frames = { ...existing.frames, [pathKey(path)]: { url } }
  b.set(id, existing)
}

/**
 * Remove a frame entry from the session (e.g. a closing drawer). No-op
 * if there's no session or no entry.
 */
export function clearSessionFrame(path: readonly string[]): void {
  const id = getSessionId()
  if (!id) return
  const b = store()
  const existing = b.get(id)
  if (!existing) return
  const key = pathKey(path)
  const { [key]: _removed, ...rest } = existing.frames
  existing.frames = rest
  b.set(id, existing)
}

// ── Per-key session values ─────────────────────────────────────────────
//
// `vary` reads values via the `session.*` surface (sync, deps-tracked);
// client code writes via the `setSessionValue` server action which
// fires implicit invalidation against every spec whose `vary` recorded
// a read on that key.

/**
 * Read one session value, or `undefined` if absent. Untyped at the
 * value layer; the read surface coerces and applies defaults.
 */
export function getSessionValue(name: string): unknown {
  return getSessionState().values[name]
}

/**
 * Write a session value. Creates the session (and Set-Cookies the ID)
 * if it doesn't exist yet. Internal — the public surface is the
 * `setSessionValue` server action.
 */
export function _writeSessionValue(name: string, value: unknown): void {
  const id = ensureSessionId()
  const b = store()
  const existing = b.get(id) ?? { frames: {}, values: {} }
  existing.values = { ...existing.values, [name]: value }
  b.set(id, existing)
}

/**
 * Sync read surface bound to the request's session. Each method
 * records its `name` in `deps` so the spec pipeline can store the
 * read keys on the partial's snapshot — server actions that mutate a
 * key then walk snapshots to fire targeted invalidations.
 *
 * Defaults: when the key is absent or the stored value's type doesn't
 * match the read shape, the surface returns the supplied default
 * (`""` / `0` / `false` / `values[0]`). Vary returns a stable shape
 * on first authoring without conditional defaults at every call site.
 */
export interface SessionReadSurface {
  text(name: string, defaultValue?: string): string
  number(name: string, defaultValue?: number): number
  boolean(name: string, defaultValue?: boolean): boolean
  enum<T extends string>(name: string, values: readonly T[], defaultValue?: T): T
}

export function createSessionReadSurface(deps: Set<string>): SessionReadSurface {
  return {
    text(name, defaultValue = "") {
      deps.add(name)
      const v = getSessionValue(name)
      return typeof v === "string" ? v : defaultValue
    },
    number(name, defaultValue = 0) {
      deps.add(name)
      const v = getSessionValue(name)
      return typeof v === "number" ? v : defaultValue
    },
    boolean(name, defaultValue = false) {
      deps.add(name)
      const v = getSessionValue(name)
      return typeof v === "boolean" ? v : defaultValue
    },
    enum<T extends string>(name: string, values: readonly T[], defaultValue?: T): T {
      deps.add(name)
      const v = getSessionValue(name)
      if (typeof v === "string" && (values as readonly string[]).includes(v)) return v as T
      return (defaultValue ?? values[0]) as T
    },
  }
}

/**
 * Test-only: wipe sessions. No argument (or `"all"`): all scopes;
 * otherwise the named scope only. Per-worker clears flow through
 * `/__test/clear-caches`, which forwards the request scope.
 */
export function _clearAllSessions(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    scopes.clear()
    return
  }
  scopes.delete(scope)
}

/** Test/debug: stats on the current scope's session store. */
export function _sessionStats(): {
  sessions: number
  frameCounts: Record<string, number>
} {
  const frameCounts: Record<string, number> = {}
  const b = store()
  for (const state of b.values()) {
    for (const framePath of Object.keys(state.frames)) {
      frameCounts[framePath] = (frameCounts[framePath] ?? 0) + 1
    }
  }
  return { sessions: b.size, frameCounts }
}

if (import.meta.hot) {
  // HMR: sessions reference URLs + nothing module-sensitive, so they
  // survive edits cleanly. But if the session store ever holds React
  // element references, this would need to clear.
}
