/**
 * `ReactCms.partial(Render, ...)` — define-step constructor.
 *
 * Replaces the old `<Partial>` JSX wrapper, the tracked-accessor
 * manifest, the per-Partial frame/CMS/manifest ALS cells, and
 * `registerBlock`. One spec call at module scope produces a placeable
 * React component. Every dependency the spec has on the request,
 * route, or CMS lives in a single sync `vary` function whose result is
 * also the cache-key surface.
 *
 *   const PokemonPage = ReactCms.partial(PokemonRender, '/pokemon/:id')
 *   <PokemonPage parent={ROOT} />
 *
 * Slot block instances pass `cmsId={entry.id}` to override the spec's
 * baked-in cmsId — same Component renders with per-instance content.
 *
 * See `notes/partial-define-step-api.md`.
 */

import React, {
  Suspense,
  cloneElement,
  isValidElement,
  type FC,
  type ReactElement,
  type ReactNode,
} from "react"
import { djb2 } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { _childContext, ROOT, type PartialCtx } from "./partial-context.ts"
import { PartialErrorBoundary } from "./partial-error-boundary.tsx"
import { FrameNameProvider, PartialsClient } from "./partial-client.tsx"
import { Cache } from "./cache.tsx"
import type { CacheOptions } from "./cache-options.ts"
import {
  enterRequestRegistry,
  getRouteSnapshots,
  lookupPartial,
  registerPartial,
  type PartialSnapshot,
} from "./partial-registry.ts"
import { enterPartialState, getPartialState, type PartialRequestState } from "./partial-request-state.ts"
import {
  cmsFingerprintContribution,
  createCmsReadSurface,
  getSpecByCmsId,
  getSpecByType,
  registerSpec,
  type CmsReadSurface,
} from "../runtime/cms-runtime.ts"
import { getRequest, parseCookies } from "../runtime/context.ts"
import {
  createSessionReadSurface,
  getSessionFrameUrl,
  setSessionFrameUrl,
  type SessionReadSurface,
} from "../runtime/session.ts"

export { ROOT, type PartialCtx } from "./partial-context.ts"

// ─── Types ─────────────────────────────────────────────────────────────

export type SelectorToken = `${"#" | "."}${string}`
export type SelectorTokens = SelectorToken | SelectorToken[]

export interface ActivatorProps {
  partialId?: string
  children?: ReactNode
}

export type DeferSpec = true | ReactElement<ActivatorProps>

export interface VaryScope {
  /** The (frame-resolved) request URL, already parsed. Reach for
   *  this when you need fields outside the destructurable shortcuts
   *  (port, protocol, hash). */
  url: URL
  /** Shortcut for `url.pathname`. */
  pathname: string
  /** Search params as a destructurable record. Missing keys are
   *  `undefined` (the type reflects this — destructure with
   *  defaults: `{ flavor = "vanilla" }`). Multi-valued keys (rare)
   *  carry only their first value; for `getAll`, reach into
   *  `url.searchParams`. */
  search: Partial<Record<string, string>>
  /** Cookies parsed from the request's `Cookie` header, as a
   *  destructurable record. Missing keys are `undefined`. */
  cookies: Partial<Record<string, string>>
  /** Request headers as a destructurable record. Keys are
   *  lowercased per HTTP spec — destructure with quoted keys for
   *  hyphenated names (`{ "accept-language": al }`). Missing keys
   *  are `undefined`. */
  headers: Partial<Record<string, string>>
  /** Match params populated by `match` (URLPattern groups for the
   *  pathname). */
  params: Record<string, string>
  /** CMS read surface bound to the spec's effective cmsId. */
  cms: CmsReadSurface
  /** Per-session read surface. Each `session.<type>(name, …)` call
   *  records `name` as a dependency on this spec — server actions
   *  that mutate the same name (`setSessionValue`) walk every
   *  registered snapshot and refetch the specs whose vary touched it.
   *  Sync; values are stored in the framework session store, written
   *  by the `setSessionValue` action. */
  session: SessionReadSurface
}

/** Build a plain `{key: value}` object from a URLSearchParams. */
function searchParamsToRecord(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of sp) out[k] = v
  return out
}

/** Lowercase + flatten a `Headers` instance into a plain record. */
function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h) out[k.toLowerCase()] = v
  return out
}

export interface RenderArgs {
  /** PartialCtx for THIS spec's descendants — pass to slot host props
   *  and nested Spec components' `parent` prop. */
  parent: PartialCtx
  /** Effective cmsId for THIS render (override-aware) — pass to slots'
   *  `hostCmsId`. */
  cmsId: string
  /** Outer `children` passed to the spec component, when used as a
   *  JSX wrapper. `undefined` when the spec was placed without
   *  children. */
  children?: ReactNode
}

/**
 * Pattern accepted by `match`. Either a pathname-only string
 * shorthand, or a full URLPattern init dict for declarative
 * matching across pathname / search / hostname / etc.
 *
 *   match: "/pokemon/:id"
 *   match: { pathname: "/p/:slug", search: "?variant=*" }
 *   match: { pathname: "/api/:v(v[0-9]+)/:resource" }
 */
export type MatchPattern = string | URLPatternInit

export interface PartialOptions<V> {
  match?: MatchPattern
  vary?: (scope: VaryScope) => V | null
  /** Class-only selector tokens (e.g. `[".hero"]`). When set, the spec
   *  is usable as a slot block — slot entries form effective selectors
   *  as `[#<entry.id>, ...tags]` and override the spec's cmsId per
   *  instance. */
  tags?: ReadonlyArray<`.${string}`>
  /** Selector for non-slot (page-position) specs. Auto-derived from
   *  `Render.name` when omitted. */
  selector?: SelectorTokens
  /** Fallback CMS storage key. Slot instances override via the
   *  Component's `cmsId` prop. */
  cmsId?: string
  /** Spec catalog tag (slot lookup). Defaults to the auto-derived id. */
  type?: string
  cache?: CacheOptions
  frame?: string
  frameUrl?: string
  defer?: DeferSpec
  fallback?: ReactNode
  errorWith?: ReactNode
}

/**
 * Framework-managed props every spec component understands. Plain
 * pass-through props (e.g. `id` from a parent wrapper) live in the
 * `Extra` parameter of `SpecComponent<Extra>` — they flow into Render
 * alongside `vary`'s output and contribute to the cache fingerprint.
 */
export interface PartialComponentProps {
  parent: PartialCtx
  /** Per-instance cmsId override (used by slots). */
  cmsId?: string
  /** Pass-through children — surfaced to `Render` as `children` in
   *  its props bag. Lets specs act as JSX wrappers (e.g. opening a
   *  frame around author content). */
  children?: ReactNode
}

/**
 * The Render function's props get split by the framework into three:
 *   - framework-managed (`parent`, `cmsId`, `children`) — `RenderArgs`,
 *     always supplied by the framework.
 *   - vary-derived (`V`) — produced by `vary`, also framework-supplied.
 *   - everything else — must be passed as a JSX prop at the call site.
 *
 * `SpecExtraProps<R, V>` is the call-site prop surface: `R` minus the
 * framework keys minus the vary keys. When `vary` returns the entire
 * prop surface, `SpecExtraProps` collapses to `{}` and the call site
 * is just `<Spec parent={...} />`.
 */
export type SpecExtraProps<R, V> = Omit<R, keyof RenderArgs | keyof V>

/**
 * Parse a route pattern at the type level into a `{param: string}`
 * shape. `/pokemon/:id` → `{ id: string }`,
 * `/p/:slug/reviews/:page` → `{ slug: string; page: string }`.
 * Patterns with no `:param` segments resolve to `object` (empty
 * surface). Wildcards (`/*`) don't contribute typed params.
 */
export type ParseRoute<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ParseRoute<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : object

/**
 * Infer the framework-supplied prop surface (`V`) from the options
 * object. Resolution order:
 *   1. string shorthand (`partial(Render, "/x/:id")`) → match-only,
 *      params auto-flow as `ParseRoute<pattern>`.
 *   2. options with `vary` → V is the vary callback's return type
 *      (null is excluded — null means "don't render").
 *   3. options with `match` but no `vary` → params auto-flow as
 *      `ParseRoute<pattern>`.
 *   4. anything else → empty: every Render prop must come from the
 *      JSX call site.
 *
 * This is what makes `{ match: "/pokemon/:id" }` enough to wire
 * `params.id` into a Render that takes `{ id: string }` — no
 * `vary: ({ params }) => ({ id: params.id })` boilerplate.
 */
export type InferV<Opts> = Opts extends string
  ? ParseRoute<Opts>
  : Opts extends { vary: (scope: VaryScope) => infer R }
    ? Exclude<R, null>
    : Opts extends { match: infer M }
      ? M extends string
        ? ParseRoute<M>
        : M extends { pathname: infer P extends string }
          ? ParseRoute<P>
          : object
      : object

/** Spec component type. The JSX call-site sees framework props
 *  AND any Render prop the `vary` return doesn't already provide. */
export type SpecComponent<Extra = unknown> = FC<PartialComponentProps & Extra>

// ─── Selector parsing & id derivation ─────────────────────────────────

interface ParsedSelector {
  uniqueTokens: string[]
  sharedTokens: string[]
}

function parseSelector(input: SelectorTokens): ParsedSelector {
  const tokens = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) {
    throw new Error("ReactCms.partial: selector is empty")
  }
  const uniqueTokens: string[] = []
  const sharedTokens: string[] = []
  for (const tok of tokens) {
    if (tok.startsWith("#")) {
      const name = tok.slice(1)
      if (!name) throw new Error('Empty "#" token')
      if (!uniqueTokens.includes(name)) uniqueTokens.push(name)
    } else if (tok.startsWith(".")) {
      const name = tok.slice(1)
      if (!name) throw new Error('Empty "." token')
      if (!sharedTokens.includes(name)) sharedTokens.push(name)
    } else {
      throw new Error(`Unprefixed token "${tok}" — must start with "#" or "."`)
    }
  }
  return { uniqueTokens, sharedTokens }
}

function effectiveIdFromSelector(parsed: ParsedSelector): string {
  const { uniqueTokens, sharedTokens } = parsed
  if (uniqueTokens.length === 1) return uniqueTokens[0]
  if (uniqueTokens.length > 1) return [...uniqueTokens].sort().join(",")
  return `__anon:${[...sharedTokens].sort().join(",")}`
}

const STRIP_SUFFIXES = ["Render", "Page", "Block", "Partial", "Component"]

function autoSelector(render: (...args: never[]) => unknown): SelectorTokens {
  const raw = (render as { displayName?: string; name?: string }).displayName ?? render.name ?? ""
  let stem = raw
  for (const suf of STRIP_SUFFIXES) {
    if (stem.endsWith(suf) && stem.length > suf.length) {
      stem = stem.slice(0, -suf.length)
      break
    }
  }
  if (!stem) stem = "anon"
  const kebab = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
  return `#${kebab}` as SelectorToken
}

// ─── Frame request resolution ─────────────────────────────────────────

/**
 * Extract NAMED match params from a URLPattern result.
 *
 * URLPattern populates `pathname.groups` / `search.groups` / etc. for
 * every part of the URL, including parts the author didn't pin. Any
 * unspecified part defaults to `*`, which captures into a numeric key
 * (`"0"`, `"1"`, …). Those captures are not deliberate dependencies
 * the author asked for — `match: "/inspect/*"` only specifies a
 * pathname wildcard, but URLPattern still produces a `search.groups[0]`
 * that captures the entire query string. Folding those numeric
 * captures into the default `varyResult` makes spec fingerprints
 * change whenever the URL's search/hash/etc. moves, which silently
 * defeats fp-skip on every navigation that carries framework-internal
 * params (`?cached=…`, `?partials=…`).
 *
 * Drop numeric keys here so only the author's named `:foo` groups
 * flow through. Authors who genuinely need a wildcard tail in their
 * dependency surface declare an explicit `vary` and read `pathname`
 * (or any other field) off the scope directly — that path is opt-in
 * and unaffected.
 */
function extractNamedParams(result: URLPatternResult): Record<string, string> {
  const groups = { ...result.pathname.groups, ...result.search.groups }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(groups)) {
    if (typeof v !== "string") continue
    if (/^\d+$/.test(k)) continue
    out[k] = v
  }
  return out
}

function resolveFrameRequest(
  framePath: readonly string[],
  initialUrl: string | undefined,
): Request {
  const pageRequest = getRequest()
  const sessionUrl = getSessionFrameUrl(framePath)
  const effective = sessionUrl ?? initialUrl
  if (effective == null) return pageRequest
  const resolved = new URL(effective, pageRequest.url).toString()
  return new Request(resolved, { headers: pageRequest.headers, method: "GET" })
}


// ─── PartialBoundary — registers + passes children through ────────────

interface PartialBoundaryProps {
  id: string
  type: string
  parentPath: readonly string[]
  uniqueTokens: string[]
  sharedTokens: string[]
  framePath: readonly string[]
  parentFrameChain: readonly string[]
  frameUrl?: string
  cmsId?: string
  cache?: CacheOptions
  fallback: ReactNode
  errorWith: ReactNode | undefined
  /** Call-site JSX props (e.g. `id` from a parent wrapper). Stored
   *  in the snapshot so partial-refetch in cache mode can replay
   *  them when re-rendering the spec without its parent. */
  props?: Record<string, unknown>
  /** Hash of the spec's varyResult — feeds the descendant fold so
   *  ancestors' fps reflect descendants' deps. */
  varyKey?: string
  /** Session keys this spec's `vary` read via the `session.*` surface.
   *  Server-action invalidations (`setSessionValue`) walk every
   *  registered snapshot and refetch the specs that recorded the
   *  mutated key. */
  sessionDeps?: readonly string[]
  children: ReactNode
}

export function PartialBoundary({
  id,
  type,
  parentPath,
  uniqueTokens,
  sharedTokens,
  framePath,
  parentFrameChain,
  frameUrl,
  cmsId,
  cache,
  fallback,
  errorWith,
  props,
  varyKey,
  sessionDeps,
  children,
}: PartialBoundaryProps): ReactNode {
  registerPartial(id, {
    type,
    fallback,
    errorWith,
    uniqueTokens,
    sharedTokens,
    framePath,
    parentFrameChain,
    frameUrl,
    parentPath,
    cmsId,
    cache,
    props,
    varyKey,
    sessionDeps,
  })
  return children
}

// ─── Registry of spec components, keyed by effective id ────────────────

const componentById = new Map<string, SpecComponent<Record<string, unknown>>>()

/**
 * Compute the descendant-fp fold for a spec.
 *
 * Walks the previous-render snapshots for descendants of `ancestorId`
 * (snapshots whose `parentPath` includes the ancestor) and resolves
 * each descendant's vary against the CURRENT request — without
 * actually re-rendering the descendant. This makes the ancestor's
 * fingerprint move whenever any descendant's deps would have moved,
 * so fp-skipping the ancestor never serves a stale subtree.
 *
 * Mirrors the OLD `<Partial>` `computeDescendantManifestKey` exactly:
 * a stored manifest schema (here, the snapshot+spec catalog pair)
 * resolved at the parent's render time, not via lagged stored
 * values. Returns a string suffix to fold into the parent's hash —
 * empty string when there are no descendants.
 */
function computeDescendantFold(ancestorId: string): string {
  const snapshots = getRouteSnapshots()
  if (!snapshots) return ""

  const parts: string[] = []
  for (const [descId, snap] of snapshots) {
    if (descId === ancestorId) continue
    if (!snap.parentPath.includes(ancestorId)) continue
    parts.push(descendantContribution(descId, snap))
  }
  if (parts.length === 0) return ""
  // Order shouldn't matter for fingerprint stability, but sorting
  // keeps it deterministic across registry iteration order changes.
  parts.sort()
  return `|desc=${djb2(parts.join(","))}`
}

/**
 * Compute one descendant's contribution to its ancestor's fp.
 * Re-evaluates the descendant's match + vary against the current
 * request so URL/cookie/header/CMS changes flow through to the
 * ancestor's fp without lag. Falls back to the snapshot's stored
 * `varyKey` when the catalog entry isn't available (e.g. the spec
 * module hasn't loaded yet on the current process).
 */
function descendantContribution(descId: string, snap: PartialSnapshot): string {
  // Slot-block instances register their snapshot with a per-instance
  // `cmsId` override (the entry id, e.g. `composed-hero-2`), but the
  // spec catalog has them under their `type` (e.g. `hero`). Try cmsId
  // first for ordinary specs, fall through to type for slot blocks.
  // Without this, slot-block-instance descendants always hit the
  // `snap.varyKey ?? ""` fallback below — frozen at the value
  // captured on the descendant's last render — so the ancestor's fp
  // never moves when only a slot block's CMS-resolved content
  // changes. That's the cms-demo-slots regression: navigating
  // `/cms-demo/alpha` → `/cms-demo/beta` swaps `composed-hero-2`'s
  // resolved fields, but the wrapper fp-skips and serves alpha's
  // cached content.
  let spec = snap.cmsId ? getSpecByCmsId(snap.cmsId) : undefined
  if (!spec && snap.type) spec = getSpecByType(snap.type)
  // No live spec → fall back to last-known varyKey. Prevents the
  // fold from becoming all-stable when the registry is warm but the
  // catalog is still hydrating; lag of one render in this corner.
  if (!spec) return `${descId}:${snap.varyKey ?? ""}`

  // Honor the descendant's match: a wrapper navigating to a URL
  // that no longer matches a child's pattern means the child won't
  // render, so its fp contribution should be a stable "no-render"
  // marker rather than the resolved vary value.
  const request = getRequest()
  let params: Record<string, string> = {}
  if (spec.matchPattern) {
    const result = spec.matchPattern.exec(request.url)
    if (result === null) return `${descId}:nomatch`
    params = extractNamedParams(result)
  }

  if (!spec.vary) {
    // No vary → only match params + props contribute. The propsKey
    // from the snapshot still distinguishes per-instance call sites.
    return `${descId}:${stableStringify(params)}|${stableStringify(snap.props ?? null)}`
  }

  // Build a vary scope from the current request and resolve.
  const url = new URL(request.url)
  let result: unknown
  try {
    result = spec.vary({
      url,
      pathname: url.pathname,
      search: searchParamsToRecord(url.searchParams),
      cookies: parseCookies(request),
      headers: headersToRecord(request.headers),
      params,
      cms: createCmsReadSurface(snap.cmsId ?? "", request),
      // Discard the deps set — the descendant fold consumes the
      // resolved `result` only (it's folded into the ancestor's fp).
      // Snapshot dep recording happens during the descendant's own
      // render pass, not here.
      session: createSessionReadSurface(new Set()),
    })
  } catch {
    // A vary that throws on the synthetic scope (e.g. relies on a
    // tracked accessor outside its expected request) just falls
    // back to the stored varyKey — same lag as missing-catalog.
    return `${descId}:${snap.varyKey ?? ""}`
  }
  if (result === null) return `${descId}:varynull`
  const cmsKey = snap.cmsId ? cmsFingerprintContribution(snap.cmsId, request) : ""
  const propsKey = stableStringify(snap.props ?? null)
  return `${descId}:${stableStringify(result)}|${propsKey}|${cmsKey}`
}

/**
 * Every URLPattern any spec was constructed with. Populated as a
 * side effect of `ReactCms.partial(..., { match: ... })`. Consumed
 * by `getRegisteredMatchPatterns()` so authors can wire a 404
 * fallback that fires only when no registered pattern matches the
 * request URL.
 */
const registeredMatchPatterns: URLPattern[] = []

/**
 * Compile a `MatchPattern` into a URLPattern with strict semantics:
 * the string form is the pathname pattern verbatim, no rewriting.
 * `match: "/inspect/*"` matches `/inspect/...` and NOT bare
 * `/inspect`; authors who want both write the URLPattern modifier
 * form `match: "/inspect{/*}?"` (or the URLPatternInit dict). This
 * keeps wildcard semantics aligned with URLPattern itself — there's
 * no implicit "optional trailing slash" magic the author has to know
 * about.
 */
function compileMatchPattern(pattern: MatchPattern): URLPattern {
  if (typeof pattern === "string") {
    return new URLPattern({ pathname: pattern })
  }
  return new URLPattern(pattern)
}

/** Snapshot of every URLPattern currently registered. */
export function getRegisteredMatchPatterns(): readonly URLPattern[] {
  return [...registeredMatchPatterns]
}

/**
 * Stable signature for a URLPattern — the concatenation of every
 * pattern component. URLPattern doesn't expose a single canonical
 * source string (the constructor accepts both string and dict forms),
 * so we read every component back and join with NUL. Two URLPatterns
 * built from the same input produce byte-identical signatures.
 */
function patternSignature(pattern: URLPattern): string {
  return [
    pattern.protocol,
    pattern.username,
    pattern.password,
    pattern.hostname,
    pattern.port,
    pattern.pathname,
    pattern.search,
    pattern.hash,
  ].join(" ")
}

/**
 * Compute a routeKey from a URL: a stable hash of WHICH registered
 * URLPatterns match. Two URLs that match the same set of patterns
 * collapse to one routeKey, so the variant-hint table scales with
 * pattern combinations (a small finite space) instead of distinct
 * pathnames. 50k product URLs that all match `/p/:slug` share one
 * hint entry instead of evicting each other from the LRU; spam
 * traffic to junk URLs that all match the same pattern can't displace
 * real hot routes.
 *
 * Returns `__no-pattern` when nothing matches — those requests don't
 * commit to the registry anyway (`notFound()` throws past the commit),
 * so the sentinel just keeps lookups deterministic on the read side.
 */
export function computeRouteKey(url: string): string {
  const matched: string[] = []
  for (const pattern of registeredMatchPatterns) {
    if (pattern.exec(url) !== null) {
      matched.push(patternSignature(pattern))
    }
  }
  if (matched.length === 0) return "__no-pattern"
  matched.sort()
  return djb2(matched.join(""))
}

// ─── The constructor ──────────────────────────────────────────────────

interface InternalSpec<V> {
  /** Spec's own id (when no cmsId override). */
  id: string
  /** Spec's own cmsId fallback (used when no override). */
  cmsId: string
  /** Spec catalog type tag (slot lookup). */
  type: string
  parsed: ParsedSelector
  options: PartialOptions<V>
  /** Compiled URLPattern for `options.match`, or `undefined` when
   *  the spec has no match. Compiled once at constructor time so
   *  every render-phase `exec` is cheap. */
  matchPattern?: URLPattern
  Render: (props: V & RenderArgs) => ReactNode
  /** True iff `options.tags` was set — spec is usable as slot block. */
  isSlotBlock: boolean
}

function placeholderFor(id: string): ReactElement {
  return <i key={id} hidden data-partial data-partial-id={id} />
}

function effectiveIdForInstance(spec: InternalSpec<unknown>, cmsIdOverride: string | undefined): {
  id: string
  parsed: ParsedSelector
} {
  if (cmsIdOverride == null || cmsIdOverride === spec.cmsId) {
    return { id: spec.id, parsed: spec.parsed }
  }
  // Slot-block instance — selector is `[#<cmsId>, ...spec.tags]`
  const uniqueTokens = [cmsIdOverride]
  const sharedTokens = spec.parsed.sharedTokens
  return {
    id: cmsIdOverride,
    parsed: { uniqueTokens, sharedTokens },
  }
}

function createSpecComponent<V>(
  spec: InternalSpec<V>,
): SpecComponent<Record<string, unknown>> {
  const Component: SpecComponent<Record<string, unknown>> = (props) => {
    const {
      parent,
      cmsId: cmsIdOverride,
      children: outerChildren,
      ...extraProps
    } = props as PartialComponentProps & Record<string, unknown>
    const opts = spec.options
    const effectiveCmsId = cmsIdOverride ?? spec.cmsId
    const { id, parsed } = effectiveIdForInstance(
      spec as InternalSpec<unknown>,
      cmsIdOverride,
    )
    // ── Match phase ──
    // `match` runs against the PAGE URL — it's a page-level "should
    // this spec render on this route" gate. The frame URL is
    // internal state, not a page-level concern. `vary` (below) sees
    // the frame-resolved URL when the spec is framed; `match` does
    // not.
    let params: Record<string, string> = {}
    if (spec.matchPattern) {
      const result = spec.matchPattern.exec(getRequest().url)
      if (result === null) return null
      params = extractNamedParams(result)
    }

    // ── Frame phase ──
    const ourFrameChain: readonly string[] = opts.frame
      ? [...parent.frameChain, opts.frame]
      : parent.frameChain
    const ourRequest =
      opts.frame != null
        ? resolveFrameRequest(ourFrameChain, opts.frameUrl)
        : ourFrameChain.length > 0
          ? resolveFrameRequest(ourFrameChain, undefined)
          : getRequest()

    // ── Vary phase ──
    const cms = createCmsReadSurface(effectiveCmsId, ourRequest)
    const sessionDepsSet = new Set<string>()
    const session = createSessionReadSurface(sessionDepsSet)
    let varyResult: unknown
    if (opts.vary) {
      const ourUrl = new URL(ourRequest.url)
      const v = opts.vary({
        url: ourUrl,
        pathname: ourUrl.pathname,
        search: searchParamsToRecord(ourUrl.searchParams),
        cookies: parseCookies(ourRequest),
        headers: headersToRecord(ourRequest.headers),
        params,
        cms,
        session,
      })
      if (v === null) return null
      varyResult = v
    } else if (Object.keys(extraProps).length > 0) {
      // No `vary` declared, but the call site supplied JSX props.
      // The spec is a nested child whose identity is its props +
      // match params; URL reactivity flows through the props.
      varyResult = { ...params }
    } else {
      // No `vary`, no call-site props — fold match params alone.
      // The page-URL fingerprint contribution is added below so
      // every spec re-renders on URL changes by default.
      varyResult = { ...params }
    }

    // ── Fingerprint ──
    // The spec's "own" fp captures only what THIS spec declared:
    // vary result, call-site props, frame URL, CMS contribution.
    // The full fp folds in transitive descendant deps so an
    // ancestor's fp moves whenever a descendant's would, keeping
    // fp-skip conservative — fp-skipping a wrapper while a
    // descendant's URL/CMS deps changed would otherwise serve a
    // stale subtree. The fold reads each descendant's `varyKey`
    // from the previous-render snapshot AND re-evaluates its vary
    // against the CURRENT request so URL changes are reflected at
    // ancestor fp time without lag (mirrors the OLD `<Partial>`
    // `computeDescendantManifestKey` mechanism).
    const cmsKey = effectiveCmsId
      ? cmsFingerprintContribution(effectiveCmsId, ourRequest)
      : ""
    const ownFrameKey = opts.frame ? `|frame=${ourFrameChain.join(".")}:${ourRequest.url}` : ""
    const ambientFrameKey =
      opts.frame == null && ourFrameChain.length > 0
        ? `|inFrame=${ourFrameChain.join(".")}:${ourRequest.url}`
        : ""
    const propsKey =
      Object.keys(extraProps).length > 0 ? `|props=${stableStringify(extraProps)}` : ""
    const varyKey = stableStringify(varyResult)
    const ownStructuralFp = djb2(
      `${id}|vary=${varyKey}${propsKey}${cmsKey}${ownFrameKey}`,
    )
    const descendantFold = computeDescendantFold(id)
    const structuralFp = djb2(`${ownStructuralFp}${descendantFold}`)
    const fp = djb2(
      `${ownStructuralFp}${ambientFrameKey}${descendantFold}`,
    )

    // ── Skip decisions ──
    // When the client has the spec's rendered output cached and its
    // current fingerprint matches, the server returns a placeholder
    // and the client paints from cache. Two things gate fp-skip:
    //
    // 1. Wrappers (`outerChildren` non-empty) never fp-skip. Their
    //    "output" IS their children, which are rendered separately
    //    by their JSX parent — fp-skipping the wrapper would block
    //    those children from re-evaluating on this request even
    //    when their deps have changed. Wrapper render is cheap (it
    //    just returns its JSX shell + children), so always running
    //    it costs nothing and preserves correctness.
    // 2. The spec's fp folds in transitive descendant fps so any
    //    descendant-dep change moves the ancestor's fp too.
    const state = getPartialState() ?? null

    const isExplicit = state?.explicitIds.has(id) ?? false
    const cachedFp = state?.cachedFingerprints.get(id)
    const fingerprintMatches = cachedFp != null && cachedFp === fp
    const hasOuterChildren = outerChildren != null && outerChildren !== false
    const shouldSkip =
      state != null && !isExplicit && fingerprintMatches && !hasOuterChildren

    if (state) {
      for (const tok of parsed.uniqueTokens) {
        if (state.seenUniqueTokens.has(tok)) {
          throw new Error(
            `Duplicate "#${tok}" selector. Tokens starting with "#" must be unique per page.`,
          )
        }
        state.seenUniqueTokens.add(tok)
      }
      if (state.seenIds.has(id)) {
        throw new Error(`Duplicate partial id "${id}".`)
      }
      state.seenIds.add(id)
    }

    const childCtx = _childContext(parent, id, opts.frame)
    // Render receives: extra JSX-prop pass-through, vary result,
    // framework-managed (parent / cmsId / children). vary wins on
    // key collision — vary's return is the canonical surface.
    const renderProps = {
      ...extraProps,
      ...(varyResult as object),
      parent: childCtx,
      cmsId: effectiveCmsId,
      children: outerChildren,
    } as V & RenderArgs
    const fallback = opts.fallback ?? null
    const sessionDeps =
      sessionDepsSet.size > 0 ? Array.from(sessionDepsSet).sort() : undefined

    if (shouldSkip) {
      return (
        <PartialBoundary
          id={id}
          type={spec.type}
          parentPath={parent.path}
          uniqueTokens={parsed.uniqueTokens}
          sharedTokens={parsed.sharedTokens}
          framePath={ourFrameChain}
          parentFrameChain={parent.frameChain}
          frameUrl={opts.frameUrl}
          cmsId={effectiveCmsId}
          cache={opts.cache}
          fallback={fallback}
          errorWith={opts.errorWith}
          props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
          varyKey={varyKey}
          sessionDeps={sessionDeps}
        >
          {placeholderFor(id)}
        </PartialBoundary>
      )
    }

    if (opts.defer && !isExplicit) {
      const defer = opts.defer
      const dormant =
        defer === true
          ? fallback
          : isValidElement(defer)
            ? cloneElement(
                defer as ReactElement<ActivatorProps>,
                { partialId: id },
                fallback,
              )
            : fallback
      return (
        <PartialBoundary
          id={id}
          type={spec.type}
          parentPath={parent.path}
          uniqueTokens={parsed.uniqueTokens}
          sharedTokens={parsed.sharedTokens}
          framePath={ourFrameChain}
          parentFrameChain={parent.frameChain}
          frameUrl={opts.frameUrl}
          cmsId={effectiveCmsId}
          cache={opts.cache}
          fallback={fallback}
          errorWith={opts.errorWith}
          props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
          varyKey={varyKey}
          sessionDeps={sessionDeps}
        >
          <PartialErrorBoundary
            key={id}
            partialId={id}
            partialFingerprint={fp}
            debugUniqueTokens={parsed.uniqueTokens}
            debugSharedTokens={parsed.sharedTokens}
            debugFramePath={ourFrameChain}
            debugParentPath={parent.path}
            fallback={opts.errorWith}
          >
            {dormant}
          </PartialErrorBoundary>
        </PartialBoundary>
      )
    }

    let body: ReactNode = spec.Render(renderProps)

    if (opts.cache !== undefined) {
      body = (
        <Cache id={id} fingerprint={structuralFp} options={opts.cache} varyResult={varyResult}>
          {body}
        </Cache>
      )
    }

    if (opts.frame != null) {
      const url = new URL(ourRequest.url)
      const initialUrl = url.pathname + url.search
      body = (
        <FrameNameProvider path={ourFrameChain} initialUrl={initialUrl}>
          {body}
        </FrameNameProvider>
      )
    }

    if (fallback != null) {
      // With fallback: outer Suspense carries the key (wrapper
      // detection: keyed Suspense). Inner PartialErrorBoundary
      // carries partialId/fingerprint for fp registration.
      body = (
        <Suspense
          key={id}
          fallback={
            <PartialErrorBoundary
              partialId={id}
              partialFingerprint={fp}
              fallback={opts.errorWith}
            >
              {fallback}
            </PartialErrorBoundary>
          }
        >
          <PartialErrorBoundary
            partialId={id}
            partialFingerprint={fp}
            debugUniqueTokens={parsed.uniqueTokens}
            debugSharedTokens={parsed.sharedTokens}
            debugFramePath={ourFrameChain}
            debugParentPath={parent.path}
            fallback={opts.errorWith}
          >
            {body}
          </PartialErrorBoundary>
        </Suspense>
      )
    } else {
      // No fallback: the PartialErrorBoundary IS the wrapper. Key it
      // so the client's `isPartialWrapper` walker (which checks
      // `node.key != null`) detects it.
      body = (
        <PartialErrorBoundary
          key={id}
          partialId={id}
          partialFingerprint={fp}
          debugUniqueTokens={parsed.uniqueTokens}
          debugSharedTokens={parsed.sharedTokens}
          debugFramePath={ourFrameChain}
          debugParentPath={parent.path}
          fallback={opts.errorWith}
        >
          {body}
        </PartialErrorBoundary>
      )
    }

    return (
      <PartialBoundary
        id={id}
        type={spec.type}
        parentPath={parent.path}
        uniqueTokens={parsed.uniqueTokens}
        sharedTokens={parsed.sharedTokens}
        framePath={ourFrameChain}
        parentFrameChain={parent.frameChain}
        frameUrl={opts.frameUrl}
        cmsId={effectiveCmsId}
        cache={opts.cache}
        fallback={fallback}
        errorWith={opts.errorWith}
        props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
        varyKey={varyKey}
        sessionDeps={sessionDeps}
      >
        {body}
      </PartialBoundary>
    )
  }
  Component.displayName = `Partial(${spec.id})`
  return Component
}

// ─── Public constructor ───────────────────────────────────────────────

export const ReactCms = {
  /**
   * Construct a placeable spec component from a Render function plus
   * an options object (or a `match` shorthand).
   *
   * Type inference splits the Render function's props into three:
   *   1. framework-managed (`parent`, `cmsId`, `children`) — always
   *      injected by the framework.
   *   2. vary-derived (`V`) — auto-inferred via `InferV<Opts>`. With
   *      `match` set, V defaults to the URL params (`Record<string,
   *      string>`); with `vary` declared, V is its return type.
   *   3. call-site pass-through (`Extra`) — anything left over.
   *      Inferred from `Render`'s prop type minus the previous two.
   *
   * `Extra` is what the JSX call site has to supply (e.g.
   * `<HeroSpec parent={...} id={pokemonId} />`). When `vary` (or the
   * URL pattern) already covers the entire surface, `Extra` is empty
   * and the call site is just `<HeroSpec parent={...} />`.
   */
  partial<
    const Opts extends string | PartialOptions<object> = PartialOptions<object>,
    V extends object = InferV<Opts>,
    R extends V & RenderArgs = V & RenderArgs,
  >(
    Render: (props: R) => ReactNode,
    matchOrOpts?: Opts,
  ): SpecComponent<SpecExtraProps<R, V>> {
    const options: PartialOptions<V> =
      typeof matchOrOpts === "string"
        ? { match: matchOrOpts }
        : ((matchOrOpts ?? {}) as PartialOptions<V>)

    const matchPattern = options.match ? compileMatchPattern(options.match) : undefined
    if (matchPattern) registeredMatchPatterns.push(matchPattern)

    const isSlotBlock = options.tags != null && options.tags.length > 0

    let parsed: ParsedSelector
    let id: string
    if (isSlotBlock) {
      // Slot-block specs have no #-token by default; their effective
      // selector is materialized per-instance from the entry's cmsId.
      // For catalog purposes we use the type tag.
      parsed = {
        uniqueTokens: [],
        sharedTokens: (options.tags ?? []).map((t) => t.slice(1)),
      }
      id = options.type ?? options.cmsId ?? autoSelector(Render).toString().slice(1)
    } else {
      const selectorInput = options.selector ?? autoSelector(Render)
      parsed = parseSelector(selectorInput)
      id = effectiveIdFromSelector(parsed)
    }

    const cmsId = options.cmsId ?? id
    const type = options.type ?? id

    const spec: InternalSpec<V> = {
      id,
      cmsId,
      type,
      parsed,
      options,
      matchPattern,
      // The internal renderer is invoked with the merged
      // (extraProps + varyResult + framework) prop bag — the type
      // narrows down to `R` at the public signature, but inside
      // `createSpecComponent` we only know the V-shape side.
      Render: Render as unknown as (props: V & RenderArgs) => ReactNode,
      isSlotBlock,
    }

    const Component = createSpecComponent(spec) as SpecComponent<SpecExtraProps<R, V>>
    componentById.set(id, Component as SpecComponent<Record<string, unknown>>)

    registerSpec({
      id,
      cmsId,
      type,
      selectorTokens: parsed,
      // Slot lookup invokes the component with only framework props
      // (`parent`, optional `cmsId`/`children`); call sites that pass
      // extra `Extra` props go through the typed `SpecComponent<Extra>`
      // surface returned to the spec author. The catalog signature is
      // narrower than `SpecComponent<Extra>`, so we cast at the boundary.
      Component: Component as FC<PartialComponentProps>,
      isSlotBlock,
      vary: options.vary as ((scope: VaryScope) => unknown) | undefined,
      matchPattern,
      displayName:
        (Render as { displayName?: string; name?: string }).displayName ?? Render.name ?? "anon",
    })

    return Component
  },
}

// ─── PartialRoot ──────────────────────────────────────────────────────

interface PartialRootProps {
  children: ReactNode
}

function parseCachedFingerprints(raw: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (!raw) return out
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (!token) continue
    // Use lastIndexOf — anonymous ids contain `:` (e.g. `__anon:product`).
    // The fingerprint comes after the LAST colon.
    const colonIdx = token.lastIndexOf(":")
    if (colonIdx > 0) out.set(token.slice(0, colonIdx), token.slice(colonIdx + 1))
    else out.set(token, null)
  }
  return out
}

function parseCsvTokens(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

function resolveSelectorToIds(
  uniqueParam: string | null,
  sharedParam: string | null,
): Set<string> | null {
  const uniqueNames = parseCsvTokens(uniqueParam)
  const sharedNames = parseCsvTokens(sharedParam)
  if (uniqueNames.length === 0 && sharedNames.length === 0) return null

  const snapshots = getRouteSnapshots()
  if (!snapshots) return null

  const ids = new Set<string>()
  for (const name of uniqueNames) {
    if (snapshots.has(name)) ids.add(name)
  }
  if (uniqueNames.length > 0) {
    for (const [id, snap] of snapshots) {
      if (ids.has(id)) continue
      for (const u of snap.uniqueTokens) {
        if (uniqueNames.includes(u)) {
          ids.add(id)
          break
        }
      }
    }
  }
  if (sharedNames.length > 0) {
    for (const [id, snap] of snapshots) {
      if (ids.has(id)) continue
      for (const s of snap.sharedTokens) {
        if (sharedNames.includes(s)) {
          ids.add(id)
          break
        }
      }
    }
  }
  return ids.size > 0 ? ids : null
}

function partialFromSnapshot(
  id: string,
  snap: PartialSnapshot,
  overrideProps: Record<string, unknown> | undefined,
): ReactNode {
  // Try direct id lookup (page specs).
  let Component = componentById.get(id)
  let cmsIdOverride: string | undefined
  if (!Component && snap.type) {
    // Slot block — look up by spec type.
    const spec = getSpecByType(snap.type)
    if (spec) {
      Component = spec.Component
      cmsIdOverride = snap.cmsId
    }
  }
  if (!Component) return null
  const parent: PartialCtx = {
    path: snap.parentPath,
    frameChain: snap.parentFrameChain,
  }
  // Replay any call-site props captured during the streaming render
  // (e.g. `<Slow flavor={…}>`). On top of those, overlay per-request
  // props the client sent via `?partialProps=` — that's how the
  // `<WhenStored>` activator delivers a stored value as a prop
  // without writing it into the URL.
  const replayProps = (snap.props ?? {}) as Record<string, unknown>
  const props = overrideProps ? { ...replayProps, ...overrideProps } : replayProps
  return <Component parent={parent} cmsId={cmsIdOverride} {...props} />
}

export async function PartialRoot({ children }: PartialRootProps): Promise<ReactNode> {
  const requestUrl = new URL(getRequest().url)
  const partialsParam = requestUrl.searchParams.get("partials")
  const tagsParam = requestUrl.searchParams.get("tags")
  const cachedParam = requestUrl.searchParams.get("cached")
  const populateCache = requestUrl.searchParams.has("__populateCache")
  const partialPropsParam = requestUrl.searchParams.get("partialProps")
  const partialProps: Record<string, Record<string, unknown>> = (() => {
    if (!partialPropsParam) return {}
    try {
      const parsed = JSON.parse(partialPropsParam) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, Record<string, unknown>>
      }
    } catch {
      // Malformed JSON — ignore. Fall through with empty props.
    }
    return {}
  })()

  const frameNames = requestUrl.searchParams.getAll("__frame")
  const frameUrls = requestUrl.searchParams.getAll("__frameUrl")
  if (frameNames.length > 0 && frameNames.length === frameUrls.length) {
    for (let i = 0; i < frameNames.length; i++) {
      const path = frameNames[i].split(".").filter(Boolean)
      if (path.length > 0) setSessionFrameUrl(path, frameUrls[i])
    }
  }

  const routeKey = computeRouteKey(getRequest().url)

  // Pre-enter the registry context so the lookups below
  // (`resolveSelectorToIds`, the registry-miss probe) see this
  // request's routeKey via `activeRouteKey(ctx)`. Without this they
  // fall back to the pathname and never resolve any hint, since hints
  // are keyed by the pattern-signature routeKey (see
  // `partial-registry.ts`'s header). Mode is tentative — the streaming
  // branch below re-enters with `"streaming"` if the probe finds no
  // hits. The pre-entered ctx accumulates no pending writes during
  // read-only lookups, so replacing it is safe.
  enterRequestRegistry(routeKey, "cache")

  const combinedRequestedIds = resolveSelectorToIds(partialsParam, tagsParam)
  const hasGlobalFilter = partialsParam != null || tagsParam != null
  const isPartialRefetch = hasGlobalFilter || populateCache

  const explicitIds = new Set<string>()
  if (combinedRequestedIds) for (const id of combinedRequestedIds) explicitIds.add(id)
  if (partialsParam) for (const name of parseCsvTokens(partialsParam)) explicitIds.add(name)

  const state: PartialRequestState = {
    requestedIds: populateCache ? null : combinedRequestedIds,
    isPartialRefetch: isPartialRefetch && !populateCache,
    populateCache,
    cachedFingerprints: parseCachedFingerprints(cachedParam),
    explicitIds,
    seenIds: new Set(),
    seenUniqueTokens: new Set(),
  }

  const requestedUniqueNames = parseCsvTokens(partialsParam)
  let registryMiss = state.isPartialRefetch && hasGlobalFilter && !combinedRequestedIds
  if (state.isPartialRefetch && !registryMiss && requestedUniqueNames.length > 0) {
    const snapshots = getRouteSnapshots()
    for (const name of requestedUniqueNames) {
      if (snapshots?.has(name)) continue
      let foundAsToken = false
      if (snapshots) {
        for (const snap of snapshots.values()) {
          if (snap.uniqueTokens.includes(name)) {
            foundAsToken = true
            break
          }
        }
      }
      if (!foundAsToken) {
        registryMiss = true
        break
      }
    }
  }

  if (!state.isPartialRefetch || registryMiss) {
    enterRequestRegistry(routeKey, "streaming")
    const streamState: PartialRequestState = {
      ...state,
      requestedIds: null,
      isPartialRefetch: false,
    }
    enterPartialState(streamState)
    return <PartialsClient mode="streaming">{children}</PartialsClient>
  }

  // Already in cache-mode ctx from the pre-enter above.
  enterPartialState(state)

  const activeIds = [...(state.requestedIds ?? [])]
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(id)
      if (!snap) return null
      return partialFromSnapshot(id, snap, partialProps[id])
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  return React.createElement(PartialsClient, { mode: "cache" }, ...wrappedChildren)
}

export function getSpecComponentById(
  id: string,
): SpecComponent<Record<string, unknown>> | undefined {
  return componentById.get(id)
}

export function lookupSpecComponentForCmsId(
  cmsId: string,
): SpecComponent<Record<string, unknown>> | undefined {
  const spec = getSpecByCmsId(cmsId)
  return spec?.Component as SpecComponent<Record<string, unknown>> | undefined
}
