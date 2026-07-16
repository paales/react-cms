/**
 * Client-side trailer application for the segmented-Flight wire format.
 *
 * Pairs with `lib/fp-trailer-split.ts` — the splitter exposes each
 * segment's trailers as a `Map<tag, body bytes>`, this helper turns
 * that map into the corresponding client-side side effects:
 *
 *   - `fp` trailer: drift between cold-render fp and warm-emit fp.
 *     Updates the client-side fingerprint registry via
 *     `_applyFpUpdates` so the next cached manifest reflects the actual
 *     bytes the client now has.
 *
 *   - `url` trailer: server-pushed URL update from
 *     `getServerNavigation().navigate(...)`. Applied via
 *     `_windowNav().navigate(url, { silent: true })` — the framework's
 *     window-scoped imperative navigation handle. The `silent: true`
 *     option signals the page-level navigate listener to update the
 *     URL bar (and the navigation entry) WITHOUT firing a refetch.
 *     A bare `history.{push,replace}State` would fire a `navigate`
 *     event the page-level listener can't distinguish from a
 *     user-initiated nav, and the listener would respond with a fresh
 *     full-route GET — redundant since the rendered content already
 *     arrived in the action response.
 *
 *     A server push is a SUGGESTION, gated on the client's own URL
 *     timeline — client-wins-at-higher-envelope-seq: it applies only
 *     when the client hasn't navigated past the state the push was
 *     rendered as-of (`opts.urlAsOf` — the delivery's wire as-of on
 *     the live stream, the issue-time navigation point for a discrete
 *     response; see `_serverUrlPushApplies` in `channel-client.ts`).
 *     The client's statement about its own URL is authoritative.
 *
 *     There is no `window.history.*State` fallback. The framework
 *     requires the Navigation API; environments without `navigation`
 *     aren't supported. (Modern browser baseline; Safari 16.4+.)
 *
 * Unknown tags are ignored — forward-compatible with future trailer
 * types. Parse errors swallow silently; a corrupted trailer should
 * not break the rendered payload that already committed.
 */

import { _serverUrlPushApplies } from "./channel-client.ts"
import { _windowNav } from "./frame-client.tsx"
import { _applyFpUpdates } from "./partial-client.tsx"
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts"

interface UrlUpdate {
  window?: string
  history?: "push" | "replace"
}

export function applyStandardTrailers(
  trailers: Map<string, Uint8Array>,
  opts?: { urlAsOf?: number },
): void {
  const decoder = new TextDecoder()

  const fpBytes = trailers.get("fp")
  if (fpBytes) {
    try {
      const updates = JSON.parse(decoder.decode(fpBytes)) as FpUpdatesPayload
      _applyFpUpdates(updates)
    } catch {}
  }

  const urlBytes = trailers.get("url")
  if (urlBytes && _serverUrlPushApplies(opts?.urlAsOf)) {
    try {
      const update = JSON.parse(decoder.decode(urlBytes)) as UrlUpdate
      if (update.window) {
        _windowNav().navigate(update.window, {
          history: update.history === "push" ? "push" : "replace",
          silent: true,
        })
      }
    } catch {}
  }
}
