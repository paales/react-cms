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

import { getScope, readCookie, setCookie } from "./context.ts"

export interface FrameSessionState {
  url: string
}

export interface SessionState {
  /** Keys are dotted frame paths (e.g. `"cart"` or `"products.list"`). */
  frames: Record<string, FrameSessionState>
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
  // Read directly via `readCookie`: the session cookie is framework-
  // internal plumbing (every request that resolves a frame URL reads
  // it). Attributing it to the Partial that triggered the lookup
  // would force every page's manifest to include `cookie:__frame_sid`,
  // and the hoisting check would refuse the first request that
  // introduces any frame at all.
  return readCookie(SESSION_COOKIE) ?? null
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
  if (!id) return { frames: {} }
  return store().get(id) ?? { frames: {} }
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
  const existing = b.get(id) ?? { frames: {} }
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

/**
 * Bare session identity — the only session surface vary and cells
 * see. `cell.vary({session}) => ({sid: session.id})` is the
 * canonical per-user partition pattern.
 *
 * Empty string when no session cookie yet AND no write has triggered
 * cookie creation (read-only anon request) — cells should treat
 * this as "no session" and either pick a different partition axis
 * or accept the anon bucket.
 */
export interface SessionId {
  readonly id: string
}

/**
 * Session surface exposed to `vary` and `cell.vary` callbacks.
 * Today this is just `SessionId` — the legacy named-key readers
 * (`session.text/number/boolean/enum`) moved to the cell primitive.
 * Kept as a separate type name for forward extensibility (a future
 * `session.scopes` surface, etc.).
 */
export type SessionReadSurface = SessionId

/** Sync, request-bound session-read surface for vary callbacks. */
export function createSessionReadSurface(): SessionReadSurface {
  return {
    get id() {
      return getSessionId() ?? ""
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
