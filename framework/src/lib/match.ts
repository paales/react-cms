/**
 * The parton match gate — a declarative pattern over the REQUEST.
 *
 * `match` decides WHICH instance renders: variant identity (named
 * params → matchKey), route buckets (the URL-pattern half feeds
 * `computeRouteKey`), and existence (a miss parks the client's cached
 * variants). The gate surface is the whole request, not just the URL:
 * URL components take URLPattern strings or per-value predicates, and
 * `searchParams` / `cookies` / `headers` gate on individual values —
 * order-independent, unlike a raw URLPattern `search` string.
 *
 * Predicates are the gate itself — primary, not a shadow of the body's
 * reads — and must be PURE and SYNC: the framework re-runs them outside
 * any render (the descendant fold, route keying, cache-mode refetch
 * reconstruction). They see one value each; a predicate that needs two
 * request dimensions is two fields (fields AND together).
 *
 * Gates read the request AS SENT: the `cookies` fields parse the raw
 * `Cookie` header, deliberately bypassing the same-request `setCookie`
 * overlay that body reads (`cookie()`) see. A gate verdict is therefore
 * a pure function of the incoming request — every re-evaluation during
 * the request's lifetime (render, fold, trailer) agrees by
 * construction. A mid-request cookie write re-gates on the NEXT
 * request, while the body's reads see it immediately: the gate is who
 * you were when you asked; the content is who you are now.
 *
 * Named params come only from URLPattern STRING components — a
 * predicate can gate but not name (there is no capture group to
 * extract), so `ParseRoute` typing and matchKey identity flow from the
 * string half untouched.
 */

export type FieldTest = string | ((value: string) => boolean)
export type ValueTest = string | ((value: string | null) => boolean)

export interface MatchInit {
  protocol?: FieldTest
  username?: string
  password?: string
  hostname?: FieldTest
  port?: FieldTest
  pathname?: FieldTest
  /** Raw URLPattern search-string pattern. Order-sensitive (it matches
   *  the literal search string) — prefer `searchParams` for individual
   *  params; this exists for full-string patterns like `"*q=:query"`
   *  where the capture group matters. */
  search?: string
  hash?: FieldTest
  baseURL?: string
  /** Per-param gates, order-independent. A predicate receives the
   *  param's first value, or `null` when the param is absent — absence
   *  is a value (`?q=` is `""`, no `?q` at all is `null`). */
  searchParams?: Record<string, ValueTest>
  /** Per-cookie gates against the request's ORIGINAL `Cookie` header
   *  (the same-request `setCookie` overlay is body-read territory). */
  cookies?: Record<string, ValueTest>
  /** Per-header gates. Names are lowercased per HTTP semantics;
   *  framework-internal `x-parton-*` headers are invisible (`null`). */
  headers?: Record<string, ValueTest>
}

export type MatchPattern = string | MatchInit

/** A match verdict: whether the gate passed, and the named params the
 *  URL-pattern half captured (empty when only predicates gated). */
export interface MatchVerdict {
  matched: boolean
  params: Record<string, string>
}

/**
 * A spec's compiled match gate. `urlPattern` is the URLPattern built
 * from the string components (or `null` when every component is a
 * predicate / only request-record fields are present) — it is what
 * feeds route keying, the 404 helper, and param extraction. `evaluate`
 * is the full gate.
 */
export interface CompiledMatch {
  readonly urlPattern: URLPattern | null
  /** Stable identity for HMR dedup + routeKey hashing. String
   *  components verbatim; predicates by source text. */
  readonly signature: string
  evaluate(request: Request): MatchVerdict
  /** Named-param extraction only (no predicate evaluation) — for
   *  ancestor walks that need a variant identity without gating. */
  extractParams(url: string): Record<string, string> | null
}

/** Search params the framework mints for transport — refetch targeting
 *  (`partials`), the client cache manifest (`cached`), live holds
 *  (`live`), commit mode
 *  (`streaming`), the viewport-visibility set (`visible` — read by the
 *  `cull` gate, a tracked dependency, never a match dimension), the
 *  culling-flip stamp (`__cullFlip`), and frame routing (`__frame`,
 *  `__frameUrl`). The catch-up anchor rides the attach POST's body
 *  statement — no URL param exists for it. Match never sees these:
 *  the SAME page arrives with
 *  and without them (SSR vs targeted refetch vs live heartbeat), and
 *  a wildcard search capture (`"*q=:query"`) would otherwise swallow
 *  them into the named param — splitting variant identity by
 *  transport noise, so a heartbeat render mints a phantom variant
 *  that supersedes (and hides) the real one on the client. */
export const TRANSPORT_PARAMS = [
  "partials",
  "cached",
  "live",
  "streaming",
  "visible",
  "__frame",
  "__frameUrl",
  "__cullFlip",
] as const

/** The request URL as the app sees it — transport params stripped. */
function appUrl(url: string): URL {
  const u = new URL(url)
  for (const p of TRANSPORT_PARAMS) u.searchParams.delete(p)
  return u
}

const URL_FIELDS = ["protocol", "hostname", "port", "pathname", "hash"] as const
type UrlField = (typeof URL_FIELDS)[number]

/** URL accessor per field — predicate input for URL components. */
const FIELD_VALUE: Record<UrlField, (url: URL) => string> = {
  protocol: (u) => u.protocol.replace(/:$/, ""),
  hostname: (u) => u.hostname,
  port: (u) => u.port,
  pathname: (u) => u.pathname,
  hash: (u) => u.hash.replace(/^#/, ""),
}

/** Parse the raw `Cookie` header — deliberately NOT `parseCookies`
 *  (which applies the same-request `setCookie` overlay; gates must see
 *  the request as sent). */
function parseRawCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie")
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

function extractNamedGroups(result: URLPatternResult): Record<string, string> {
  const groups = { ...result.pathname.groups, ...result.search.groups }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(groups)) {
    if (typeof v !== "string") continue
    if (/^\d+$/.test(k)) continue
    out[k] = v
  }
  return out
}

function testValue(test: ValueTest, value: string | null): boolean {
  if (typeof test === "function") return test(value)
  return value === test
}

const NO_MATCH: MatchVerdict = { matched: false, params: {} }

/**
 * Compile a `MatchPattern` into the gate the wrapper (and every
 * outside-the-render re-evaluation) runs. String semantics are strict
 * URLPattern: `match: "/inspect/*"` matches `/inspect/…` and NOT bare
 * `/inspect` — authors who want both write `"/inspect{/*}?"`.
 */
export function compileMatch(pattern: MatchPattern): CompiledMatch {
  const init: MatchInit = typeof pattern === "string" ? { pathname: pattern } : pattern

  // Split URL components into the URLPattern half (strings) and the
  // predicate half (functions).
  const urlPatternInit: Record<string, string> = {}
  const urlPredicates: Array<{ field: UrlField; test: (v: string) => boolean }> = []
  for (const field of URL_FIELDS) {
    const t = init[field]
    if (t === undefined) continue
    if (typeof t === "function") urlPredicates.push({ field, test: t })
    else urlPatternInit[field] = t
  }
  if (init.search !== undefined) urlPatternInit.search = init.search
  if (init.username !== undefined) urlPatternInit.username = init.username
  if (init.password !== undefined) urlPatternInit.password = init.password
  if (init.baseURL !== undefined) urlPatternInit.baseURL = init.baseURL

  const urlPattern =
    Object.keys(urlPatternInit).length > 0 ? new URLPattern(urlPatternInit) : null

  const searchParams = init.searchParams
  const cookies = init.cookies
  const headers = init.headers

  const signatureParts: string[] = []
  for (const field of URL_FIELDS) {
    const t = init[field]
    if (t === undefined) continue
    signatureParts.push(`${field}=${typeof t === "function" ? `fn:${t.toString()}` : t}`)
  }
  if (init.search !== undefined) signatureParts.push(`search=${init.search}`)
  for (const [label, record] of [
    ["searchParams", searchParams],
    ["cookies", cookies],
    ["headers", headers],
  ] as const) {
    if (!record) continue
    for (const key of Object.keys(record).sort()) {
      const t = record[key]
      signatureParts.push(
        `${label}.${key}=${typeof t === "function" ? `fn:${t.toString()}` : t}`,
      )
    }
  }

  return {
    urlPattern,
    signature: signatureParts.join(" "),
    evaluate(request: Request): MatchVerdict {
      const url = appUrl(request.url)
      let params: Record<string, string> = {}
      if (urlPattern) {
        const result = urlPattern.exec(url.href)
        if (result === null) return NO_MATCH
        params = extractNamedGroups(result)
      }
      for (const { field, test } of urlPredicates) {
        if (!test(FIELD_VALUE[field](url))) return NO_MATCH
      }
      if (searchParams) {
        for (const [name, test] of Object.entries(searchParams)) {
          if (!testValue(test, url.searchParams.get(name))) return NO_MATCH
        }
      }
      if (cookies) {
        const raw = parseRawCookies(request)
        for (const [name, test] of Object.entries(cookies)) {
          if (!testValue(test, raw[name] ?? null)) return NO_MATCH
        }
      }
      if (headers) {
        for (const [name, test] of Object.entries(headers)) {
          const lower = name.toLowerCase()
          const value = lower.startsWith("x-parton-")
            ? null
            : request.headers.get(lower)
          if (!testValue(test, value)) return NO_MATCH
        }
      }
      return { matched: true, params }
    },
    extractParams(url: string): Record<string, string> | null {
      if (!urlPattern) return {}
      const result = urlPattern.exec(appUrl(url).href)
      return result === null ? null : extractNamedGroups(result)
    },
  }
}
