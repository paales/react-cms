/**
 * Client-side trailer application for the segmented-Flight wire format.
 *
 * Pairs with `lib/fp-trailer-split.ts` — the splitter exposes each
 * segment's trailers as a `Map<tag, body bytes>`, this helper turns
 * that map into the corresponding client-side side effects:
 *
 *   - `fp` trailer: drift between cold-render fp and warm-emit fp.
 *     Updates the client-side fingerprint registry via
 *     `_applyFpUpdates` so the next `?cached=` reflects the actual
 *     bytes the client now has.
 *
 *   - `url` trailer: server-pushed URL update from
 *     `getServerNavigation().navigate(...)`. Applied silently via
 *     `history.{push,replace}State` so the browser URL bar reflects
 *     the new state without re-entering the framework's own
 *     navigation handler (which would fire a fresh refetch, redundant
 *     since we already have the rendered content).
 *
 * Unknown tags are ignored — forward-compatible with future trailer
 * types. Parse errors swallow silently; a corrupted trailer should
 * not break the rendered payload that already committed.
 */

import { _applyFpUpdates } from "./partial-client.tsx"

interface UrlUpdate {
  window?: string
  history?: "push" | "replace"
}

export function applyStandardTrailers(trailers: Map<string, Uint8Array>): void {
  const decoder = new TextDecoder()

  const fpBytes = trailers.get("fp")
  if (fpBytes) {
    try {
      const updates = JSON.parse(decoder.decode(fpBytes)) as Record<string, string>
      _applyFpUpdates(updates)
    } catch {}
  }

  const urlBytes = trailers.get("url")
  if (urlBytes) {
    try {
      const update = JSON.parse(decoder.decode(urlBytes)) as UrlUpdate
      if (update.window) {
        const mode = update.history === "push" ? "pushState" : "replaceState"
        window.history[mode]({}, "", update.window)
      }
    } catch {}
  }
}
