/**
 * Server-hooks — free functions a parton's `schema` or `Render` calls
 * to read a request dimension AND record the dependency, so it folds
 * into the fingerprint: `cookie("cart_id")` returns the value and
 * records `"cookie:cart_id"`, so a change to that cookie moves the
 * parton's fp on the next navigation. The read IS the dependency,
 * exactly like a cell.
 *
 * The recording rides the parton self-context ([[current-parton]]); the
 * value is read from the parton's frame-resolved request, so a framed
 * spec tracks its frame's URL/cookies. Reads outside a
 * parton body are a no-op that returns the empty value.
 *
 * Timing: a tracked read in `Render` is recorded during the render, but
 * the fingerprint is computed BEFORE the render — so the fold uses the
 * PRIOR render's recorded keys, re-read at the current request
 * (store-and-reread, see `evalDepKeys`). The first render of a variant
 * has no prior record and folds nothing; it's cold (no fp-skip relies on
 * it), and the record it captures makes every subsequent render
 * fp-accurate. See `docs/reference/partial.md`.
 */

import { getCurrentParton, type VisibleOptions } from "./current-parton.ts"
import { _getConnectionVisibleSet, parseCookies } from "../runtime/context.ts"
import { getSessionId } from "../runtime/session.ts"
import { parseSelector, queryMatchingTs } from "../runtime/invalidation-registry.ts"
import { buildTimeScope, type TimeScope } from "./time.ts"
import type { ParseRoute } from "./partial.tsx"

type Prettify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Declare a freshness boundary for this render: after `at`
 * (epoch ms), this parton's output is no longer fresh. Two consumers:
 * the live segment driver arms its expiry timer on the earliest
 * boundary across the route's snapshots (so a live connection wakes
 * and re-renders this parton on time), and fp-skip declines to serve
 * a snapshot past its boundary. A wake hint, never an fp dependency —
 * reading the clock is not a dependency; only the declared boundary
 * matters. Multiple calls keep the EARLIEST boundary. Callable
 * anywhere in schema or Render (the boundary carries a live box, so
 * post-await calls land before the driver consults the snapshot).
 *
 *     expires(time().nextSecond)   // live ticker
 *     expires(time().in(60_000))   // one-minute TTL
 */
export function expires(at: number): void {
  const cp = getCurrentParton()
  if (!cp) return
  const h = cp.wakeHints
  h.expiresAt = h.expiresAt === undefined ? at : Math.min(h.expiresAt, at)
}

/**
 * Declare a stale-while-revalidate boundary: between `expires()` and
 * `at`, cached output may be served stale while a refresh runs.
 * Multiple calls keep the earliest boundary. See `expires()`.
 */
export function staleUntil(at: number): void {
  const cp = getCurrentParton()
  if (!cp) return
  const h = cp.wakeHints
  h.staleUntil = h.staleUntil === undefined ? at : Math.min(h.staleUntil, at)
}

/**
 * The render clock — quantized timestamps for deriving wake
 * boundaries without calling `Date.now()` math inline:
 * `expires(time().nextSecond)`, `expires(time().in(5_000))`. Reading
 * the clock records nothing; it is not a dependency.
 */
export function time(): TimeScope {
  return buildTimeScope()
}

/** Read a cookie and record it as an fp dependency. */
export function cookie(name: string): string | undefined {
  const cp = getCurrentParton()
  if (!cp) return undefined
  cp.deps.add(`cookie:${name}`)
  return parseCookies(cp.request)[name]
}

/**
 * Read a URL search param and record it as an fp dependency. The
 * two-argument form supplies a default for an ABSENT param, so the
 * ubiquitous read-with-default is a default, not a null-dance:
 * `searchParam("q", "")`. A present-but-empty param (`?q=`) still
 * returns `""` — absence is a value, and the fp folds the two
 * distinctly either way.
 */
export function searchParam(name: string): string | null
export function searchParam(name: string, fallback: string): string
export function searchParam(name: string, fallback?: string): string | null {
  const cp = getCurrentParton()
  if (!cp) return fallback ?? null
  cp.deps.add(`search:${name}`)
  return new URL(cp.request.url).searchParams.get(name) ?? fallback ?? null
}

/**
 * Read a request header and record it as an fp dependency. Names are
 * lowercased per HTTP semantics (`header("Accept-Language")` and
 * `header("accept-language")` are the same read and the same dep key).
 * Framework-internal `x-parton-*` headers are invisible here — they
 * never reach a spec's dependency surface, so the read returns
 * `undefined` and records nothing.
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
 * so the parton re-renders when the session changes. The value is
 * the `__frame_sid`-cookie-backed id, or `""` for an anon request with no
 * session yet. Pair with a cell's `partition: ({session}) => ({sid})` to give
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
 * `undefined` is GLOBAL — it means the connection carries no visible set
 * at all, not that this one parton is unmeasured. Once the client
 * reports one, every parton is in (`true`) or out (`false`); the
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

/** Resolve a parton's visibility from the connection's current visible
 *  set. Two carriers, one precedence order: a live connection's session
 *  set first (seeded from the `?live=1` request's `?visible=` param and
 *  updated by visibility-report POSTs — see
 *  `../runtime/context.ts::_getConnectionVisibleSet`), then the
 *  request's own `?visible=<id>,…` param (one-shot culling reloads, the
 *  no-connection fallback). Absent from both → `undefined` (cold /
 *  pre-measurement). Shared by the `visible()` hook, `evalDepKeys`'
 *  store-and-reread, AND the spec wrapper's culled-state derivation
 *  (partial.tsx) so no consumer of the visibility signal can drift:
 *  every one reads the connection's CURRENT set at its own evaluation
 *  time. */
export function readVisible(search: URLSearchParams, id: string): boolean | undefined {
  const connectionSet = _getConnectionVisibleSet()
  if (connectionSet !== null) return connectionSet.has(id)
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
 * A string pattern types its params like the `match` OPTION does
 * (`ParseRoute`), so inline reads are fully typed:
 *
 *     const { slug } = match("/p/:slug") ?? {}   // slug: string
 *
 * A `URLPatternInit` pattern (for hash/port/hostname dimensions)
 * returns an untyped param record.
 */
export function match<P extends string>(pattern: P): Prettify<ParseRoute<P>> | null
export function match(pattern: URLPatternInit): Record<string, string> | null
export function match(pattern: string | URLPatternInit): Record<string, string> | null {
  const cp = getCurrentParton()
  if (!cp) return null
  cp.deps.add(`match:${typeof pattern === "string" ? pattern : JSON.stringify(pattern)}`)
  const result = compilePattern(pattern).exec(cp.request.url)
  return result ? namedGroups(result) : null
}

/** Evaluators for dep kinds owned by OTHER layers (the CMS layer's
 *  `cms:<contentKey>` content-hash kind, an app's file-mtime kind).
 *  Registered at module scope by the owning layer, so `evalDepKeys`
 *  stays import-cycle-free. */
const depKindEvaluators = new Map<
  string,
  (name: string, request: Request) => string | null | undefined
>()

/**
 * Register a custom dependency kind — the extension point for external
 * re-readable dependencies the built-in hooks don't cover (a CMS row's
 * content hash, a file's mtime). `evaluate` must be a pure sync read of
 * `(name, request)` whose string encoding is injective over its
 * observable value space; every fingerprint fold re-reads it
 * (store-and-reread), so a changed value moves the fp like any tracked
 * read.
 *
 * Returns the kind's tracked-read hook: calling it inside a parton body
 * records `<kind>:<name>` on the dep set and returns the evaluated
 * value — the same read-IS-the-dependency shape as `cookie()`.
 *
 *     const docMtime = registerDepKind("docmtime", (abs) =>
 *       String(statSync(abs).mtimeMs))
 *     // in a Render:
 *     docMtime(resolved.abs)
 */
export function registerDepKind(
  kind: string,
  evaluate: (name: string, request: Request) => string | null | undefined,
): (name: string) => string | null | undefined {
  depKindEvaluators.set(kind, evaluate)
  return (name: string) => {
    const cp = getCurrentParton()
    if (!cp) return undefined
    cp.deps.add(`${kind}:${name}`)
    return evaluate(name, cp.request)
  }
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
    } else if (kind === "tag") {
      // A render-body `tag()` folds as its matching invalidation
      // timestamp — same "fold the tag, not the value" rule as cells: a
      // `refreshSelector(name)` bumps the ts, the fp shifts, the parton
      // re-renders on the next pass. `name` may carry `?k=v` constraints.
      const sel = parseSelector(name)
      value = String(queryMatchingTs([sel.name], sel.constraints))
    } else if (kind === "cell") {
      // An inline cell folds as its invalidation timestamp, not its
      // value: a write fires `reload(cell:<id>?<partition>)`, bumping the
      // ts so the parton re-renders next nav. The value isn't re-derivable
      // later (it's loaded), so the tag drives freshness — see
      // "fold the tag, not the value" (docs/reference/cells.md). `key` is
      // the partition-scoped selector; parse it and query with the
      // partition so a partition-scoped bump is matched, not only a bare
      // one.
      const sel = parseSelector(key)
      value = String(queryMatchingTs([sel.name], sel.constraints))
    } else if (kind === "visible") {
      // `name` is the parton's own id. Re-read the connection's current
      // visible set (store-and-reread; session-first, `?visible=` URL
      // fallback): in → "1", out → "0", absent (cold) → "u". Three
      // distinct strings so entering view, leaving view, and the first
      // client report each move the fp.
      const v = readVisible(url.searchParams, name)
      value = v === undefined ? "u" : v ? "1" : "0"
    } else {
      const custom = depKindEvaluators.get(kind)
      value = custom ? custom(name, request) : undefined
    }
    // Absence is a VALUE: `?search=` (empty string, dialog open) and no
    // `?search` at all (dialog closed) must fold differently — the hooks
    // return `""` vs `null` and Renders branch on it. Encode absent as
    // the bare key (no `=`), which no present value can collide with.
    parts.push(value == null ? key : `${key}=${value}`)
  }
  return `|deps=${parts.join("&")}`
}
