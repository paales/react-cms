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
 *
 * ── Expiry ──────────────────────────────────────────────────────────
 * Entries expire on INACTIVITY, not age: every session read or write
 * refreshes the entry's `touchedAt`, so an active session's frame
 * URLs never vanish mid-session — only sessions idle longer than the
 * configured TTL (default 30 minutes; `configureSessionStore`) are
 * dropped, which is what bounds the store in a long-lived process.
 * The read path checks idleness before serving (an expired entry is
 * never returned, regardless of sweep timing); an opportunistic sweep
 * on store access — rate-limited to once per minute — reclaims the
 * entries no request ever reads again.
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

/** A stored session plus its inactivity clock. `touchedAt` refreshes
 *  on every read or write of the session, so expiry keys on idleness
 *  — an active session never ages out under the user. */
interface SessionEntry {
  state: SessionState
  touchedAt: number
}

/** Sessions idle longer than this are dropped. Overridable via
 *  `configureSessionStore`. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/** Rate limit for the opportunistic sweep — a full-store walk at most
 *  this often, amortized across requests. Correctness doesn't depend
 *  on it (the read path never serves an expired entry); the sweep only
 *  reclaims memory for sessions no request reads again. */
const SWEEP_INTERVAL_MS = 60 * 1000

let idleTtlMs = DEFAULT_SESSION_IDLE_TTL_MS
let lastSweepAt = 0

/**
 * Configure the in-memory session store. `idleTtlMs` is the
 * inactivity window after which a session is dropped (frame URLs and
 * all); `Infinity` disables expiry.
 */
export function configureSessionStore(opts: { idleTtlMs?: number }): void {
  if (opts.idleTtlMs !== undefined) idleTtlMs = opts.idleTtlMs
}

// CATEGORY C (docs/internals/server-isolation.md) — intentional shared map,
// now nested under a per-scope bucket. Inner map keyed by opaque
// session ID; different users don't collide within a scope.
const scopes = new Map<string, Map<string, SessionEntry>>()

function store(scope: string = getScope()): Map<string, SessionEntry> {
  sweepExpired(Date.now())
  let b = scopes.get(scope)
  if (!b) {
    b = new Map()
    scopes.set(scope, b)
  }
  return b
}

/** Walk every scope and drop entries past the idle TTL. Rate-limited
 *  by `SWEEP_INTERVAL_MS`; runs on any store access. */
function sweepExpired(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const [scope, bucket] of scopes) {
    for (const [id, entry] of bucket) {
      if (now - entry.touchedAt > idleTtlMs) bucket.delete(id)
    }
    if (bucket.size === 0) scopes.delete(scope)
  }
}

/** Look up a session entry, treating an idle-expired one as absent
 *  (and deleting it in passing). Does NOT touch — callers touch after
 *  deciding the entry is live, so a lookup that ends in "no session"
 *  can't resurrect one. */
function liveEntry(
  bucket: Map<string, SessionEntry>,
  id: string,
  now: number,
): SessionEntry | undefined {
  const entry = bucket.get(id)
  if (!entry) return undefined
  if (now - entry.touchedAt > idleTtlMs) {
    bucket.delete(id)
    return undefined
  }
  return entry
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
  const now = Date.now()
  const entry = liveEntry(store(), id, now)
  if (!entry) return { frames: {} }
  // Touch on read: any request that resolves this session's state
  // counts as activity, so an in-use session's frame URLs never
  // vanish mid-session.
  entry.touchedAt = now
  return entry.state
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
  const now = Date.now()
  // An expired entry is absent (not resurrected) — the write starts a
  // fresh session state rather than reviving stale frame URLs.
  const entry = liveEntry(b, id, now) ?? { state: { frames: {} }, touchedAt: now }
  entry.state.frames = { ...entry.state.frames, [pathKey(path)]: { url } }
  entry.touchedAt = now
  b.set(id, entry)
}

/**
 * Remove a frame entry from the session (e.g. a closing drawer). No-op
 * if there's no session or no entry.
 */
export function clearSessionFrame(path: readonly string[]): void {
  const id = getSessionId()
  if (!id) return
  const b = store()
  const now = Date.now()
  const entry = liveEntry(b, id, now)
  if (!entry) return
  const key = pathKey(path)
  const { [key]: _removed, ...rest } = entry.state.frames
  entry.state.frames = rest
  entry.touchedAt = now
}

/**
 * Bare session identity — the only session surface vary and cells
 * see. `vary: ({session}) => ({sid: session.id})` is the canonical
 * per-user partition pattern on a `localCell`.
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
 * Session surface exposed to a spec's `vary` and a cell's `vary`
 * callbacks.
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
    lastSweepAt = 0
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
  for (const entry of b.values()) {
    for (const framePath of Object.keys(entry.state.frames)) {
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
