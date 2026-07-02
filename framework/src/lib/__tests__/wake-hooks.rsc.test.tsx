/**
 * Wake hooks — `expires()` / `staleUntil()` / `time()`, the hooks-era
 * replacement for `vary`'s reserved `expiresAt` / `staleUntil` keys.
 *
 * The claims under test:
 *   1. a render-body `expires()` lands on the committed snapshot's
 *      effective wake surface (via the live box — the boundary
 *      registered BEFORE the body ran), earliest call wins;
 *   2. the live segment driver's expiry arm wakes a lane for a parton
 *      whose only wake declaration is the hook (no `vary` at all);
 *   3. fp-skip declines to serve a snapshot past its declared
 *      freshness boundary (the TTL gate), and the skip pass threads
 *      the prior box through so the wake schedule survives a skip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { computeRouteKey, parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import {
  clearRegistry,
  effectiveExpiresAt,
  effectiveStaleUntil,
  enterRequestRegistry,
  lookupPartial,
} from "../partial-registry.ts"
import { expires, staleUntil, time } from "../server-hooks.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function fpById(flight: string, id: string): string | undefined {
  const m = new RegExp(`"partialId":"${id}","partialFingerprint":"([^"]+)"`).exec(flight)
  return m?.[1]
}

async function committedSnap(url: string, id: string) {
  const { result } = await runWithRequestAsync(new Request(url), async () => {
    enterRequestRegistry(computeRouteKey(url), "cache")
    return lookupPartial(id)
  })
  return result
}

const ROOT_MK = hash(stableStringify({}))

// Declares its wake purely via render-body hooks — no vary anywhere.
const HookTtl = parton(
  function HookTtlRender(_: RenderArgs) {
    expires(time().in(5_000))
    expires(time().in(60_000)) // later boundary — earliest must win
    staleUntil(time().in(120_000))
    return <span>hook-ttl-body</span>
  },
  { selector: "#wake-ttl" },
)

// Live ticker: content changes every render, wake declared in-body.
const renders = { clock: 0 }
const HookClock = parton(
  function HookClockRender(_: RenderArgs) {
    renders.clock++
    expires(time().in(80))
    return <time data-hook-clock>{`hook-tick-${renders.clock}`}</time>
  },
  { selector: "wake-clock" },
)

// Short-TTL spec for the fp-skip gate: stable fp (no tracked reads),
// expires 300ms after each render.
const ShortTtl = parton(
  function ShortTtlRender(_: RenderArgs) {
    expires(Date.now() + 300)
    return <span>short-ttl-body</span>
  },
  { selector: "#wake-short" },
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.clock = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("wake hooks — expires()/staleUntil()/time()", () => {
  it("render-body expires() lands on the committed snapshot; earliest boundary wins", async () => {
    const url = "http://t/wake-ttl"
    const before = Date.now()
    await flightAt(
      url,
      <PartialRoot>
        <HookTtl />
      </PartialRoot>,
    )
    const snap = await committedSnap(url, "wake-ttl")
    expect(snap).toBeDefined()
    const exp = effectiveExpiresAt(snap!)
    const swr = effectiveStaleUntil(snap!)
    expect(exp).toBeDefined()
    // Earliest of the two calls: ~now+5s, not ~now+60s.
    expect(exp!).toBeGreaterThanOrEqual(before + 5_000)
    expect(exp!).toBeLessThan(before + 30_000)
    expect(swr).toBeDefined()
    expect(swr!).toBeGreaterThanOrEqual(before + 120_000)
  })

  it("the live driver's expiry arm wakes a lane from a hook-declared boundary", async () => {
    await withLiveDrive(
      "http://localhost/hook-clock?live=1",
      () => (
        <PartialRoot>
          <HookClock />
        </PartialRoot>
      ),
      freshLiveScope("wake-hooks"),
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        expect(renders.clock).toBe(1)

        // No bump fired — the 80ms hook boundary alone must wake a lane.
        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes")
          throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()
        const lane = (await laneIter.next()).value as DemuxedLane
        expect(lane.partonId).toBe("wake-clock")
        const { bodyText } = await decodeLane(lane)
        expect(renders.clock).toBe(2)
        expect(bodyText).toContain("hook-tick-2")

        await h.shutdown("wake-clock")
      },
    )
  })

  it("fp-skip serves a fresh snapshot but declines one past its boundary", async () => {
    const url = "http://t/wake-short"
    const tree = (
      <PartialRoot>
        <ShortTtl />
      </PartialRoot>
    )
    const r1 = await flightAt(url, tree)
    expect(r1).toContain("short-ttl-body")
    const fp = fpById(r1, "wake-short")
    expect(fp).toBeDefined()

    // Within the 300ms window: fp matches AND the snapshot is fresh →
    // skip (placeholder, no body).
    const cachedUrl = `${url}?cached=wake-short:${ROOT_MK}:${fp}`
    const skipped = await flightAt(cachedUrl, tree)
    expect(skipped).not.toContain("short-ttl-body")

    // The skip pass re-registered the snapshot; the prior box must have
    // been threaded through (a skip must not erase the wake schedule).
    const afterSkip = await committedSnap(cachedUrl, "wake-short")
    expect(effectiveExpiresAt(afterSkip!)).toBeDefined()

    // Past the boundary: same fp declaration, but the snapshot expired
    // → the TTL gate declines the skip and renders fresh.
    await new Promise((r) => setTimeout(r, 350))
    const fresh = await flightAt(cachedUrl, tree)
    expect(fresh).toContain("short-ttl-body")
  })
})
