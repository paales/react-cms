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
 * Place a single `<NotFoundFallback parent={ROOT} />` alongside the
 * other page wrappers; the gating is automatic.
 */

import { ReactCms, getRegisteredMatchPatterns } from "@react-cms/framework"
import { notFound } from "@react-cms/framework/framework/errors.ts"

export const NotFoundFallback = ReactCms.partial(
  function NotFoundFallbackRender() {
    notFound()
    return null
  },
  {
    vary: ({ url }) => {
      for (const pattern of getRegisteredMatchPatterns()) {
        if (pattern.test(url.href)) return null
      }
      return {}
    },
  },
)
