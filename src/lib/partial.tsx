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
} from "../framework/cms-runtime.ts"
import { getRequest, matchRoutePattern } from "../framework/context.ts"
import { getSessionFrameUrl, setSessionFrameUrl } from "../framework/session.ts"

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
  request: Request
  params: Record<string, string>
  cms: CmsReadSurface
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

export interface PartialOptions<V> {
  match?: string
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

export interface PartialComponentProps {
  parent: PartialCtx
  /** Per-instance cmsId override (used by slots). */
  cmsId?: string
  /** Pass-through children — surfaced to `Render` as `children` in
   *  its props bag. Lets specs act as JSX wrappers (e.g. opening a
   *  frame around author content). */
  children?: ReactNode
}

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
  })
  return children
}

// ─── Registry of spec components, keyed by effective id ────────────────

const componentById = new Map<string, FC<PartialComponentProps>>()

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

function createSpecComponent<V>(spec: InternalSpec<V>): FC<PartialComponentProps> {
  const Component: FC<PartialComponentProps> = ({
    parent,
    cmsId: cmsIdOverride,
    children: outerChildren,
  }) => {
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
    if (opts.match) {
      const pageUrl = new URL(getRequest().url)
      const matched = matchRoutePattern(pageUrl.pathname, opts.match)
      if (matched === null) return null
      params = matched
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
    let varyResult: unknown
    if (opts.vary) {
      const v = opts.vary({ request: ourRequest, params, cms })
      if (v === null) return null
      varyResult = v
    } else {
      // No `vary` declared. Default: fold match params + the full
      // request URL search string into the dependency surface. This
      // keeps "wrapper" specs (chrome with no own state) reactive to
      // URL changes their descendants might depend on. If a spec
      // wants to fp-skip across URL changes, it must declare a vary
      // that returns a stable shape.
      varyResult = {
        ...params,
        __search: new URL(ourRequest.url).search,
      }
    }

    // ── Fingerprint ──
    const cmsKey = effectiveCmsId
      ? cmsFingerprintContribution(effectiveCmsId, ourRequest)
      : ""
    const ownFrameKey = opts.frame ? `|frame=${ourFrameChain.join(".")}:${ourRequest.url}` : ""
    const ambientFrameKey =
      opts.frame == null && ourFrameChain.length > 0
        ? `|inFrame=${ourFrameChain.join(".")}:${ourRequest.url}`
        : ""
    const structuralFp = djb2(
      `${id}|vary=${stableStringify(varyResult)}${cmsKey}${ownFrameKey}`,
    )
    const fp = djb2(
      `${id}|vary=${stableStringify(varyResult)}${cmsKey}${ownFrameKey}${ambientFrameKey}`,
    )

    // ── Skip decisions ──
    const state = getPartialState() ?? null

    const isExplicit = state?.explicitIds.has(id) ?? false
    const cachedFp = state?.cachedFingerprints.get(id)
    const fingerprintMatches = cachedFp != null && cachedFp === fp
    const shouldSkip = state ? !isExplicit && fingerprintMatches : false

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
    const renderProps = {
      ...(varyResult as object),
      parent: childCtx,
      cmsId: effectiveCmsId,
      children: outerChildren,
    } as V & RenderArgs
    const fallback = opts.fallback ?? null

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
  partial<V extends object>(
    Render: (props: V & RenderArgs) => ReactNode,
    matchOrOpts: string | PartialOptions<V> = {},
  ): FC<PartialComponentProps> {
    const options: PartialOptions<V> =
      typeof matchOrOpts === "string" ? { match: matchOrOpts } : matchOrOpts

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
      Render,
      isSlotBlock,
    }

    const Component = createSpecComponent(spec)
    componentById.set(id, Component)

    registerSpec({
      id,
      cmsId,
      type,
      selectorTokens: parsed,
      Component,
      isSlotBlock,
      vary: options.vary as ((scope: VaryScope) => unknown) | undefined,
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

function partialFromSnapshot(id: string, snap: PartialSnapshot): ReactNode {
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
  return <Component parent={parent} cmsId={cmsIdOverride} />
}

export async function PartialRoot({ children }: PartialRootProps): Promise<ReactNode> {
  const requestUrl = new URL(getRequest().url)
  const partialsParam = requestUrl.searchParams.get("partials")
  const tagsParam = requestUrl.searchParams.get("tags")
  const cachedParam = requestUrl.searchParams.get("cached")
  const populateCache = requestUrl.searchParams.has("__populateCache")

  const frameNames = requestUrl.searchParams.getAll("__frame")
  const frameUrls = requestUrl.searchParams.getAll("__frameUrl")
  if (frameNames.length > 0 && frameNames.length === frameUrls.length) {
    for (let i = 0; i < frameNames.length; i++) {
      const path = frameNames[i].split(".").filter(Boolean)
      if (path.length > 0) setSessionFrameUrl(path, frameUrls[i])
    }
  }

  const route = requestUrl.pathname
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
    enterRequestRegistry(route, "streaming")
    const streamState: PartialRequestState = {
      ...state,
      requestedIds: null,
      isPartialRefetch: false,
    }
    enterPartialState(streamState)
    return <PartialsClient mode="streaming">{children}</PartialsClient>
  }

  enterRequestRegistry(route, "cache")
  enterPartialState(state)

  const activeIds = [...(state.requestedIds ?? [])]
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(id)
      if (!snap) return null
      return partialFromSnapshot(id, snap)
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  return React.createElement(PartialsClient, { mode: "cache" }, ...wrappedChildren)
}

export function getSpecComponentById(id: string): FC<PartialComponentProps> | undefined {
  return componentById.get(id)
}

export function lookupSpecComponentForCmsId(cmsId: string): FC<PartialComponentProps> | undefined {
  const spec = getSpecByCmsId(cmsId)
  return spec?.Component
}
