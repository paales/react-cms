/**
 * Structural template derivation + render for the client partial
 * merge. A template is the page's layout skeleton: DOM wrappers and
 * non-partial elements preserved with stable keys, partial wrappers
 * replaced with `<i data-partial hidden>` placeholders. `PartialsClient`
 * derives one from every full-payload render and persists it (see
 * `partial-client-state.ts`) so cache-mode refetches can re-render the
 * page from template + cache without the server re-shipping layout.
 */

import { Children, cloneElement, isValidElement, type ReactNode } from "react"
import {
  getPartialId,
  getPartialMatchKey,
  getPlaceholderId,
  getPlaceholderMatchKey,
  isPartialWrapper,
  isPlaceholder,
  LAZY_PENDING,
  substituteNested,
  unwrapLazy,
} from "./partial-cache.ts"
import { cacheLookup, type PartialCache } from "./partial-client-state.ts"

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
export function deriveTemplate(node: ReactNode): ReactNode {
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
      <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
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
      <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
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
 * Walk the structural template, filling partial placeholders from cache.
 * Keyless wrappers (main, footer) are preserved; keyed placeholders
 * are replaced with cached partial content (with nested placeholders
 * substituted recursively — see `substituteNested`).
 */
export function renderTemplate(template: ReactNode, cache: PartialCache): ReactNode[] {
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
