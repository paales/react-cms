"use client"

// `"use client"` modules import framework client symbols from the
// client barrel, never through the server barrel.
import { usePartonStale } from "@parton/framework/client"

/**
 * The flaky district's staleness indicator. Renders nothing while the
 * chunk's content is authoritative; lights up when the framework
 * served last-known-good bytes in place of a failed render — read off
 * the explicit `usePartonStale()` marker the stale replay carries
 * (`docs/reference/errors.md`), never inferred from content age.
 *
 * Mounted inside the chunk body, so it rides the CACHED bytes: the
 * same element renders hidden in a fresh emission and visible when
 * those bytes are replayed under the stale provider.
 */
export function StaleBadge() {
  const stale = usePartonStale()
  if (!stale) return null
  return (
    <span
      className="chunk__stale"
      data-stale={stale.attempts}
      title={
        `serving last-known-good since ${new Date(stale.since).toLocaleTimeString()} — ` +
        `attempt ${stale.attempts}, next retry ${new Date(stale.retryAt).toLocaleTimeString()}`
      }
    >
      STALE
    </span>
  )
}
