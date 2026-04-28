/**
 * Framework control-flow sentinels. Throw from a page component (or
 * an async server component deep in the tree) to signal "this URL is
 * 404" or "this URL should redirect." Two coordinated signals are
 * sent on every call:
 *
 *   1. The framework control channel on the request's ALS store
 *      (`setFrameworkControl`) is mutated so the RSC entry handler
 *      sees the decision after the render completes — used to pick
 *      HTTP status code / `Location` header.
 *   2. The error is thrown so render short-circuits. Root's sync
 *      try/catch handles it for page-level throws; deep async throws
 *      bubble to a Partial error boundary that re-throws the sentinel
 *      (so `errorWith` doesn't swallow it) and ultimately surface via
 *      the control channel regardless.
 *
 *   // /app/pages/product.tsx
 *   async function ProductPage() {
 *     const product = await fetchProduct(getPathname("/p/:slug")?.slug);
 *     if (!product) notFound();
 *     if (product.archivedTo) redirect(`/p/${product.archivedTo}`);
 *     return <Hero product={product} />;
 *   }
 */

import { setFrameworkControl } from "./context.ts"

export class NotFoundError extends Error {
  readonly __framework = "not-found" as const
  constructor(message = "Not Found") {
    super(message)
    this.name = "NotFoundError"
  }
}

export class RedirectError extends Error {
  readonly __framework = "redirect" as const
  readonly url: string
  readonly status: number
  constructor(url: string, status = 302) {
    super(`Redirect to ${url}`)
    this.name = "RedirectError"
    this.url = url
    this.status = status
  }
}

export function notFound(): never {
  // Eagerly flag the control channel so a deep-async throw still
  // reaches the RSC entry even if the error chunks out via Flight
  // instead of bubbling up to Root's sync catch.
  try {
    setFrameworkControl({ notFound: true })
  } catch {
    // Outside a request ALS scope — called from a test, a script,
    // etc. Fall through to the throw; whoever catches it owns the
    // behavior.
  }
  throw new NotFoundError()
}

export function redirect(url: string, status = 302): never {
  try {
    setFrameworkControl({ redirect: { url, status } })
  } catch {
    /* as above */
  }
  throw new RedirectError(url, status)
}

export function isFrameworkSentinel(e: unknown): e is NotFoundError | RedirectError {
  return e instanceof NotFoundError || e instanceof RedirectError
}
