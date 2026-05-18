"use client"

/**
 * Client-side partial merge coordinator.
 *
 * Receives a structural template (layout with partial placeholders)
 * and fresh partial content. Caches partials across renders and fills
 * the template from cache on every render.
 *
 * On full renders: all partials are fresh → cache fully populated.
 * On partial renders: only requested partials update the cache.
 * The template is always the same structural layout (main, footer, etc.),
 * so keyless wrappers are preserved across partial updates.
 *
 * Nested partials are supported: if "cart" is nested inside "header",
 * refreshing "header" re-renders the header layout but keeps cached
 * cart. Refreshing "cart" patches just the cart into cached header.
 *
 * Client API surface: `useNavigation()` returns a handle whose
 * `navigate(url, opts)` / `reload(opts)` methods drive every
 * refetch on the page. Targeted refetches are expressed through the
 * `selector` option (CSS-style `#id` / `.class` tokens) — see
 * {@link FrameworkNavigateOptions}. There is no `usePartial` or
 * `__inputs`: state must land in a URL (page URL or frame URL), and
 * the client never sends prop overrides.
 */

import React, {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react"
import {
  getNavigation,
  type FrameEntryState,
  type FrameNavigationHistoryEntry,
  type FrameworkNavigateOptions,
  type FrameworkNavigation,
  type FrameworkReloadOptions,
  type ImperativeNavigation,
  type Navigate,
  type NavigateStatus,
  type NavigateTarget,
  type NavigationMilestones,
  type NavigationProgress,
  type Reload,
  type ReloadStatus,
} from "../runtime/navigation-api.ts"
import { NavigationError, toNavigationError } from "../runtime/navigation-error.ts"

/**
 * Return true if the node looks like the outermost wrapper a
 * `<Partial>` renders — a keyed `<Suspense>` (partial with fallback)
 * or a keyed `<PartialErrorBoundary>` (partial without fallback).
 *
 * We can't reliably compare `node.type` against the PartialErrorBoundary
 * class identity — in SSR the class reference can differ from the
 * one this module imports (different module graphs across the RSC /
 * SSR boundary). Instead we detect by the `partialId` prop the Partial
 * component always sets on its wrapper. For the Suspense branch, the
 * key is the partial id and Suspense wraps a PartialErrorBoundary that
 * also carries `partialId` — we detect via `type === Suspense`.
 */
function isPartialWrapper(node: React.ReactElement): boolean {
  if (node.key == null) return false
  if (node.type === Suspense) return true
  const props = node.props as { partialId?: unknown }
  return typeof props?.partialId === "string"
}

/**
 * Extract the partial id from a wrapper node.
 *
 * Prefer the `partialId` prop over `node.key`. Flight combines the
 * outer `.map()` key with a client-component's own `key` into a
 * composite string like "page-1,page-1" when a `<Partial>` is
 * produced inside a `.map()`. The `partialId` prop stays clean and
 * is always the source of truth.
 *
 * Suspense (a React built-in) doesn't get double-keyed and doesn't
 * carry `partialId` itself — but its child is the PartialErrorBoundary
 * that does. Fall back to the Suspense `key` (which stays clean) or
 * peek at the direct child's `partialId`.
 */
function getPartialId(node: React.ReactElement): string | null {
  const props = node.props as { partialId?: unknown; children?: unknown }
  if (typeof props.partialId === "string") return props.partialId
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as React.ReactElement).props as { partialId?: unknown }
      if (typeof cp.partialId === "string") return cp.partialId
    }
    if (node.key != null) return String(node.key)
  }
  return null
}

/**
 * Extract the structural fingerprint off a partial wrapper. Mirrors
 * `getPartialId` — direct `partialFingerprint` prop, or peek through a
 * Suspense wrapper to the PartialErrorBoundary child. Returns `null`
 * for wrappers that don't carry one (shouldn't happen in practice but
 * we bail rather than register a bogus value).
 */
function getPartialFingerprint(node: React.ReactElement): string | null {
  const props = node.props as {
    partialFingerprint?: unknown
    children?: unknown
  }
  if (typeof props.partialFingerprint === "string") return props.partialFingerprint
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as React.ReactElement).props as {
        partialFingerprint?: unknown
      }
      if (typeof cp.partialFingerprint === "string") return cp.partialFingerprint
    }
  }
  return null
}

interface PartialsClientProps {
  /**
   * Rendering mode:
   * - "streaming": passthrough — renders children directly in the tree.
   *   Used on full page renders so Suspense boundaries stay in the server
   *   component tree and can stream.
   * - "cache": template + cache merge — the existing behavior.
   *   Used on partial re-fetches where only requested partials are fresh
   *   and the rest are served from the client cache.
   */
  mode?: "streaming" | "cache"
  // Optional at the type level so callers that supply children via
  // positional `createElement(PartialsClient, props, ...children)`
  // don't trip the required-prop check.
  children?: ReactNode
}

/**
 * Walk the structural template, filling partial placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached partial content.
 *
 * IMPORTANT: cached partials are pushed as-is with NO traversal of their
 * own children. The Suspense boundaries inside cached partials have lazy
 * refs (from the RSC Flight stream) as `props.children`; any `React.Children.*`
 * helper on those thenables causes React to resolve them during reconcile
 * instead of showing a fallback on remount, which breaks progressive
 * streaming on refetch. See notes/archive/STREAMING_DEBUG_NOTES.md §7-8.
 */
function isPlaceholder(child: React.ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true
}

/**
 * Id for a placeholder `<i>`. Prefer the `data-partial-id` prop, which
 * is stable, over `node.key`, which Flight can composite with an outer
 * `.map()` key into `"outer,inner"` for dynamic Partials.
 */
function getPlaceholderId(node: React.ReactElement): string | null {
  const props = node.props as { ["data-partial-id"]?: unknown }
  if (typeof props["data-partial-id"] === "string") {
    return props["data-partial-id"]
  }
  return node.key != null ? String(node.key) : null
}

/**
 * MatchKey of a placeholder `<i>`. matchKey identifies the rendered
 * variant (cache slot under id) — read from `data-partial-match`. The
 * value is a 16-char hex hash of stableStringify(matchParams); specs
 * without `match` resolve to a constant matchKey.
 */
function getPlaceholderMatchKey(node: React.ReactElement): string | null {
  const props = node.props as { ["data-partial-match"]?: unknown }
  if (typeof props["data-partial-match"] === "string") {
    return props["data-partial-match"]
  }
  return null
}

/**
 * MatchKey off a partial wrapper. Mirrors `getPartialFingerprint`:
 * read `partialMatchKey` directly, or peek through a Suspense wrapper
 * to its PartialErrorBoundary child.
 */
function getPartialMatchKey(node: React.ReactElement): string | null {
  const props = node.props as {
    partialMatchKey?: unknown
    children?: unknown
  }
  if (typeof props.partialMatchKey === "string") return props.partialMatchKey
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as React.ReactElement).props as {
        partialMatchKey?: unknown
      }
      if (typeof cp.partialMatchKey === "string") return cp.partialMatchKey
    }
  }
  return null
}

function addSeen(out: Map<string, Set<string>>, id: string, matchKey: string): void {
  let inner = out.get(id)
  if (!inner) {
    inner = new Set()
    out.set(id, inner)
  }
  inner.add(matchKey)
}

/**
 * Collect every (id, matchKey) pair reachable inside a node — wrapper
 * OR placeholder. Read-only walk: doesn't mutate `_currentPagePartials`
 * or `_currentPageFingerprints`. Used by the streaming-mode prune to
 * expand `seen` with nested variants that live inside cached wrappers —
 * when the server fp-skips an outer partial, the new tree carries only
 * its top-level placeholder, so the nested (id, matchKey) pairs backing
 * the rendered region need to be harvested from the cache itself or the
 * prune deletes them out from under the next render.
 *
 * Wrappers without a `partialMatchKey` prop (legacy fixtures, missing
 * server-side wire) fall back to the empty string so they're still
 * tracked as a single-variant cache entry under `(id, "")`.
 */
function harvestPartialIds(node: ReactNode, out: Map<string, Set<string>>): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      harvestPartialIds(node[i] as ReactNode, out)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped == null) return
    harvestPartialIds(unwrapped as ReactNode, out)
    return
  }
  if (!isValidElement(node)) return

  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (id) addSeen(out, id, getPartialMatchKey(node) ?? "")
    const inner = (node.props as { children?: ReactNode })?.children
    if (inner != null) harvestPartialIds(inner, out)
    return
  }
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    if (id) addSeen(out, id, getPlaceholderMatchKey(node) ?? "")
    return
  }
  const inner = (node.props as { children?: ReactNode })?.children
  if (inner != null) harvestPartialIds(inner, out)
}

type PartialCache = Map<string, Map<string, ReactNode>>

function cacheLookup(
  cache: PartialCache,
  id: string,
  matchKey: string,
): ReactNode | undefined {
  return cache.get(id)?.get(matchKey)
}

/**
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that (id, matchKey) variant.
 *
 * `skipKey` is `${id}|${matchKey}` so the recursion can't loop on a
 * wrapper that contains a placeholder pointing to itself (any
 * fp-skipped partial caches a wrapper that contains its own
 * placeholder). The outer id alone isn't enough — two siblings under
 * the same PartialBoundary can share an id but differ on matchKey
 * (hidden Activity sibling for a parked variant), and the inner one
 * must still resolve when the outer references the same id.
 */
function substituteNested(
  node: ReactNode,
  cache: PartialCache,
  skipKey: string,
): ReactNode {
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    let changed = false
    const mapped = node.map((c) => {
      const s = substituteNested(c, cache, skipKey)
      if (s !== c) changed = true
      return s
    })
    return changed ? mapped : node
  }

  // Flight lazy refs appear as children of cached client-component
  // boundaries (e.g. `<PartialErrorBoundary>{lazyRef}</PartialErrorBoundary>`
  // where the server was still streaming when the cache was
  // populated). By the time a refetch lands they've been resolved —
  // unwrap so we can descend into the nested tree and find keyed
  // partials to swap. Pending / errored lazies return null; we treat
  // them as opaque and leave the original node in place.
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped == null) return node
    return substituteNested(unwrapped as ReactNode, cache, skipKey)
  }

  if (!isValidElement(node)) return node

  // Placeholder: substitute from cache. Id + matchKey come from the
  // `data-partial-id` + `data-partial-match` props (stable), not the
  // key (Flight composites).
  //
  // Recurse into the cached wrapper. A wrapper produced by a
  // cache-mode refetch can carry INTERNAL placeholders for partials
  // whose fp matched (no fresh content emitted server-side). Those
  // inner placeholders need to be substituted with the next cache
  // entries — without the recursion the inner placeholders survive
  // into the rendered tree as `<i hidden>` markers and the partial's
  // descendant content is empty in the DOM. This was the
  // "consecutive moves blank the preview" bug (issue #1, 2026-04-25):
  // move 2's cms-demo-root wrapper held 6 Fragments-with-placeholder
  // children, and the substitution stopped at the wrapper without
  // unfolding those nested placeholders against the cache entries
  // populated by move 1.
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    const mk = getPlaceholderMatchKey(node) ?? ""
    const key = `${id ?? ""}|${mk}`
    if (id && key !== skipKey) {
      const fresh = cacheLookup(cache, id, mk)
      return fresh ? substituteNested(fresh, cache, key) : node
    }
  }

  // Partial-shape wrapper: if there's a fresh cache entry for the
  // same (id, matchKey) variant, use it. If the cache entry is the
  // same wrapper we're looking at (i.e. the wrapper itself wasn't
  // replaced this round), descend INTO its children so any descendant
  // Partial that DID get a fresh cache entry still gets swapped.
  // Without this descent, a refetch targeting a deeply-nested partial
  // lands a fresh entry but the surrounding ancestor wrappers keep
  // their old children references — so the new content never reaches
  // the rendered tree.
  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    const mk = getPartialMatchKey(node) ?? ""
    const key = `${id ?? ""}|${mk}`
    if (id && key !== skipKey) {
      const fresh = cacheLookup(cache, id, mk)
      if (fresh && fresh !== node) {
        return substituteNested(fresh, cache, key)
      }
      // Wrapper unchanged — keep descending so nested partials whose
      // cache entries DID change still get substituted.
    }
  }

  const children = (node.props as any).children
  if (children == null) return node
  const newChildren = substituteNested(children, cache, skipKey)
  if (newChildren === children) return node
  // Spread arrays as variadic — see the matching comment in
  // cache.tsx#resolveLazies. Flight-decoded children are arrays
  // even for static JSX siblings, and a bare `cloneElement(node,
  // {}, arr)` triggers React's "unique key" warning.
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren)
}

const LAZY_SYMBOL_STR = "Symbol(react.lazy)"

/**
 * Unwrap a raw lazy reference at the tree level.
 */
function unwrapLazy(node: unknown): unknown {
  if (node == null || typeof node !== "object") return node
  const n = node as any
  if (typeof n.$$typeof !== "symbol") return node
  if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node
  const payload = n._payload
  if (payload && payload._status === 1) return payload._result
  try {
    const init = n._init
    if (typeof init === "function") return init(payload)
  } catch {
    // Pending/errored — treat as opaque
  }
  return null
}

/**
 * Walk the streamed children tree and cache partial contents by id.
 *
 * Partials are recognized by their outermost wrapper shape (see
 * `isPartialWrapper`): a keyed `<Suspense>` or keyed
 * `<PartialErrorBoundary>`. The key is the partial id.
 *
 * We cache the wrapper AND descend into its children looking for
 * NESTED partial wrappers. Nested partials need their own top-level
 * entries so that after a parent-only refetch (which emits a
 * placeholder for the nested partial inside the parent's new
 * content), the client can still find the nested partial's content
 * by id — otherwise `substituteNested` produces an empty hole.
 *
 * Why we can descend safely: during streaming, inner async chunks
 * arrive as Flight lazies. Walking past a lazy forces React's
 * lazy-init — which is fine because the lazy will resolve
 * eventually, and our walk of the lazy's contents just searches for
 * more partial wrappers (no side effects). `unwrapLazy` returns
 * null for pending lazies, so we stop cleanly if a lazy hasn't
 * resolved yet.
 *
 * Placeholders (`<i data-partial hidden>`) are skipped — the
 * existing cache entry from a prior render is the thing we want.
 */
function cacheStore(
  cache: PartialCache,
  id: string,
  matchKey: string,
  node: ReactNode,
): void {
  let inner = cache.get(id)
  if (!inner) {
    inner = new Map()
    cache.set(id, inner)
  }
  const replacing = inner.has(matchKey)
  inner.set(matchKey, node)
  // Overwriting a cache slot invalidates any fingerprint that
  // referred to the old content. Without this, fps from prior
  // navs accumulate in `_currentPageFingerprints[id][matchKey]`
  // and travel back to the server in `?cached=`; the next visit
  // can fp-skip against a stale entry while the cache slot points
  // at fresh content, and `substituteNested` lands the wrong
  // subtree (or the right one for the wrong URL). Same matchKey
  // with different vary outputs share a slot by design — the
  // fingerprint set must shrink to "what the current slot
  // actually represents", which is exactly the fp that
  // `registerClientPartial` is about to write after this call.
  // Cold→warm trailer adds for the same render still land
  // additively after the walk completes.
  if (replacing) {
    _currentPageFingerprints.get(id)?.delete(matchKey)
  }
}

function cacheFromStreamingChildren(
  node: ReactNode,
  cache: PartialCache,
  seen?: Map<string, Set<string>>,
): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache, seen)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped == null) return
    cacheFromStreamingChildren(unwrapped as ReactNode, cache, seen)
    return
  }
  if (!isValidElement(node)) return

  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (id) {
      const mk = getPartialMatchKey(node) ?? ""
      if (seen) addSeen(seen, id, mk)
      cacheStore(cache, id, mk, node)
      // Populate `_currentPageFingerprints` synchronously from the tree walk
      // rather than waiting for each `<PartialErrorBoundary>` to
      // commit on the client. The commit order is non-deterministic
      // across transitions (React may defer subtrees such as the
      // `<head>` wrapper), so a targeted refetch fired right after a
      // client nav could otherwise send a `?cached=` that's missing
      // late-committing ids. The wrapper already carries the
      // fingerprint — just lift it off.
      const fp = getPartialFingerprint(node)
      if (fp) registerClientPartial(id, mk, fp)
    }
    // Descend: nested partial wrappers need their own top-level cache
    // entries so subsequent parent-only refetches with inner
    // placeholders can fill the holes.
    const inner = (node.props as any)?.children
    if (inner != null) cacheFromStreamingChildren(inner, cache, seen)
    return
  }
  if (isPlaceholder(node)) {
    // Placeholder means "server skipped this partial; client keeps
    // its existing cache entry." Don't overwrite — but DO mark the
    // (id, matchKey) pair as seen so the streaming-mode prune step
    // keeps the cache / fingerprint entries that back this placeholder.
    // Without this, a nested partial whose server confirmed an fp
    // match would be pruned out of `_currentPagePartials` and the next
    // render's `substituteNested` call would leave the `<i hidden>`
    // placeholder in the DOM — blanking the partial's region until a
    // hard reload.
    const id = getPlaceholderId(node)
    if (id && seen) addSeen(seen, id, getPlaceholderMatchKey(node) ?? "")
    return
  }

  const inner = (node.props as any)?.children
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache, seen)
  }
}

/**
 * Walk the streamed children tree and produce a structural template:
 * DOM wrappers and non-partial elements preserved with stable keys,
 * partial wrappers replaced with `<i data-partial hidden key={id}>`
 * placeholders.
 *
 * Runs on the client so the tree is observed AFTER `<Partial>` bodies
 * have decided fresh-vs-skip — opaque server components execute once,
 * via the streamed `children` path, no matter where a Partial sits
 * inside them.
 *
 * Same lazy-safety rule as `cacheFromStreamingChildren`: stop at
 * partial wrappers (don't descend into their children, which may be
 * unresolved Flight lazies). Everything non-partial walks freely.
 */
function deriveTemplate(node: ReactNode): ReactNode {
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    return node.map((c) => deriveTemplate(c as ReactNode))
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    return deriveTemplate(unwrapped as ReactNode)
  }
  if (!isValidElement(node)) return node

  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (!id) return node
    const mk = getPartialMatchKey(node) ?? ""
    return (
      <i
        key={`${id}|${mk}`}
        hidden
        data-partial
        data-partial-id={id}
        data-partial-match={mk}
      />
    )
  }
  if (isPlaceholder(node)) {
    // Already a placeholder (server emitted a fingerprint-match skip);
    // re-emit with a clean key derived from `data-partial-id` +
    // `data-partial-match` to undo any Flight key-composite
    // artifacts (e.g. "page-1,page-1" for .map()-produced placeholders).
    const id = getPlaceholderId(node)
    if (!id) return node
    const mk = getPlaceholderMatchKey(node) ?? ""
    return (
      <i
        key={`${id}|${mk}`}
        hidden
        data-partial
        data-partial-id={id}
        data-partial-match={mk}
      />
    )
  }

  const inner = (node.props as any)?.children
  if (inner == null) return node
  const newInner = deriveTemplate(inner)
  if (newInner === inner) return node
  return Array.isArray(newInner)
    ? cloneElement(node, {}, ...newInner)
    : cloneElement(node, {}, newInner)
}

function renderTemplate(template: ReactNode, cache: PartialCache): ReactNode[] {
  const result: ReactNode[] = []

  Children.forEach(template, (child) => {
    if (!isValidElement(child)) {
      result.push(child)
      return
    }
    if (isPlaceholder(child)) {
      const id = getPlaceholderId(child)
      const mk = getPlaceholderMatchKey(child) ?? ""
      if (id) {
        const cached = cacheLookup(cache, id, mk)
        if (cached) result.push(substituteNested(cached, cache, `${id}|${mk}`))
      }
      return
    }
    if ((child.props as any).children != null) {
      const inner = renderTemplate((child.props as any).children, cache)
      result.push(cloneElement(child, {}, ...inner))
    } else {
      result.push(child)
    }
  })

  return result
}

/**
 * Module-level global state.
 *
 * Lives outside the React tree so it survives the two-phase void→payload
 * remount in entry.browser.tsx. Without this, each refetch would wipe the
 * cache and force every partial to re-render.
 */
/**
 * Module-level state scoped to the CURRENT page only. Pruned on every
 * streaming-mode render against the harvested `seen` set, so entries
 * for partials that aren't on the new page are dropped immediately.
 * Survives the two-phase void→payload remount in entry.browser.tsx so
 * cache-mode refetches don't wipe everything between commits — but
 * doesn't accumulate across navigations. Steady-state size is bounded
 * by the largest single page the user visits, not by browsing history.
 *
 * Two-level keying:
 *   - Outer key: partial `id` (e.g. `"pokemon-page"`).
 *   - Inner key: `matchKey` (16-char hex hash of `stableStringify(
 *     matchParams)`) — identifies the rendered variant.
 *
 * Why nested: navigating `/pokemon/1` ↔ `/pokemon/2` produces two
 * different matchKeys for the same id. Both variants coexist in the
 * cache (rendered as hidden `<Activity>` siblings by the server when
 * the client advertises them via `?cached=`), so the prior variant's
 * fiber survives the round-trip. Specs without `match` resolve to a
 * constant matchKey — the inner map always has size 1.
 *
 * Eviction is purely per-page prune today: any (id, matchKey) not in
 * the new render's `seen` set is dropped on the next streaming-mode
 * commit. There is no time-based TTL or LRU; the steady-state bound
 * is the cartesian product of (live id) × (cached variants per id).
 * For a future LRU layer over the variant pool, see
 * `docs/notes/IDEAS.md` (Keepalive follow-ups).
 */
const _currentPagePartials = new Map<string, Map<string, ReactNode>>()
const _currentPageFingerprints = new Map<string, Map<string, Set<string>>>()

/**
 * Structural layout skeleton, derived from the most recent full-payload
 * render via `deriveTemplate`. Persisted across refetches so the server
 * doesn't need to ship the template bytes on every partial refetch.
 * Re-derived whenever a full payload arrives (covers layout changes
 * across route navigations).
 *
 * Keyed by route (pathname + search). Same-URL refetches reuse the
 * cached template; different-URL navigations re-derive.
 */
let _template: ReactNode = null

/**
 * Register a partial's fingerprint from the client side.
 *
 * Called by `<PartialErrorBoundary>` during its render, which is how
 * each `<Partial>`'s fingerprint gets into `_currentPageFingerprints`
 * without a server prop round-trip. Later `getCachedPartialIds()` reads
 * from here to tell the server what's already cached.
 *
 * Fingerprints are scoped to (id, matchKey) — cold/warm fp drift
 * accumulates within a single variant; cross-variant navigation
 * (`/pokemon/1` ↔ `/pokemon/2`) populates distinct matchKey slots.
 */
export function registerClientPartial(
  id: string,
  matchKey: string,
  fingerprint: string,
): void {
  let inner = _currentPageFingerprints.get(id)
  if (!inner) {
    inner = new Map()
    _currentPageFingerprints.set(id, inner)
  }
  let set = inner.get(matchKey)
  if (!set) {
    set = new Set()
    inner.set(matchKey, set)
  }
  set.add(fingerprint)
}

/**
 * Apply an fp-updates trailer (parsed JSON from the wire) to the
 * client's fingerprint map. Each `id → warm_fp` entry is attached
 * to the most-recently-inserted variant for that id — the trailer
 * fires only for ids whose body the server JUST emitted in this
 * response, so insertion order pins the right variant without
 * having to wire matchKey through the trailer payload.
 *
 * See `lib/fp-trailer.ts` for the server-side emission, and
 * `lib/fp-trailer-marker.ts` for the wire sentinel.
 */
export function _applyFpUpdates(updates: Record<string, string>): void {
  applyFpUpdates(updates)
}

function applyFpUpdates(updates: Record<string, string>): void {
  for (const [id, fp] of Object.entries(updates)) {
    const inner = _currentPageFingerprints.get(id)
    if (!inner || inner.size === 0) continue
    // Pick the most-recently-inserted matchKey — that's the variant
    // the just-emitted body belongs to. Map iteration is
    // insertion-ordered, so `Array.from(...keys()).at(-1)` is the
    // freshest. Trailer is a no-op if the client hasn't registered
    // any variant for the id yet (e.g. the wrapper was unreachable
    // during walk; the next render will re-register).
    const matchKeys = Array.from(inner.keys())
    const latestMk = matchKeys[matchKeys.length - 1]
    let set = inner.get(latestMk)
    if (!set) {
      set = new Set()
      inner.set(latestMk, set)
    }
    set.add(fp)
  }
}

/**
 * Apply the `<!--fp-trailer:JSON-->` comment the server appends after
 * `</html>` (see `wrapSsrStreamWithFpTrailer` in `lib/fp-trailer.ts`).
 *
 * The HTML parser places the comment as a `Document` child (alongside
 * `documentElement`) or, in some browsers, as a `documentElement`
 * child. We scan both lists and apply any update map we find.
 *
 * The hydration entry calls this at startup, but on a streaming HTML
 * response the parser may not have reached the trailing comment yet —
 * `document.readyState` is `"interactive"` (DOMContentLoaded fired)
 * but the after-html comments are still in flight. In that case we
 * defer to the `load` event, which only fires once the parser has
 * fully consumed the response body (including the trailing comment).
 *
 * Calling once on startup AND again on `load` is safe: registration
 * is set-additive, so re-applying the same map is a no-op. Calling
 * on startup catches the common case (non-streaming response that
 * arrives complete); the `load` listener covers the streaming case
 * where the comment lands late.
 */
function tryApplyTrailerNow(): boolean {
  const tag = "fp-trailer:"
  const candidates: Node[] = []
  for (const c of document.childNodes) candidates.push(c)
  if (document.documentElement) {
    for (const c of document.documentElement.childNodes) candidates.push(c)
  }
  for (const node of candidates) {
    if (node.nodeType !== 8 /* COMMENT_NODE */) continue
    const text = (node as Comment).data
    if (!text.startsWith(tag)) continue
    try {
      const json = text.slice(tag.length).replace(/-\\-/g, "--")
      const updates = JSON.parse(json) as Record<string, string>
      applyFpUpdates(updates)
      return true
    } catch {
      return false
    }
  }
  return false
}

export function _applyFpTrailerFromDocument(): void {
  if (tryApplyTrailerNow()) return
  if (typeof window === "undefined") return
  // Streaming HTML: the trailing comment may not have been parsed
  // into the DOM yet. The parser is fully done at the `load` event,
  // so retry there. DOMContentLoaded fires earlier — for some browsers
  // BEFORE post-`</html>` comments are committed — so we wait for
  // `load`, which is guaranteed to fire after the entire response has
  // been consumed.
  //
  // If `load` already fired (this code runs late on a slow-hydration
  // path), one more synchronous attempt picks up the comment that
  // landed between our two scans.
  if (document.readyState === "complete") {
    tryApplyTrailerNow()
    return
  }
  window.addEventListener("load", () => tryApplyTrailerNow(), { once: true })
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:matchKey:fingerprint" triples so the server can:
 *   - decide fp-skip per (id, fingerprint), unchanged from before;
 *   - emit hidden `<Activity>` siblings for cached matchKeys other
 *     than the current variant, so cross-variant navigation parks
 *     the prior variant rather than dropping its fiber.
 *
 * Used by the browser entry to build `?cached=` during navigation.
 *
 * Source of truth is `_currentPageFingerprints`, not
 * `_currentPagePartials`. Every rendered Partial — top-level OR deep
 * (`.map()`-generated, nested inside an ancestor's subtree) —
 * registers its (matchKey, fingerprint) client-side as its wrapper
 * mounts via `PartialErrorBoundary`. Reporting from
 * `_currentPageFingerprints` means the skip-on-unchanged optimization
 * applies uniformly across the entire tree.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = []
  for (const [id, byMatchKey] of _currentPageFingerprints) {
    for (const [matchKey, fps] of byMatchKey) {
      for (const fp of fps) {
        out.push(`${id}:${matchKey}:${fp}`)
      }
    }
  }
  return out
}

// ─── Framework-internal navigation info ───────────────────────────
//
// The Navigation API's `info` option is a one-shot payload delivered
// on the resulting `navigate` event. Unlike `state` it is not
// persisted on the history entry, so it's a natural channel for
// signalling intent from initiator to listener.
//
// Two framework-internal paths still go through `nav.navigate()` and
// need the page-level intercept to stand down:
//   - window-scoped silent nav (URL-only update, or caller dispatches
//     its own targeted refetch via `enqueueRefetch`)
//   - frame nav with explicit `history: "push" | "replace"` (caller
//     dispatches `_dispatchFrameRefetch` itself)
//
// Frame navs with the default `history: "auto"` do NOT stamp silent
// info — they patch state via `updateCurrentEntry`, which fires
// `currententrychange` but not `navigate`, so there's nothing for the
// listener to intercept.
//
// Any non-framework-branded `info` (user-provided via
// `navigate(url, { info })`) passes straight through as a normal
// page-level navigation.

interface FrameworkSilentInfo {
  __framework: "silent-navigate"
  mode: "window" | "frame"
  name?: string
}

function makeSilentInfo(mode: "window" | "frame", name?: string): FrameworkSilentInfo {
  return { __framework: "silent-navigate", mode, name }
}

export function isFrameworkSilentInfo(info: unknown): info is FrameworkSilentInfo {
  return (
    info != null &&
    typeof info === "object" &&
    (info as { __framework?: unknown }).__framework === "silent-navigate"
  )
}

// ─── Selector parsing (client-side, mirrors partial.tsx) ─────────────
//
// Selectors at the use site (`reload({selector})` / `navigate(url,
// {selector})`) are flat lists of labels. The framework strips
// leading `#` / `.` characters as cosmetic — both `"#hero"` and
// `"hero"` resolve to the same label.

function parseSelectorClient(input: string | string[] | undefined): {
  labels: string[]
} {
  if (input == null) return { labels: [] }
  const tokens = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
  const labels: string[] = []
  for (const tok of tokens) {
    const name = tok.startsWith("#") || tok.startsWith(".") ? tok.slice(1) : tok
    if (name && !labels.includes(name)) labels.push(name)
  }
  return { labels }
}

// ─── Microtask-batched targeted-refetch dispatcher ────────────────
//
// Multiple `reload` / `navigate({ selector })` calls in the same tick
// coalesce into one refetch request. Keeps tag-fanout and multi-id
// event handlers cheap: three buttons clicked in the same frame
// produce one request with `?partials=a,b,c`. Each batched entry
// carries its own `streaming` / `finished` deferreds so the batched
// request can fan out its two milestones (first-segment received,
// full body drained) back to every caller separately.

/** Two-milestone return mirroring the host's `fetchRscPayload`. */
interface RefetchMilestones {
  streaming: Promise<void>
  finished: Promise<void>
}

interface RefetchBatchEntry {
  /** Selector labels — become `?partials=…` on the wire. The server
   *  walks snapshots looking for matching labels (or matching ids)
   *  and re-renders each match. */
  labels: string[]
  /** Render mode for the commit — `false` (default) wraps in
   *  `startTransition`; `true` opts into progressive streaming with
   *  Suspense fallbacks. Mirrors the `streaming` option on
   *  `FrameworkNavigateOptions` / `FrameworkReloadOptions`. */
  streaming: boolean
  /** Per-id props map merged into the wire as `?partialProps=<JSON>`.
   *  Server reads it in `PartialRoot` and forwards to the spec via
   *  `partialFromSnapshot` so `<WhenStored>` and similar activators
   *  can pass values without writing them into the URL. */
  props?: Record<string, Record<string, unknown>>
  /** Abort signal for the in-flight HTTP fetch on this entry. Per-
   *  selector supersede sets this to a fresh `AbortController`'s signal
   *  and aborts predecessors when the newer fire's `streaming`
   *  resolves. Passed straight through to `__rsc_partial_refetch`. */
  signal?: AbortSignal
  /** Resolver for this entry's `streaming` milestone — called when the
   *  flushed batch's first segment lands. */
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  /** Resolver for this entry's `finished` milestone — called when the
   *  flushed batch's full response drains. */
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

let _batchRef: RefetchBatchEntry[] = []
let _batchScheduled = false

function flushRefetchBatch(batch: RefetchBatchEntry[]): void {
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (
        url: string,
        signal?: AbortSignal,
      ) => RefetchMilestones
    }
  ).__rsc_partial_refetch
  if (!handler) {
    // Host bundle hasn't wired the handler yet (SSR / pre-hydration).
    // Resolve every entry as a no-op so callers don't hang.
    for (const e of batch) {
      e.resolveStreaming()
      e.resolveFinished()
    }
    return
  }

  const labelSet = new Set<string>()
  const mergedProps: Record<string, Record<string, unknown>> = {}
  let streamingMode = false
  for (const entry of batch) {
    for (const l of entry.labels) labelSet.add(l)
    if (entry.streaming) streamingMode = true
    if (entry.props) {
      for (const [id, p] of Object.entries(entry.props)) {
        mergedProps[id] = { ...(mergedProps[id] ?? {}), ...p }
      }
    }
  }

  // Combine per-entry signals so the batched fetch aborts when any
  // caller superseded. Batched callers share fate by construction —
  // they're one HTTP request. (In practice batched entries usually
  // come from the same event handler; cross-supersede happens only
  // across microtasks so each fire is in its own batch.)
  const signals = batch
    .map((e) => e.signal)
    .filter((s): s is AbortSignal => s != null)
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals)

  const url = new URL(window.location.href)
  if (labelSet.size > 0) url.searchParams.set("partials", [...labelSet].join(","))
  if (streamingMode) url.searchParams.set("streaming", "1")
  if (Object.keys(mergedProps).length > 0) {
    url.searchParams.set("partialProps", JSON.stringify(mergedProps))
  }

  // Send cached fingerprints for the non-target set so the server can
  // skip the unchanged ones via fingerprint-match placeholders. The
  // client doesn't know the server-side id↔label mapping from here, so
  // we strip cached tokens whose id prefix matches a wanted label.
  // Specs whose id equals the wanted label hit; spec-with-label-only
  // would slip through and just get re-rendered (cheap).
  if (labelSet.size > 0) {
    const targetPrefixes = [...labelSet].map((l) => `${l}:`)
    const cached = getCachedPartialIds().filter((t) => !targetPrefixes.some((p) => t.startsWith(p)))
    if (cached.length > 0) url.searchParams.set("cached", cached.join(","))
  }

  const milestones = handler(url.toString(), signal)
  milestones.streaming.then(
    () => {
      for (const e of batch) e.resolveStreaming()
    },
    (err) => {
      for (const e of batch) e.rejectStreaming(err)
    },
  )
  milestones.finished.then(
    () => {
      for (const e of batch) e.resolveFinished()
    },
    (err) => {
      for (const e of batch) e.rejectFinished(err)
    },
  )
}

/**
 * Enqueue a targeted refetch. Multiple calls in the same microtask
 * coalesce into one request. Returns synchronously with
 * `{streaming, finished}` promises — the caller can attach handlers
 * on either milestone independently. Both reject with whatever
 * `__rsc_partial_refetch` rejected with (typically a
 * `NavigationError` from `fetchRscPayload`); on supersede, the
 * shared `AbortSignal` propagates an `AbortError` to both milestones.
 */
function enqueueRefetch(
  entry: Omit<
    RefetchBatchEntry,
    | "resolveStreaming"
    | "rejectStreaming"
    | "resolveFinished"
    | "rejectFinished"
  >,
): RefetchMilestones {
  let resolveStreaming!: () => void
  let rejectStreaming!: (err: unknown) => void
  let resolveFinished!: () => void
  let rejectFinished!: (err: unknown) => void
  const streaming = new Promise<void>((res, rej) => {
    resolveStreaming = res
    rejectStreaming = rej
  })
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res
    rejectFinished = rej
  })
  // Pre-attach no-op handlers so a rejection that lands before the
  // downstream consumer's `.then(_, handler)` registers doesn't
  // surface as unhandledrejection. The pre-attach does NOT consume
  // the rejection — subsequent handlers still see the error.
  streaming.catch(() => {})
  finished.catch(() => {})

  _batchRef.push({
    ...entry,
    resolveStreaming,
    rejectStreaming,
    resolveFinished,
    rejectFinished,
  })
  if (!_batchScheduled) {
    _batchScheduled = true
    queueMicrotask(() => {
      const batch = _batchRef
      _batchRef = []
      _batchScheduled = false
      flushRefetchBatch(batch)
    })
  }
  return { streaming, finished }
}

// ─── Per-selector in-flight queue + deferred abort ────────────────
//
// A new fire for a selector that's already in flight supersedes the
// older one(s). To avoid yanking the previously-committed tree off
// the screen, abort is DEFERRED: the older fire keeps streaming
// bytes into its Suspense boundaries until the newer fire's first
// segment lands. At that moment the newer fire calls
// `abortPredecessors` to cancel the older fetches in one shot.
//
// Selector identity is the sorted, comma-joined label set. Multiple
// callers with the same selector key share one stack; their fires
// race and the newest always wins.

interface InFlightEntry {
  controller: AbortController
}

const _inFlight = new Map<string, InFlightEntry[]>()

function inFlightKey(labels: string[]): string | null {
  if (labels.length === 0) return null
  return labels.slice().sort().join(",")
}

function registerInFlight(key: string, entry: InFlightEntry): void {
  const stack = _inFlight.get(key)
  if (stack) stack.push(entry)
  else _inFlight.set(key, [entry])
}

function unregisterInFlight(key: string, entry: InFlightEntry): void {
  const stack = _inFlight.get(key)
  if (!stack) return
  const idx = stack.indexOf(entry)
  if (idx >= 0) stack.splice(idx, 1)
  if (stack.length === 0) _inFlight.delete(key)
}

/** Abort every entry older than `entry` in this selector's stack. */
function abortPredecessors(key: string, entry: InFlightEntry): void {
  const stack = _inFlight.get(key)
  if (!stack) return
  const idx = stack.indexOf(entry)
  if (idx <= 0) return
  for (let i = 0; i < idx; i++) stack[i].controller.abort()
  stack.splice(0, idx)
}

// ─── Frame navigation ─────────────────────────────────────────────

/**
 * Cached frame URLs on the client, keyed by the frame's dotted path
 * (`"cart"` or `"products.list"`). Updated on every
 * `useNavigation(path).navigate(url)` call so `currentEntry.url` can
 * return a synchronous value without a server round-trip. The server
 * session is authoritative — this is a UX cache.
 */
const _frameUrls = new Map<string, string>()

/**
 * Client-side context carrying the AMBIENT frame path (outer-most to
 * inner-most). Populated by `<FrameNameProvider>` (rendered as part of
 * `<Partial frame="X">`) which stacks its own local name onto any
 * enclosing chain. Empty array at the page root. Lets
 * `useNavigation()` default to "the enclosing frame" without every
 * caller passing the path explicitly, and gives nested frames a
 * canonical identity (`["products","list"]` → `"products.list"`) for
 * session/state lookup.
 */
export const FrameNameContext = createContext<readonly string[]>(
  Object.freeze([]) as readonly string[],
)

/**
 * Enclosing partial instance id. Set by every spec's render via the
 * `<PartialIdContext.Provider>` wrapper around its body. Self-target
 * reload from a client descendant by writing the `@self` token —
 * `useNavigation().reload()` reads this context and substitutes:
 *
 *     const [reload] = useNavigation().reload()
 *     <Button onClick={() => reload({ selector: "@self" })} />
 */
export const PartialIdContext = createContext<string | null>(null)

/** Dotted canonical name for a frame path. */
function joinFramePath(path: readonly string[]): string {
  return path.join(".")
}

/**
 * Multi-frame URL snapshot carried on each navigation entry. Every
 * pushed entry stores the URL of every known frame so browser
 * back/forward can diff two entries and dispatch refetches for the
 * frames that changed. See `docs/frames-navigation.md`.
 */
const FRAMES_KEY = "__frames"

/**
 * Tree-shaped per-frame record on a navigation entry. Every
 * `<Partial frame="X">` (at any nesting depth) contributes one node,
 * keyed by its local name inside its parent's `__frames`.
 *
 *   state.__frames = {
 *     cart:     { url: "/cart/open", __frameHistory: {...} },
 *     products: { url: "/products", __frameHistory: {...},
 *                 __frames: {
 *                   list: { url: "/list?page=3", __frameHistory: {...} }
 *                 } }
 *   }
 *
 * `__frameHistory` and `__frameState` live at each node, scoped to
 * that node's navigation — a nested frame's history doesn't pollute
 * its parent's and vice versa.
 */
interface FrameHistoryEntry {
  past: string[]
  future: string[]
}

interface FrameNode {
  /** Current URL for this frame. Not always present — a node may
   *  exist only to carry `__frames` for descendants (e.g. a parent
   *  node whose children mutated first). Readers fall back to
   *  `_frameUrls`. */
  url?: string
  __frameHistory?: FrameHistoryEntry
  __frameState?: Record<string, unknown>
  __frames?: Record<string, FrameNode>
}

interface FramesTree {
  [localName: string]: FrameNode
}

/**
 * Read the per-frame URL tree from a navigation entry's state.
 * Exported for `entry.browser.tsx`'s traverse listener.
 */
export function _readFramesSnapshot(state: unknown): FramesTree {
  if (state == null || typeof state !== "object") return {}
  const v = (state as Record<string, unknown>)[FRAMES_KEY]
  if (v == null || typeof v !== "object") return {}
  return v as FramesTree
}

/** Walk the tree at `path`, returning the node or `undefined`. */
export function _readFrameNode(state: unknown, path: readonly string[]): FrameNode | undefined {
  let cursor: FrameNode | undefined = undefined
  let level: FramesTree = _readFramesSnapshot(state)
  for (const name of path) {
    cursor = level[name]
    if (cursor == null) return undefined
    level = cursor.__frames ?? {}
  }
  return cursor
}

/**
 * Flatten the tree into `{dottedPath: url}` pairs — used by browser
 * traverse diffing in `entry.browser.tsx` to detect which frames
 * changed between two entries.
 */
export function _collectFramePaths(
  tree: FramesTree,
  prefix: readonly string[] = [],
): Record<string, { url: string }> {
  const out: Record<string, { url: string }> = {}
  for (const [name, node] of Object.entries(tree)) {
    const path = [...prefix, name]
    if (node.url != null) out[path.join(".")] = { url: node.url }
    if (node.__frames) {
      Object.assign(out, _collectFramePaths(node.__frames, path))
    }
  }
  return out
}

/**
 * Immutably patch a frame node at `path`. Returns a new state object
 * with parent chain cloned; creates missing intermediate nodes as
 * empty containers.
 */
function writeFrameNode(
  priorState: unknown,
  path: readonly string[],
  patch: (node: FrameNode) => FrameNode,
): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error("writeFrameNode: path must be non-empty")
  }
  const base = (priorState as Record<string, unknown> | null) ?? {}
  const rootTree: FramesTree = { ...(_readFramesSnapshot(priorState) ?? {}) }

  // Walk into the tree, cloning each node we pass through.
  let levelTree = rootTree
  for (let i = 0; i < path.length - 1; i++) {
    const name = path[i]
    const existing = levelTree[name] ?? {}
    const childrenCopy = { ...(existing.__frames ?? {}) }
    const cloned: FrameNode = { ...existing, __frames: childrenCopy }
    levelTree[name] = cloned
    levelTree = childrenCopy
  }
  const leafName = path[path.length - 1]
  levelTree[leafName] = patch(levelTree[leafName] ?? {})

  return { ...base, [FRAMES_KEY]: rootTree }
}

function emptyHistoryEntry(): FrameHistoryEntry {
  return { past: [], future: [] }
}

/**
 * Wraps descendants so `useNavigation()` calls inside them bind to this
 * frame by default. Also seeds the current navigation entry's state
 * with this frame's initial URL + an empty history stack on first
 * mount, so `frame.canGoBack` / `canGoForward` read a well-formed
 * shape even before the first frame nav.
 */
export function FrameNameProvider({
  path,
  initialUrl,
  children,
}: {
  path: readonly string[]
  initialUrl: string
  children: ReactNode
}) {
  const key = joinFramePath(path)
  useEffect(() => {
    // Client cache: so `useNavigation(path).currentEntry.url` is
    // non-null on cold load.
    if (!_frameUrls.has(key)) {
      _frameUrls.set(key, initialUrl)
    }
    const nav = getNavigation()
    if (!nav) return
    const current = nav.currentEntry?.getState() ?? null
    const existing = _readFrameNode(current, path)
    const hasUrl = existing?.url != null
    const hasHistory = existing?.__frameHistory != null
    if (!hasUrl || !hasHistory) {
      nav.updateCurrentEntry({
        state: writeFrameNode(current, path, (node) => ({
          ...node,
          url: node.url ?? initialUrl,
          __frameHistory: node.__frameHistory ?? emptyHistoryEntry(),
        })),
      })
    }
  }, [key, initialUrl])
  return <FrameNameContext value={path}>{children}</FrameNameContext>
}

/**
 * Runs a frame refetch end-to-end: writes the cached URL, builds the
 * refetch URL with `__frame` + `__frameUrl`, dispatches to the RSC
 * refetch handler. Shared between `frame.navigate()` and the browser-
 * traverse listener (which re-invokes it for each frame whose URL
 * differs between the destination entry and the current one).
 *
 * Returns the handler's `{streaming, finished}` milestones so frame
 * `navigate` / `reload` can pipe them straight through to their own
 * `NavigationMilestones`. Callers awaiting completion use `.finished`.
 */
export function _dispatchFrameRefetch(
  path: readonly string[],
  url: string,
  options?: FrameworkNavigateOptions,
  signal?: AbortSignal,
): RefetchMilestones {
  const key = joinFramePath(path)
  _frameUrls.set(key, url)
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (
        url: string,
        signal?: AbortSignal,
      ) => RefetchMilestones
    }
  ).__rsc_partial_refetch
  if (!handler) {
    return { streaming: Promise.resolve(), finished: Promise.resolve() }
  }
  const refetchUrl = new URL(window.location.href)
  refetchUrl.searchParams.set("__frame", key)
  refetchUrl.searchParams.set("__frameUrl", url)
  // Narrow to the TOP-LEVEL frame of the path as the partials filter.
  // For a top-level frame (path `["cart"]`), that's `partials=cart` —
  // same as pre-nesting behavior. For a nested frame (path
  // `["cart", "tab"]`), that's still `partials=cart` — we need the
  // root-of-the-subtree rendered FRESH so its descendants (the
  // nested frame included) re-run their bodies with the updated
  // session URL. Narrowing to the nested leaf's selector would be
  // more precise but requires a server-side registry lookup on
  // `framePath` to bridge local name → effective id; the ancestor
  // hint correctly widens the render until that's built.
  //
  // Without this hint, the parent frame's fingerprint (which hasn't
  // changed — only the nested child's frame URL did) would match
  // `?cached=`, the server would emit a placeholder, and the client
  // would keep showing stale nested content.
  //
  // Frame refetches invoked from the urlChanged path in
  // `entry.browser.tsx` deliberately DO NOT set `partials=` — they
  // want a full render so URL-dependent content (e.g. main listing
  // switching on `?product=`) rerenders while `__frame` still
  // updates the session.
  refetchUrl.searchParams.set("partials", path[0])
  if (options?.streaming) {
    refetchUrl.searchParams.set("streaming", "1")
  }
  return handler(refetchUrl.toString(), signal)
}

// ─── NavigateTarget resolution ────────────────────────────────────
//
// `FrameworkNavigation.navigate(target, ...)` accepts a URL string, a
// URL instance, or an updater function `(current: URL) => URL | string`.
// Both handle scopes synthesize an absolute URL for the updater so
// authors write the same code regardless of whether they hold a page
// or frame handle. For frames, the origin is the page origin (frame
// URLs are same-origin by construction) and a cross-origin result
// from the updater throws a hard error — frame refetches have no
// meaning outside the page's origin.

/** Resolve a `NavigateTarget` against a base URL. */
function applyTarget(target: NavigateTarget, base: URL): URL {
  if (typeof target === "function") {
    const result = target(new URL(base.href))
    return typeof result === "string" ? new URL(result, base) : result
  }
  if (target instanceof URL) return new URL(target.href)
  return new URL(target, base)
}

function resolveWindowTarget(target: NavigateTarget): string {
  const base = new URL(window.location.href)
  return applyTarget(target, base).href
}

function resolveFrameTarget(target: NavigateTarget, frameName: string): string {
  const base = new URL(_frameUrls.get(frameName) ?? "/", window.location.origin)
  const next = applyTarget(target, base)
  if (next.origin !== base.origin) {
    throw new Error(`frame "${frameName}" cannot navigate cross-origin (got ${next.origin})`)
  }
  return next.pathname + next.search + next.hash
}

// ─── Browser NavigationResult helpers ─────────────────────────────

/**
 * Await the browser's `NavigationResult.committed` (or resolve
 * immediately if absent — TS 6's `lib.dom.d.ts` marks it optional).
 * The framework's `NavigationMilestones.committed` is built off this
 * — it resolves once the browser entry exists and `currentEntry` can
 * be read.
 */
async function awaitCommitted(result: NavigationResult): Promise<void> {
  if (result.committed) await result.committed
}

/**
 * Await the browser's `NavigationResult.finished` (full commit +
 * any intercepted handler). The page-level navigate-event handler
 * does the framework's full-page refetch — `finished` resolves only
 * after that handler's promise settles.
 */
async function awaitFinished(result: NavigationResult): Promise<void> {
  if (result.finished) await result.finished
}

// ─── Deferred / milestone helpers ─────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Build a fresh `NavigationMilestones` shell. Each milestone has a
 * no-op rejection handler pre-attached so an un-listened branch
 * doesn't surface as unhandledrejection when the rejection comes
 * through — the pre-attach doesn't consume the rejection, so
 * subsequent consumer handlers still see the error.
 */
function makeMilestoneDeferreds(): {
  committed: Deferred<NavigationHistoryEntry>
  streaming: Deferred<void>
  finished: Deferred<NavigationHistoryEntry>
} {
  const committed = deferred<NavigationHistoryEntry>()
  const streaming = deferred<void>()
  const finished = deferred<NavigationHistoryEntry>()
  committed.promise.catch(() => {})
  streaming.promise.catch(() => {})
  finished.promise.catch(() => {})
  return { committed, streaming, finished }
}

function parseOptionsSelector(
  options: FrameworkNavigateOptions | FrameworkReloadOptions | undefined,
): { labels: string[] } {
  if (!options?.selector) return { labels: [] }
  return parseSelectorClient(options.selector)
}

// ─── @self token resolution ───────────────────────────────────────

/**
 * Special selector token resolved at fire time to the enclosing
 * partial's id. The framework provides the id via `PartialIdContext`
 * (set by `PartialErrorBoundary`); the hook captures it at render
 * and substitutes here.
 *
 *   <Button onClick={() => reload({ selector: "@self" })} />
 *
 * Works in:
 *   - `selector: "@self"`             — single token
 *   - `selector: ["@self", ".price"]` — array form, mixed freely
 *   - `selector: "@self .price"`      — space-separated string
 *   - `props: { "@self": {...} }`     — same resolution on the key
 *
 * If `@self` appears but the call site is outside any partial
 * (ambient id is null), throws a clear error rather than silently
 * dropping the token — almost always a wiring mistake worth
 * surfacing loudly.
 */
const SELF_TOKEN = "@self"

function containsSelfInSelector(s: string | string[] | undefined): boolean {
  if (s == null) return false
  if (Array.isArray(s)) return s.some((t) => typeof t === "string" && t.trim() === SELF_TOKEN)
  return s.split(/\s+/).some((t) => t === SELF_TOKEN)
}

function containsSelfInProps(p: Record<string, unknown> | undefined): boolean {
  if (p == null) return false
  return Object.prototype.hasOwnProperty.call(p, SELF_TOKEN)
}

function replaceSelfInSelector(
  s: string | string[],
  id: string,
): string | string[] {
  if (Array.isArray(s)) return s.map((t) => (t === SELF_TOKEN ? id : t))
  return s
    .split(/\s+/)
    .map((t) => (t === SELF_TOKEN ? id : t))
    .join(" ")
}

function replaceSelfInProps<V>(p: Record<string, V>, id: string): Record<string, V> {
  if (!containsSelfInProps(p)) return p
  const out: Record<string, V> = {}
  for (const [k, v] of Object.entries(p)) out[k === SELF_TOKEN ? id : k] = v
  return out
}

function resolveSelfInReloadOptions(
  options: FrameworkReloadOptions | undefined,
  ambientId: string | null,
): FrameworkReloadOptions | undefined {
  if (!options) return options
  const inSelector = containsSelfInSelector(options.selector)
  const inProps = containsSelfInProps(options.props)
  if (!inSelector && !inProps) return options
  if (!ambientId) {
    throw new Error(
      `"${SELF_TOKEN}" used outside a partial — no enclosing partial id is available`,
    )
  }
  const next: FrameworkReloadOptions = { ...options }
  if (inSelector && options.selector !== undefined) {
    next.selector = replaceSelfInSelector(options.selector, ambientId)
  }
  if (inProps && options.props !== undefined) {
    next.props = replaceSelfInProps(options.props, ambientId)
  }
  return next
}

function resolveSelfInNavigateOptions(
  options: FrameworkNavigateOptions | undefined,
  ambientId: string | null,
): FrameworkNavigateOptions | undefined {
  if (!options) return options
  const inSelector = containsSelfInSelector(options.selector)
  const inProps = containsSelfInProps(options.props)
  if (!inSelector && !inProps) return options
  if (!ambientId) {
    throw new Error(
      `"${SELF_TOKEN}" used outside a partial — no enclosing partial id is available`,
    )
  }
  const next: FrameworkNavigateOptions = { ...options }
  if (inSelector && options.selector !== undefined) {
    next.selector = replaceSelfInSelector(options.selector, ambientId)
  }
  if (inProps && options.props !== undefined) {
    next.props = replaceSelfInProps(options.props, ambientId)
  }
  return next
}

// ─── Frame entry projection ───────────────────────────────────────

/**
 * Project a window `NavigationHistoryEntry` into a frame-scoped
 * `FrameNavigationHistoryEntry`: `url` reports the frame's URL
 * (absolute, against the page origin); `getState()` returns the node
 * at `path`'s `__frameState` bucket, not the whole window state.
 */
function projectEntryForFrame(
  entry: NavigationHistoryEntry | null,
  path: readonly string[],
): FrameNavigationHistoryEntry | null {
  if (!entry) return null
  const key = joinFramePath(path)
  const node = _readFrameNode(entry.getState(), path)
  const frameUrl = node?.url ?? _frameUrls.get(key) ?? "/"
  const origin = typeof window !== "undefined" ? window.location.origin : "http://_"
  const absoluteUrl = new URL(frameUrl, origin).href
  return new Proxy(entry, {
    get(_target, prop, _receiver) {
      if (prop === "url") return absoluteUrl
      if (prop === "getState") {
        return function getState(): FrameEntryState | null {
          const bucket = _readFrameNode(entry.getState(), path)?.__frameState
          if (bucket == null || typeof bucket !== "object") return null
          return bucket as FrameEntryState
        }
      }
      // Native NavigationHistoryEntry getters (url, key, id, index,
      // sameDocument) throw "Illegal invocation" when invoked with a
      // non-NavigationHistoryEntry `this` — so we must bypass the
      // Proxy receiver and read directly off the underlying entry.
      const value = (entry as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(entry) : value
    },
  }) as FrameNavigationHistoryEntry
}

// ─── SSR / no-Navigation stub ─────────────────────────────────────
//
// `useNavigation()` is a hook that must run in React's render phase,
// but RSC renders happen server-side where `globalThis.navigation` is
// undefined. Return a stub that type-checks with no-op behavior — any
// actual invocation only happens on the client after hydration.

function nullImperativeNavigation(name: string | null): ImperativeNavigation {
  const stubEntry = null as unknown as NavigationHistoryEntry
  const stubMilestones = (): NavigationMilestones => ({
    committed: Promise.resolve(stubEntry),
    streaming: Promise.resolve(),
    finished: Promise.resolve(stubEntry),
  })
  const stubNavResult = {
    committed: Promise.resolve(stubEntry),
    finished: Promise.resolve(stubEntry),
  } as unknown as NavigationResult
  return {
    name,
    currentEntry: null,
    canGoBack: false,
    canGoForward: false,
    transition: null,
    activation: null,
    entries: () => [],
    navigate: stubMilestones,
    reload: stubMilestones,
    back: () => stubNavResult,
    forward: () => stubNavResult,
    traverseTo: () => stubNavResult,
    updateCurrentEntry: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    oncurrententrychange: null,
    onnavigate: null,
    onnavigateerror: null,
    onnavigatesuccess: null,
  } as unknown as ImperativeNavigation
}

// ─── Handle builders ──────────────────────────────────────────────

/**
 * Window-scoped handle — a Proxy over `window.navigation` with
 * `name: null`, an extended `navigate()` (updater callback, targeted
 * refetch via `selector`, `silent` URL-only updates) and an extended
 * `reload()` (targeted refetch without a URL change). Everything
 * else passes straight through to the browser.
 */
/**
 * Apply client-side cookie writes from a `navigate` options bag.
 * Called synchronously at the entry of the window AND frame
 * `navigate` paths so the new cookie values are present in
 * `document.cookie` before the refetch fetch issues — the browser
 * picks them up automatically and ships them in the `Cookie` header.
 *
 * Cookies are NOT supported on `reload` — refetches that need a new
 * cookie value go through `navigate(currentUrl, {cookies})` instead.
 * With `history: "auto"` the URL-unchanged case resolves to a
 * replace, so the effect is identical to a reload plus the cookie
 * write, but the API surface stays strict: cookies imply a
 * `navigate`.
 *
 * Frame handles share this global write — `document.cookie` is not
 * frame-scoped at the browser layer, so a frame.navigate({cookies})
 * writes the same cookie any other handle would. Per-frame cookie
 * scoping would need a different mechanism (a server-side cookie
 * namespace, or a synthetic header) and can be layered later.
 *
 * Empty string deletes the cookie (`max-age=0`). Defaults: `path=/`,
 * `samesite=lax`, `max-age=31536000`. Callers that need different
 * attributes can append them in the value string (cookies do not
 * have a structured-write API in browsers).
 */
function applyClientCookies(cookies: Record<string, string> | undefined): void {
  if (!cookies) return
  for (const [name, value] of Object.entries(cookies)) {
    if (value === "") {
      document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; samesite=lax`
    } else {
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
    }
  }
}

function buildWindowNavigationHandle(): ImperativeNavigation {
  const nav = getNavigation()
  if (!nav) return nullImperativeNavigation(null)

  const windowNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones => {
    applyClientCookies(options?.cookies)
    const url = resolveWindowTarget(target)
    const parsed = parseOptionsSelector(options)
    const filtered = parsed.labels.length > 0
    const silent = options?.silent === true
    const m = makeMilestoneDeferreds()

    if (filtered || silent) {
      // URL-only update — the page-level listener sees the branded
      // info and declines to intercept, so no refetch fires from its
      // side. If we have a selector filter, dispatch the targeted
      // refetch ourselves after commit.
      const result = nav.navigate(url, {
        history: options?.history ?? "push",
        state: options?.state ?? null,
        info: makeSilentInfo("window"),
      })
      const key = filtered ? inFlightKey(parsed.labels) : null
      const controller = key ? new AbortController() : undefined
      const inFlightEntry: InFlightEntry | null =
        key && controller ? { controller } : null
      if (key && inFlightEntry) registerInFlight(key, inFlightEntry)

      void (async () => {
        try {
          await awaitCommitted(result)
          m.committed.resolve(nav.currentEntry!)
          if (silent) {
            m.streaming.resolve()
            m.finished.resolve(nav.currentEntry!)
            return
          }
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            props: options?.props,
            signal: controller?.signal,
          })
          await refetch.streaming
          // Newer fire's first segment landed — kill any older fires
          // for the same selector so they stop chewing through the
          // server's response.
          if (key && inFlightEntry) abortPredecessors(key, inFlightEntry)
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.committed.reject(err)
          m.streaming.reject(err)
          m.finished.reject(err)
        } finally {
          if (key && inFlightEntry) unregisterInFlight(key, inFlightEntry)
        }
      })()
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }

    // Full-page nav: the navigate-event listener intercepts and runs
    // the framework's main refetch via `fetchRscPayload(...).finished`,
    // so `result.finished` covers both the browser commit and the full
    // body drain. No per-segment hook is exposed today, so `streaming`
    // collapses to `finished`.
    const result = nav.navigate(url, {
      history: options?.history,
      state: options?.state,
      info: options?.info,
    })
    void (async () => {
      try {
        await awaitCommitted(result)
        m.committed.resolve(nav.currentEntry!)
        await awaitFinished(result)
        m.streaming.resolve()
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.committed.reject(err)
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  const windowReload = (
    options?: FrameworkReloadOptions,
  ): NavigationMilestones => {
    const parsed = parseOptionsSelector(options)
    const m = makeMilestoneDeferreds()

    if (parsed.labels.length > 0) {
      // Targeted reload — same in-flight-queue behavior as
      // selector-filtered navigate. No browser nav.navigate call;
      // `committed` resolves immediately because the URL isn't
      // changing.
      const key = inFlightKey(parsed.labels)
      const controller = key ? new AbortController() : undefined
      const inFlightEntry: InFlightEntry | null =
        key && controller ? { controller } : null
      if (key && inFlightEntry) registerInFlight(key, inFlightEntry)

      m.committed.resolve(nav.currentEntry!)
      void (async () => {
        try {
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            props: options?.props,
            signal: controller?.signal,
          })
          await refetch.streaming
          if (key && inFlightEntry) abortPredecessors(key, inFlightEntry)
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.streaming.reject(err)
          m.finished.reject(err)
        } finally {
          if (key && inFlightEntry) unregisterInFlight(key, inFlightEntry)
        }
      })()
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }

    const result = nav.reload({ state: options?.state, info: options?.info })
    void (async () => {
      try {
        await awaitCommitted(result)
        m.committed.resolve(nav.currentEntry!)
        await awaitFinished(result)
        m.streaming.resolve()
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.committed.reject(err)
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  return new Proxy(nav, {
    get(_target, prop, _receiver) {
      if (prop === "name") return null
      if (prop === "navigate") return windowNavigate
      if (prop === "reload") return windowReload
      // Native Navigation getters (currentEntry, canGoBack,
      // canGoForward, transition, activation) throw "Illegal
      // invocation" when invoked with a non-Navigation `this`, so we
      // have to bypass the Proxy receiver and read directly off
      // `window.navigation`.
      const value = (nav as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(nav) : value
    },
  }) as unknown as ImperativeNavigation
}

/**
 * Frame-scoped handle — a Proxy over `window.navigation` with
 * frame-scoped overrides.
 *
 * `navigate` defaults to `history: "auto"` which patches the current
 * browser entry via `updateCurrentEntry` (no new entry) and pushes
 * the prior frame URL onto `__frameHistory[name].past`. Browser
 * back/forward is left alone; `frame.back()` walks the in-state
 * stack. Explicit `history: "push" | "replace"` still uses
 * `nav.navigate()` for callers that want a bookmarkable drawer URL
 * or a pure URL sync (search-as-you-type).
 *
 * `back` / `forward` / `canGoBack` / `canGoForward` read the
 * in-state `__frameHistory[name]` arrays instead of scanning
 * browser entries — this is what lets a drawer have a back stack
 * without polluting browser history. `currentEntry` / `entries()`
 * project the frame URL and state; `updateCurrentEntry` merges user
 * state under `__frameState[name]`.
 */
function buildFrameHandle(path: readonly string[]): ImperativeNavigation {
  const nav = getNavigation()
  const key = joinFramePath(path)
  if (!nav) return nullImperativeNavigation(key)
  if (path.length === 0) {
    throw new Error("buildFrameHandle: path must be non-empty")
  }

  const frameNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones => {
    applyClientCookies(options?.cookies)
    const url = resolveFrameTarget(target, key)
    const historyMode: NavigationHistoryBehavior = options?.history ?? "auto"

    const priorState = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
    const priorNode = _readFrameNode(priorState, path)
    // Prior URL for this frame — prefer the entry snapshot, fall back
    // to the module-level cache for first nav before FrameNameProvider
    // seeded the entry.
    const priorUrl = priorNode?.url ?? _frameUrls.get(key) ?? null

    // History update policy per mode:
    //   auto  — push prior URL onto past, clear future. (DEFAULT)
    //   push  — same push on the per-frame stack, PLUS a new browser
    //           entry (drawer URLs the user wants in browser history).
    //   replace — no change to the per-frame stack (pure URL sync).
    const pushToHistory = historyMode === "auto" || historyMode === "push"

    const userState = (options?.state as Record<string, unknown> | null) ?? null
    const baseState = { ...priorState, ...(userState ?? {}) }
    const nextState = writeFrameNode(baseState, path, (node) => {
      const existingHistory = node.__frameHistory ?? emptyHistoryEntry()
      const nextHistory: FrameHistoryEntry = pushToHistory
        ? {
            past:
              priorUrl != null && priorUrl !== url
                ? [...existingHistory.past, priorUrl]
                : existingHistory.past,
            future: [],
          }
        : existingHistory
      return { ...node, url, __frameHistory: nextHistory }
    })

    // Seed the client-side frame-URL cache BEFORE we touch Navigation —
    // `nav.navigate`/`updateCurrentEntry` fires events synchronously
    // that bump reactive consumers; waiting would have them read a
    // stale URL.
    _frameUrls.set(key, url)

    const m = makeMilestoneDeferreds()

    // Frame nav participates in the same per-selector supersede queue
    // as `windowNavigate({selector})` — keyed by the top-level frame
    // name (which is also the `partials=` value the server sees), so
    // a `?chat=closed` frame nav fires while a prior `?chat=open`
    // segment-loop fetch is still streaming, the older fetch aborts
    // when the newer one's first segment lands. Without this, the
    // chat overlay's open response keeps streaming tick updates and
    // races the close response's commit.
    const inFlightK = inFlightKey([path[0]])
    const controller = inFlightK ? new AbortController() : undefined
    const inFlightEntry: InFlightEntry | null =
      inFlightK && controller ? { controller } : null
    if (inFlightK && inFlightEntry) registerInFlight(inFlightK, inFlightEntry)

    if (historyMode === "auto") {
      // No new browser entry. updateCurrentEntry patches state in
      // place, fires currententrychange (consumers update) but NOT
      // navigate — no silent-info bypass needed. `committed` resolves
      // immediately because there's no browser commit to wait on.
      nav.updateCurrentEntry({ state: nextState })
      m.committed.resolve(nav.currentEntry!)
      const refetch = _dispatchFrameRefetch(path, url, options, controller?.signal)
      void (async () => {
        try {
          await refetch.streaming
          if (inFlightK && inFlightEntry) abortPredecessors(inFlightK, inFlightEntry)
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.streaming.reject(err)
          m.finished.reject(err)
        } finally {
          if (inFlightK && inFlightEntry) unregisterInFlight(inFlightK, inFlightEntry)
        }
      })()
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }

    // Explicit push/replace — browser entry grows/replaces. Use the
    // silent-info brand so the page-level listener doesn't also fire
    // a full-page refetch.
    const result = nav.navigate(window.location.href, {
      history: historyMode,
      state: nextState,
      info: makeSilentInfo("frame", key),
    })
    void (async () => {
      try {
        await awaitCommitted(result)
        m.committed.resolve(nav.currentEntry!)
        const refetch = _dispatchFrameRefetch(path, url, options, controller?.signal)
        await refetch.streaming
        if (inFlightK && inFlightEntry) abortPredecessors(inFlightK, inFlightEntry)
        m.streaming.resolve()
        await refetch.finished
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.committed.reject(err)
        m.streaming.reject(err)
        m.finished.reject(err)
      } finally {
        if (inFlightK && inFlightEntry) unregisterInFlight(inFlightK, inFlightEntry)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  const frameReload = (
    options?: FrameworkReloadOptions,
  ): NavigationMilestones => {
    const url = _frameUrls.get(key)
    const m = makeMilestoneDeferreds()
    const entry = nav.currentEntry!
    m.committed.resolve(entry)
    if (!url) {
      // No frame URL known — there's nothing to refetch.
      m.streaming.resolve()
      m.finished.resolve(entry)
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }
    const refetch = _dispatchFrameRefetch(path, url, options)
    void (async () => {
      try {
        await refetch.streaming
        m.streaming.resolve()
        await refetch.finished
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  /**
   * Move within the per-entry `__frameHistory` arrays. No browser
   * traversal — pure state patch via `updateCurrentEntry` plus a
   * refetch dispatch. Missing / empty stack → no-op with stub result.
   */
  const frameTraverseInState = (direction: "back" | "forward"): NavigationResult => {
    const stub = null as unknown as NavigationHistoryEntry
    const priorState = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
    const priorNode = _readFrameNode(priorState, path)
    const history = priorNode?.__frameHistory ?? emptyHistoryEntry()
    const currentUrl = priorNode?.url ?? _frameUrls.get(key) ?? null

    let nextUrl: string | null = null
    let nextPast = history.past
    let nextFuture = history.future
    if (direction === "back") {
      if (history.past.length === 0) {
        return {
          committed: Promise.resolve(stub),
          finished: Promise.resolve(stub),
        }
      }
      nextUrl = history.past[history.past.length - 1]
      nextPast = history.past.slice(0, -1)
      nextFuture = currentUrl != null ? [currentUrl, ...history.future] : history.future
    } else {
      if (history.future.length === 0) {
        return {
          committed: Promise.resolve(stub),
          finished: Promise.resolve(stub),
        }
      }
      nextUrl = history.future[0]
      nextFuture = history.future.slice(1)
      nextPast = currentUrl != null ? [...history.past, currentUrl] : history.past
    }

    const resolvedNextUrl = nextUrl
    const nextState = writeFrameNode(priorState, path, (node) => ({
      ...node,
      url: resolvedNextUrl,
      __frameHistory: { past: nextPast, future: nextFuture },
    }))

    _frameUrls.set(key, resolvedNextUrl)
    nav.updateCurrentEntry({ state: nextState })
    const work = _dispatchFrameRefetch(path, resolvedNextUrl)
    const resolveEntry = () => nav.currentEntry ?? stub
    return {
      committed: Promise.resolve(resolveEntry()),
      finished: work.finished.then(resolveEntry),
    }
  }

  const frameUpdateCurrentEntry = (options: NavigationUpdateCurrentEntryOptions): void => {
    const current = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
    const patch = options.state as Record<string, unknown> | null
    const next = writeFrameNode(current, path, (node) => ({
      ...node,
      __frameState: { ...(node.__frameState ?? {}), ...(patch ?? {}) },
    }))
    nav.updateCurrentEntry({ state: next })
  }

  return new Proxy(nav, {
    get(target, prop) {
      if (prop === "name") return key
      if (prop === "navigate") return frameNavigate
      if (prop === "reload") return frameReload
      if (prop === "back") return () => frameTraverseInState("back")
      if (prop === "forward") return () => frameTraverseInState("forward")
      if (prop === "canGoBack") {
        const node = _readFrameNode(target.currentEntry?.getState(), path)
        return (node?.__frameHistory?.past.length ?? 0) > 0
      }
      if (prop === "canGoForward") {
        const node = _readFrameNode(target.currentEntry?.getState(), path)
        return (node?.__frameHistory?.future.length ?? 0) > 0
      }
      if (prop === "currentEntry") return projectEntryForFrame(target.currentEntry, path)
      if (prop === "entries") {
        return () =>
          target
            .entries()
            .map((e) => projectEntryForFrame(e, path))
            .filter((e): e is FrameNavigationHistoryEntry => e !== null)
      }
      if (prop === "updateCurrentEntry") return frameUpdateCurrentEntry
      // See window-handle Proxy above — native Navigation getters
      // throw "Illegal invocation" when reached via the Proxy
      // receiver, so we read directly off `target` (window.navigation).
      const value = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as unknown as ImperativeNavigation
}

/**
 * Framework-internal plain-function handle for a frame. Accepts the
 * frame's full dotted path (e.g. `"cart"` or `"products.list"`) or an
 * equivalent array of local names.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_frame()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach).
 */
export function _frame(pathOrName: string | readonly string[]): ImperativeNavigation {
  const path = Array.isArray(pathOrName) ? pathOrName : splitFramePath(pathOrName as string)
  return buildFrameHandle(path)
}

/** Parse a dotted frame path into its component names. Empty → []. */
function splitFramePath(dotted: string): readonly string[] {
  if (!dotted) return []
  return dotted.split(".").filter(Boolean)
}

/**
 * Framework-internal plain-function handle for the window.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_windowNav()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach). A
 * subscribe callback needs the handle threaded in as a parameter
 * from the component's render, not fetched here.
 *
 * Always pick this over reaching into `window.navigation` directly:
 * it respects the framework's silent-info convention so internal URL
 * syncs don't trigger a full page refetch.
 */
export function _windowNav(): ImperativeNavigation {
  return buildWindowNavigationHandle()
}

// ─── Hook wrappers around the imperative handle ───────────────────

/**
 * Internal state backing the milestone tuple. The three `committed` /
 * `streaming` / `finished` booleans are what the consumer sees through
 * `NavigationProgress`. `error` is kept here too so that a fire's
 * rejection can be thrown from render (the nearest
 * `<NavigationErrorBubbler>` / error boundary catches), but it's
 * intentionally NOT surfaced through the tuple — the bubbler is the
 * one and only consumer-facing error channel.
 *
 * `fireId` is a monotonic counter that lets per-milestone watchers
 * skip updates from a fire that's already been superseded by the next
 * one. Without it, two rapid keystrokes would race: fire-1's commit
 * watcher could land after fire-2's reset, polluting fire-2's state.
 */
interface InternalProgressState {
  fireId: number
  committed: boolean
  streaming: boolean
  finished: boolean
  error: NavigationError | null
}

const INITIAL_PROGRESS_STATE: InternalProgressState = {
  fireId: 0,
  committed: false,
  streaming: false,
  finished: false,
  error: null,
}

/**
 * Classify a milestone rejection into either a NavigationError (for
 * the bubbler) or null (AbortError — a normal lifecycle event when a
 * newer fire supersedes, NOT a failure).
 */
function classifyMilestoneError(err: unknown): NavigationError | null {
  if (err instanceof Error && err.name === "AbortError") return null
  if (err instanceof NavigationError) return err
  return toNavigationError(
    err,
    typeof window !== "undefined" ? window.location.href : "?",
  )
}

/**
 * Wrap a synchronously-thrown error from the fire body
 * (`resolveSelfIn…Options` validation, for instance) into a milestones
 * object whose three promises are all immediately rejected. The
 * watcher path then classifies and bubbles it the same way as a
 * mid-fetch rejection — sync and async failures share one channel.
 */
function rejectedMilestones(err: unknown): NavigationMilestones {
  const wrapped =
    err instanceof NavigationError
      ? err
      : toNavigationError(
          err,
          typeof window !== "undefined" ? window.location.href : "?",
        )
  const m: NavigationMilestones = {
    committed: Promise.reject(wrapped),
    streaming: Promise.reject(wrapped),
    finished: Promise.reject(wrapped),
  }
  // Pre-attach no-op rejection handlers so un-listened branches
  // don't surface as unhandledrejection.
  m.committed.catch(() => {})
  m.streaming.catch(() => {})
  m.finished.catch(() => {})
  return m
}

/**
 * Inner hook backing `nav.reload()`. Owns the milestone-progress state
 * for one call site, attaches watchers to each fire's
 * `committed` / `streaming` / `finished` promises to flip the
 * corresponding boolean to `true`, and surfaces errors through the
 * render-throw bubbler path. The fire fn returns
 * `NavigationMilestones` synchronously so consumers can `.finished` /
 * `.streaming` independently.
 */
function useReloadHook(imperative: ImperativeNavigation): ReloadStatus {
  const [state, setState] = useState<InternalProgressState>(INITIAL_PROGRESS_STATE)
  // Capture the enclosing partial id at render so the fire fn can
  // resolve `@self` tokens. The id may be null outside a partial;
  // resolveSelfInReloadOptions throws on use in that case.
  const ambientPartialId = useContext(PartialIdContext)
  // `fireIdRef` survives across renders without re-triggering useMemo
  // deps, so the fire callback's identity stays stable for callers
  // passing it into effect deps. Each invocation bumps to the next
  // monotonic id, captured into the milestone watchers' closure for
  // supersede-detection.
  const fireIdRef = useRef(0)
  // Lift the error to render so the nearest enclosing React error
  // boundary catches. The throw bubbles from THIS component; a
  // boundary reset re-mounts with a fresh useState (no error) so
  // there's no stale-error loop.
  if (state.error) throw state.error
  const fire = useMemo<Reload>(
    () => (options) => {
      fireIdRef.current += 1
      const myFireId = fireIdRef.current
      setState({
        fireId: myFireId,
        committed: false,
        streaming: false,
        finished: false,
        error: null,
      })
      let milestones: NavigationMilestones
      try {
        const resolved = resolveSelfInReloadOptions(options, ambientPartialId)
        milestones = imperative.reload(resolved)
      } catch (err) {
        milestones = rejectedMilestones(err)
      }
      attachMilestoneWatchers(milestones, myFireId, setState)
      return milestones
    },
    [imperative, ambientPartialId],
  )
  return [
    fire,
    {
      committed: state.committed,
      streaming: state.streaming,
      finished: state.finished,
    } satisfies NavigationProgress,
  ] as const
}

/**
 * Inner hook backing `nav.navigate()`. Same shape as
 * {@link useReloadHook} — see its comment for the rationale.
 */
function useNavigateHook(imperative: ImperativeNavigation): NavigateStatus {
  const [state, setState] = useState<InternalProgressState>(INITIAL_PROGRESS_STATE)
  const ambientPartialId = useContext(PartialIdContext)
  const fireIdRef = useRef(0)
  if (state.error) throw state.error
  const fire = useMemo<Navigate>(
    () => (target, options) => {
      fireIdRef.current += 1
      const myFireId = fireIdRef.current
      setState({
        fireId: myFireId,
        committed: false,
        streaming: false,
        finished: false,
        error: null,
      })
      let milestones: NavigationMilestones
      try {
        const resolved = resolveSelfInNavigateOptions(options, ambientPartialId)
        milestones = imperative.navigate(target, resolved)
      } catch (err) {
        milestones = rejectedMilestones(err)
      }
      attachMilestoneWatchers(milestones, myFireId, setState)
      return milestones
    },
    [imperative, ambientPartialId],
  )
  return [
    fire,
    {
      committed: state.committed,
      streaming: state.streaming,
      finished: state.finished,
    } satisfies NavigationProgress,
  ] as const
}

/**
 * Wire up the three milestone promises to a setState dispatcher.
 * Each watcher checks `myFireId` against the latest state's
 * `fireId` before applying its update, so an older fire that
 * resolves AFTER a newer one started can't pollute the newer fire's
 * progress booleans.
 *
 * `error` is set from any milestone's rejection (except AbortError);
 * `finished` flips true on settle (success OR error/abort), so the
 * `!finished` predicate cleanly reads as "in flight."
 */
function attachMilestoneWatchers(
  milestones: NavigationMilestones,
  myFireId: number,
  setState: React.Dispatch<React.SetStateAction<InternalProgressState>>,
): void {
  const onSuccess = (key: "committed" | "streaming" | "finished") => () => {
    setState((s) => (s.fireId !== myFireId ? s : { ...s, [key]: true }))
  }
  const onRejection = (err: unknown) => {
    const navErr = classifyMilestoneError(err)
    setState((s) =>
      s.fireId !== myFireId
        ? s
        : { ...s, finished: true, error: s.error ?? navErr },
    )
  }
  milestones.committed.then(onSuccess("committed"), onRejection)
  milestones.streaming.then(onSuccess("streaming"), onRejection)
  milestones.finished.then(onSuccess("finished"), onRejection)
}

/**
 * Wrap an imperative handle so its `reload` / `navigate` properties
 * are hooks returning the `[fire, progress]` tuple. Every other
 * property passes straight through to the imperative handle (which
 * itself is a Proxy over `window.navigation` — see
 * `buildWindowNavigationHandle`).
 *
 * The returned wrapper is itself a Proxy; `useNavigation()` memoizes
 * one of these per resolved frame path so effects with the handle in
 * their deps don't re-run on every navigation commit.
 */
function wrapWithHooks(imperative: ImperativeNavigation): FrameworkNavigation {
  return new Proxy(imperative, {
    get(target, prop, receiver) {
      if (prop === "reload") {
        return function reload(): ReloadStatus {
          return useReloadHook(target as ImperativeNavigation)
        }
      }
      if (prop === "navigate") {
        return function navigate(): NavigateStatus {
          return useNavigateHook(target as ImperativeNavigation)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as FrameworkNavigation
}

/**
 * React hook returning a {@link FrameworkNavigation} handle.
 *
 *   useNavigation()                  // no name + inside <Partial frame=X> → X
 *   useNavigation()                  // no name + outside any frame → window
 *   useNavigation("cart")            // explicit absolute name → top-level cart frame
 *   useNavigation("products.list")   // nested frame via dotted path
 *
 * `name` is an ABSOLUTE dotted path from the page root, not a local
 * name relative to the enclosing frame. To get the ambient (innermost)
 * frame, omit the argument.
 *
 * The handle's live getters (`currentEntry`, `canGoBack`,
 * `canGoForward`) subscribe to `navigation` events, so they stay
 * reactive across any navigation on the page.
 *
 * `handle.reload()` and `handle.navigate()` are **hooks** — call
 * them during render to get back `[fire, progress]`. Calling the
 * fire fn from an event handler triggers the navigation:
 *
 *   const [reload, { committed, finished }] = useNavigation().reload()
 *   <Button
 *     onClick={() => reload({ selector: "#cart" })}
 *     disabled={committed && !finished}
 *   />
 *
 * The fire returns `NavigationMilestones` synchronously, so callers
 * can also await individual milestones:
 *
 *   reload({ selector: "#cart" }).finished
 *
 * Always returns a handle — never throws.
 */
export function useNavigation(name?: string): FrameworkNavigation {
  const ambient = useContext(FrameNameContext)
  const resolvedPath: readonly string[] = name != null ? splitFramePath(name) : ambient
  // Stable key for memoization — names may be dotted, ambients may be
  // distinct arrays that encode the same path across renders.
  const resolvedKey = joinFramePath(resolvedPath)
  // Bump on any navigation so computed getters (`currentUrl`,
  // `canGoBack`, `entryState`) re-read after a commit. Runs for all
  // navigation types — framework-silent window navs and frame navs
  // alike — because both surface new client-side state that reactive
  // consumers (e.g. a header button reading `frameNav.currentUrl`)
  // need to pick up.
  const [, tick] = useState(0)
  useEffect(() => {
    const nav = getNavigation()
    if (!nav) return
    const bump = () => tick((n) => n + 1)
    nav.addEventListener("currententrychange", bump)
    nav.addEventListener("navigate", bump)
    return () => {
      nav.removeEventListener("currententrychange", bump)
      nav.removeEventListener("navigate", bump)
    }
  }, [])
  // Memoize both the imperative handle AND its hook wrapper so a
  // consumer effect that depends on the handle doesn't re-run on
  // every render. The wrapper's reload/navigate proxies still create
  // fresh hooks per render (that's the point), but the wrapper's
  // identity stays stable until the bound name changes.
  const imperative = useMemo(
    () =>
      resolvedPath.length > 0 ? buildFrameHandle(resolvedPath) : buildWindowNavigationHandle(),
    // resolvedKey captures any change to the path — resolvedPath is a
    // fresh array each render, so we can't use it as a dep directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedKey],
  )
  return useMemo(() => wrapWithHooks(imperative), [imperative])
}

/**
 * Activator building block. Subscribe a client-side trigger to a
 * Partial's activation refetch.
 *
 * Typical use inside an activator component:
 *
 *   useActivate(partialId, (fire) => {
 *     const obs = new IntersectionObserver(
 *       (e) => e.some(x => x.isIntersecting) && fire(),
 *       { rootMargin },
 *     );
 *     obs.observe(node);
 *     return () => obs.disconnect();
 *   });
 *
 * `fire()` triggers a targeted reload by sending the Partial's
 * effective id as a `#`-token — server-side, the direct-lookup pass
 * on `resolveSelectorToIds` hits the effective id even for anonymous
 * Partials (`__anon:.foo`) or multi-`#` compound ids (`a,b`). Calling
 * `fire` more than once is a no-op by default (one-shot activation).
 * Pass `{once: false}` if you need an activator that can fire repeatedly.
 *
 * `subscribe` is registered once per mount and is captured via ref, so
 * the latest closure is used when the subscription fires. The effect
 * itself does not re-run when `subscribe` changes — if you need to
 * re-subscribe on prop changes, remount the activator by setting a
 * `key` that changes with those props.
 *
 * Note: activators do not pass prop overrides to the Partial.
 * If the activated content needs dynamic data, the activator should
 * write that data to a URL (page URL via `useNavigation().navigate`
 * or a frame URL via `useNavigation("name").navigate`) so the server reads
 * it via tracked accessors on re-render.
 */
/** Fire signature: optionally pass a `props` payload that the server
 *  forwards to the activated spec as JSX-like props (the `<WhenStored>`
 *  and similar activators use this so values flow without writing
 *  to the URL). */
export type ActivatorFire = (payload?: { props?: Record<string, unknown> }) => void

export function useActivate(
  partialId: string,
  subscribe: (fire: ActivatorFire) => (() => void) | void,
  opts?: { once?: boolean },
): void {
  const once = opts?.once ?? true
  const firedRef = useRef(false)
  const subscribeRef = useRef(subscribe)
  subscribeRef.current = subscribe
  // Activator fires happen in event-callback land — outside render —
  // so the imperative handle is the right shape. The ambient frame
  // path comes from context; the handle is resolved per-fire to
  // pick up any frame changes between mount and trigger.
  const framePath = useContext(FrameNameContext)
  const framePathKey = joinFramePath(framePath)
  const framePathRef = useRef(framePath)
  framePathRef.current = framePath

  useEffect(() => {
    const cleanup = subscribeRef.current((payload) => {
      if (once && firedRef.current) return
      firedRef.current = true
      // Funnel activator-driven refetches through the same imperative
      // `reload` surface that `<CacheControls>` etc. use — one path
      // for "refetch this partial with these props", batched by the
      // same microtask coalescer. AbortError / NavigationError
      // surface via the public hook layer; an activator-internal
      // fire is fire-and-forget so we don't await.
      const handle =
        framePathRef.current.length > 0 ? _frame(framePathRef.current) : _windowNav()
      void handle.reload({
        selector: [`#${partialId}`],
        props: payload?.props ? { [partialId]: payload.props } : undefined,
      })
    })
    return () => {
      if (typeof cleanup === "function") cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partialId, once, framePathKey])
}

// ─── Scroll restoration for non-window scroll containers ───────────────

interface ScrollPositionsState {
  __scrollPositions?: Record<string, number>
}

/**
 * Restore scroll position of a custom scroll container across browser
 * back / forward / refresh, persisted on the Navigation API entry
 * state. Browser-native scroll restoration only covers `window` —
 * nested scrollable elements (drawer bodies, modal contents, virtual
 * lists) need explicit save/restore.
 *
 * Returns a `RefObject` to attach to the scroll container. Restore
 * happens in a layout effect so the scroll position is in place before
 * the next paint — this matters for view transitions, where the
 * snapshot is captured pre-paint and would otherwise show the list
 * scrolled to the top during the slide-in.
 *
 * Save policy: a `scrollend` listener (with a debounced `scroll`
 * fallback for browsers without `scrollend`) writes the current
 * `scrollTop` onto the entry's state under `__scrollPositions[key]`.
 * A `navigate`-event handler also flushes the latest position before
 * the navigation commits, so a click that pushes a new entry doesn't
 * lose the in-flight scroll position.
 *
 *   const ref = useScrollRestore<HTMLDivElement>("drawer-2-list")
 *   <div ref={ref} className="overflow-y-auto h-full">…</div>
 *
 * `key` should be stable per logical scroll context. Different
 * containers on the same entry must use distinct keys.
 */
export function useScrollRestore<T extends HTMLElement = HTMLElement>(
  key: string,
): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  // Restore synchronously after commit, before paint — so the
  // view-transition snapshot taken on the next frame already shows
  // the restored scroll.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const nav = getNavigation()
    if (!nav) return
    const state = nav.currentEntry?.getState() as ScrollPositionsState | null
    const saved = state?.__scrollPositions?.[key]
    if (typeof saved === "number") el.scrollTop = saved
  }, [key])

  // Persist scroll on the current entry. Two writers:
  //
  //  1. `scrollend` (or debounced `scroll` fallback) catches the user
  //     pausing — keeps the entry state warm for refresh.
  //  2. The `navigate` event fires before a commit. We capture the
  //     latest scrollTop synchronously so a click that pushes a new
  //     entry saves the position onto the entry we're leaving (not
  //     the new one).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const nav = getNavigation()
    if (!nav) return

    const writePosition = () => {
      const current = (nav.currentEntry?.getState() as ScrollPositionsState | null) ?? {}
      const positions = { ...(current.__scrollPositions ?? {}) }
      const next = el.scrollTop
      if (positions[key] === next) return
      positions[key] = next
      try {
        nav.updateCurrentEntry({ state: { ...current, __scrollPositions: positions } })
      } catch {
        // updateCurrentEntry can throw on detached entries — ignore.
      }
    }

    // Prefer scrollend (Chrome 114+, Firefox 109+). Fall back to a
    // 120 ms debounced scroll handler for older engines.
    const supportsScrollend = "onscrollend" in el
    let scrollTimer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      if (supportsScrollend) return
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(writePosition, 120)
    }
    const onScrollend = () => writePosition()

    el.addEventListener("scroll", onScroll, { passive: true })
    if (supportsScrollend) {
      el.addEventListener("scrollend", onScrollend, { passive: true })
    }
    nav.addEventListener("navigate", writePosition)

    return () => {
      el.removeEventListener("scroll", onScroll)
      if (supportsScrollend) el.removeEventListener("scrollend", onScrollend)
      nav.removeEventListener("navigate", writePosition)
      if (scrollTimer) clearTimeout(scrollTimer)
    }
  }, [key])

  return ref
}

export function PartialsClient({ mode = "cache", children }: PartialsClientProps) {
  // PartialsClient is a `"use client"` component — but client components
  // STILL execute during SSR's render-to-HTML pass (entry.ssr.tsx ->
  // renderToReadableStream decodes the Flight tree and runs every
  // client-component body to produce the HTML). On the server we skip
  // the cache/template machinery entirely:
  //
  //   1. `_currentPagePartials`, `_currentPageFingerprints`, `_template`
  //      are module-level state — session-scoped for the BROWSER tab.
  //      The same module is reused across every request in the server
  //      process, so any write would leak request N's state into
  //      request N+1. That leak is what produced the production-preview
  //      "subsequent GET returns empty body" regression.
  //
  //   2. The cache-populating walk in `cacheFromStreamingChildren` calls
  //      `unwrapLazy(node)`, which returns `null` for unresolved Flight
  //      lazies (the form unrendered partial wrappers take while their
  //      chunks are still in flight). `deriveTemplate` likewise walks
  //      past lazies. In a production build the streamed children
  //      contain exactly those lazies — so a cache-walk-then-render
  //      path on the server outputs an EMPTY tree where the partial
  //      wrappers should have rendered, and the SSR HTML loses every
  //      partial body. Letting React see `children` directly preserves
  //      the lazies and resolves them through React's native Suspense /
  //      streaming machinery the way the bypass intended.
  //
  // Symmetry note for hydration: the browser path returns
  // `<Fragment>{...rendered}</Fragment>` (an explicit Fragment from
  // `renderChildren`). useId positions are sensitive to tree shape, so
  // returning raw `children` on the server while wrapping the client
  // tree in a Fragment desyncs hydration — `useId`-driven attributes
  // mismatch and the subtree ends up patched up imperfectly, breaking
  // the cache-mode merge path defer activators rely on. We mirror the
  // wrapper here so the SSR DOM and the client's first render share
  // the same useId tree positions.
  if (typeof document === "undefined") return renderChildren([children])

  const cache = _currentPagePartials

  // ── Streaming mode ──────────────────────────────────────────────────
  //
  // Cache is populated from the streamed children by walking for keyed
  // `<Suspense>` elements — that's what `<Partial>` emits. Placeholders
  // (`<i data-partial hidden>`) are left alone so the existing cache
  // entry from a prior render still backs the template.
  //
  // Template is DERIVED on the client from the rendered children (not
  // built server-side). The derived template is persisted in module
  // state so subsequent cache-mode refetches can reuse it without a
  // server round-trip.
  //
  // Fingerprints land in `_currentPageFingerprints` primarily via the synchronous
  // walk inside `cacheFromStreamingChildren` (the wrapper props carry
  // the fingerprint, so we don't have to wait for every
  // `<PartialErrorBoundary>` to commit). Each boundary's render still
  // re-registers as a fallback — harmless, same value.
  if (mode === "streaming") {
    // Walk the streamed tree and track every Partial id encountered,
    // whether emitted as a fresh wrapper or as an fp-skip placeholder.
    // Both kinds of id are still live on this route — the placeholder
    // means "the server confirmed your cache entry is current", so its
    // cache + fingerprint MUST survive the prune below.
    //
    // Clearing `_currentPageFingerprints` up-front (the previous design) wiped
    // skipped partials' fingerprints because the walk only re-sets
    // them for fresh wrappers. Likewise pruning `_currentPagePartials` against just
    // the top-level placeholders from `deriveTemplate` (which stops
    // at any wrapper, so nested ids are never visited) deleted the
    // cache entries for nested partials whose ancestor was re-rendered
    // fresh but whose own region was fp-skipped — leaving
    // `substituteNested` no entry to fill the placeholder with on the
    // next render.
    const seen = new Map<string, Set<string>>()
    cacheFromStreamingChildren(children, cache, seen)
    const derived = deriveTemplate(children)
    _template = derived

    // Expand `seen` with nested (id, matchKey) pairs reachable through
    // cached wrappers. When the server fp-skips an OUTER partial (e.g.
    // `cms-demo-root` unchanged across `/cms-demo/beta` →
    // `/cms-demo/gamma`), the new streamed tree carries only the
    // outer's placeholder. Without this expansion, the prune below
    // would drop every nested partial's cache entry — and the next
    // render's `substituteNested` walk over the cached outer wrapper
    // would find empty placeholders for slug-nav, hero, multi-slot,
    // product-grid, …, blanking those regions.
    //
    // Frontier-style BFS: each newly-discovered (id, matchKey) can
    // itself be a wrapper containing more nested partials, so harvest
    // until no new pairs appear.
    let frontier: Array<[string, string]> = []
    for (const [id, mks] of seen) for (const mk of mks) frontier.push([id, mk])
    while (frontier.length > 0) {
      const next: Array<[string, string]> = []
      for (const [id, mk] of frontier) {
        const wrapper = cacheLookup(cache, id, mk)
        if (!wrapper) continue
        const inner = (wrapper as { props?: { children?: ReactNode } }).props?.children
        if (inner == null) continue
        const nested = new Map<string, Set<string>>()
        harvestPartialIds(inner, nested)
        for (const [nid, nmks] of nested) {
          for (const nmk of nmks) {
            const existing = seen.get(nid)
            if (!existing || !existing.has(nmk)) {
              addSeen(seen, nid, nmk)
              next.push([nid, nmk])
            }
          }
        }
      }
      frontier = next
    }

    // Drop entries from prior routes that don't appear on the new
    // page. `seen` covers fresh wrappers, placeholders from the new
    // tree, AND nested (id, matchKey) pairs harvested from cached
    // wrappers, so any variant still backing the rendered tree
    // survives. Pruning is at (id, matchKey) granularity — a parked
    // variant whose hidden Activity sibling is still emitted by the
    // server stays alive, while a variant no longer referenced
    // anywhere (different layout, never re-emitted) drops.
    for (const [id, mkMap] of _currentPagePartials) {
      const seenMks = seen.get(id)
      for (const mk of [...mkMap.keys()]) {
        if (!seenMks?.has(mk)) mkMap.delete(mk)
      }
      if (mkMap.size === 0) _currentPagePartials.delete(id)
    }
    for (const [id, byMatchKey] of _currentPageFingerprints) {
      const seenMks = seen.get(id)
      for (const mk of [...byMatchKey.keys()]) {
        if (!seenMks?.has(mk)) byMatchKey.delete(mk)
      }
      if (byMatchKey.size === 0) _currentPageFingerprints.delete(id)
    }

    const rendered = renderTemplate(derived, cache)
    return renderChildren(rendered)
  }

  // ── Cache mode ──────────────────────────────────────────────────────
  //
  // Reuses the client-derived `_template` from the most recent
  // streaming render. Cache-mode is always preceded by a full render
  // (initial HTML load), so `_template` is guaranteed to be populated.
  //
  // We descend into each refetched partial's content looking for
  // NESTED partials so they get their own top-level cache entries
  // too. Without this, a frame refetch that introduces a brand-new
  // inner partial would cache only the outer wrapper; a subsequent
  // same-URL refetch (which emits a placeholder for the inner) would
  // find no top-level cache entry to fill the placeholder.
  cacheFromStreamingChildren(children, cache)

  const rendered = renderTemplate(_template, cache)
  return renderChildren(rendered)
}

/**
 * Return `<>{...rendered}</>`, but built via `React.createElement` so
 * the array is spread as positional children. `<>{rendered}</>` passes
 * the array as a single children prop, which makes React enforce the
 * unique-key rule on every item — and the cached partial elements
 * carry intentional non-keys (adding one would trigger Flight's
 * outer/inner key composite, remounting client state on refetch; see
 * `partialFromSnapshot`).
 */
function renderChildren(rendered: ReactNode[]): ReactNode {
  return React.createElement(React.Fragment, null, ...rendered)
}
