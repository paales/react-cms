/**
 * Server-side navigation handle.
 *
 * Symmetric to the client's `useNavigation()` / `getNavigation()` but
 * runs inside a request context. Two operations:
 *
 *   - `.reload({selector})` — server-side equivalent of the client's
 *     targeted refetch. Queues a bump into the invalidation registry
 *     so partials carrying the selector's labels re-render with a new
 *     fingerprint on the next render.
 *
 *   - `.navigate(url, options)` — push a URL change. For the window
 *     scope, this mutates the server's request URL (next segment's
 *     vary reads the new URL) AND queues a `url`-tagged trailer entry
 *     so the client applies the same URL update to the browser URL
 *     bar via the Navigation API.
 *
 * Scope parameter:
 *
 *   undefined / null  — window-scoped (the page URL)
 *   "frame-name"      — the named frame's URL (writes to session
 *                       frame state + queues a frames update to the
 *                       client). NOT yet wired — falls back to window
 *                       scope for now.
 *
 *   // In a server action
 *   await cart.addItem(...)
 *   getServerNavigation().reload({ selector: "cart" })
 *
 *   // From a server-side stream producer
 *   getServerNavigation().navigate(`?cursor=${n+1}`, { history: "replace" })
 */

import { _mergeUrlUpdate, getRequest, setRequest } from "./context.ts"
import { refreshSelector } from "./invalidation-registry.ts"

export interface ServerNavigateOptions {
  history?: "push" | "replace"
}

export interface ServerNavigation {
  /** Queue a refresh of partials matching the selector. */
  reload(options: { selector: string | string[] }): void

  /** Push a URL change. Window-scoped (no `scope` argument): mutates
   *  the request URL so subsequent renders in this connection read
   *  the new URL, and queues a `url`-tagged trailer entry for the
   *  client. Default `history: "replace"` — same-URL refresh and
   *  cursor-style state updates shouldn't pollute the back stack;
   *  explicit `"push"` opts in to a new history entry. */
  navigate(target: string | URL, options?: ServerNavigateOptions): void
}

/**
 * Return a server-side navigation handle. `scope` reserves the slot
 * for frame-targeted URL pushes (TODO); today only window scope is
 * wired and the scope argument has no effect.
 */
export function getServerNavigation(scope?: string | null): ServerNavigation {
  void scope
  return {
    reload({ selector }) {
      refreshSelector(selector)
    },
    navigate(target, options) {
      const currentUrl = getRequest().url
      const resolved =
        target instanceof URL ? target.toString() : new URL(String(target), currentUrl).toString()
      // Mutate the request URL so subsequent renders in this
      // connection see the new URL. Header preservation keeps cookies
      // and session attribution intact.
      setRequest(new Request(resolved, { headers: getRequest().headers }))
      // Queue the client-side push. Merge with any prior queued
      // update from this segment — last write wins on `history`.
      _mergeUrlUpdate({ window: resolved, history: options?.history ?? "replace" })
    },
  }
}
