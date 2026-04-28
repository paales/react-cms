/**
 * PartialRoot Architecture
 *
 * Pages are composed of independently re-renderable partials declared
 * with the <Partial> wrapper:
 *
 *   <PartialRoot>
 *     <html>
 *       <Partial selector="#head"><head>...</head></Partial>
 *       <body>
 *         <Partial selector="#nav"><nav>...</nav></Partial>
 *         <Partial selector="#cart .cart" fallback={<Spinner/>}>
 *           <CartBadge/>
 *         </Partial>
 *       </body>
 *     </html>
 *   </PartialRoot>
 *
 * `<PartialRoot>` is a thin orchestrator: it parses the request
 * params, sets up the request-scoped state that each `<Partial>`
 * reads during render, decides whether we're in streaming mode (full
 * page) or cache mode (partial refetch, served from snapshots), and
 * wraps the output in `<PartialsClient>`.
 *
 * Every decision about an individual partial — "render fresh?",
 * "emit placeholder because the fingerprint matched?" — lives in the
 * `Partial` component itself. There is no static walker; each Partial
 * discovers itself by running. Deep Partials produced inside `.map()`
 * loops or other opaque component bodies are first-class: they
 * register themselves via `<PartialBoundary>` on every render.
 *
 * Snapshots stored by `<PartialBoundary>` are captured JSX from the
 * ancestor's most recent execution. Cache-mode refetches render that
 * snapshot directly through a fresh `<Partial>` body — the Partial
 * re-evaluates its fingerprint, opens any frame scope, and
 * re-registers the snapshot. All request-varying state flows through
 * tracked accessors (`getSearchParam`, `getCookie`, `getPathname`,
 * frame URLs), not props.
 */

import React, { type ReactNode } from "react"
import { PartialsClient } from "./partial-client.tsx"
import { Partial, PartialBoundary, type PartialProps } from "./partial-component.tsx"
import { PartialErrorBoundary } from "./partial-error-boundary.tsx"
import { getRequest } from "../framework/context.ts"
import {
  enterRequestRegistry,
  getRouteSnapshots,
  lookupPartial,
  type PartialSnapshot,
} from "./partial-registry.ts"
import { enterPartialState, type PartialRequestState } from "./partial-request-state.ts"
import { setSessionFrameUrl } from "../framework/session.ts"

export { Partial, type PartialProps }

interface PartialRootProps {
  children: ReactNode
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parseCachedFingerprints(raw: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (!raw) return out
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (!token) continue
    const colonIdx = token.indexOf(":")
    if (colonIdx > 0) {
      out.set(token.slice(0, colonIdx), token.slice(colonIdx + 1))
    } else {
      out.set(token, null)
    }
  }
  return out
}

function parseCsvTokens(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Resolve requested selector tokens (from `?partials=` and `?tags=`)
 * to the set of effective ids to refetch.
 *
 *   - `?partials=cart,header` — unique (`#`) token names (sans `#`),
 *     OR anonymous / multi-`#` effective ids sent by activators that
 *     only know the Partial's effective id (e.g. `__anon:.ad-slot`,
 *     `cart,primary-cart`). Direct-lookup first, scan for `#`-token
 *     match second.
 *   - `?tags=price,product` — shared (`.`) token names (sans `.`).
 *     Scans snapshots' `sharedTokens`.
 *
 * Union semantics across both params and across multiple tokens in
 * either param. Returns `null` if no filter was requested OR if a
 * filter was requested but nothing matched (caller distinguishes
 * via `hasGlobalFilter`, which treats those as registry-miss).
 */
function resolveSelectorToIds(
  uniqueParam: string | null,
  sharedParam: string | null,
  route: string,
): Set<string> | null {
  const uniqueNames = parseCsvTokens(uniqueParam)
  const sharedNames = parseCsvTokens(sharedParam)
  if (uniqueNames.length === 0 && sharedNames.length === 0) return null

  const snapshots = getRouteSnapshots(route)
  if (!snapshots) return null

  const ids = new Set<string>()

  // Pass 1: direct effective-id lookup for each `partials=` token.
  // Covers activator refetches (`useActivate(partialId)` sends the
  // effective id, which equals the `#`-token name in the canonical
  // case but is `__anon:…` for anonymous Partials and a comma-join
  // for multi-`#` Partials).
  for (const name of uniqueNames) {
    if (snapshots.has(name)) ids.add(name)
  }

  // Pass 2: scan for `#`-token matches not caught by direct lookup.
  // Handles the multi-`#` case where the client sent `#cart` but the
  // snapshot's effective id is `cart,primary-cart`.
  if (uniqueNames.length > 0) {
    for (const [id, snap] of snapshots) {
      if (ids.has(id)) continue
      for (const u of snap.uniqueTokens) {
        if (uniqueNames.includes(u)) {
          ids.add(id)
          break
        }
      }
    }
  }

  // Pass 3: scan for `.`-token (shared) matches.
  if (sharedNames.length > 0) {
    for (const [id, snap] of snapshots) {
      if (ids.has(id)) continue
      for (const s of snap.sharedTokens) {
        if (sharedNames.includes(s)) {
          ids.add(id)
          break
        }
      }
    }
  }

  return ids.size > 0 ? ids : null
}

/**
 * Reconstruct a `<Partial>` element from a registry snapshot. Used in
 * cache mode to render each explicitly-requested partial without
 * re-executing any ancestor component.
 */
function partialFromSnapshot(_id: string, snap: PartialSnapshot): ReactNode {
  // NOTE: no explicit `key` on the Partial element even though it's
  // placed in an array. Flight composites the outer element's `key`
  // with inner element keys — if this element had `key="slow"` and
  // its rendered output is `<Suspense key="slow">`, the wire format
  // emits a composite `"slow,slow"` which React reconciles as a
  // different key than the `"slow"` rendered during streaming mode,
  // forcing a remount that resets client state inside the partial
  // (see cache-demo click counter). Relying on position-based
  // reconciliation is safe here: `activeIds` is stable per refetch
  // and each id resolves its own internally-keyed Suspense wrapper.
  //
  // Reconstruct the selector in array form — the parser treats each
  // element as one token (so `#`-tokens containing spaces, e.g. SKUs
  // with whitespace, survive the round-trip intact).
  const selector = [
    ...snap.uniqueTokens.map((t): `#${string}` => `#${t}`),
    ...snap.sharedTokens.map((t): `.${string}` => `.${t}`),
  ]
  // Reconstruct the parent context from the stored path. The cell
  // can't be trusted for this call — we're rendering snapshots as
  // flat siblings in cache-mode, not through their original tree.
  // We reconstruct `frameChain` from the snapshot's `framePath` so
  // that if this Partial is itself a frame, its own FrameWrapper
  // re-computes the full dotted frame path identically to the
  // original render.
  const frameChain: readonly string[] =
    snap.framePath.length > 0 ? snap.framePath.slice(0, snap.framePath.length - 1) : []
  const frameLocalName: string | undefined =
    snap.framePath.length > 0 ? snap.framePath[snap.framePath.length - 1] : undefined
  return React.createElement(
    Partial,
    {
      // Cache-mode refetches render snapshots as flat siblings with
      // no surviving ancestor chain — `provides` from the original
      // render's ancestors are gone (see `Partial.provides` docs).
      // Descendants relying on `getClosest(key)` for an ancestor-
      // provided value should also carry a concrete `getReference`
      // value in the store so the refetch still resolves.
      parent: { path: snap.parentPath, frameChain, provides: {} },
      selector,
      fallback: snap.fallback ?? undefined,
      errorWith: snap.errorWith,
      cache: snap.cache,
      frame: frameLocalName,
      frameUrl: snap.frameUrl,
      cmsId: snap.cmsId,
    },
    snap.content,
  )
}

// ─── PartialRoot ───────────────────────────────────────────────────────

export async function PartialRoot({ children }: PartialRootProps) {
  const requestUrl = new URL(getRequest().url)
  const partialsParam = requestUrl.searchParams.get("partials")
  const tagsParam = requestUrl.searchParams.get("tags")
  const cachedParam = requestUrl.searchParams.get("cached")
  const populateCache = requestUrl.searchParams.has("__populateCache")

  // Frame navigation: `?__frame=a.b.c&__frameUrl=/path` carries the
  // next URL for a frame at a dotted path. Write it to the session
  // before any `<Partial frame=…>` runs — its `resolveFrameRequest`
  // will pick up the new URL from the session.
  const frameNames = requestUrl.searchParams.getAll("__frame")
  const frameUrls = requestUrl.searchParams.getAll("__frameUrl")
  if (frameNames.length > 0 && frameNames.length === frameUrls.length) {
    for (let i = 0; i < frameNames.length; i++) {
      const path = frameNames[i].split(".").filter(Boolean)
      if (path.length > 0) setSessionFrameUrl(path, frameUrls[i])
    }
  }

  const route = requestUrl.pathname

  // Selector resolution scans the registry populated by PRIOR requests.
  // `?partials=` carries `#`-token names (sans `#`); `?tags=` carries
  // `.`-token names (sans `.`). Union semantics across both.
  //
  // `?__frame=name&__frameUrl=...` is deliberately NOT a filter
  // contributor — it only updates the session. Whether the refetch
  // narrows to a specific Partial vs. does a full render is decided
  // by the client: `_dispatchFrameRefetch` adds `partials=<name>` to
  // narrow (frame nav), while the `urlChanged` browser-traverse
  // handler omits it to get a full render with session updates.
  const combinedRequestedIds = resolveSelectorToIds(partialsParam, tagsParam, route)

  const hasGlobalFilter = partialsParam != null || tagsParam != null
  const isPartialRefetch = hasGlobalFilter || populateCache

  // Explicit ids are never skipped on a fingerprint match or filter —
  // they're what the caller asked for. Seed from the resolver output
  // when possible; on a cold registry (no prior streaming render) the
  // scan can't resolve `?partials=` tokens to effective ids, so also
  // include the raw `#`-token names from the wire. A Partial body
  // whose effective id matches a raw name will take the explicit
  // path (e.g. render through a `defer` branch) even during the
  // streaming fallback.
  const explicitIds = new Set<string>()
  if (combinedRequestedIds) {
    for (const id of combinedRequestedIds) explicitIds.add(id)
  }
  if (partialsParam) {
    for (const name of parseCsvTokens(partialsParam)) explicitIds.add(name)
  }

  const state: PartialRequestState = {
    requestedIds: populateCache ? null : combinedRequestedIds,
    isPartialRefetch: isPartialRefetch && !populateCache,
    populateCache,
    cachedFingerprints: parseCachedFingerprints(cachedParam),
    explicitIds,
    seenIds: new Set(),
    seenUniqueTokens: new Set(),
  }

  // Registry-miss fallback: if any requested `#`-token doesn't match a
  // registered snapshot (either nothing matched at all, or a new
  // `#`-token was introduced by a navigation that expanded the range
  // — e.g. infinite scroll bumping `?end=N+1` before `page-{N+1}`
  // was ever rendered), drop the filter and do a full streaming
  // render so ancestors re-execute and the client reconciles against
  // a fresh tree. `.class` tokens don't participate in this check —
  // a selector that only resolves to a subset of known snapshots is
  // valid (that's how unions work).
  const requestedUniqueNames = parseCsvTokens(partialsParam)
  let registryMiss = state.isPartialRefetch && hasGlobalFilter && !combinedRequestedIds
  if (state.isPartialRefetch && !registryMiss && requestedUniqueNames.length > 0) {
    const snapshots = getRouteSnapshots(route)
    for (const name of requestedUniqueNames) {
      // Direct lookup (effective id). If it's not a direct id match,
      // check whether any snapshot declares the name as a `#`-token.
      if (snapshots?.has(name)) continue
      let foundAsToken = false
      if (snapshots) {
        for (const snap of snapshots.values()) {
          if (snap.uniqueTokens.includes(name)) {
            foundAsToken = true
            break
          }
        }
      }
      if (!foundAsToken) {
        registryMiss = true
        break
      }
    }
  }

  // ── Streaming mode (full render) ──────────────────────────────────
  //
  // Every Partial runs; its body handles fingerprint-skip vs render.
  // Ancestors re-execute, so snapshots registered during this render
  // carry fresh closures — no refreshing walk required.
  //
  // Open the request registry context BEFORE `enterPartialState` so
  // descendants' `<Partial>` registrations land in pendingWrites
  // (not canonical). The context's previousView captures the prior
  // render's tree at this moment; concurrent requests on the same
  // route get their own independent views and can't observe each
  // other's in-flight writes. On commit (driven by the response
  // stream's flush hook in entry.rsc.tsx), pendingWrites *replace*
  // canonical[route] — ids that didn't re-register are dropped,
  // which is what `clearRoute(route)` used to do in-band.
  if (!state.isPartialRefetch || registryMiss) {
    enterRequestRegistry(route, "streaming")
    const streamState: PartialRequestState = {
      ...state,
      requestedIds: null,
      isPartialRefetch: false,
    }
    enterPartialState(streamState)
    return <PartialsClient mode="streaming">{children}</PartialsClient>
  }

  // ── Cache mode (partial refetch) ──────────────────────────────────
  //
  // Render each explicitly-requested partial from its registry
  // snapshot as a flat sibling. The `<Partial>` body re-runs (wrapping
  // in Suspense + ErrorBoundary, re-registering) — but its ancestors
  // do not. No server-side template: the client re-renders against
  // the `_template` derived during the most recent streaming render.
  //
  // Why no refresh walk: snapshots store the JSX captured at the
  // ancestor's most-recent execution. Request-varying state flows
  // through tracked accessors (`getSearchParam`, `getCookie`,
  // `getPathname`, frame URLs) read inside the Partial's content on
  // re-render — the snapshot doesn't have to be re-baked to pick up
  // new inputs because inputs don't live on the JSX at all. Closures
  // that would have been stale (sku from a `.map()` iteration, etc.)
  // stay stable-by-construction.
  //
  // Cache-mode commit overlays pendingWrites onto canonical[route]
  // (no replace) — ids that didn't re-render keep their snapshots.
  enterRequestRegistry(route, "cache")
  enterPartialState(state)

  const activeIds = [...(state.requestedIds ?? [])]
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(route, id)
      if (!snap) return null
      return partialFromSnapshot(id, snap)
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  // Pass wrappedChildren as positional args via `createElement` rather
  // than `{wrappedChildren}` in JSX. Passing an array as a child prop
  // triggers React's "each child in a list needs a key" warning.
  // Adding a `key` on each snapshot element is not an option: Flight
  // composites an outer element's key with its rendered output's key
  // into `"outerKey,innerKey"`. Since `<Partial>` renders `<Suspense
  // key={id}>` internally, a `key={id}` on the outer Partial would
  // emit `"id,id"` on the wire — which React reconciles as a
  // different identity than the plain `"id"` emitted in streaming
  // mode, forcing a remount that wipes client state inside the
  // partial (e.g. the /cache-demo click counter). Positional children
  // sidestep both: no warning, no composite.
  return React.createElement(PartialsClient, { mode: "cache" }, ...wrappedChildren)
}

// Re-export PartialBoundary + PartialErrorBoundary so existing
// imports elsewhere (notably cache.tsx, which walks for PartialBoundary
// as a type marker) keep working.
export { PartialBoundary }
// PartialErrorBoundary is client-only but some server-only code paths
// reference its type; re-export for convenience.
export type { PartialErrorBoundary }
