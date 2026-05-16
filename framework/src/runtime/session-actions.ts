"use server"

/**
 * Session-write server actions.
 *
 * `setSessionValue(name, value)` writes a per-session value and
 * invalidates every spec whose `vary` recorded a `session.*` read on
 * that name. Client code calls it directly:
 *
 *   import { setSessionValue } from "@react-cms/framework"
 *   <button onClick={() => setSessionValue('palette', 'dark')}>…</button>
 *
 * The implicit dep tracking is symmetric with how the CMS surface
 * works: vary's `session.<type>(name, …)` reads are stamped onto the
 * partial's snapshot at registration time; this action walks the
 * route's snapshots and unions the matching specs into one
 * `{invalidate: {selector}}` directive the framework refetches on
 * the next render.
 */

import { _writeSessionValue } from "./session.ts"
import { getRouteSnapshots } from "../lib/partial-registry.ts"

export async function setSessionValue(
  name: string,
  value: unknown,
): Promise<{ invalidate: { selector: string } }> {
  _writeSessionValue(name, value)

  const snapshots = getRouteSnapshots()
  const ids: string[] = []
  if (snapshots) {
    for (const [id, snap] of snapshots) {
      if (snap.sessionDeps?.includes(name)) ids.push(id)
    }
  }

  // No-op selector when nothing read this key. The framework treats
  // an empty selector as a refetch with no targets — equivalent to a
  // bare invalidation that just commits the session write. The next
  // streaming nav picks the new value up via vary.
  if (ids.length === 0) return { invalidate: { selector: "" } }
  return { invalidate: { selector: ids.join(" ") } }
}
