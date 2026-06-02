import React, { type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it } from "vitest"
import {
  PartialsClient,
  getCachedPartialIds,
  _warmCacheFromPayload,
} from "../partial-client.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

/**
 * `useNavigation().preload(url)` warms a destination's partials into the
 * client cache WITHOUT committing — no `setPayload`, no render, nothing
 * mounts. The browser entry decodes the preload response and hands each
 * payload tree to `_warmCacheFromPayload`, which walks it exactly like
 * the streaming-mode commit's cache step.
 *
 * These tests drive that walk directly (no network, no React render) and
 * assert the post-warm `getCachedPartialIds()` — the set the browser
 * serializes into `?cached=` on the next navigation. A warmed id landing
 * in that set is what makes the actual click fp-skip the partial and
 * substitute it from cache instantly.
 */

// ─── Server-shaped node builders (mirror partial.tsx output) ────────
//
// A fresh partial is a keyed `<PartialErrorBoundary>` carrying
// id / fingerprint / matchKey; an fp-skip is a bare `<i data-partial>`
// placeholder. `isPartialWrapper` detects the former by `key + partialId`
// — no Suspense or render needed — so the static warm walk picks it up.

function freshWith(id: string, mk: string, fp: string, children: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary key={id} partialId={id} partialFingerprint={fp} partialMatchKey={mk}>
      {children}
    </PartialErrorBoundary>
  )
}

function fresh(id: string, mk: string, fp: string): ReactNode {
  return freshWith(id, mk, fp, <div data-testid={id} />)
}

function placeholder(id: string, mk: string): ReactNode {
  return (
    <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
  )
}

/**
 * A decoded preload payload's root mirrors the server stream: the page
 * tree wrapped in `<PartialsClient>`. `_warmCacheFromPayload` walks this
 * element tree statically (it never renders `PartialsClient`), so the
 * wrappers inside are reached through `props.children`.
 */
function payloadRoot(children: ReactNode): ReactNode {
  return (
    <PartialsClient mode="streaming">
      <main>{children}</main>
    </PartialsClient>
  )
}

beforeEach(() => {
  // Reset the module-level client maps: a streaming commit with no
  // partials prunes every prior (id, matchKey) — same reset the
  // fp-desync suite uses.
  renderToStaticMarkup(<PartialsClient mode="streaming">{null}</PartialsClient>)
})

describe("_warmCacheFromPayload — warm-only preload commit", () => {
  it("warms a decoded payload into the cached-id set without rendering it", () => {
    expect(getCachedPartialIds()).toEqual([])
    _warmCacheFromPayload(payloadRoot(fresh("defer-demo-page", "mk1", "fp_dd")))
    // The id is now advertised for fp-skip on the next navigation —
    // populated purely by the static walk, with no React commit.
    expect(getCachedPartialIds()).toContain("defer-demo-page:mk1:fp_dd")
  })

  it("warms nested partials inside a wrapper, not just the top level", () => {
    _warmCacheFromPayload(
      payloadRoot(freshWith("outer", "", "fp_outer", fresh("inner", "", "fp_inner"))),
    )
    const advertised = getCachedPartialIds()
    expect(advertised).toContain("outer::fp_outer")
    expect(advertised).toContain("inner::fp_inner")
  })

  it("leaves fp-skip placeholders uncached — there's nothing to warm", () => {
    // A placeholder means the server confirmed the client already holds
    // this partial; warming must not invent a fingerprint for it.
    _warmCacheFromPayload(payloadRoot(placeholder("already-have-it", "")))
    expect(getCachedPartialIds().some((t) => t.startsWith("already-have-it:"))).toBe(false)
  })

  it("does not commit: warming twice is idempotent on the advertised set", () => {
    _warmCacheFromPayload(payloadRoot(fresh("p", "mk", "fp1")))
    _warmCacheFromPayload(payloadRoot(fresh("p", "mk", "fp1")))
    const advertised = getCachedPartialIds().filter((t) => t === "p:mk:fp1")
    expect(advertised).toHaveLength(1)
  })
})
