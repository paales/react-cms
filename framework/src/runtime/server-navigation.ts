/**
 * Server-side navigation handle.
 *
 * Symmetric to the client's `useNavigation()` / `getNavigation()` but
 * runs inside a request context. Today the only operation supported is
 * `.reload({selector})` — server-side equivalent of the client's
 * targeted refetch primitive, which queues a bump into the
 * invalidation registry so partials carrying the selector's labels
 * re-render with a new fingerprint.
 *
 *   // In a server action
 *   await cart.addItem(...)
 *   getServerNavigation().reload({ selector: "cart" })
 *
 *   // Targeted invalidation by vary key
 *   getServerNavigation().reload({ selector: "cart?cart_id=1234" })
 *
 * URL push (`getServerNavigation(frame).navigate(url, options)`) is
 * the planned shape for advancing a frame's URL from server-side
 * tasks (e.g. an LLM stream advancing a chat's `?cursor=` between
 * segments). It will land alongside the segment-loop driver — until
 * then, only `.reload` is wired.
 *
 * Scope parameter accepts:
 *   undefined / null  — window-scoped (the page URL)
 *   "frame-name"      — the named frame's URL
 *   "@self"           — the enclosing frame, resolved from the partial
 *                       context at call time (server actions running
 *                       outside a partial render get an error here)
 *
 * For now, only window-scoped reload is meaningful; the scope is
 * accepted so call sites can be written against the final shape.
 */

import { refreshSelector } from "./invalidation-registry.ts"

export interface ServerNavigation {
  /** Queue a refresh of partials matching the selector. Equivalent to
   *  the client-side `reload({selector})` but driven from the server
   *  side. Inside `runInvalidationTransaction(fn)` (server-action
   *  scope), the bump waits until `fn` resolves; outside it applies
   *  immediately.
   *
   *  Selector accepts the same vocabulary as a spec's `selector`
   *  field — plain names, optional `?key=val&…` constraints, an
   *  array of tokens, or a whitespace string. */
  reload(options: { selector: string | string[] }): void
}

/**
 * Return a server-side navigation handle. `scope` is reserved for
 * future frame/window targeting on URL push; today it has no effect
 * on `.reload`, which is registry-global.
 */
export function getServerNavigation(scope?: string | null): ServerNavigation {
  // `scope` is currently a no-op for reload (the registry is global)
  // and exists in the signature so call sites stay forward-compatible
  // with the segment-loop URL-push surface. Suppress unused-var lint
  // until that surface lands.
  void scope
  return {
    reload({ selector }) {
      refreshSelector(selector)
    },
  }
}
