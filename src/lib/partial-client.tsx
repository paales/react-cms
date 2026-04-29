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
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react"
import {
  getNavigation,
  type FrameEntryState,
  type FrameNavigationHistoryEntry,
  type FrameworkNavigateOptions,
  type FrameworkNavigation,
  type FrameworkNavigationResult,
  type FrameworkReloadOptions,
  type NavigateTarget,
} from "../framework/navigation-api.ts"

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
 * Collect every partial id reachable inside a node — wrapper OR
 * placeholder. Read-only walk: doesn't mutate `_cache` or
 * `_fingerprints`. Used by the streaming-mode prune to expand `seen`
 * with nested ids that live inside cached wrappers — when the server
 * fp-skips an outer partial, the new tree carries only its top-level
 * placeholder, so the nested ids backing the rendered region (via
 * `substituteNested` walking the cached wrapper) need to be
 * harvested from the cache itself or the prune deletes them out from
 * under the next render.
 */
function harvestPartialIds(node: ReactNode, out: Set<string>): void {
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
    if (id) out.add(id)
    const inner = (node.props as { children?: ReactNode })?.children
    if (inner != null) harvestPartialIds(inner, out)
    return
  }
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    if (id) out.add(id)
    return
  }
  const inner = (node.props as { children?: ReactNode })?.children
  if (inner != null) harvestPartialIds(inner, out)
}

/**
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that partial id.
 */
function substituteNested(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  skipId: string,
): ReactNode {
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    let changed = false
    const mapped = node.map((c) => {
      const s = substituteNested(c, cache, skipId)
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
    return substituteNested(unwrapped as ReactNode, cache, skipId)
  }

  if (!isValidElement(node)) return node

  // Placeholder: substitute from cache. Id comes from the
  // `data-partial-id` prop (stable), not the key (Flight composites).
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
  //
  // Pass `id` as the new skipId so the recursion can't loop on a
  // wrapper that contains a placeholder pointing to itself (which
  // happens any time a fp-skipped partial gets cached).
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    if (id && id !== skipId) {
      const fresh = cache.get(id)
      return fresh ? substituteNested(fresh, cache, id) : node
    }
  }

  // Partial-shape wrapper: if there's a fresh cache entry, use it.
  // If the cache entry is the same wrapper we're looking at (i.e. the
  // wrapper itself wasn't replaced this round), descend INTO its
  // children so any descendant Partial that DID get a fresh cache
  // entry still gets swapped. Without this descent, a refetch
  // targeting a deeply-nested partial (e.g. `#product-card-1` inside
  // a preview frame) lands a fresh entry in the cache for that id,
  // but the surrounding ancestor wrappers (cms-edit-preview, the
  // composed/group containers) keep their old children references —
  // so the new content never reaches the rendered tree.
  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (id && id !== skipId) {
      const fresh = cache.get(id)
      if (fresh && fresh !== node) {
        // Recurse into the substituted wrapper. A cache-mode
        // refetch can produce a wrapper whose children are
        // placeholders or stale nested wrappers — without recursing
        // those inner stale references survive into the rendered
        // tree, leaving partial regions blank. Pass `id` as the new
        // skipId so the recursion can't loop on a wrapper that
        // contains a placeholder pointing to itself.
        return substituteNested(fresh, cache, id)
      }
      // Wrapper unchanged — keep descending so nested partials whose
      // cache entries DID change still get substituted. Lazy-safety:
      // any unresolved Flight lazy hits the `unwrapLazy` branch
      // earlier in this function on its first visit, so by the time
      // we recurse here the wrapper's children are real elements.
    }
  }

  const children = (node.props as any).children
  if (children == null) return node
  const newChildren = substituteNested(children, cache, skipId)
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
function cacheFromStreamingChildren(
  node: ReactNode,
  cache: Map<string, ReactNode>,
  seen?: Set<string>,
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
      seen?.add(id)
      cache.set(id, node)
      // Populate `_fingerprints` synchronously from the tree walk
      // rather than waiting for each `<PartialErrorBoundary>` to
      // commit on the client. The commit order is non-deterministic
      // across transitions (React may defer subtrees such as the
      // `<head>` wrapper), so a targeted refetch fired right after a
      // client nav could otherwise send a `?cached=` that's missing
      // late-committing ids. The wrapper already carries the
      // fingerprint — just lift it off.
      const fp = getPartialFingerprint(node)
      if (fp) _fingerprints.set(id, fp)
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
    // its existing cache entry." Don't overwrite — but DO mark the id
    // as seen so the streaming-mode prune step keeps the cache /
    // fingerprint entries that back this placeholder. Without this,
    // a nested partial whose server confirmed an fp match would be
    // pruned out of `_cache` and the next render's `substituteNested`
    // call would leave the `<i hidden>` placeholder in the DOM —
    // blanking the partial's region until a hard reload.
    const id = getPlaceholderId(node)
    if (id) seen?.add(id)
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
 * This is the client-side replacement for the old server-side
 * `buildTemplate` walk. Running on the client means we see the tree
 * AFTER `<Partial>` bodies have decided fresh-vs-skip, so opaque
 * server components only execute once (via the streamed `children`
 * path). No more "Partial inside an opaque component must be wrapped
 * at the callsite" invariant.
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
    return id ? <i key={id} hidden data-partial data-partial-id={id} /> : node
  }
  if (isPlaceholder(node)) {
    // Already a placeholder (server emitted a fingerprint-match skip);
    // re-emit with a clean key derived from `data-partial-id` to
    // undo any Flight key-composite artifacts (e.g. "page-1,page-1"
    // for .map()-produced placeholders).
    const id = getPlaceholderId(node)
    return id ? <i key={id} hidden data-partial data-partial-id={id} /> : node
  }

  const inner = (node.props as any)?.children
  if (inner == null) return node
  const newInner = deriveTemplate(inner)
  if (newInner === inner) return node
  return Array.isArray(newInner)
    ? cloneElement(node, {}, ...newInner)
    : cloneElement(node, {}, newInner)
}

function renderTemplate(template: ReactNode, cache: Map<string, ReactNode>): ReactNode[] {
  const result: ReactNode[] = []

  Children.forEach(template, (child) => {
    if (!isValidElement(child)) {
      result.push(child)
      return
    }
    if (isPlaceholder(child)) {
      const id = getPlaceholderId(child)
      if (id) {
        const cached = cache.get(id)
        if (cached) result.push(substituteNested(cached, cache, id))
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
const _cache = new Map<string, ReactNode>()
const _fingerprints = new Map<string, string>()

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
 * each `<Partial>`'s fingerprint gets into `_fingerprints` without a
 * server prop round-trip. Later `getCachedPartialIds()` reads from
 * here to tell the server what's already cached.
 */
export function registerClientPartial(id: string, fingerprint: string): void {
  _fingerprints.set(id, fingerprint)
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:fingerprint" pairs so the server can detect shape changes.
 * Used by the browser entry to send ?cached= during navigation.
 *
 * Source of truth is `_fingerprints`, not `_cache`. Every rendered
 * Partial — top-level OR deep (`.map()`-generated, nested inside an
 * ancestor's subtree) — registers its fingerprint client-side as its
 * wrapper mounts via `PartialErrorBoundary`. Reporting from
 * `_fingerprints` means the skip-on-unchanged optimization applies
 * uniformly across the entire tree; deep Partials that live inside
 * an ancestor's `_cache` entry (rather than as a standalone key) are
 * reported correctly. See `docs/partial.md`.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = []
  for (const [id, fp] of _fingerprints) {
    out.push(`${id}:${fp}`)
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

// ─── Selector parsing (client-side, mirrors partial-component.tsx) ───
//
// The server-side parser lives in `partial-component.tsx` and runs on
// `<Partial selector>`. Authors also pass selector strings on
// `reload({ selector })` / `navigate(url, { selector })` — we parse
// them here before splitting into the wire params the server expects.

function parseSelectorClient(input: string | string[] | undefined): {
  uniqueTokens: string[]
  sharedTokens: string[]
} {
  if (input == null) return { uniqueTokens: [], sharedTokens: [] }
  // Mirror the server parser: string form splits on whitespace;
  // array form keeps each element as one token (so values with
  // spaces — SKUs, slugs — survive intact).
  const tokens = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
  const uniqueTokens: string[] = []
  const sharedTokens: string[] = []
  for (const tok of tokens) {
    if (tok.startsWith("#")) {
      const name = tok.slice(1)
      if (name && !uniqueTokens.includes(name)) uniqueTokens.push(name)
    } else if (tok.startsWith(".")) {
      const name = tok.slice(1)
      if (name && !sharedTokens.includes(name)) sharedTokens.push(name)
    } else {
      throw new Error(
        `Unprefixed token "${tok}" in selector. Tokens must start with ` +
          `"#" (unique) or "." (shared). Did you mean "#${tok}" or ".${tok}"?`,
      )
    }
  }
  return { uniqueTokens, sharedTokens }
}

// ─── Microtask-batched targeted-refetch dispatcher ────────────────
//
// Multiple `reload` / `navigate({ selector })` calls in the same tick
// coalesce into one refetch request. Keeps tag-fanout and multi-id
// event handlers cheap: three buttons clicked in the same frame
// produce one request with `?partials=a,b,c`.

interface RefetchBatchEntry {
  /** `#`-token names (sans `#`) — become `?partials=…` on the wire. */
  uniqueTokens: string[]
  /** `.`-token names (sans `.`) — become `?tags=…` on the wire. */
  sharedTokens: string[]
  disableTransition: boolean
  /** Per-id props map merged into the wire as `?partialProps=<JSON>`.
   *  Server reads it in `PartialRoot` and forwards to the spec via
   *  `partialFromSnapshot` so `<WhenStored>` and similar activators
   *  can pass values without writing them into the URL. */
  props?: Record<string, Record<string, unknown>>
}

let _batchRef: RefetchBatchEntry[] = []
let _batchPromise: { promise: Promise<void>; resolve: () => void } | null = null

async function flushRefetchBatch(batch: RefetchBatchEntry[]): Promise<void> {
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (url: string) => Promise<void>
    }
  ).__rsc_partial_refetch
  if (!handler) return

  const uniques = new Set<string>()
  const shareds = new Set<string>()
  const mergedProps: Record<string, Record<string, unknown>> = {}
  let disableTransition = false
  for (const entry of batch) {
    for (const u of entry.uniqueTokens) uniques.add(u)
    for (const s of entry.sharedTokens) shareds.add(s)
    if (entry.disableTransition) disableTransition = true
    if (entry.props) {
      for (const [id, p] of Object.entries(entry.props)) {
        mergedProps[id] = { ...(mergedProps[id] ?? {}), ...p }
      }
    }
  }

  const url = new URL(window.location.href)
  if (uniques.size > 0) url.searchParams.set("partials", [...uniques].join(","))
  if (shareds.size > 0) url.searchParams.set("tags", [...shareds].join(","))
  if (disableTransition) url.searchParams.set("disableTransition", "1")
  if (Object.keys(mergedProps).length > 0) {
    url.searchParams.set("partialProps", JSON.stringify(mergedProps))
  }

  // Send cached fingerprints for the non-target set so the server can
  // skip the unchanged ones via fingerprint-match placeholders. We
  // don't know the server-side effective-id→`#`-token mapping from
  // here (a multi-`#` Partial's effective id is a sorted-join), but
  // the common case is effective id == single `#`-token, so a prefix
  // filter on the effective id works. For the rare multi-`#` case
  // we'd send the fingerprint anyway and the server would match it.
  if (uniques.size > 0) {
    const targetPrefixes = [...uniques].map((u) => `${u}:`)
    const cached = getCachedPartialIds().filter((t) => !targetPrefixes.some((p) => t.startsWith(p)))
    if (cached.length > 0) url.searchParams.set("cached", cached.join(","))
  }

  await handler(url.toString())
}

/**
 * Enqueue a targeted refetch. Multiple calls in the same microtask
 * coalesce into one request. Returns a Promise that resolves when
 * the flush completes.
 */
function enqueueRefetch(entry: RefetchBatchEntry): Promise<void> {
  _batchRef.push(entry)
  if (!_batchPromise) {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    _batchPromise = { promise, resolve }
    queueMicrotask(() => {
      const batch = _batchRef
      const done = _batchPromise!.resolve
      _batchRef = []
      _batchPromise = null
      flushRefetchBatch(batch).then(done)
    })
  }
  return _batchPromise.promise
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
 */
export async function _dispatchFrameRefetch(
  path: readonly string[],
  url: string,
  options?: FrameworkNavigateOptions,
): Promise<void> {
  const key = joinFramePath(path)
  _frameUrls.set(key, url)
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (url: string) => Promise<void>
    }
  ).__rsc_partial_refetch
  if (!handler) return
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
  if (options?.disableTransition) {
    refetchUrl.searchParams.set("disableTransition", "1")
  }
  await handler(refetchUrl.toString())
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

// ─── FrameworkNavigationResult plumbing ───────────────────────────

/**
 * Tighten TS 6's optional `committed` / `finished` by supplying a
 * fallback resolution. Our handle always fills both — so the
 * `NavigationHistoryEntry | null` union collapses to a non-null entry
 * by the time the caller awaits.
 *
 * Fire-and-forget callers (`void nav.navigate(url)`) discard the result
 * without awaiting. If a newer navigation supersedes this one, the
 * browser's `committed` / `finished` promises reject with AbortError —
 * unobserved, that surfaces as an unhandled rejection. Attach a silent
 * sink so awaiters still see the rejection but the fire-and-forget path
 * doesn't pollute the console.
 */
function tightenResult(
  result: NavigationResult,
  fallbackEntry: () => NavigationHistoryEntry,
): FrameworkNavigationResult {
  const committed = result.committed ?? Promise.resolve(fallbackEntry())
  const finished = result.finished ?? Promise.resolve(fallbackEntry())
  sinkAbort(committed)
  sinkAbort(finished)
  return { committed, finished }
}

function sinkAbort(p: Promise<unknown>): void {
  // Silently swallow AbortError so fire-and-forget `void nav.navigate(...)`
  // doesn't surface as an unhandled rejection when a newer navigation
  // supersedes it. Callers who .then/await the same promise still see
  // the rejection — Promise allows multiple subscribers, each receives
  // the settled value independently.
  p.catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return
    // Re-raise anything else so it shows up in the console (matches the
    // default unhandled-rejection behavior for non-AbortErrors).
    console.error(err)
  })
}

/**
 * Synthesize a `FrameworkNavigationResult` when the framework is
 * doing work that the browser `Navigation` object doesn't cover
 * (targeted refetch without a URL change, frame reload). `commit`
 * resolves immediately with the current entry; `finished` resolves
 * after the supplied work completes.
 */
function syntheticResult(nav: Navigation, work: Promise<unknown>): FrameworkNavigationResult {
  const entry = () => {
    const e = nav.currentEntry
    if (!e) throw new Error("navigation has no current entry")
    return e
  }
  const committed = Promise.resolve().then(entry)
  const finished = work.then(entry)
  sinkAbort(committed)
  sinkAbort(finished)
  return { committed, finished }
}

/**
 * Compose a browser `NavigationResult` with extra framework work
 * (refetch dispatch). `committed` passes through; `finished` waits
 * for both the browser commit and the framework work.
 */
function composeResult(
  result: NavigationResult,
  fallbackEntry: () => NavigationHistoryEntry,
  extraWork: () => Promise<unknown>,
): FrameworkNavigationResult {
  const committed = result.committed ?? Promise.resolve(fallbackEntry())
  const baseFinished = result.finished ?? Promise.resolve(fallbackEntry())
  const finished = (async () => {
    const entry = await baseFinished
    await extraWork()
    return entry
  })()
  sinkAbort(committed)
  sinkAbort(finished)
  return { committed, finished }
}

function parseOptionsSelector(
  options: FrameworkNavigateOptions | FrameworkReloadOptions | undefined,
): { uniqueTokens: string[]; sharedTokens: string[] } {
  if (!options?.selector) return { uniqueTokens: [], sharedTokens: [] }
  return parseSelectorClient(options.selector)
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
// undefined. Return a stub that type-checks as `FrameworkNavigation`
// with no-op behavior — any actual invocation only happens on the
// client after hydration.

function nullNavigation(name: string | null): FrameworkNavigation {
  const stubEntry = null as unknown as NavigationHistoryEntry
  const stubResult: FrameworkNavigationResult = {
    committed: Promise.resolve(stubEntry),
    finished: Promise.resolve(stubEntry),
  }
  const stubNavResult = stubResult as unknown as NavigationResult
  return {
    name,
    currentEntry: null,
    canGoBack: false,
    canGoForward: false,
    transition: null,
    activation: null,
    entries: () => [],
    navigate: () => stubResult,
    reload: () => stubResult,
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
  } as unknown as FrameworkNavigation
}

// ─── Handle builders ──────────────────────────────────────────────

/**
 * Window-scoped handle — a Proxy over `window.navigation` with
 * `name: null`, an extended `navigate()` (updater callback, targeted
 * refetch via `selector`, `silent` URL-only updates) and an extended
 * `reload()` (targeted refetch without a URL change). Everything
 * else passes straight through to the browser.
 */
function buildWindowNavigationHandle(): FrameworkNavigation {
  const nav = getNavigation()
  if (!nav) return nullNavigation(null)

  const windowNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): FrameworkNavigationResult => {
    const url = resolveWindowTarget(target)
    const parsed = parseOptionsSelector(options)
    const filtered = parsed.uniqueTokens.length > 0 || parsed.sharedTokens.length > 0
    const silent = options?.silent === true
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
      if (silent) return tightenResult(result, () => nav.currentEntry!)
      return composeResult(
        result,
        () => nav.currentEntry!,
        () =>
          enqueueRefetch({
            uniqueTokens: parsed.uniqueTokens,
            sharedTokens: parsed.sharedTokens,
            disableTransition: options?.disableTransition ?? false,
            props: options?.props,
          }),
      )
    }
    return tightenResult(
      nav.navigate(url, {
        history: options?.history,
        state: options?.state,
        info: options?.info,
      }),
      () => nav.currentEntry!,
    )
  }

  const windowReload = (options?: FrameworkReloadOptions): FrameworkNavigationResult => {
    const parsed = parseOptionsSelector(options)
    if (parsed.uniqueTokens.length > 0 || parsed.sharedTokens.length > 0) {
      return syntheticResult(
        nav,
        enqueueRefetch({
          uniqueTokens: parsed.uniqueTokens,
          sharedTokens: parsed.sharedTokens,
          disableTransition: options?.disableTransition ?? false,
          props: options?.props,
        }),
      )
    }
    return tightenResult(
      nav.reload({ state: options?.state, info: options?.info }),
      () => nav.currentEntry!,
    )
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
  }) as unknown as FrameworkNavigation
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
function buildFrameHandle(path: readonly string[]): FrameworkNavigation {
  const nav = getNavigation()
  const key = joinFramePath(path)
  if (!nav) return nullNavigation(key)
  if (path.length === 0) {
    throw new Error("buildFrameHandle: path must be non-empty")
  }

  const frameNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): FrameworkNavigationResult => {
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

    if (historyMode === "auto") {
      // No new browser entry. updateCurrentEntry patches state in
      // place, fires currententrychange (consumers update) but NOT
      // navigate — no silent-info bypass needed.
      nav.updateCurrentEntry({ state: nextState })
      return syntheticResult(nav, _dispatchFrameRefetch(path, url, options))
    }

    // Explicit push/replace — browser entry grows/replaces. Use the
    // silent-info brand so the page-level listener doesn't also fire
    // a full-page refetch.
    const result = nav.navigate(window.location.href, {
      history: historyMode,
      state: nextState,
      info: makeSilentInfo("frame", key),
    })
    return composeResult(
      result,
      () => nav.currentEntry!,
      () => _dispatchFrameRefetch(path, url, options),
    )
  }

  const frameReload = (options?: FrameworkReloadOptions): FrameworkNavigationResult => {
    const url = _frameUrls.get(key)
    if (!url) return syntheticResult(nav, Promise.resolve())
    return syntheticResult(nav, _dispatchFrameRefetch(path, url, options))
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
      finished: work.then(resolveEntry),
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
  }) as unknown as FrameworkNavigation
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
export function _frame(pathOrName: string | readonly string[]): FrameworkNavigation {
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
export function _windowNav(): FrameworkNavigation {
  return buildWindowNavigationHandle()
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
 * Always returns a handle — never throws. Outside a frame it's a
 * small Proxy over `window.navigation`; inside a frame it's a Proxy
 * with frame-scoped overrides. The same code (a "back" button, a
 * "reload" icon) works at the page level and per-frame.
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
  // Memoize the handle so a consumer effect that depends on it
  // doesn't re-run on every render. The handle's getters read live
  // state, so memoizing doesn't stale the values — and keeping the
  // reference stable means effects whose dep array includes the
  // handle only re-run when the bound name changes, not on every
  // navigation commit. (Pre-memoization, a targeted-refetch activator
  // could fire twice: the first nav's commit would bump React, the
  // handle would become a new object, the effect would re-run and
  // re-register its trigger before the server response had propagated
  // fresh props.)
  return useMemo(
    () =>
      resolvedPath.length > 0 ? buildFrameHandle(resolvedPath) : buildWindowNavigationHandle(),
    // resolvedKey captures any change to the path — resolvedPath is a
    // fresh array each render, so we can't use it as a dep directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedKey],
  )
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
 * Note: activators no longer pass prop overrides to the Partial.
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
  const nav = useNavigation()

  useEffect(() => {
    const cleanup = subscribeRef.current((payload) => {
      if (once && firedRef.current) return
      firedRef.current = true
      // Funnel activator-driven refetches through the same public
      // `nav.reload` surface that `<CacheControls>` etc. use — one
      // path for "refetch this partial with these props", batched
      // by the same microtask coalescer.
      void nav.reload({
        selector: [`#${partialId}`],
        props: payload?.props ? { [partialId]: payload.props } : undefined,
      })
    })
    return () => {
      if (typeof cleanup === "function") cleanup()
    }
  }, [partialId, once, nav])
}

export function PartialsClient({ mode = "cache", children }: PartialsClientProps) {
  const cache = _cache

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
  // Fingerprints land in `_fingerprints` primarily via the synchronous
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
    // Clearing `_fingerprints` up-front (the previous design) wiped
    // skipped partials' fingerprints because the walk only re-sets
    // them for fresh wrappers. Likewise pruning `_cache` against just
    // the top-level placeholders from `deriveTemplate` (which stops
    // at any wrapper, so nested ids are never visited) deleted the
    // cache entries for nested partials whose ancestor was re-rendered
    // fresh but whose own region was fp-skipped — leaving
    // `substituteNested` no entry to fill the placeholder with on the
    // next render.
    const seen = new Set<string>()
    cacheFromStreamingChildren(children, cache, seen)
    const derived = deriveTemplate(children)
    _template = derived

    // Expand `seen` with nested partial ids reachable through cached
    // wrappers. When the server fp-skips an OUTER partial (e.g.
    // `cms-demo-root` unchanged across `/cms-demo/beta` →
    // `/cms-demo/gamma`), the new streamed tree carries only the
    // outer's placeholder. Without this expansion, the prune below
    // would drop every nested partial's cache entry — and the next
    // render's `substituteNested` walk over the cached outer wrapper
    // would find empty placeholders for slug-nav, hero, multi-slot,
    // product-grid, …, blanking those regions.
    //
    // Frontier-style BFS: each newly-discovered id can itself be a
    // wrapper containing more nested partials, so harvest until no
    // new ids appear.
    let frontier: string[] = [...seen]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const id of frontier) {
        const wrapper = cache.get(id)
        if (!wrapper) continue
        const inner = (wrapper as { props?: { children?: ReactNode } }).props?.children
        if (inner == null) continue
        const nested = new Set<string>()
        harvestPartialIds(inner, nested)
        for (const nid of nested) {
          if (!seen.has(nid)) {
            seen.add(nid)
            next.push(nid)
          }
        }
      }
      frontier = next
    }

    // Drop entries from prior routes that don't appear on the new
    // page. `seen` covers fresh wrappers, placeholders from the new
    // tree, AND nested ids harvested from cached wrappers, so any
    // partial still backing the rendered tree survives.
    for (const id of [..._cache.keys()]) {
      if (!seen.has(id)) _cache.delete(id)
    }
    for (const id of [..._fingerprints.keys()]) {
      if (!seen.has(id)) _fingerprints.delete(id)
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
