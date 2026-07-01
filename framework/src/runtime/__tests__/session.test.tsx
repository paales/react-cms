/**
 * Task 3 regression: server-side session store.
 *
 * A cookie holds a session ID; the store keeps frame URLs keyed by
 * name. Requests that carry the same session cookie see the same
 * scene; different cookies get isolated state; no cookie means
 * empty scene.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithRequestAsync } from "../context.ts"
import {
  _clearAllSessions,
  _sessionStats,
  clearSessionFrame,
  configureSessionStore,
  DEFAULT_SESSION_IDLE_TTL_MS,
  ensureSessionId,
  getSessionFrameUrl,
  getSessionId,
  setSessionFrameUrl,
} from "../session.ts"

beforeEach(() => {
  _clearAllSessions()
})

async function makeRequest(sessionId?: string, url = "http://localhost/page"): Promise<Request> {
  const headers: Record<string, string> = {}
  if (sessionId) headers.cookie = `__frame_sid=${sessionId}`
  return new Request(url, { headers })
}

describe("session store basics", () => {
  it("no cookie → no session id, empty state, empty frame lookup", async () => {
    const req = await makeRequest()
    const { result } = await runWithRequestAsync(req, async () => ({
      id: getSessionId(),
      cartUrl: getSessionFrameUrl(["cart"]),
    }))
    expect(result.id).toBeNull()
    expect(result.cartUrl).toBeNull()
  })

  it("ensureSessionId creates + returns a new id on cold requests", async () => {
    const req = await makeRequest()
    const { result, cookies } = await runWithRequestAsync(req, async () => {
      return ensureSessionId()
    })
    expect(result).toMatch(/^[0-9a-f-]{36}$/) // UUID shape
    // Set-Cookie emitted on the response.
    expect(cookies.some((c) => c.includes("__frame_sid="))).toBe(true)
  })

  it("ensureSessionId is idempotent within a single request", async () => {
    const req = await makeRequest()
    const { result } = await runWithRequestAsync(req, async () => {
      const a = ensureSessionId()
      const b = ensureSessionId()
      return { a, b }
    })
    expect(result.a).toBe(result.b)
  })

  it("setSessionFrameUrl persists across requests with the same cookie", async () => {
    // Request 1: no cookie, set cart URL.
    const req1 = await makeRequest()
    const { result: sid, cookies } = await runWithRequestAsync(req1, async () => {
      setSessionFrameUrl(["cart"], "/cart/checkout")
      return getSessionId()
    })
    expect(sid).not.toBeNull()

    // Parse Set-Cookie to get the assigned id (same as sid above).
    const cookieHeader = cookies.find((c) => c.includes("__frame_sid="))
    expect(cookieHeader).toBeDefined()
    const sessionId = cookieHeader!.match(/__frame_sid=([^;]+)/)![1]

    // Request 2: with the cookie — session state is visible.
    const req2 = await makeRequest(sessionId)
    const { result } = await runWithRequestAsync(req2, async () => {
      return getSessionFrameUrl(["cart"])
    })
    expect(result).toBe("/cart/checkout")
  })

  it("different cookies get isolated state", async () => {
    const req1 = await makeRequest()
    const { cookies: cookies1 } = await runWithRequestAsync(req1, async () => {
      setSessionFrameUrl(["cart"], "/user-a/cart")
    })
    const id1 = cookies1[0].match(/__frame_sid=([^;]+)/)![1]

    const req2 = await makeRequest()
    const { cookies: cookies2 } = await runWithRequestAsync(req2, async () => {
      setSessionFrameUrl(["cart"], "/user-b/cart")
    })
    const id2 = cookies2[0].match(/__frame_sid=([^;]+)/)![1]

    expect(id1).not.toBe(id2)

    // Check each user sees only their own URL.
    const { result: a } = await runWithRequestAsync(await makeRequest(id1), async () =>
      getSessionFrameUrl(["cart"]),
    )
    const { result: b } = await runWithRequestAsync(await makeRequest(id2), async () =>
      getSessionFrameUrl(["cart"]),
    )
    expect(a).toBe("/user-a/cart")
    expect(b).toBe("/user-b/cart")
  })

  it("clearSessionFrame removes the entry", async () => {
    const req = await makeRequest()
    const { cookies } = await runWithRequestAsync(req, async () => {
      setSessionFrameUrl(["cart"], "/cart/open")
    })
    const sid = cookies[0].match(/__frame_sid=([^;]+)/)![1]

    await runWithRequestAsync(await makeRequest(sid), async () => {
      clearSessionFrame(["cart"])
    })

    const { result } = await runWithRequestAsync(await makeRequest(sid), async () =>
      getSessionFrameUrl(["cart"]),
    )
    expect(result).toBeNull()
  })

  it("stats reflects active sessions + frame counts", async () => {
    const r1 = await makeRequest()
    await runWithRequestAsync(r1, async () => {
      setSessionFrameUrl(["cart"], "/a")
      setSessionFrameUrl(["menu"], "/m")
    })
    const r2 = await makeRequest()
    await runWithRequestAsync(r2, async () => {
      setSessionFrameUrl(["cart"], "/b")
    })
    const stats = _sessionStats()
    expect(stats.sessions).toBe(2)
    expect(stats.frameCounts.cart).toBe(2)
    expect(stats.frameCounts.menu).toBe(1)
  })
})

describe("session idle expiry", () => {
  beforeEach(() => {
    _clearAllSessions()
    vi.useFakeTimers()
    configureSessionStore({ idleTtlMs: 1000 })
  })

  afterEach(() => {
    vi.useRealTimers()
    configureSessionStore({ idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS })
    _clearAllSessions()
  })

  async function createSession(frameUrl = "/cart/open"): Promise<string> {
    const { cookies } = await runWithRequestAsync(await makeRequest(), async () => {
      setSessionFrameUrl(["cart"], frameUrl)
    })
    return cookies[0].match(/__frame_sid=([^;]+)/)![1]
  }

  async function readCart(sid: string): Promise<string | null> {
    const { result } = await runWithRequestAsync(await makeRequest(sid), async () =>
      getSessionFrameUrl(["cart"]),
    )
    return result
  }

  it("a session idle past the TTL is never served", async () => {
    const sid = await createSession()
    vi.advanceTimersByTime(1500)
    expect(await readCart(sid)).toBeNull()
  })

  it("reads touch — an active session outlives many TTL windows", async () => {
    const sid = await createSession()
    // 5 × 600ms = 3s total, far past the 1s TTL — but never more than
    // 600ms idle, so every read keeps the session alive.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600)
      expect(await readCart(sid)).toBe("/cart/open")
    }
  })

  it("writes touch — frame navigation keeps the whole session alive", async () => {
    const sid = await createSession()
    vi.advanceTimersByTime(600)
    await runWithRequestAsync(await makeRequest(sid), async () => {
      setSessionFrameUrl(["menu"], "/menu/about")
    })
    vi.advanceTimersByTime(600)
    // 1.2s since the cart write, but only 0.6s since the menu write
    // touched the session — the cart URL is still there.
    expect(await readCart(sid)).toBe("/cart/open")
  })

  it("a write to an expired session starts fresh instead of resurrecting stale frames", async () => {
    const sid = await createSession("/cart/stale")
    vi.advanceTimersByTime(1500)
    await runWithRequestAsync(await makeRequest(sid), async () => {
      setSessionFrameUrl(["menu"], "/menu/about")
    })
    const { result } = await runWithRequestAsync(await makeRequest(sid), async () => ({
      cart: getSessionFrameUrl(["cart"]),
      menu: getSessionFrameUrl(["menu"]),
    }))
    expect(result.cart).toBeNull()
    expect(result.menu).toBe("/menu/about")
  })

  it("the opportunistic sweep reclaims idle sessions nobody reads again", async () => {
    await createSession("/a")
    await createSession("/b")
    await createSession("/c")
    expect(_sessionStats().sessions).toBe(3)
    // Past both the TTL and the sweep rate limit; the next store
    // access (the stats read itself) sweeps them all.
    vi.advanceTimersByTime(120_000)
    expect(_sessionStats().sessions).toBe(0)
  })

  it("idleTtlMs: Infinity disables expiry", async () => {
    configureSessionStore({ idleTtlMs: Infinity })
    const sid = await createSession()
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
    expect(await readCart(sid)).toBe("/cart/open")
  })
})

// End-to-end "accessor reads frame URL from session" coverage lives
// in playwright against the /frames-demo page. Frame scoping uses a
// React.cache-backed mutation cell (see `context.ts` frame-scope
// section) — works under plain vitest once Partial has mounted,
// but the full session→session-aware-Partial loop needs the dev
// server. See `docs/frames-navigation.md`.
