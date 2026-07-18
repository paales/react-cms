/**
 * NotFoundFallback — fires when no other spec's `match` matched the
 * request URL.
 *
 * The framework collects every URLPattern any spec is constructed
 * with into a registered-patterns list. This spec's `vary` iterates
 * that list; if any pattern matches the URL, vary returns `null` and
 * nothing renders. If nothing matches, the render path throws
 * `notFound()` — `Root` catches it, sets HTTP 404, and emits the
 * default `<NotFoundPage>`.
 *
 * Place a single `<NotFoundFallback />` alongside the
 * other page wrappers; the gating is automatic.
 */

import { parton, getRegisteredMatchPatterns, getCurrentParton, notFound } from "@parton/framework"

export const NotFoundFallback = parton(function NotFoundFallbackRender() {
  // Non-addressable 404 gate: if any registered pattern matches the
  // current URL, render nothing; otherwise throw notFound(). It gates
  // rather than varying by a tracked dimension, so it re-evaluates on
  // every render (every page render runs it) — no dep to record.
  const url = getCurrentParton()?.request.url
  if (url) {
    for (const pattern of getRegisteredMatchPatterns()) {
      if (pattern.test(url)) return null
    }
  }
  notFound()
  return null
})
