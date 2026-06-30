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
 * {@link FrameworkNavigateOptions}. State lives in a URL (the page URL
 * or a frame URL); a spec's request-dependent inputs reach it through
 * `vary` / `match` / cells, which re-resolve on each refetch.
 */

import React, {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  Suspense,
  useContext,
  useEffect,
  useEffectEvent,
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
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts"
import { claimRefetchCommit, nextRefetchSeq } from "./refetch-ordering.ts"

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
    // Errored OR pending lazy — can't descend; skip.
    if (unwrapped == null || unwrapped === LAZY_PENDING) return
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
  // partials to swap. Pending / errored lazies leave the original
  // node in place so React's native Suspense resolves them later.
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped == null || unwrapped === LAZY_PENDING) return node
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

/** Sentinel returned by `unwrapLazy` when the lazy is pending — distinct
 *  from `null` (which signaled "unwrap failed, drop the node"). Callers
 *  who recognise this keep the original lazy in place so React's native
 *  Suspense machinery resolves it; callers who don't recognise it fall
 *  back to the legacy "drop" behaviour. */
const LAZY_PENDING = Symbol("partial-client.lazyPending")

/**
 * Unwrap a raw lazy reference at the tree level.
 *
 * Returns the resolved value when the lazy is fulfilled; `LAZY_PENDING`
 * when the underlying chunk is still in flight; `null` when the lazy
 * errored (treated as opaque).
 *
 * The pending sentinel matters for streaming hydration: the cache-walk
 * (`cacheFromStreamingChildren`) and the template-derive
 * (`deriveTemplate`) both encounter Flight lazies while early chunks
 * are still arriving. Treating pending the same as "drop" silently
 * loses the partial wrapper inside the lazy — the cache never gets
 * an entry, the template emits a bare placeholder, and `renderTemplate`
 * leaves an empty `<i hidden>` in the DOM. Returning a distinct
 * sentinel lets each caller decide: skip caching this round (the
 * lazy will be cached on a re-render when it resolves) but keep the
 * lazy in the rendered output so React resolves it natively.
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
    if (typeof init === "function") {
      const result = init(payload)
      // init returned synchronously — fulfilled.
      return result
    }
  } catch (e) {
    // A thenable throw is React's "pending" signal for lazy refs.
    // Anything else is an error we treat as opaque.
    if (e && typeof e === "object" && typeof (e as PromiseLike<unknown>).then === "function") {
      return LAZY_PENDING
    }
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

/**
 * Sentinel mutable used by `cacheFromStreamingChildren` to report
 * whether the walk encountered any pending Flight lazies. PartialsClient's
 * streaming-mode path uses this to decide: if any lazy is still in flight,
 * skip the template/derive/substitute machinery and return `children`
 * directly so the rendered tree matches the SSR HTML exactly. The cache
 * walk that DID complete is still safe to keep (any wrappers that were
 * walked are cached); a later PartialsClient render with the lazies
 * resolved will fill in the gaps.
 */
interface LazyWalkStats {
  pending: number
}

function cacheFromStreamingChildren(
  node: ReactNode,
  cache: PartialCache,
  seen?: Map<string, Set<string>>,
  stats?: LazyWalkStats,
): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache, seen, stats)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING && stats) stats.pending++
    // Errored OR pending lazy — can't descend to find wrappers. The
    // template-derive keeps the lazy in place so React resolves it
    // through native Suspense; a re-render after resolution will
    // populate the cache for whatever wrappers are inside.
    if (unwrapped == null || unwrapped === LAZY_PENDING) return
    cacheFromStreamingChildren(unwrapped as ReactNode, cache, seen, stats)
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
    if (inner != null) cacheFromStreamingChildren(inner, cache, seen, stats)
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
    cacheFromStreamingChildren(inner, cache, seen, stats)
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
    // Errored OR pending lazy — keep the original node so React's
    // native Suspense resolves it (pending) or its error boundary
    // catches (errored). Without this the wrapper inside the lazy
    // is silently dropped from the derived template and renderTemplate
    // emits a bare `<i hidden>` for any schema-using partial whose
    // Flight chunk hadn't arrived when PartialsClient first
    // committed. See the `streaming-demo-schema-hydration` preview
    // spec.
    if (unwrapped == null || unwrapped === LAZY_PENDING) return node
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

/**
 * True if any node in the tree is a still-pending Flight lazy — i.e. the
 * render is incomplete because a chunk is in flight. Used to defer the
 * cache-mode prune past a mid-stream render so live partials hidden
 * behind an unresolved lazy aren't evicted. Mirrors the lazy-stop rule
 * in `cacheFromStreamingChildren` / `substituteNested`.
 */
function treeHasPendingLazy(node: ReactNode): boolean {
  if (node == null || typeof node === "boolean") return false
  if (typeof node === "string" || typeof node === "number") return false
  if (Array.isArray(node)) {
    return node.some((c) => treeHasPendingLazy(c as ReactNode))
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING) return true
    if (unwrapped == null) return false
    return treeHasPendingLazy(unwrapped as ReactNode)
  }
  if (!isValidElement(node)) return false
  return treeHasPendingLazy((node.props as { children?: ReactNode }).children)
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
 * The page `_template` was derived for — the pathname only. The
 * structural skeleton is decided by which specs `match` (a path
 * concern), so a same-page change — a query/state param like
 * `?chat=open` or `?q=…`, a refetch's `?cached=`/`?streaming=`, a frame
 * URL — keeps the same structure and reuses the template, while a
 * different page re-derives. Gates the streaming-mode pending-lazy
 * fallback (see `PartialsClient`): without it, a cross-page nav whose
 * new page still has a Flight chunk in flight would re-render this STALE
 * prior-page template — the page sticks on the one you just left.
 */
let _templateRoute: string | null = null

/** Page key for `_template`: the pathname. Same-page query/state changes
 *  reuse the template (the `match`-driven structure is unchanged); only a
 *  pathname change re-derives. Client-only (reads `window.location`);
 *  callers are past the SSR `typeof document` guard. */
function templateRouteKey(): string {
  return new URL(window.location.href).pathname
}

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
/** Soft cap on fps tracked per (id, matchKey). The cold→warm
 *  transition emits two fps per render cycle (one at boundary
 *  mount, one from the trailer post-resolution); live partials
 *  emit a fresh pair per segment. Keeping the LATEST few is
 *  enough for the cold/warm fp-skip on the next nav; older fps
 *  for the same variant are stale and only bloat `?cached=`. */
const FP_CAP_PER_VARIANT = 4

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
  if (set.has(fingerprint)) return
  set.add(fingerprint)
  // Evict the oldest entries (insertion order) once the cap is
  // reached. Without this, a live partial that re-renders every
  // segment would inflate `?cached=` unboundedly.
  while (set.size > FP_CAP_PER_VARIANT) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/**
 * Apply an fp-updates trailer (parsed JSON from the wire) to the
 * client's fingerprint map. Each entry is a `{from, to}` cold→warm
 * pair (see {@link FpUpdate}); `to` is aliased onto whichever
 * `(id, matchKey)` slot still holds `from`.
 *
 * See `lib/fp-trailer.ts` for the server-side emission, and
 * `lib/fp-trailer-marker.ts` for the wire sentinel + payload shape.
 */
export function _applyFpUpdates(updates: FpUpdatesPayload): void {
  applyFpUpdates(updates)
}

function applyFpUpdates(updates: FpUpdatesPayload): void {
  for (const [id, { from, to }] of Object.entries(updates)) {
    const inner = _currentPageFingerprints.get(id)
    if (!inner) continue
    // Alias the warm fp `to` onto the variant slot whose set still
    // holds the cold fp `from` — matched by CONTENT. The trailer is
    // async: it lands after its response's body committed, by which
    // point a concurrent refetch for a DIFFERENT query against the same
    // stable `(id, matchKey)` may have overwritten the slot — and
    // cleared its fp-set (see `cacheStore`). Anchoring on `from` means
    // such a superseded trailer finds no slot and is dropped, so the
    // advertised fp-set stays in lockstep with the node the slot
    // actually holds — the invariant that makes every server fp-skip
    // restore the content the server matched it against. `from` folds in
    // matchKey, so it pins exactly one slot. registerClientPartial
    // enforces the per-variant fp cap.
    for (const [mk, set] of inner) {
      if (set.has(from)) {
        registerClientPartial(id, mk, to)
        break
      }
    }
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
      const updates = JSON.parse(json) as FpUpdatesPayload
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

/**
 * Warm the client partial cache from a decoded preload payload WITHOUT
 * committing it to the React root. Walks the tree exactly like the
 * streaming-mode commit's cache step (`cacheFromStreamingChildren`):
 * each partial wrapper's subtree lands in `_currentPagePartials` and
 * its fingerprint in `_currentPageFingerprints`, while placeholders
 * (the server's fp-skips for partials the client already holds) are
 * left untouched. The destination's partials are now cached, so a later
 * navigation to it fp-skips them and `renderTemplate` substitutes them
 * from cache on the first commit. Nothing mounts and `_template` is
 * untouched — the current page keeps rendering until the user actually
 * navigates.
 *
 * Called by the browser entry's preload transport
 * (`window.__rsc_partial_preload`), once per decoded segment. Pairs
 * with `useNavigation().preload(target)`.
 */
export function _warmCacheFromPayload(node: ReactNode): void {
  cacheFromStreamingChildren(node, _currentPagePartials)
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
  /** Open as a live subscription — adds `?live=1` so the server's
   *  segment driver holds the connection open and pushes future
   *  segments. Only the heartbeat sets this; targeted refetches are
   *  one-shot. Mirrors `FrameworkReloadOptions.live`. */
  live: boolean
  /** Abort signal for the in-flight HTTP fetch on this entry. Per-
   *  selector supersede sets this to a fresh `AbortController`'s signal
   *  and aborts predecessors when the newer fire's `streaming`
   *  resolves. Passed straight through to `__rsc_partial_refetch`. */
  signal?: AbortSignal
  /** Extra query params appended to the refetch url (not the page url).
   *  Mirrors `FrameworkReloadOptions.params` — ephemeral per-request
   *  view state read by `vary`'s `search`. */
  params?: Record<string, string>
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
        claimCommit?: () => boolean,
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
  let streamingMode = false
  let liveMode = false
  const extraParams = new Map<string, string>()
  for (const entry of batch) {
    for (const l of entry.labels) labelSet.add(l)
    if (entry.streaming) streamingMode = true
    if (entry.live) liveMode = true
    if (entry.params) for (const [k, v] of Object.entries(entry.params)) extraParams.set(k, v)
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
  // `?live=1` is the server hold-open signal — distinct from
  // `?streaming=1` (client commit mode). Only the heartbeat sets it;
  // targeted refetches stay one-shot and the connection closes.
  if (liveMode) url.searchParams.set("live", "1")

  // Send cached fingerprints so the server can fp-skip unchanged
  // partials. With a selector, strip cached tokens whose id prefix
  // matches a wanted label (those entries are the explicit refetch
  // targets — server must re-render them, not match-and-skip). With
  // no selector (streaming heartbeat, full-page refetch), send every
  // cached entry so the fp-skip cascade prunes the page to deltas.
  const cachedIds = getCachedPartialIds()
  if (cachedIds.length > 0) {
    const targetPrefixes = [...labelSet].map((l) => `${l}:`)
    const cached =
      labelSet.size > 0
        ? cachedIds.filter((t) => !targetPrefixes.some((p) => t.startsWith(p)))
        : cachedIds
    if (cached.length > 0) url.searchParams.set("cached", cached.join(","))
  }

  // Caller-supplied per-request params (ephemeral view state) — appended
  // to the refetch url only; the page url is untouched.
  for (const [k, v] of extraParams) url.searchParams.set(k, v)

  // Monotonic commit ordering. Stamp this fire with the next issue seq
  // for its selector key, and hand the host a commit gate bound to it.
  // The host calls the gate before each segment commit and drops the
  // commit when a newer fire for the same selector has already landed —
  // so a superseded fire whose response arrives late can't clobber the
  // newer tree. Keyed on the sorted label set (matches `?partials=` and
  // `inFlightKey`); a label-less batch (no selector) gets no gate.
  const orderKey = inFlightKey([...labelSet])
  let claimCommit: (() => boolean) | undefined
  if (orderKey != null) {
    const seq = nextRefetchSeq(orderKey)
    claimCommit = () => claimRefetchCommit(orderKey, seq)
  }

  const milestones = handler(url.toString(), signal, claimCommit)
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

// ─── In-flight queue + deferred abort (frame long-polls only) ─────
//
// SCOPE: this machinery now serves ONLY frame navigation, whose
// segment-loop fetch can be an unbounded long-poll (the chat overlay
// streams tick updates for the lifetime of `?chat=open`). A newer
// frame nav must cancel the older infinite stream or it streams
// forever and races the newer commit — so here, deferred abort is
// correct and necessary.
//
// Window-scoped targeted refetches (`navigate({selector})` /
// `reload({selector})`) do NOT use this. They are finite documents;
// aborting one mid-decode rejects the whole Flight document and
// crashes the page through the nearest error boundary. They drain and
// commit on supersede, ordered by the monotonic commit guard
// (`refetch-ordering.ts`): each fire carries a per-selector issue seq,
// and a late-arriving OLDER fire's commit is dropped rather than
// clobbering a newer one — last ISSUED wins, not last to arrive. That
// real signal is what keeps a `reload({selector})` of live server state
// correct when responses race (the URL is identical, so it can't
// arbitrate). They are cancelled only by the caller's own
// `options.signal`.
//
// Abort is DEFERRED: the older fire keeps streaming into its Suspense
// boundaries until the newer fire's first segment lands, then
// `abortPredecessors` cancels the older fetches. Selector identity is
// the sorted, comma-joined label set.

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

/**
 * The current page URL, threaded from the server render through Flight
 * so client components resolve it on the initial (SSR) paint — before
 * the browser Navigation API exists. `PartialRoot` seeds it at the root;
 * after hydration `useNavigation()` reads the live browser URL instead,
 * so this value is consulted only while `window.navigation` is absent
 * (SSR / pre-hydration). This is what makes `useNavigation()` isomorphic:
 * server-correct on first paint, browser-driven after.
 *
 * Because it's never read on a client-driven `.rsc` refetch (the live
 * Navigation API is present there), `PartialRoot` seeds it as `null` on
 * those — serializing the URL would echo the framework-internal `?cached=`
 * query (kilobytes) back into every payload for nothing. It carries a
 * real (framework-param-stripped) string only on the SSR document render.
 */
export const PageUrlContext = createContext<string | null>(null)

/**
 * Provide the page URL to descendant client components. Rendered by a
 * server component at the app root with the request URL, so the value
 * crosses Flight and is present during SSR. Pairs with the SSR branch
 * of `buildWindowNavigationHandle`.
 */
export function PageUrlProvider({
  url,
  children,
}: {
  /** `null` on a client-driven `.rsc` refetch — the live Navigation API
   *  supersedes this seed there, so the server omits it (see
   *  `PartialRoot`). A string only on the SSR document paint. */
  url: string | null
  children: ReactNode
}) {
  return <PageUrlContext value={url}>{children}</PageUrlContext>
}

/** Per-frame URL map (frame key → resolved URL), accumulated down the
 *  tree by `FrameNameProvider`. SSR / pre-hydration counterpart to the
 *  module-level `_frameUrls`: a framed `useNavigation(name)` reads it so
 *  `currentEntry.url` is correct on the first server paint, before the
 *  browser Navigation API exists. The live handle supersedes it after
 *  hydration. */
const FrameUrlContext = createContext<ReadonlyMap<string, string>>(new Map<string, string>())

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
  const parentFrameUrls = useContext(FrameUrlContext)
  // Thread this frame's server-resolved URL down via context so SSR can
  // resolve a framed `currentEntry.url` — the `useEffect` below seeds
  // the client-only `_frameUrls`, which never runs during SSR. Nested
  // frames accumulate into one map.
  const frameUrls = useMemo(() => {
    const next = new Map(parentFrameUrls)
    next.set(key, initialUrl)
    return next
  }, [parentFrameUrls, key, initialUrl])
  // Seed the nav entry's frame node for this `path`. Wrapped in useEffectEvent
  // so the effect keys off `key` (the stable join of `path`) without reacting
  // to `path`'s per-render array identity — it reads the current path each
  // time `key` changes.
  const seedFrameNode = useEffectEvent(() => {
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
  })
  useEffect(() => {
    // Client cache: so `useNavigation(path).currentEntry.url` is non-null on
    // cold load.
    if (!_frameUrls.has(key)) {
      _frameUrls.set(key, initialUrl)
    }
    seedFrameNode()
  }, [key, initialUrl])
  return (
    <FrameUrlContext value={frameUrls}>
      <FrameNameContext value={path}>{children}</FrameNameContext>
    </FrameUrlContext>
  )
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
  // The browser's NavigationResult exposes BOTH `committed` and
  // `finished`. When a newer `history:"replace"` navigation supersedes
  // this one (rapid search keystrokes), the browser rejects BOTH with
  // AbortError. If we await only `committed`, the `finished` rejection
  // is an orphaned promise → "Uncaught (in promise) AbortError:
  // BodyStreamBuffer was aborted" in the console. Consume `finished`
  // with a no-op so the supersede stays silent; callers that need the
  // finished milestone await it themselves via `awaitFinished`.
  silenceNavResultRejections(result)
  if (result.committed) await result.committed
}

/**
 * Attach no-op rejection handlers to a NavigationResult's `committed`
 * and `finished` promises so a browser-driven supersede (AbortError on
 * both) never surfaces as an unhandled rejection. The handlers don't
 * consume the rejection for real consumers — a later `await
 * result.committed` / `awaitFinished(result)` still observes it.
 */
function silenceNavResultRejections(result: NavigationResult): void {
  result.committed?.catch(() => {})
  result.finished?.catch(() => {})
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

function resolveSelfInReloadOptions(
  options: FrameworkReloadOptions | undefined,
  ambientId: string | null,
): FrameworkReloadOptions | undefined {
  if (!options) return options
  if (!containsSelfInSelector(options.selector)) return options
  if (!ambientId) {
    throw new Error(
      `"${SELF_TOKEN}" used outside a partial — no enclosing partial id is available`,
    )
  }
  return { ...options, selector: replaceSelfInSelector(options.selector!, ambientId) }
}

function resolveSelfInNavigateOptions(
  options: FrameworkNavigateOptions | undefined,
  ambientId: string | null,
): FrameworkNavigateOptions | undefined {
  if (!options) return options
  if (!containsSelfInSelector(options.selector)) return options
  if (!ambientId) {
    throw new Error(
      `"${SELF_TOKEN}" used outside a partial — no enclosing partial id is available`,
    )
  }
  return { ...options, selector: replaceSelfInSelector(options.selector!, ambientId) }
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

function nullImperativeNavigation(
  name: string | null,
  url?: string | null,
): ImperativeNavigation {
  const stubEntry = null as unknown as NavigationHistoryEntry
  // On the server (and pre-hydration) there is no browser Navigation
  // API, but a Flight-borne URL still lets `currentEntry.url` resolve
  // correctly for the first paint. Synthesize a minimal entry carrying
  // just that URL; everything else stays inert until the live browser
  // handle takes over after hydration.
  const ssrEntry =
    url == null
      ? null
      : ({
          url,
          key: "",
          id: "",
          index: 0,
          sameDocument: true,
          getState: () => null,
          ondispose: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        } as unknown as NavigationHistoryEntry)
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
    currentEntry: ssrEntry,
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

function buildWindowNavigationHandle(ssrUrl?: string | null): ImperativeNavigation {
  const nav = getNavigation()
  // No browser Navigation API → SSR or pre-hydration. Fall back to the
  // Flight-borne page URL so `currentEntry.url` is correct on first
  // paint; the live handle takes over once `window.navigation` exists.
  if (!nav) return nullImperativeNavigation(null, ssrUrl ?? null)

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

      void (async () => {
        try {
          await awaitCommitted(result)
          m.committed.resolve(nav.currentEntry!)
          if (silent) {
            m.streaming.resolve()
            m.finished.resolve(nav.currentEntry!)
            return
          }
          // Targeted refetches are NEVER aborted on supersede. A
          // refetch is one Flight document feeding the whole root;
          // aborting it mid-decode rejects the entire document (not
          // just the superseded section) and crashes the page through
          // the nearest error boundary. Superseded fires drain and
          // commit — they're small once fp-skipped — but the monotonic
          // commit guard (`refetch-ordering.ts`) drops a late older
          // fire's commit so it can't clobber a newer one. `navigate`
          // has no caller signal (unlike `reload`), so nothing cancels
          // a window-nav fire.
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            // Navigation is one-shot — a held-open subscription belongs
            // to the heartbeat's `reload({live: true})`, not a nav.
            live: false,
          })
          await refetch.streaming
          m.streaming.resolve()
          await refetch.finished
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

    // Three ways to reach the in-place refetch path (no browser reload):
    //
    //   1. Selector filter (`reload({selector: "#cart"})`) — targeted
    //      partial refetch. Existing behaviour.
    //   2. Live subscription (`reload({live: true})`) without a
    //      selector — the framework heartbeat. Full-page top-down
    //      re-render with fp-skip pruning unchanged partials; the
    //      `?live=1` URL flag holds the connection open for live
    //      updates.
    //   3. Streaming opt-in (`reload({streaming: true})`) — the client
    //      commits the response progressively. A render-mode switch, not
    //      a browser reload, so it stays in-place too.
    //
    // Only a bare `reload()` (no selector, no streaming, no live) falls
    // through to `nav.reload()` — that's the user-facing "reload this
    // URL" command and IS supposed to do a real browser reload.
    const wantsInPlace =
      parsed.labels.length > 0 || options?.streaming === true || options?.live === true
    if (wantsInPlace) {
      m.committed.resolve(nav.currentEntry!)
      void (async () => {
        try {
          // Targeted refetches are NEVER aborted on supersede — see the
          // note in `windowNavigate`. Only the caller's own
          // `options.signal` cancels a fire; the heartbeat passes one so
          // its long-poll connection tears down on nav-away.
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            // `live: true` (the heartbeat) holds the connection open as
            // a subscription; a bare `reload({selector, streaming})` is
            // one-shot and closes once its segment drains.
            live: options?.live ?? false,
            signal: options?.signal,
            params: options?.params,
          })
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
function buildFrameHandle(path: readonly string[], ssrUrl?: string | null): ImperativeNavigation {
  const nav = getNavigation()
  const key = joinFramePath(path)
  // No browser Navigation API → SSR / pre-hydration. Resolve
  // `currentEntry.url` from the Flight-borne frame URL so a framed
  // `useNavigation()` is correct on first paint; the live handle takes
  // over once `window.navigation` exists.
  if (!nav) return nullImperativeNavigation(key, ssrUrl ?? null)
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

// ─── Preload (warm-only fetch, no commit) ─────────────────────────
//
// `useNavigation().preload(target)` warms a destination's partials into
// the client cache without navigating. The browser entry's
// `__rsc_partial_preload` transport fetches `target` as a read-only
// render and walks the response into `_currentPagePartials` /
// `_currentPageFingerprints` (via `_warmCacheFromPayload`), with NO
// `setPayload`. Nothing mounts, no effects run, the URL is untouched.
// A later navigation to `target` then fp-skips the warmed partials and
// `renderTemplate` substitutes them from cache on the first commit
// while the fresh render revalidates in the background.

/** At most one preload is in flight at a time. A newer `preload()`
 *  aborts the prior one so a pointer sweeping across a nav bar doesn't
 *  leave a trail of live warm-fetches. Immediate abort is safe — a
 *  preload never commits to the React root, so cancelling mid-decode
 *  just stops the warm and discards partial bytes. */
let _preloadController: AbortController | null = null

function doPreload(target: NavigateTarget, frameName: string | null): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  const handler = (
    window as Window & {
      __rsc_partial_preload?: (url: string, signal?: AbortSignal) => Promise<void>
    }
  ).__rsc_partial_preload
  if (!handler) return Promise.resolve()
  // Window-scoped only today: a frame handle's preload is a no-op.
  // Warming a frame's destination would need the `?__frame=&__frameUrl=`
  // round-trip; deferred until a caller needs it. preload is a
  // best-effort hint, so an unsupported scope degrades silently rather
  // than throwing into an event handler.
  if (frameName !== null) return Promise.resolve()
  let url: string
  try {
    url = resolveWindowTarget(target)
  } catch {
    return Promise.resolve()
  }
  // Coalesce: a newer preload supersedes any still in flight, so a
  // pointer sweeping across a nav bar doesn't pile up live fetches.
  // Immediate abort is safe — a preload never commits to the React
  // root; cancelling mid-decode just discards partial bytes. The warm
  // walk is per-partial atomic (each wrapper's `cacheStore` +
  // `registerClientPartial` run together), so a navigation reading the
  // maps concurrently always sees whole entries, never a torn one —
  // hover-then-immediately-click stays correct without special-casing.
  if (_preloadController) _preloadController.abort()
  const controller = new AbortController()
  _preloadController = controller
  return handler(url, controller.signal)
    .catch(() => {
      // preload is a hint — failures (network / decode / supersede) are
      // swallowed; the next navigation just pays full freight.
    })
    .finally(() => {
      if (_preloadController === controller) _preloadController = null
    })
}

/**
 * Wrap an imperative handle so its `reload` / `navigate` properties
 * are hooks returning the `[fire, progress]` tuple, and `preload` is a
 * plain imperative method. Every other property passes straight through
 * to the imperative handle (which itself is a Proxy over
 * `window.navigation` — see `buildWindowNavigationHandle`).
 *
 * The returned wrapper is itself a Proxy; `useNavigation()` memoizes
 * one of these per resolved frame path so effects with the handle in
 * their deps don't re-run on every navigation commit.
 */
function wrapWithHooks(imperative: ImperativeNavigation): FrameworkNavigation {
  return new Proxy(imperative, {
    get(target, prop, receiver) {
      if (prop === "reload") {
        // Named `useReload` (not `reload`): these Proxy methods ARE hooks —
        // they return the [fire, progress] tuple and are invoked as hooks
        // during render. The `use` name makes that contract legible to React
        // and the linter; the property key the caller sees stays `reload`.
        return function useReload(): ReloadStatus {
          return useReloadHook(target as ImperativeNavigation)
        }
      }
      if (prop === "navigate") {
        return function useNavigate(): NavigateStatus {
          return useNavigateHook(target as ImperativeNavigation)
        }
      }
      if (prop === "preload") {
        // `preload` is NOT a hook — it returns the imperative warm fn
        // directly, callable from an event handler. Scope (window vs
        // frame) comes off the underlying handle's `name`.
        const frameName = (target as ImperativeNavigation).name
        return function preload(navTarget: NavigateTarget): Promise<void> {
          return doPreload(navTarget, frameName)
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
  // Flight-borne page URL — the SSR / pre-hydration fallback for the
  // window scope, so `currentEntry.url` is correct on first paint
  // before `window.navigation` exists. Ignored once the live browser
  // handle is available.
  const ssrPageUrl = useContext(PageUrlContext)
  const ssrFrameUrls = useContext(FrameUrlContext)
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
    () => {
      if (resolvedPath.length === 0) return buildWindowNavigationHandle(ssrPageUrl)
      // Resolve the frame's SSR URL against the page origin so its
      // pathname matches the client (which absolutizes via
      // `projectEntryForFrame`), avoiding a hydration mismatch. An empty
      // frame URL → no SSR entry; the live handle fills it in.
      const frameUrl = ssrFrameUrls.get(resolvedKey)
      const ssrFrameUrl =
        frameUrl != null && frameUrl !== ""
          ? new URL(frameUrl, ssrPageUrl ?? "http://_").href
          : null
      return buildFrameHandle(resolvedPath, ssrFrameUrl)
    },
    // resolvedKey captures any change to the path — resolvedPath is a
    // fresh array each render, so we can't use it as a dep directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedKey, ssrPageUrl, ssrFrameUrls],
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
 * `subscribe` is registered once per mount; `useEffectEvent` keeps the
 * latest `subscribe` + fire closure, so the subscription always calls the
 * freshest version without re-running. To genuinely re-subscribe on prop
 * changes, remount the activator by setting a `key` that changes with
 * those props.
 *
 * Note: activators are triggers. If the activated content needs
 * dynamic data, the activator writes that data to a scope the spec
 * reads via `vary` — the page URL via `useNavigation().navigate`, a
 * frame URL via `useNavigation("name").navigate`, or a cookie — so the
 * server re-resolves it on the refetch.
 */
/** Fire signature: an activation trigger. Request-dependent inputs
 *  reach the activated spec through `vary` / `match` / cells, which
 *  re-resolve on the refetch. */
export type ActivatorFire = () => void

export function useActivate(
  partialId: string,
  subscribe: (fire: ActivatorFire) => (() => void) | void,
  opts?: { once?: boolean },
): void {
  const once = opts?.once ?? true
  const firedRef = useRef(false)
  // Activator fires happen in event-callback land — outside render — so the
  // imperative handle is the right shape. The ambient frame path comes from
  // context; the handle is resolved per-fire to pick up frame changes between
  // mount and trigger.
  const framePath = useContext(FrameNameContext)

  // useEffectEvent keeps the latest `subscribe` and fire behavior without
  // re-running the mount-scoped subscription — the modern replacement for
  // smuggling them through `ref.current = latest` during render.
  const onSubscribe = useEffectEvent((fire: ActivatorFire) => subscribe(fire))
  const fireReload = useEffectEvent(() => {
    if (once && firedRef.current) return
    firedRef.current = true
    // Funnel activator-driven refetches through the same imperative `reload`
    // surface other triggers use — one path, batched by the same microtask
    // coalescer. AbortError / NavigationError surface via the public hook
    // layer; an activator-internal fire is fire-and-forget so we don't await.
    const handle = framePath.length > 0 ? _frame(framePath) : _windowNav()
    void handle.reload({ selector: [`#${partialId}`] })
  })

  useEffect(() => {
    const cleanup = onSubscribe(() => fireReload())
    return () => {
      if (typeof cleanup === "function") cleanup()
    }
  }, [])
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
    const stats: LazyWalkStats = { pending: 0 }
    cacheFromStreamingChildren(children, cache, seen, stats)
    // Route this payload renders for — keys the template reuse below so a
    // cross-route nav never reuses the prior route's `_template`.
    const route = templateRouteKey()
    if (stats.pending > 0) {
      // A Flight chunk hadn't arrived when we walked the children tree, so
      // the cache walk is incomplete — a wrapper inside a pending lazy was
      // missed. We still must substitute the fp-skipped CHROME (the nav,
      // the header) from cache: returning it raw leaves bare `<i hidden>`
      // placeholders, so the nav vanishes until the next full re-render
      // (the heartbeat) restores it. The choice turns on which template to
      // substitute through:
      //
      //   - Same-route template (steady-state streaming segment — e.g. the
      //     chat's `<ChunkSlot>` is suspended): render through the SAME
      //     complete `_template` + cache path a cache-mode refetch takes. A
      //     page with two live connections commits cache-mode (the chat
      //     overlay's frame long-poll) AND streaming-mode (the heartbeat)
      //     segments onto one root; if this branch returned a raw shape
      //     instead, every partial inside the page would remount on each
      //     seam (the nav, the grid — the inspect-overlay flicker).
      //     Matching the cache path lets React reconcile in place, and the
      //     complete prior template carries structure currently behind the
      //     pending lazy that a fresh derive would miss.
      //
      //   - Cross-route nav whose new route still has a chunk in flight:
      //     derive a FRESH template from the NEW children and substitute.
      //     Reusing the prior route's `_template` would re-render the page
      //     just navigated away from (the `/magento → /` stuck-page
      //     regression); a fresh derive shows the new page. `deriveTemplate`
      //     keeps pending lazies raw, so the new page's deferred content
      //     resolves natively for the NEW route, while
      //     `cacheFromStreamingChildren` above just cached every walkable
      //     wrapper — so the fp-skipped chrome fills from cache instead of
      //     blanking. `_template` is left untouched (this derive is
      //     incomplete); the next fully-resolved render refreshes it.
      //
      //   - No template yet (`_template == null`, first render hydrating
      //     against SSR HTML): no cache to substitute from. Raw `children`
      //     keep the tree shape aligned for `useId`.
      if (_template != null && route === _templateRoute) {
        return renderChildren(renderTemplate(_template, cache))
      }
      if (_template == null) return renderChildren([children])
      return renderChildren(renderTemplate(deriveTemplate(children), cache))
    }
    const derived = deriveTemplate(children)
    _template = derived
    _templateRoute = route

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

  // Bound both client maps to what's actually on the page. `rendered`
  // is the FULL page (template + cache), so `harvestPartialIds` over it
  // yields every (id, matchKey) currently displayed OR parked (hidden
  // Activity placeholders are harvested too). Anything in the maps but
  // not here was superseded — a churned-away instance id (props pass a
  // new value → new effective id), an evicted variant — and the client
  // can no longer restore it, so it must stop being advertised in
  // `?cached=`. Without this, the maps only ever grew on the cache-mode
  // (in-app refetch) path — the streaming-mode prune above runs only on
  // a full page load, which never happens mid-session. Identity-method
  // agnostic: bounds props / vary / cell / match alike, because it
  // keys on "still in the rendered/parked tree", not on how data is
  // passed. Un-refetched partials (header, list pages) and live sibling
  // instances stay — they're present in `rendered`.
  //
  // Guard on a COMPLETE render. A substituted cache wrapper can still
  // carry an in-flight Flight lazy — a slow descendant (the search
  // stages) hadn't resolved when the wrapper was last cached. The
  // partials behind that lazy are still live but aren't materialised in
  // `rendered`, so `harvestPartialIds` doesn't see them; pruning would
  // evict their cache + advertised-fp entries, and the next render's
  // fp-skip placeholder would have nothing to substitute — blanking the
  // region until a full re-render restores it ("content behind search
  // disappears"). The streaming-mode path prunes only in its
  // non-pending branch for the same reason; mirror it here and defer
  // the prune to a later commit whose render is whole.
  if (!treeHasPendingLazy(rendered)) {
    const live = new Map<string, Set<string>>()
    harvestPartialIds(rendered, live)
    pruneToLive(live)
  }

  return renderChildren(rendered)
}

function pruneToLive(live: Map<string, Set<string>>): void {
  for (const map of [_currentPagePartials, _currentPageFingerprints]) {
    for (const [id, byMatchKey] of map) {
      const liveMks = live.get(id)
      if (!liveMks) {
        map.delete(id)
        continue
      }
      for (const mk of [...byMatchKey.keys()]) {
        if (!liveMks.has(mk)) byMatchKey.delete(mk)
      }
      if (byMatchKey.size === 0) map.delete(id)
    }
  }
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
