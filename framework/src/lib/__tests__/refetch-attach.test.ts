/**
 * The manifest cap splits by transport. An ATTACH batch ships the
 * FULL manifest in the POST body (`getAllCachedPartialTokens` — no
 * request line to protect, so no cap and no priority walk), while a
 * discrete batch keeps the capped `?cached=` URL form
 * (`getCachedPartialIds`, `CACHED_MANIFEST_CAP`). The forced-label
 * strip applies on both transports — an explicit refetch target must
 * re-render, never match-and-skip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AttachStatement } from "../channel-protocol.ts"
import {
  CACHED_MANIFEST_CAP,
  getAllCachedPartialTokens,
  getCachedPartialIds,
  pruneToLive,
  registerClientPartial,
} from "../partial-client-state.ts"
import { enqueueRefetch } from "../refetch.ts"

interface CapturedFire {
  url: URL
  attach?: AttachStatement
}

let fires: CapturedFire[]

beforeEach(() => {
  fires = []
  ;(window as any).__rsc_partial_refetch = (
    url: string,
    _signal?: AbortSignal,
    _claimCommit?: () => boolean,
    attach?: AttachStatement,
  ) => {
    fires.push({ url: new URL(url), attach })
    return { streaming: Promise.resolve(), finished: Promise.resolve() }
  }
})

afterEach(() => {
  delete (window as any).__rsc_partial_refetch
  pruneToLive(new Map())
})

/** Register `n` distinct (id, matchKey, fp) tokens. */
function registerTokens(n: number): void {
  for (let i = 0; i < n; i++) {
    registerClientPartial(`tok-${i}`, "aaaaaaaaaaaaaaaa", `fp-${i}`)
  }
}

/** The dispatcher flushes per microtask. */
function flushed(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)))
}

describe("refetch dispatch — attach vs discrete manifest", () => {
  it("an attach batch ships the uncapped manifest in the body, none in the URL", async () => {
    registerTokens(CACHED_MANIFEST_CAP + 24)
    enqueueRefetch({
      labels: [],
      streaming: true,
      live: true,
      attach: { since: { epoch: "e1", ts: 5 }, visible: ["v-1"] },
    })
    await flushed()

    expect(fires).toHaveLength(1)
    const { url, attach } = fires[0]
    expect(url.searchParams.get("live")).toBe("1")
    expect(url.searchParams.has("cached")).toBe(false)
    expect(attach).toBeDefined()
    expect(attach?.cached).toHaveLength(CACHED_MANIFEST_CAP + 24)
    expect(attach?.cached).toContain("tok-0:aaaaaaaaaaaaaaaa:fp-0")
    expect(attach?.since).toEqual({ epoch: "e1", ts: 5 })
    expect(attach?.visible).toEqual(["v-1"])
    expect(getAllCachedPartialTokens()).toHaveLength(CACHED_MANIFEST_CAP + 24)
  })

  it("a discrete batch keeps the capped ?cached= URL form", async () => {
    registerTokens(CACHED_MANIFEST_CAP + 24)
    enqueueRefetch({ labels: [], streaming: true, live: false })
    await flushed()

    expect(fires).toHaveLength(1)
    const { url, attach } = fires[0]
    expect(attach).toBeUndefined()
    const cached = url.searchParams.get("cached")?.split(",") ?? []
    expect(cached).toHaveLength(CACHED_MANIFEST_CAP)
    expect(getCachedPartialIds()).toHaveLength(CACHED_MANIFEST_CAP)
  })

  it("the forced-label strip applies to the body manifest too", async () => {
    registerTokens(8)
    enqueueRefetch({
      labels: ["tok-3"],
      streaming: true,
      live: true,
      attach: { since: null, visible: null },
    })
    await flushed()

    expect(fires).toHaveLength(1)
    const { url, attach } = fires[0]
    expect(url.searchParams.get("partials")).toBe("tok-3")
    expect(attach?.cached).toHaveLength(7)
    expect(attach?.cached.some((t) => t.startsWith("tok-3:"))).toBe(false)
  })
})
