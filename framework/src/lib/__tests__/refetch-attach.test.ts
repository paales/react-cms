/**
 * The manifest cap splits by carrier. The ATTACH statement ships the
 * FULL manifest in the POST body (`getAllCachedPartialTokens` — no
 * request line to protect, so no cap and no priority walk), while the
 * action POST keeps the capped `?cached=` URL form
 * (`getCachedPartialIds`, `CACHED_MANIFEST_CAP` — the one surviving
 * URL carrier, request-line-bound).
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  CACHED_MANIFEST_CAP,
  getAllCachedPartialTokens,
  getCachedPartialIds,
  pruneToLive,
  registerClientPartial,
} from "../partial-client-state.ts"

afterEach(() => {
  pruneToLive(new Map())
})

/** Register `n` distinct (id, matchKey, fp) tokens. */
function registerTokens(n: number): void {
  for (let i = 0; i < n; i++) {
    registerClientPartial(`tok-${i}`, "aaaaaaaaaaaaaaaa", `fp-${i}`)
  }
}

describe("manifest carriers — attach body vs action URL form", () => {
  it("the attach body manifest is uncapped", () => {
    registerTokens(CACHED_MANIFEST_CAP + 24)
    const body = getAllCachedPartialTokens()
    expect(body).toHaveLength(CACHED_MANIFEST_CAP + 24)
    expect(body).toContain("tok-0:aaaaaaaaaaaaaaaa:fp-0")
  })

  it("the ?cached= URL form caps at CACHED_MANIFEST_CAP", () => {
    registerTokens(CACHED_MANIFEST_CAP + 24)
    const url = getCachedPartialIds()
    expect(url).toHaveLength(CACHED_MANIFEST_CAP)
    // Newest registrations win the capped walk — the oldest tokens are
    // the ones that fall off (they re-render server-side and re-enter
    // by registering again: over-fetch, never stale).
    expect(url.some((t) => t.startsWith(`tok-${CACHED_MANIFEST_CAP + 23}:`))).toBe(true)
    expect(url.some((t) => t.startsWith("tok-0:"))).toBe(false)
  })
})
