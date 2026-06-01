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
 *      and ultimately surface via the control channel regardless.
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

/**
 * True for the "errors" that are normal render lifecycle, not failures
 * worth logging: client disconnects / supersede aborts, and the
 * redirect / not-found control-flow sentinels that ride the render
 * error channel by design (the framework-control channel has already
 * routed the response, so their stack traces are just noise).
 */
export function isExpectedRenderError(error: unknown): boolean {
  if (isFrameworkSentinel(error)) return true
  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "NotFoundError" ||
      error.name === "RedirectError" ||
      error.message === "The render was aborted by the server without a reason."
    )
  }
  return false
}

let renderErrorSeq = 0

/**
 * `onError` body shared by the RSC (`renderToReadableStream`) and SSR
 * (`renderToReadableStream` from react-dom) render streams.
 *
 * In production React strips the message off a render error and ships
 * only a `digest` to the client — the "specific message is omitted in
 * production builds…" error the user sees. This mints that digest
 * server-side, logs it next to the real error + stack, and returns it
 * for React to serialize, so the opaque client digest traces back to a
 * concrete server log line. Returns `undefined` for expected
 * disconnect / control-flow errors (no log, no digest).
 *
 * When an RSC error propagates into the SSR pass it arrives carrying
 * the digest React already assigned; that digest is reused (both
 * phases share one id) and the SSR pass skips re-logging the stack the
 * RSC pass already logged.
 */
export function reportServerRenderError(
  phase: "rsc" | "ssr",
  error: unknown,
): string | undefined {
  if (isExpectedRenderError(error)) return undefined
  // A propagated digest counts only if NON-EMPTY. React stamps some
  // errors with `digest: ""` (empty) before they reach this phase;
  // treating that as "already has a digest" forwarded the empty string
  // AND skipped the re-log — the `digest: ''` with no message. An empty
  // digest is no digest: mint a real one and log.
  const incoming =
    typeof error === "object" && error !== null
      ? (error as { digest?: unknown }).digest
      : undefined
  const propagated = typeof incoming === "string" && incoming.length > 0 ? incoming : undefined
  const digest =
    propagated ?? `render-${Date.now().toString(36)}-${(renderErrorSeq++).toString(36)}`
  if (!(phase === "ssr" && propagated)) {
    console.error(`[${phase}] server render error (digest=${digest}):`, error)
  }
  return digest
}
