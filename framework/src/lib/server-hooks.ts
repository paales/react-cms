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

import { getCurrentParton, type VisibleOptions } from "./current-parton.ts"
import { parseCookies } from "../runtime/context.ts"
import { getSessionId } from "../runtime/session.ts"
import { parseSelector, queryMatchingTs } from "../runtime/invalidation-registry.ts"

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
 * Read a request header and record it as an fp dependency. Names are
 * lowercased per HTTP semantics (`header("Accept-Language")` and
 * `header("accept-language")` are the same read and the same dep key).
 * Framework-internal `x-parton-*` headers are invisible here — they
 * never reach a spec's dependency surface (mirroring the `vary`
 * scope's header record), so the read returns `undefined` and records
 * nothing.
 */
export function header(name: string): string | undefined {
  const cp = getCurrentParton()
  if (!cp) return undefined
  const lower = name.toLowerCase()
  if (lower.startsWith("x-parton-")) return undefined
  cp.deps.add(`header:${lower}`)
  return cp.request.headers.get(lower) ?? undefined
}

/**
 * Read the (frame-resolved) request pathname and record it as an fp
 * dependency — the whole-pathname axis for specs that genuinely depend
 * on parts of the path their `match` doesn't name (a wildcard tail, a
 * breadcrumb built from the full path). Prefer `match()` / `param()`
 * when a named segment is enough: a pathname dep moves the fp on EVERY
 * path change, which defeats fp-skip across unrelated navigations.
 */
export function pathname(): string {
  const cp = getCurrentParton()
  if (!cp) return ""
  cp.deps.add("pathname:")
  return new URL(cp.request.url).pathname
}

/**
 * Read a resolved match param (`/pokemon/:id` → `param("id")`). Records
 * NO dependency: match params already fold into the fp via `matchKey`,
 * so reading one is enough — a param change moves the fp through the
 * match identity. `undefined` outside a parton body or for an unmatched
 * name.
 */
export function param(name: string): string | undefined {
  return getCurrentParton()?.params[name]
}

/**
 * Read the current session identity and record it as an fp dependency,
 * so the parton re-renders when the session changes — the inline-tracking
 * analogue of `vary: ({session}) => ({sid: session.id})`. The value is
 * the `__frame_sid`-cookie-backed id, or `""` for an anon request with no
 * session yet. Pair with a cell's `vary: ({session}) => ({sid})` to give
 * each session its own partition.
 */
export function session(): { readonly id: string } {
  const cp = getCurrentParton()
  if (!cp) return { id: "" }
  cp.deps.add("session:")
  return { id: getSessionId() ?? "" }
}

/**
 * Read this parton's view-visibility and record it as an fp dependency —
 * the read-tracked culling signal, the viewport analogue of `cookie()` /
 * `searchParam()`. A parton that calls `visible()` becomes cullable
 * (entering/leaving the viewport moves its fp, so it self-refetches);
 * one that never calls it is invariant to scrolling. The read IS the
 * dependency, exactly like a cell. Tri-state:
 *
 *   - `true`      — the client reported this parton within the viewport
 *     (expanded by the observer's runway margin).
 *   - `false`     — the client reported and it's outside that margin.
 *   - `undefined` — no client report yet: the PRE-MEASUREMENT state
 *     (cold render / SSR / no-JS). Seed the cull decision off the anchor
 *     here, e.g. `const show = visible() ?? nearAnchor(searchParam("page"))`,
 *     so the first paint reserves the right neighborhood.
 *
 * `undefined` is GLOBAL — it means the request carries no `?visible=` at
 * all, not that this one parton is unmeasured. Once the client sends
 * `?visible=`, every parton is in (`true`) or out (`false`); the
 * observer's `rootMargin` is the runway, so "out" is the correct skeleton
 * state for everything past it.
 *
 * `options` configures THIS parton's observation — e.g. `visible({
 * rootMargin: "1000px 0px" })` for an eager runway. It rides to the client
 * boundary's IntersectionObserver; it doesn't affect the fp.
 */
export function visible(options?: VisibleOptions): boolean | undefined {
  const cp = getCurrentParton()
  if (!cp) return undefined
  cp.deps.add(`visible:${cp.id}`)
  if (options) cp.visibleOptions = options
  return readVisible(new URL(cp.request.url).searchParams, cp.id)
}

/** Resolve a parton's visibility from a request's `?visible=<id>,…` set:
 *  absent param → `undefined` (cold / pre-measurement), present →
 *  membership. Shared by the `visible()` hook and `evalDepKeys`'
 *  store-and-reread so the live read and the fp fold can't drift. */
function readVisible(search: URLSearchParams, id: string): boolean | undefined {
  const raw = search.get("visible")
  if (raw === null) return undefined
  return raw.split(",").includes(id)
}

// URLPattern helpers — mirror the parton `match` option's compilation
// (`compileMatchPattern` / `extractNamedParams` in partial.tsx),
// duplicated here to avoid a partial.tsx ↔ server-hooks import cycle.
// Compiled patterns are cached (compilation isn't free and the fold
// re-runs them on every fp).
const _patternCache = new Map<string, URLPattern>()
function compilePattern(pattern: string | URLPatternInit): URLPattern {
  const key = typeof pattern === "string" ? pattern : JSON.stringify(pattern)
  let p = _patternCache.get(key)
  if (!p) {
    p = new URLPattern(typeof pattern === "string" ? { pathname: pattern } : pattern)
    _patternCache.set(key, p)
  }
  return p
}
function namedGroups(result: URLPatternResult): Record<string, string> {
  const groups = { ...result.pathname.groups, ...result.search.groups }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(groups)) {
    if (typeof v === "string" && !/^\d+$/.test(k)) out[k] = v
  }
  return out
}

/**
 * Match the (frame-resolved) request URL against `pattern` — the SAME
 * argument shape the parton `match` option takes (a pathname string or a
 * `URLPatternInit`) — and return its named capture groups, or `null` on
 * no match. Records a dependency keyed by the pattern, so the fp folds
 * only the MATCHED PARAMS, not the whole pathname: the spec varies when
 * its captured segment changes, never on every navigation.
 *
 *     const { slug } = match("/p/:slug") ?? {}
 */
export function match(pattern: string | URLPatternInit): Record<string, string> | null {
  const cp = getCurrentParton()
  if (!cp) return null
  cp.deps.add(`match:${typeof pattern === "string" ? pattern : JSON.stringify(pattern)}`)
  const result = compilePattern(pattern).exec(cp.request.url)
  return result ? namedGroups(result) : null
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
    else if (kind === "header") value = request.headers.get(name)
    else if (kind === "pathname") value = url.pathname
    else if (kind === "match") {
      // `name` is the pattern (string) or its JSON (dict). Re-run it and
      // fold the NAMED params only — so a spec varies when its captured
      // segment changes, not on every pathname.
      const pattern = name.startsWith("{") ? (JSON.parse(name) as URLPatternInit) : name
      const result = compilePattern(pattern).exec(url.href)
      value = result ? JSON.stringify(namedGroups(result)) : "nomatch"
    } else if (kind === "session") {
      value = getSessionId() ?? ""
    } else if (kind === "cell") {
      // An inline cell folds as its invalidation timestamp, not its
      // value: a write fires `reload(cell:<id>?<partition>)`, bumping the
      // ts so the parton re-renders next nav. The value isn't re-derivable
      // later (it's loaded), so the tag drives freshness — see
      // docs/notes/server-hooks.md "fold the tag, not the value". `key` is
      // the partition-scoped selector; parse it and query with the
      // partition so a partition-scoped bump is matched, not only a bare
      // one.
      const sel = parseSelector(key)
      value = String(queryMatchingTs([sel.name], sel.constraints))
    } else if (kind === "visible") {
      // `name` is the parton's own id. Re-read the request's `?visible=`
      // set (store-and-reread): in → "1", out → "0", absent (cold) → "u".
      // Three distinct strings so entering view, leaving view, and the
      // first client report each move the fp.
      const v = readVisible(url.searchParams, name)
      value = v === undefined ? "u" : v ? "1" : "0"
    } else value = undefined
    // Absence is a VALUE: `?search=` (empty string, dialog open) and no
    // `?search` at all (dialog closed) must fold differently — the hooks
    // return `""` vs `null` and Renders branch on it, exactly like a
    // declared vary distinguished `""` from `undefined` via
    // stableStringify. Encode absent as the bare key (no `=`), which no
    // present value can collide with.
    parts.push(value == null ? key : `${key}=${value}`)
  }
  return `|deps=${parts.join("&")}`
}
