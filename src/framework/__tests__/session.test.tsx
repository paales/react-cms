/**
 * Task 3 regression: server-side session store.
 *
 * A cookie holds a session ID; the store keeps frame URLs keyed by
 * name. Requests that carry the same session cookie see the same
 * scene; different cookies get isolated state; no cookie means
 * empty scene.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../context.ts"
import {
  _clearAllSessions,
  _sessionStats,
  clearSessionFrame,
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

// End-to-end "accessor reads frame URL from session" coverage lives
// in playwright against the /frames-demo page. Frame scoping uses a
// React.cache-backed mutation cell (see `context.ts` frame-scope
// section) — works under plain vitest once Partial has mounted,
// but the full session→session-aware-Partial loop needs the dev
// server. See `docs/frames-navigation.md`.
