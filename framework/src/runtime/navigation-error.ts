/**
 * Navigation error surface.
 *
 * `NavigationError` is the typed error every targeted refetch /
 * navigation rejection settles to. It distinguishes the three real
 * failure modes the host's browser can encounter when re-fetching an
 * RSC payload:
 *
 *   - `network` — fetch threw (offline, DNS failure, CORS, the host
 *     server is down).
 *   - `http`    — fetch returned but `response.ok` was false; the
 *     `status` field carries the HTTP code.
 *   - `decode`  — body was present but Flight / fp-trailer / snapshot-
 *     trailer parsing failed.
 *
 * `AbortError` (a newer navigation superseded an in-flight one) is
 * deliberately NOT classified here — it's a normal lifecycle signal,
 * not a failure. Callers continue to see the AbortError on a chained
 * `await reload(...)`, but the framework's hook silently clears
 * pending state and skips publishing.
 *
 * The module also owns the global pub/sub used by the
 * `<NavigationErrorBubbler>` component: every per-call hook publishes
 * to `_latest` on failure, and the Bubbler subscribes via
 * `useSyncExternalStore` and re-throws during its next render so the
 * nearest React error boundary catches. This is how navigation
 * failures bubble to UI without each individual call site having to
 * `if (error) throw error` itself.
 */

export type NavigationErrorKind = "network" | "http" | "decode"

export interface NavigationErrorInit {
  readonly kind: NavigationErrorKind
  readonly url: string
  readonly status?: number
  readonly cause?: unknown
  readonly message?: string
  /** The response carried the explicit drain-refusal header
   *  (`x-parton-drain` — the server is deploy-draining and refused a
   *  NEW live attach). The channel's close arbitration retries such a
   *  fire promptly and never counts it toward the degrade bound. Set
   *  only by the attach transports; never inferred from a bare status. */
  readonly drainRefusal?: boolean
}

export class NavigationError extends Error {
  readonly kind: NavigationErrorKind
  readonly url: string
  readonly status?: number
  readonly drainRefusal?: boolean

  constructor(init: NavigationErrorInit) {
    super(init.message ?? defaultMessage(init.kind, init.url, init.status), {
      cause: init.cause,
    })
    this.name = "NavigationError"
    this.kind = init.kind
    this.url = init.url
    this.status = init.status
    if (init.drainRefusal === true) this.drainRefusal = true
  }
}

function defaultMessage(
  kind: NavigationErrorKind,
  url: string,
  status: number | undefined,
): string {
  if (kind === "network") return `Navigation failed: network unreachable (${url})`
  if (kind === "http") return `Navigation failed: HTTP ${status ?? "?"} (${url})`
  return `Navigation failed: decode error (${url})`
}

/**
 * Classify an unknown thrown value into a `NavigationError`. The
 * heuristics:
 *
 *   - Already a `NavigationError`: returned as-is.
 *   - `TypeError`: treated as a network failure. Browsers throw
 *     `TypeError("Failed to fetch")` / `NetworkError` etc. from
 *     `fetch()` when the connection can't be made; any TypeError
 *     reaching here is almost certainly that path.
 *   - Other `Error`: treated as a decode failure (Flight / snapshot
 *     trailer parsing usually surface as plain errors with the
 *     library's own messages).
 *   - Anything else: wrapped as a decode failure with no specific
 *     message.
 */
export function toNavigationError(err: unknown, url: string): NavigationError {
  if (err instanceof NavigationError) return err
  if (err instanceof TypeError) {
    return new NavigationError({ kind: "network", url, cause: err, message: err.message })
  }
  if (err instanceof Error) {
    return new NavigationError({ kind: "decode", url, cause: err, message: err.message })
  }
  return new NavigationError({ kind: "decode", url, cause: err })
}

// ─── Global pub/sub for the Bubbler ──────────────────────────────────────

type Listener = () => void
const _listeners = new Set<Listener>()
let _latest: NavigationError | null = null

/** @internal — publish a navigation error to all subscribers. */
export function _publishNavigationError(err: NavigationError): void {
  _latest = err
  for (const l of _listeners) l()
}

/** @internal — snapshot for `useSyncExternalStore`. */
export function _getLatestNavigationError(): NavigationError | null {
  return _latest
}

/**
 * @internal — clear the latest error so the Bubbler doesn't re-throw
 * on its next render after the boundary catches.
 */
export function _clearLatestNavigationError(): void {
  _latest = null
}

/** @internal — subscribe for `useSyncExternalStore`. */
export function _subscribeNavigationError(l: Listener): () => void {
  _listeners.add(l)
  return () => {
    _listeners.delete(l)
  }
}
