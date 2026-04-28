/**
 * Request context for server components and server actions.
 *
 * Uses AsyncLocalStorage to make the incoming request (cookies, headers)
 * available anywhere during a render or action, and to collect
 * Set-Cookie headers for the response.
 *
 * Tracked accessors (`getCookie`, `getHeader`, `getSearchParam`,
 * `getPathname`) additionally push their `(kind, name)` into a
 * per-Partial *access manifest* held in a second ALS slot. A cached
 * Partial uses that manifest as its cache key surface — so the author
 * doesn't have to re-declare which cookies/headers/URL params their
 * content depends on. See `docs/cache.md`.
 *
 * ── Frame scoping (2026-04-21) ─────────────────────────────────────
 * Accessors also consult a per-request **frame cache** — a mutable
 * `{ current: Request | null }` cell created by `React.cache()`,
 * following the pattern of https://github.com/zhangyu1818/react-server-only-context.
 * `<Partial frame="…">`'s `FrameWrapper` mutates the cell before
 * rendering children; accessors read it. The cell is a per-request
 * singleton, so sibling frames mutate sequentially as React walks
 * their subtrees depth-first.
 *
 * Discipline: accessors must be called BEFORE any `await` in a
 * server component body (the same rule as `HoistingViolationError`
 * for cache manifest keys). After an await the cell may have been
 * mutated by a sibling frame.
 *
 * We dropped the Flight render+decode round-trip that previously
 * contained the scope — it killed progressive streaming inside
 * frames, which is load-bearing for slow async content. The cache
 * pattern preserves streaming at the cost of the hoisting
 * discipline (which we already enforce).
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { cache } from "react"
import {
  createCmsScope,
  resolveCmsScope,
  type CmsScope,
  type ContentFieldKind,
  type Reference,
} from "./cms-runtime.ts"
import { capturePartialContext } from "../lib/partial-context.ts"

interface FrameworkControl {
  notFound?: boolean
  redirect?: { url: string; status: number }
}

interface RequestStore {
  request: Request
  cookies: string[]
  /**
   * Per-request **scope token**. Production always sees `"default"`.
   * In dev, we honour an `x-test-scope` header — Playwright workers
   * send a distinct value per worker so concurrent test runs don't
   * contend on the process-wide state maps (`<Cache>` store,
   * partial registry, session store, GraphQL cache). See
   * `getScope()` below and `docs-dev/server-isolation.md`.
   */
  scope: string
  /**
   * Populated by `Root`'s framework-sentinel catch branch. Read by
   * the RSC entry after rendering to pick the right HTTP status /
   * `Location` header / payload marker.
   */
  control?: FrameworkControl
}

const requestContext = new AsyncLocalStorage<RequestStore>()

/**
 * Per-Partial cache access manifest. Opened by `<Cache>` at the top of
 * its body, closes when Cache returns. Nested Partials open their own
 * manifest (ALS scopes stack naturally), so reads inside an inner
 * Partial are attributed to that Partial, not the outer one.
 *
 * Outside a Cache scope (inside a non-cached Partial body, a server
 * action, etc.), accessor calls no-op for tracking purposes. The
 * underlying read still happens normally — tracking is only a
 * side-effect.
 *
 * Scope holds both `current` (being filled during this render) and
 * `stored` (from a previous render, or null on first render). If
 * `stored` is set and an accessor reads a key NOT in `stored`, we
 * throw immediately — that's a hoisting violation (the Partial's key
 * surface changed). Missing keys (stored has X, current doesn't touch
 * X) are detected post-render by `<Cache>` and treated as a soft
 * failure (log + preserve the old entry).
 */
export interface ManifestScope {
  current: Set<string>
  stored: ReadonlySet<string> | null
  partialId: string
  /**
   * Called by `trackAccess` immediately before throwing a
   * `HoistingViolationError`. The framework uses this to invalidate
   * the offending Partial's previous-render snapshot so the next
   * render starts with `stored = null` instead of looping the same
   * comparison. Without this hook the throw becomes "sticky": the
   * partial manifest from the failed render persists in the
   * registry, every subsequent reload re-trips the same check, and
   * the dev has to restart the server to recover.
   *
   * Optional: `<Cache>`'s manifest scopes don't set it (Cache's
   * Flight round-trip + reliable attribution mean a hoisting
   * violation there really is the author's bug — recovery via HMR
   * after the fix is the right model). The per-Partial cell scope
   * sets it because cell-drift attributions can blame the wrong
   * Partial, and the violation becomes unrecoverable without an
   * automatic clear.
   */
  onViolation?: () => void
}

const manifestContext = new AsyncLocalStorage<ManifestScope>()

// ─── Partial-level manifest (React.cache mutation cell) ──────────────
//
// Per-Partial manifest scope, set by every `<Partial>` body before
// rendering its children. Sibling to the ALS-based `manifestContext`
// that `<Cache>` opens via `runWithCacheManifest`:
//
//   ALS scope:  set by `<Cache>` only, propagates through Cache's
//               Flight round-trip to descendants (the await chain
//               carries the ALS).
//   Cell scope: set by EVERY Partial body, read by descendants
//               through the per-request mutation cell. Discipline-
//               dependent (descendants must hoist their tracked
//               accessor reads to the sync top of their body, before
//               any await — the same rule documented for the frame
//               cell in `docs-dev/frame-scope.md`).
//
// `trackAccess` writes to BOTH so an accessor read inside a Cache
// inside a Partial lands in both manifests. Each layer uses its
// manifest for its own purpose: Cache for the cache key, Partial for
// the structural fingerprint.
//
// The cell can drift when descendants render after their ancestor
// has yielded (sibling Partial's body runs in between, overwriting
// the cell). Hoisting prevents this from causing under-attribution
// for direct sync children: their reads happen during React's
// synchronous call from the parent's wrapped JSX, before any sibling
// Partial body has had a chance to run. Deeper async descendants
// past intermediate awaits hit the same drift sharp edge as frame
// scope — see `docs-dev/frame-scope.md` and the limit documented on
// the Partial body's `descendantManifestKey` computation.
const partialManifestCell = cache((): { current: ManifestScope | null } => ({
  current: null,
}))

export function setCurrentPartialManifest(scope: ManifestScope | null): void {
  partialManifestCell().current = scope
}

export function getCurrentPartialManifest(): ManifestScope | null {
  return partialManifestCell().current
}

// ─── Frame scope (React.cache mutation cell) ──────────────────────

/**
 * Per-frame scope seen by descendant server components rendered
 * inside a `<Partial frame="name">`. Accessors call `frameRequest()`
 * which reads the cell; falls back to the ALS request when no
 * frame is active.
 *
 * Frames can't use React Context for scoping because React's RSC
 * build (`react.react-server.js`) deliberately excludes
 * `createContext` — server components can't create their own
 * providers. `React.cache` gives us a per-request-singleton object
 * we can mutate during render; descendants see the mutation if
 * they read accessors at the top of their body (before any await).
 */
export interface FrameScope {
  /** Synthetic Request this frame's accessors resolve against. */
  request: Request
  /** Full frame path, outer-first (e.g. `["products", "list"]`).
   *  Dotted for logging / session lookup via `path.join(".")`. */
  path: readonly string[]
}

/**
 * React.cache memoizes this function per request. The mutable cell
 * it returns is shared by every reader in the same render pass;
 * `FrameWrapper` writes to `current` before rendering children,
 * accessors read it.
 */
const frameScopeCell = cache((): { current: FrameScope | null } => ({
  current: null,
}))

/**
 * Called by `FrameWrapper` before rendering a framed subtree. The
 * cell is mutated in place; descendants reading accessors pick up
 * the new value.
 */
export function setCurrentFrameScope(scope: FrameScope | null): void {
  frameScopeCell().current = scope
}

/** Current frame scope, or `null` if no frame is active. */
export function getCurrentFrameScope(): FrameScope | null {
  return frameScopeCell().current
}

function frameRequest(): Request | null {
  return frameScopeCell().current?.request ?? null
}

// ─── CMS scope (React.cache mutation cell) ────────────────────────

/**
 * Per-Partial CMS scope seen by descendant server components rendered
 * inside a `<Partial cmsId="…">`. Content-field accessors (`getText`,
 * `getEnum`, etc.) read the cell; `<Partial>` mutates it before
 * rendering children. Same React.cache pattern as the frame scope —
 * a mutable per-request cell that survives the synchronous render
 * walk without a Flight round-trip.
 *
 * Discipline: content accessors, like frame / cache-manifest
 * accessors, must be called BEFORE any `await` in a server component
 * body. After an await the cell may have been mutated by a sibling
 * Partial's render. See `docs/cms.md`.
 *
 * The `<Partial>` component is responsible for pushing a null scope
 * when it runs WITHOUT `cmsId` — otherwise a CMS-aware ancestor's
 * scope would leak into a non-CMS descendant Partial and its
 * `getText` calls would resolve against the wrong node.
 */
const cmsScopeCell = cache((): { current: CmsScope | null } => ({
  current: null,
}))

/**
 * Called by `<Partial cmsId>` before rendering children. Passing
 * `null` clears the scope (a descendant Partial without its own
 * `cmsId` should not inherit from an ancestor's CMS scope).
 */
export function _setCurrentCmsScope(scope: CmsScope | null): void {
  cmsScopeCell().current = scope
}

/**
 * Dev-time prerender scope — used by the block-catalog prerender to
 * introspect accessor reads without rendering through React.
 * `React.cache` (the backing for `cmsScopeCell`) only works inside a
 * React render pass; calling a block component directly as a
 * function needs a different transport.
 *
 * Resolution priority: prerender ALS wins over the cell so the
 * prerender can override even when the cell happens to be populated
 * (it shouldn't be during a direct call, but the precedence is
 * explicit).
 */
const cmsPrerenderContext = new AsyncLocalStorage<CmsScope>()

/** @internal Used by `src/framework/cms-prerender.ts`. */
export function _runWithPrerenderCmsScope<T>(
  scope: CmsScope,
  fn: () => T | Promise<T>,
): Promise<T> {
  return cmsPrerenderContext.run(scope, async () => fn())
}

function currentCmsScope(): CmsScope | null {
  return cmsPrerenderContext.getStore() ?? cmsScopeCell().current
}

/** Current CMS scope, or `null` if this render isn't inside a `<Partial cmsId>`. */
export function getCurrentCmsScope(): CmsScope | null {
  return currentCmsScope()
}

/**
 * Pick the scope token for this request. In dev, an `x-test-scope`
 * header wins (Playwright workers stamp a per-worker value so their
 * process-wide state buckets don't collide). In prod, the header is
 * ignored — every request maps to `"default"` — so a malicious
 * caller can't cause cache-miss amplification or state exfil by
 * spoofing scopes.
 */
const DEFAULT_SCOPE = "default"
function deriveScope(request: Request): string {
  if (import.meta.env?.DEV) {
    const h = request.headers.get("x-test-scope")
    if (h) return h
  }
  return DEFAULT_SCOPE
}

/**
 * `true` whenever the current request came from a Playwright worker
 * (anything with a non-default `x-test-scope` header). Demo-app
 * components that simulate network latency can branch on this to
 * emit their output at test speed — the scope header is only honored
 * in dev, so prod requests always return `false`.
 *
 * Currently only `src/app/chat/log.ts` uses this, because the chat
 * producer's hand-crafted 100 ms × 100-chunk × 10 s budget would
 * otherwise dominate Playwright runtime. Other demo delays (Pokemon
 * search stages, cache-demo SlowContent, frames-demo MenuSlowView)
 * stay at demo cadence — some specs assert on absolute-latency
 * behaviour (cache hit < cold miss / 3, fallback visible before
 * resolved content) that breaks if you uniformly shrink them.
 */
export function isTestMode(): boolean {
  return getStore().scope !== DEFAULT_SCOPE
}

export function runWithRequest<T>(request: Request, fn: () => T): { result: T; cookies: string[] } {
  const store: RequestStore = {
    request,
    cookies: [],
    scope: deriveScope(request),
  }
  const result = requestContext.run(store, fn)
  return { result, cookies: store.cookies }
}

export async function runWithRequestAsync<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; cookies: string[] }> {
  const store: RequestStore = {
    request,
    cookies: [],
    scope: deriveScope(request),
  }
  const result = await requestContext.run(store, fn)
  return { result, cookies: store.cookies }
}

function getStore(): RequestStore {
  const store = requestContext.getStore()
  if (!store) throw new Error("No request context — are you inside a server component or action?")
  return store
}

export function getRequest(): Request {
  return getStore().request
}

export function setRequest(request: Request): void {
  getStore().request = request
}

/**
 * Per-request scope token — `"default"` in prod, dev-only
 * `x-test-scope` header otherwise. State modules that hold
 * process-wide Maps (`<Cache>` store, partial registry, session
 * store, GraphQL cache) bucket by this so parallel test workers
 * don't interfere.
 *
 * Falls back to the default scope when called outside a request
 * context — that path is exercised by HMR dispose hooks and
 * module-init code which shouldn't throw just because there's no
 * live request.
 */
export function getScope(): string {
  return requestContext.getStore()?.scope ?? DEFAULT_SCOPE
}

export function getDefaultScope(): string {
  return DEFAULT_SCOPE
}

// ─── Manifest tracking ─────────────────────────────────────────────────

export function runWithCacheManifest<T>(scope: ManifestScope, fn: () => Promise<T>): Promise<T> {
  return manifestContext.run(scope, fn)
}

export function getCurrentCacheManifest(): ManifestScope | undefined {
  return manifestContext.getStore()
}

export class HoistingViolationError extends Error {
  readonly partialId: string
  readonly newKey: string
  readonly previousKeys: string[]
  constructor(partialId: string, newKey: string, previousKeys: string[]) {
    super(
      `Partial "${partialId}"'s manifest captured a read of "${newKey}" on ` +
        `this render that its previous render didn't see (previous keys: ` +
        `[${previousKeys.join(", ")}]).\n\n` +
        `Two common causes:\n` +
        `  1. A conditional read inside this Partial's body — move the ` +
        `getCookie / getHeader / getSearchParam / getPathname call to the ` +
        `top of the body, before any branching, like a React hook.\n` +
        `  2. Cell drift: another Partial's body called a tracked accessor ` +
        `AFTER an \`await\`, by which point the per-request manifest cell ` +
        `had been overwritten by this Partial's body. The read got ` +
        `attributed to "${partialId}" by accident. Find the Partial ` +
        `actually doing the read and hoist its accessor call ABOVE the ` +
        `await — the framework can only attribute reads correctly when ` +
        `they happen at the synchronous top of a server component body.\n\n` +
        `If "${partialId}" really does need to vary by "${newKey}" ` +
        `conditionally, use \`cache.vary\` for <Cache> partials.`,
    )
    this.name = "HoistingViolationError"
    this.partialId = partialId
    this.newKey = newKey
    this.previousKeys = previousKeys
  }
}

function trackAccess(kind: string, name: string): void {
  const key = `${kind}:${name}`
  // ALS scope (Cache via runWithCacheManifest). Innermost Cache wins
  // by ALS semantics, so a nested `<Cache>` inside a `<Cache>` lands
  // in the inner cache's manifest — same as before.
  const alsScope = manifestContext.getStore()
  if (alsScope) recordAccess(alsScope, key)
  // Per-request cell scope (Partial body). Distinct from the ALS
  // scope: a single accessor read attributes to BOTH the surrounding
  // Cache (if any) AND the surrounding Partial. Each layer folds its
  // own manifest into its own key derivation downstream — Cache into
  // the cache key, Partial into the structural fingerprint.
  const cellScope = partialManifestCell().current
  if (cellScope && cellScope !== alsScope) recordAccess(cellScope, key)
}

function recordAccess(scope: ManifestScope, key: string): void {
  if (scope.current.has(key)) return
  if (scope.stored !== null && !scope.stored.has(key)) {
    const prevKeys = [...scope.stored].sort()
    // Capture the violation handler BEFORE clearing — see scope.onViolation
    // doc for why. Clearing stored locally also stops a chain of further
    // throws inside this same render (one violation surfaces, rest are
    // recorded as new keys until the render ends).
    scope.onViolation?.()
    scope.stored = null
    throw new HoistingViolationError(scope.partialId, key, prevKeys)
  }
  scope.current.add(key)
}

/**
 * Given a manifest (from a prior render), resolve each tracked key
 * against the current request and return a values map. Used by
 * `<Cache>` to derive a cache key before running the Partial body on
 * subsequent requests.
 *
 * `request` defaults to the top-level ALS request. Callers inside a
 * frame (e.g. `<Cache>` when it sits inside a `<Partial frame=…>`)
 * pass the frame's Request so URL/pathname keys resolve against the
 * frame's URL instead of the page's.
 *
 * Does NOT participate in tracking — we're reading on behalf of the
 * cache layer, not the user's component.
 */
export function resolveManifest(manifest: Set<string>, request?: Request): Record<string, string> {
  const store = getStore()
  const effectiveRequest = request ?? store.request
  const url = new URL(effectiveRequest.url)
  const values: Record<string, string> = {}
  for (const spec of manifest) {
    const colonIdx = spec.indexOf(":")
    if (colonIdx < 0) continue
    const kind = spec.slice(0, colonIdx)
    const name = spec.slice(colonIdx + 1)
    switch (kind) {
      case "cookie":
        values[spec] = readCookieFromRequest(effectiveRequest, name) ?? ""
        break
      case "header":
        values[spec] = effectiveRequest.headers.get(name) ?? ""
        break
      case "url":
        values[spec] = url.searchParams.get(name) ?? ""
        break
      case "pathname": {
        const matched = matchRoutePattern(url.pathname, name)
        if (!matched) {
          values[spec] = ""
          break
        }
        // Stable serialization: sort keys so manifest hashing is
        // deterministic regardless of JS object property order.
        const sorted: Record<string, string> = {}
        for (const k of Object.keys(matched).sort()) sorted[k] = matched[k]
        values[spec] = JSON.stringify(sorted)
        break
      }
      default:
        values[spec] = ""
    }
  }
  return values
}

/**
 * Match a URL pathname against a pattern with `:name` segments.
 *
 *   matchRoutePattern("/p/bulbasaur", "/p/:slug") → { slug: "bulbasaur" }
 *   matchRoutePattern("/p/x/reviews/2", "/p/:slug/reviews/:page")
 *     → { slug: "x", page: "2" }
 *   matchRoutePattern("/other", "/p/:slug") → null
 *
 * Segment semantics:
 *   - Static segments must match literally.
 *   - `:name` matches any single non-slash segment; value decoded.
 *   - Length must match (no optional or wildcard segments for now).
 *   - Leading / trailing slashes are normalized.
 *
 * Kept as a stand-alone helper (not the `URLPattern`-based `matchPath`
 * from `router.ts`) because this one is small, allocation-light, and
 * runs inside `resolveManifest` on every cache key build.
 */
export function matchRoutePattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = pathname.split("/").filter(Boolean)
  const patSegs = pattern.split("/").filter(Boolean)
  if (pathSegs.length !== patSegs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i]
    const seg = pathSegs[i]
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(seg)
    } else if (pat !== seg) {
      return null
    }
  }
  return params
}

// ─── Tracked accessors ─────────────────────────────────────────────────

/**
 * Read a cookie from a Request, considering any Set-Cookies added
 * during this request's ALS scope (server actions that fired earlier
 * in the chain).
 *
 * The Set-Cookie accumulator is always page-scoped (cookies live on
 * the response, not per-frame), so it's read from the ALS store
 * regardless of whether `request` is the page request or a frame's.
 */
function readCookieFromRequest(request: Request, name: string): string | undefined {
  const store = getStore()
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`))
    if (match) return match[1]
  }
  const header = request.headers.get("cookie") ?? ""
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

/**
 * Return the Request tracked accessors should read from: the current
 * frame's Request if we're inside a `<Partial frame=…>`, otherwise
 * the top-level page Request.
 */
function currentRequest(): Request {
  return frameRequest() ?? getStore().request
}

export function getCookie(name: string): string | undefined {
  trackAccess("cookie", name)
  return readCookieFromRequest(currentRequest(), name)
}

/**
 * @internal
 *
 * Untracked cookie read for framework code that runs INSIDE a Partial
 * body (or any other place a manifest scope is active) but whose
 * reads must not be attributed to the surrounding Partial. Reading
 * the session cookie to resolve a frame URL is the canonical case —
 * the framework always reads the session cookie regardless of what
 * the user component does, so attributing it would push every
 * Partial's manifest into reading `cookie:__frame_sid` and the
 * hoisting check would refuse the first nav that introduced a frame.
 *
 * Always reads from the page request — frames don't carry their own
 * cookies.
 */
export function _readCookieUntracked(name: string): string | undefined {
  return readCookieFromRequest(getStore().request, name)
}

export function getHeader(name: string): string | null {
  trackAccess("header", name.toLowerCase())
  return currentRequest().headers.get(name)
}

export function getSearchParam(name: string): string | null {
  trackAccess("url", name)
  return new URL(currentRequest().url).searchParams.get(name)
}

/**
 * Match the current request's pathname against a pattern with `:name`
 * segments and return the extracted params (or `null` if no match).
 *
 *   const { slug } = getPathname("/p/:slug") ?? {};
 *
 * Tracked as a `<Partial cache>` manifest key. The PATTERN (not the
 * extracted values) is what gets recorded — resolution re-runs on
 * every cache-key build, so two requests with different matched
 * values hash to different entries. Authors who want a single Partial
 * snapshot to serve every `/p/:slug` URL should prefer this accessor
 * over closure-capturing props.
 *
 * Pattern grammar: static segments + `:name` capture. Matches segment
 * count exactly; no wildcards / optional segments yet.
 *
 * (This is the only pathname accessor the framework ships — there's
 * no zero-arg "give me the raw pathname" form. Making a pattern
 * required steers authors away from caches that key on the full URL,
 * which blows up registry storage on high-cardinality routes.)
 */
export function getPathname(pattern: string): Record<string, string> | null {
  trackAccess("pathname", pattern)
  return matchRoutePattern(new URL(currentRequest().url).pathname, pattern)
}

// ─── Content-field accessors ───────────────────────────────────────────
//
// Read CMS-authored fields for the enclosing `<Partial cmsId=…>`.
// Outside a CMS scope every accessor returns its empty / default
// value without touching the resolver — the accessors are safe to
// call from any server component, but only meaningful inside a
// CMS-aware Partial.
//
// Hoisting discipline: call these at the top of the component body,
// before any `await`, for the same reason tracked accessors and
// frame-scope reads do. See `docs/cms.md`.
//
// First-render rule: every accessor resolves to SOMETHING even when
// the store has no matching config — empty string, 0, false,
// `values[0]` for enums, `{src:"",alt:""}` for images. Authors can
// always render; the editor populates real values later.

/**
 * Record this accessor's declaration into the current CMS scope's
 * field manifest. The editor reads this manifest to know which form
 * inputs to render for this Partial.
 */
function trackContentField(name: string, kind: ContentFieldKind): CmsScope | null {
  const scope = currentCmsScope()
  if (!scope) return null
  if (!scope.contentFields.has(name)) {
    scope.contentFields.set(name, kind)
  }
  return scope
}

function resolvedFields(scope: CmsScope): Record<string, unknown> | null {
  return resolveCmsScope(scope, currentRequest())
}

export function getText(name: string): string {
  const scope = trackContentField(name, "text")
  if (!scope) return ""
  const v = resolvedFields(scope)?.[name]
  return typeof v === "string" ? v : ""
}

export function getRichText(name: string): string {
  // V1: rich text is a plain string. Future versions can return a
  // structured value (portable-text-ish) without changing the accessor
  // surface — the editor decides whether to show a plain textarea or
  // a rich-text widget by inspecting `contentFields.get(name)`.
  const scope = trackContentField(name, "richText")
  if (!scope) return ""
  const v = resolvedFields(scope)?.[name]
  return typeof v === "string" ? v : ""
}

export function getNumber(name: string): number {
  const scope = trackContentField(name, "number")
  if (!scope) return 0
  const v = resolvedFields(scope)?.[name]
  return typeof v === "number" ? v : 0
}

export function getBoolean(name: string): boolean {
  const scope = trackContentField(name, "boolean")
  if (!scope) return false
  const v = resolvedFields(scope)?.[name]
  return typeof v === "boolean" ? v : false
}

export function getEnum<T extends string>(name: string, values: readonly T[]): T {
  const scope = trackContentField(name, "enum")
  if (!scope) return values[0]
  const v = resolvedFields(scope)?.[name]
  if (typeof v === "string" && (values as readonly string[]).includes(v)) {
    return v as T
  }
  return values[0]
}

export interface ImageValue {
  readonly src: string
  readonly alt: string
}

const EMPTY_IMAGE: ImageValue = Object.freeze({ src: "", alt: "" })

export function getImage(name: string): ImageValue {
  const scope = trackContentField(name, "image")
  if (!scope) return EMPTY_IMAGE
  const v = resolvedFields(scope)?.[name]
  if (typeof v !== "object" || v === null) return EMPTY_IMAGE
  const obj = v as { src?: unknown; alt?: unknown }
  return {
    src: typeof obj.src === "string" ? obj.src : "",
    alt: typeof obj.alt === "string" ? obj.alt : "",
  }
}

/**
 * Declare a typed entity reference. Returns a `Reference<T>` that
 * userspace loaders consume to resolve the entity.
 *
 * Resolution order inside a loader:
 *   1. If `ref.value` is set, the loader fetches that concrete id.
 *   2. Else if `ref.fallback === "closest"`, the loader calls
 *      `getClosest<T>(ref.type)` to inherit from an ancestor that
 *      provided an entity of this type.
 *   3. Else the loader returns `null` (author said "no fallback").
 *
 * Records into the CMS scope's `references` map so the future editor
 * can render a picker widget for this name, keyed by the type tag.
 * Outside a CMS scope returns a ref with `value: null` and the
 * `"closest"` fallback — blocks still compose via ancestor context
 * even when not CMS-authored.
 *
 * See `docs/cms.md` § Reference accessors.
 */
export function getReference<T extends string>(name: string, type: T): Reference<T> {
  const scope = currentCmsScope()
  if (!scope) {
    return { type, value: null, fallback: "closest" }
  }
  if (!scope.references.has(name)) {
    scope.references.set(name, type)
  }
  const raw = resolveCmsScope(scope, currentRequest())?.[name]
  const value = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null
  return { type, value, fallback: "closest" }
}

/**
 * Read the nearest ancestor-provided context value for `key`.
 * Returns `null` when no ancestor set this key.
 *
 * Records the read into the CMS scope's `contextConsumes` set so
 * the editor can surface "this block depends on an ancestor
 * providing X" in authoring UI. Reading outside a CMS scope still
 * resolves through the partial-context chain — context inheritance
 * works for any Partial, not just CMS-authored ones.
 *
 * Hoisting: call at the top of a block/component body, before any
 * `await`. The partial-context cell drifts across async boundaries
 * in the same way tracked-accessor and frame-scope cells do.
 */
export function getClosest<T>(key: string): T | null {
  const scope = currentCmsScope()
  if (scope) {
    scope.contextConsumes.add(key)
  }
  const ctx = capturePartialContext()
  const value = ctx.provides[key]
  return value === undefined ? null : (value as T)
}

export function setFrameworkControl(patch: FrameworkControl): void {
  const store = getStore()
  store.control = { ...store.control, ...patch }
}

export function getFrameworkControl(): FrameworkControl | undefined {
  return getStore().control
}

export function setCookie(name: string, value: string, maxAge = 60 * 60 * 24 * 30): void {
  const store = getStore()
  store.cookies.push(`${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
}
