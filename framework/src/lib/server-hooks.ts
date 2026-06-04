/**
 * Server-hooks — free functions a parton's `Render` calls to read a
 * request dimension AND record the dependency, so it folds into the
 * fingerprint without an explicit `vary`. The auto-tracked replacement
 * for `vary`'s request reads: `cookie("cart_id")` returns the value and
 * records `"cookie:cart_id"`, so a change to that cookie moves the
 * parton's fp on the next navigation.
 *
 * The recording rides the parton self-context ([[current-parton]]); the
 * value is read from the parton's frame-resolved request, so a framed
 * spec tracks its frame's URL/cookies (as `vary` did). Reads outside a
 * parton body are a no-op that returns the empty value.
 *
 * Timing: a tracked read in `Render` is recorded during the render, but
 * the fingerprint is computed BEFORE the render — so the fold uses the
 * PRIOR render's recorded keys, re-read at the current request
 * (store-and-reread, see `evalDepKeys`). The first render of a variant
 * has no prior record and folds nothing; it's cold (no fp-skip relies on
 * it), and the record it captures makes every subsequent render
 * fp-accurate. See `docs/notes/server-hooks.md`.
 */

import { getCurrentParton } from "./current-parton.ts"
import { parseCookies } from "../runtime/context.ts"

/** Read a cookie and record it as an fp dependency. */
export function cookie(name: string): string | undefined {
  const cp = getCurrentParton()
  if (!cp) return undefined
  cp.deps.add(`cookie:${name}`)
  return parseCookies(cp.request)[name]
}

/** Read a URL search param and record it as an fp dependency. */
export function searchParam(name: string): string | null {
  const cp = getCurrentParton()
  if (!cp) return null
  cp.deps.add(`search:${name}`)
  return new URL(cp.request.url).searchParams.get(name)
}

/**
 * Re-evaluate recorded dependency keys against a request, producing a
 * stable `|deps=…` suffix for the fingerprint. The read side of
 * store-and-reread: a parton's (or descendant's) prior-render keys are
 * re-read at the CURRENT request, so a changed cookie / search value
 * shifts the fp. Returns `""` for an empty/absent key set — the additive
 * guarantee that a spec which never calls a tracked hook is unaffected.
 */
export function evalDepKeys(
  keys: ReadonlySet<string> | readonly string[] | undefined,
  request: Request,
): string {
  if (!keys) return ""
  const list = Array.isArray(keys) ? keys : [...keys]
  if (list.length === 0) return ""
  const url = new URL(request.url)
  const cookies = parseCookies(request)
  const parts: string[] = []
  for (const key of [...list].sort()) {
    const colon = key.indexOf(":")
    const kind = key.slice(0, colon)
    const name = key.slice(colon + 1)
    let value: string | null | undefined
    if (kind === "cookie") value = cookies[name]
    else if (kind === "search") value = url.searchParams.get(name)
    else value = undefined
    parts.push(`${key}=${value ?? ""}`)
  }
  return `|deps=${parts.join("&")}`
}
