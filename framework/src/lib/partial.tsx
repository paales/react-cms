/**
 * `parton(Render, ...)` — define-step constructor.
 *
 * One spec call at module scope produces a placeable React component.
 * `match` chooses which instance renders (variant identity, typed
 * params); everything else the spec depends on, its schema/body READS
 * via tracked hooks (`cookie()`, `searchParam()`, `match()`, cells,
 * CMS) — the read IS the dependency, recorded on the render and folded
 * into the fingerprint by store-and-reread.
 *
 *   const PokemonPage = parton(PokemonRender, '/pokemon/:id')
 *   <PokemonPage />
 *
 * Per-instance render-id overrides flow in through the framework-
 * internal `__instanceId` JSX prop — the same Component renders with
 * that id taking the place of the spec's catalog id (slot wiring sets
 * it to the slot entry's id).
 *
 * See `docs/reference/partial.md`.
 */

import React, {
  Activity,
  Suspense,
  cloneElement,
  isValidElement,
  type FC,
  type ReactElement,
  type ReactNode,
} from "react"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { _childContext, ParentContext, type PartialCtx } from "./partial-context.ts"
import { PartialErrorBoundary, PartialErrorCard } from "./partial-error-boundary.tsx"
import { PageUrlProvider, PartialsClient } from "./partial-client.tsx"
import { Cache } from "./cache.tsx"
import type { CacheOptions } from "./cache-options.ts"
import { RemoteFrame } from "./remote-frame.tsx"
import type { Capability } from "../runtime/capability.ts"
import {
  committedDepsEvidence,
  effectiveExpiresAt,
  enterRequestRegistry,
  getActiveRegistry,
  getFoldBaseSnapshots,
  getRouteSnapshots,
  lookupPartial,
  registerPartial,
  type PartialSnapshot,
} from "./partial-registry.ts"
import {
  enterPartialState,
  getPartialState,
  type PartialRequestState,
} from "./partial-request-state.ts"
import {
  getSpecById,
  registerSpec,
  type SpecComponentProps,
} from "./spec-catalog.ts"
import {
  _getCachedOverride,
  _setCachedOverride,
  getRequest,
  parseCookies,
} from "../runtime/context.ts"
import { HEADER_RSC_RENDER, stripFrameworkParams } from "../runtime/request.tsx"
import {
  parseSelector as parseInvalidationSelector,
  queryMatchingTs,
} from "../runtime/invalidation-registry.ts"
import {
  createSessionReadSurface,
  getSessionFrameUrl,
  setSessionFrameUrl,
  type SessionReadSurface,
} from "../runtime/session.ts"
import {
  buildResolvedCell,
  computeCellPartitionKey,
  finalizeScopedCell,
  getCellById,
  isBoundCell,
  isModuleCell,
  isScopedCellDescriptor,
  resolveCellValue,
  type BoundCell,
  type CellInterface,
  type CellArgs,
  type CellPartitionScope,
  type ResolvedCell,
  type ScopedCellDescriptor,
} from "./cell.ts"
import { getCellStorage } from "../runtime/cell-storage.ts"
import { _getSettleTrailerSink, getScope } from "../runtime/context.ts"
import { buildTimeScope, type TimeScope } from "./time.ts"
import { _onPartonSettled, _openPartonSettleScope, getServerContext } from "./server-context.ts"
import { _setCurrentParton, type CurrentParton, type WakeHints } from "./current-parton.ts"
import { baseKey, culledKey, isCulledKey } from "./cull-key.ts"
import { CullSlot } from "./cull-slot.tsx"
import { evalDepKeys, readVisible } from "./server-hooks.ts"

export { ROOT, type PartialCtx } from "./partial-context.ts"

// ─── Types ─────────────────────────────────────────────────────────────

/** A refetch label. Plain string; the framework treats CSS-style
 *  `#foo` / `.foo` prefixes as cosmetic and strips them on parse.
 *  Multiple labels per spec are allowed (fan-out refetch targets). */
export type SelectorToken = string
export type SelectorTokens = SelectorToken | SelectorToken[]

export interface ActivatorProps {
  partialId?: string
  children?: ReactNode
}

export type DeferSpec = true | ReactElement<ActivatorProps>

/** Build a plain `{key: value}` object from a URLSearchParams. */
function searchParamsToRecord(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of sp) out[k] = v
  return out
}

/** Lowercase + flatten a `Headers` instance into a plain record.
 *  Framework-internal `x-parton-*` headers (e.g. the RSC-render marker)
 *  are dropped so they never reach a spec's header read surface or
 *  fold into its fingerprint. */
function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h) {
    const lk = k.toLowerCase()
    if (lk.startsWith("x-parton-")) continue
    out[lk] = v
  }
  return out
}

export interface RenderArgs {
  /** Outer `children` passed to the spec component, when used as a
   *  JSX wrapper. `undefined` when the spec was placed without
   *  children. A parton's descendants inherit their `parent` from
   *  server context (the ambient parton) — Render receives no `parent`. */
  children?: ReactNode
}

import { compileMatch, type CompiledMatch, type MatchPattern } from "./match.ts"

export { compileMatch, type CompiledMatch, type MatchInit, type MatchPattern } from "./match.ts"

export type PartialOptions<V> = Pick<
  InternalSpecConfig<V>,
  | "match"
  | "cache"
  | "defer"
  | "fallback"
  | "keepalive"
  | "fpSkip"
  | "selector"
  | "capabilityType"
>

/**
 * Internal merged options consumed by `buildSpecComponent`.
 * `parton()` marshals to this shape; the CMS layer's
 * `block()` wrapper composes a CMS-aware Render and feeds it through
 * the same builder via `_buildPartial`.
 */
interface InternalSpecConfig<V> {
  /** URLPattern gate. Spec emits nothing on miss. */
  match?: MatchPattern
  /** Refetch labels (whitespace string or array). First label is the
   *  spec catalog id; additional labels are extra fan-out targets.
   *  Auto-derives from `Render.name` when omitted. */
  selector?: SelectorTokens
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
  /** When `true` (default), wraps the spec's rendered body in
   *  `<Activity mode="visible">` while active and emits
   *  `<Activity mode="hidden">` with a placeholder when `match` says
   *  the spec shouldn't render on this request — provided
   *  the client has previously cached this id (signalled via
   *  `?cached=id:fp`). The spec component fiber lives at its natural
   *  JSX position (e.g. a root.tsx sibling), so Activity mode flips
   *  rather than the subtree mounting/unmounting; `useState` /
   *  `useRef` / DOM state inside the partial survive cross-route
   *  navigation, refetching only when the fingerprint differs.
   *
   *  Set to `false` for partials that genuinely should be torn down
   *  on cross-route nav (heavy video / iframe DOM, partials whose
   *  state is meaningful only while visible, debug-only specs). */
  keepalive?: boolean
  /** When `false`, this spec is never served from the client's cache
   *  on a fingerprint match — every request renders it fresh. For
   *  always-authoritative surfaces (the CMS editor chrome) whose
   *  output must track the request exactly. Default `true`. */
  fpSkip?: boolean
  /** Capability schema name for this spec — referenced by the
   *  `/__remote/manifest.json` endpoint so the `parton add` CLI can
   *  generate typed bindings (`remote<TypeName>({…})`). The string
   *  must match a type exported from the remote app's
   *  `remote-types.ts` (served at `/__remote/types.d.ts`). Omit if
   *  the spec doesn't read capability values. */
  capabilityType?: string
}

/**
 * Framework-managed props every spec component understands. Plain
 * pass-through props (e.g. `id` from a parent wrapper) live in the
 * `Extra` parameter of `SpecComponent<Extra>` — they flow into Render
 * alongside the match params and contribute to the cache fingerprint.
 */
export interface PartialComponentProps {
  /** Internal: parent injected for an isolated render that's its own
   *  render root (cache hole / `partialFromSnapshot` refetch), where there
   *  is no ambient parton. Overrides the server-context parent. Authors
   *  never pass this — a parton's `parent` flows via server context. */
  __parent?: PartialCtx
  /** Pass-through children — surfaced to `Render` as `children` in
   *  its props bag. Lets specs act as JSX wrappers (e.g. opening a
   *  frame around author content). */
  children?: ReactNode
}

/**
 * The Render function's props get split by the framework into three:
 *   - framework-managed (`children`) — `RenderArgs`, always supplied
 *     by the framework.
 *   - framework-derived (`V`) — match params + resolved schema +
 *     actions, also framework-supplied.
 *   - everything else — must be passed as a JSX prop at the call site.
 *
 * `SpecExtraProps<R, V>` is the call-site prop surface: `R` minus the
 * framework keys minus `V`'s keys. When `V` covers the entire prop
 * surface, `SpecExtraProps` collapses to `{}` and the call site is
 * just `<Spec />`.
 */
/** A prop the Render receives as `ResolvedCell<T>` may be SUPPLIED at
 *  the call site as a `BoundCell<T>` (`cell.with(args)`) or a `CellInterface<T>`
 *  (module / scoped handle) — the framework resolves it to a
 *  `ResolvedCell<T>` in the props phase before Render runs. Widen each
 *  such prop so the JSX call site type-checks against what authors
 *  actually pass. Non-cell props pass through unchanged. */
type AcceptBindableCell<X> = [X] extends [ResolvedCell<infer T>]
  ? ResolvedCell<T> | BoundCell<T> | CellInterface<T>
  : X
export type SpecExtraProps<R, V> = {
  [K in keyof Omit<R, keyof RenderArgs | keyof V>]: AcceptBindableCell<
    Omit<R, keyof RenderArgs | keyof V>[K]
  >
}

/**
 * Read a URLPattern parameter name from the start of a string,
 * stopping at the first character that terminates the name. URLPattern
 * names run until any of `/`, `(` (start of regex), `?`/`+`/`*`
 * (modifiers), `{`/`}` (group brackets), or `.`.
 */
type ReadParamName<S extends string, Acc extends string = ""> = S extends `${infer C}${infer R}`
  ? C extends "/" | "(" | "?" | "+" | "*" | "{" | "}" | "."
    ? [Acc, S]
    : ReadParamName<R, `${Acc}${C}`>
  : [Acc, S]

/**
 * Skip a `(regex)` modifier following a parameter name. URLPattern
 * lets authors constrain a param's accepted shape via regex
 * (`:id(\\d+)`); the constraint affects matching at runtime but the
 * TS surface stays `string`. We just need to skip the parens.
 *
 * Doesn't handle nested parens; URLPattern itself doesn't either.
 */
type SkipParamRegex<S extends string> = S extends `(${string})${infer After}` ? After : S

/**
 * Parse a URLPattern path string into a `{ name: string }` shape at
 * the type level. Handled tokens:
 *   `/:foo`               → `{ foo: string }`
 *   `/:foo?`              → `{ foo?: string }`               (optional)
 *   `/:foo+ /:foo*`       → `{ foo: string }`                (URLPattern flattens repeating to one string)
 *   `/:foo(<regex>)`      → `{ foo: string }`                (regex constraint, value still string)
 *   `/*`                  → not in result                    (anonymous wildcard captures don't contribute)
 *   `/{group}?`           → group brackets are stripped; named params inside parse normally
 *
 * Patterns with no named `:param` segments resolve to `object`. The
 * runtime URLPattern is the source of truth for what actually matches;
 * unparseable corners fall through and the prop is just absent.
 */
export type ParseRoute<T extends string> = T extends `${string}:${infer Rest}`
  ? ReadParamName<Rest> extends [infer Name extends string, infer Tail extends string]
    ? Name extends ""
      ? ParseRoute<Tail>
      : SkipParamRegex<Tail> extends `?${infer After}`
        ? { [K in Name]?: string } & ParseRoute<After>
        : SkipParamRegex<Tail> extends `${"+" | "*"}${infer After}`
          ? { [K in Name]: string } & ParseRoute<After>
          : { [K in Name]: string } & ParseRoute<SkipParamRegex<Tail>>
    : object
  : object

/**
 * Infer the framework-supplied prop surface (`V`) from the options
 * object. Resolution order:
 *   1. string shorthand (`partial(Render, "/x/:id")`) → match-only,
 *      params auto-flow as `ParseRoute<pattern>`.
 *   2. options with `match` → params auto-flow as
 *      `ParseRoute<pattern>`.
 *   3. anything else → empty: every Render prop must come from the
 *      JSX call site or a tracked hook read inside the body.
 *
 * This is what makes `{ match: "/pokemon/:id" }` enough to wire
 * `params.id` into a Render that takes `{ id: string }`. Everything
 * request-shaped beyond params, a body READS — `cookie()`,
 * `searchParam()`, `match()` — and the hook return types carry the
 * information.
 */
type InferMatch<Opts> = Opts extends string
  ? ParseRoute<Opts>
  : Opts extends { match: infer M }
    ? M extends string
      ? ParseRoute<M>
      : M extends { pathname: infer P extends string }
        ? ParseRoute<P>
        : object
    : object

export type InferV<Opts> = Prettify<InferMatch<Opts>>

/** Flatten a `T1 & T2 & …` intersection into a single object literal
 *  shape so editor hovers display the merged keys, not a chain. */
type Prettify<T> = { [K in keyof T]: T[K] } & {}

/**
 * The full prop bag a spec's Render function receives:
 * match/schema/action-derived keys + framework-managed keys.
 * Re-exposed as `Spec.props` (type-only phantom) for ergonomic
 * inference at the call site (`function R(p: typeof Spec.props)`).
 */
export type InferRenderProps<Opts> = Prettify<InferV<Opts> & RenderArgs>

/**
 * A parton Render's prop bag: the author's own props `V` plus the
 * framework-managed `RenderArgs` (`parent`, `children`, …). Reads better
 * than spelling out `V & RenderArgs` at every Render:
 *
 *     function CartLineRender({ item }: PartonProps<{ item: ResolvedCell<…> }>) { … }
 */
export type PartonProps<V = object> = Prettify<V & RenderArgs>

/**
 * Spec component type. The JSX call-site sees framework props AND
 * any Render prop the framework-derived surface doesn't already
 * provide.
 *
 * `Props` (second generic) is a phantom that exposes the Render-side
 * prop bag via `typeof Spec.props`. The runtime never reads it; it's
 * a TypeScript-only static. Use it to derive the function signature
 * without retyping the derived surface:
 *
 *     const Hero = parton(HeroRender, { match: "/p/:id" })
 *     type HeroProps = typeof Hero.props        // { id: string } & RenderArgs
 *
 * `typeof Hero.props` resolves AFTER the spec is constructed. The
 * builder overload (`partial(opts)`) handles the forward-reference
 * pattern where the Render needs the type before the spec exists.
 */
export type SpecComponent<Extra = unknown, Props = unknown> = FC<PartialComponentProps & Extra> & {
  /** Phantom — `typeof Spec.props` resolves to the prop bag the
   *  framework supplies to Render. No runtime value. */
  readonly props: Props
}

/**
 * Builder returned by the single-argument `partial(opts)` form.
 * Lets author derive `typeof Builder.props` BEFORE the Render
 * function exists, sidestepping the circular initializer that
 * `const Spec = partial(R, opts); function R(p: typeof Spec.props)`
 * triggers.
 *
 *     const HeroBuilder = parton({ match: "/p/:id" })
 *     function HeroRender(p: typeof HeroBuilder.props) { … }
 *     const Hero = HeroBuilder(HeroRender)
 *
 * The builder is callable: passing the Render finishes the spec.
 */
export type PartialBuilder<Opts, V = InferV<Opts>> = {
  /** Phantom — `typeof Builder.props` is the Render prop bag. */
  readonly props: Prettify<V & RenderArgs>;
  /** Bind a Render to produce the final spec component. */
  (Render: (props: V & RenderArgs) => ReactNode): SpecComponent<object, Prettify<V & RenderArgs>>
}

// ─── Selector parsing & id derivation ─────────────────────────────────
//
// Selectors are flat lists of string labels. The parser strips leading
// `#` or `.` as cosmetic (legacy CSS-style syntax keeps working), but
// the framework no longer distinguishes "unique" from "shared" — all
// labels are fan-out refetch targets. A spec's labels are stored on
// its snapshot; `reload({selector: "foo"})` matches every spec whose
// label set contains "foo" (or whose catalog id is "foo").

interface ParsedSelector {
  labels: string[]
}

function stripPrefix(tok: string): string {
  if (tok.startsWith("#") || tok.startsWith(".")) return tok.slice(1)
  return tok
}

function parseSelector(input: SelectorTokens): ParsedSelector {
  const raw = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
  if (raw.length === 0) {
    throw new Error("parton: selector is empty")
  }
  const labels: string[] = []
  for (const tok of raw) {
    const name = stripPrefix(tok)
    if (!name) throw new Error(`Empty selector token in "${tok}"`)
    if (!labels.includes(name)) labels.push(name)
  }
  return { labels }
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
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
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
 * dependency surface read `pathname()` / `searchParam()`
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

/**
 * Resolve the request URL for a partial under a frame chain. Reads
 * the session-bound URL for the chain (populated by `<Frame>`); falls
 * back to the page request when no session entry exists.
 */
function resolveFrameRequest(framePath: readonly string[]): Request {
  const pageRequest = getRequest()
  const sessionUrl = getSessionFrameUrl(framePath)
  if (sessionUrl == null) return pageRequest
  const resolved = new URL(sessionUrl, pageRequest.url).toString()
  return new Request(resolved, { headers: pageRequest.headers, method: "GET" })
}

// ─── PartialBoundary — registers + passes children through ────────────

interface PartialBoundaryProps {
  id: string
  type: string
  parentPath: readonly string[]
  /** Refetch labels carried by this rendered instance. Any
   *  `reload({selector: "label"})` matching one of these labels
   *  targets this spec. The first label is always `id` itself, so
   *  refetching by spec catalog id works without an explicit
   *  selector. */
  labels: string[]
  framePath: readonly string[]
  parentFrameChain: readonly string[]
  cache?: CacheOptions
  fallback: ReactNode
  /** Call-site JSX props (e.g. `id` from a parent wrapper). Stored
   *  in the snapshot so partial-refetch in cache mode can replay
   *  them when re-rendering the spec without its parent. */
  props?: Record<string, unknown>
  /** Resolved bound-cell args (schema + props). Snapshotted so the
   *  descendant-fold can match partition-scoped invalidation signals
   *  against the spec's effective constraint surface, not just its
   *  match-params. */
  constraintArgs?: Record<string, unknown>
  /** Hash of the spec's varyResult — feeds the descendant fold so
   *  ancestors' fps reflect descendants' deps. */
  varyKey?: string
  /** Tracked-read dependency keys (`cookie:…`, `search:…`) recorded by
   *  server-hooks during this render. The live Set, so post-await reads
   *  land before the next render consults it. */
  deps?: ReadonlySet<string>
  /** Variant key for this rendered instance — see `deriveMatchKey`.
   *  Stored on the snapshot so the fp-trailer's `recomputeFp` can
   *  read it without re-deriving from the catalog. */
  matchKey?: string
  /** `|schema=<hash>` term folded into this spec's own structural fp —
   *  the resolved-cell surface. Snapshotted so the fp-trailer's
   *  `recomputeFp` folds the identical term (it can't re-resolve cells
   *  at flush). Empty for any spec that resolves no cells. */
  schemaKey?: string
  /** The full fp baked into this spec's PartialErrorBoundary prop —
   *  i.e. what the client ends up registering. Stored on the snapshot
   *  so the fp-trailer flush can detect cold→warm drift and ship the
   *  warm fp to the client without an extra round-trip. */
  emittedFp?: string
  /** Live wake-hint box the `expires()` / `staleUntil()` hooks write
   *  into during schema/Render. The render path passes the
   *  CurrentParton's box; skip/defer paths (where Render doesn't run)
   *  thread the prior snapshot's box through so a hook-declared wake
   *  survives. */
  wakeHints?: WakeHints
  /** This registration is the parton's CULLED render — it lands in the
   *  `~cull` registry variant beside the in-view one, so each state
   *  keeps its own dep record. See `PartialSnapshot.culled`. */
  culled?: boolean
  children: ReactNode
}

export function PartialBoundary({
  id,
  type,
  parentPath,
  labels,
  framePath,
  parentFrameChain,
  cache,
  fallback,
  props,
  constraintArgs,
  varyKey,
  deps,
  matchKey,
  schemaKey,
  emittedFp,
  wakeHints,
  culled,
  children,
}: PartialBoundaryProps): ReactNode {
  // Two dep kinds double as invalidation selectors and ride in `deps`
  // (folding into the fp via store-and-reread): inline-cell deps
  // (`cell:<id>?<part>` — the selector verbatim) and render-body tags
  // (`tag:<name>` — the selector is the name, prefix stripped). Surface
  // both as refetch labels and fold their constraints into the
  // constraint surface, so a partition-scoped write (`cell:<id>?sid=`)
  // or a constrained tag bump matches this parton. Schema-phase cells
  // and tags got this in `expandedLabels`; these are declared
  // mid-Render, too late for that — but recorded by the time the
  // boundary registers, so fold them in here.
  const rideDeps = deps
    ? [...deps].filter((d) => d.startsWith("cell:") || d.startsWith("tag:"))
    : []
  let labelsWithCells = labels
  let constraintsWithCells = constraintArgs
  if (rideDeps.length > 0) {
    const parsed = rideDeps.map((d) =>
      parseInvalidationSelector(d.startsWith("tag:") ? d.slice("tag:".length) : d),
    )
    labelsWithCells = [...labels, ...parsed.map((p) => p.name)]
    constraintsWithCells = { ...constraintArgs }
    for (const p of parsed) Object.assign(constraintsWithCells, p.constraints)
    if (Object.keys(constraintsWithCells).length === 0) constraintsWithCells = constraintArgs
  }
  registerPartial(id, {
    type,
    fallback,
    labels: labelsWithCells,
    framePath,
    parentFrameChain,
    parentPath,
    cache,
    props,
    constraintArgs: constraintsWithCells,
    varyKey,
    deps,
    matchKey,
    schemaKey,
    emittedFp,
    wakeHints,
    culled,
  })
  return children
}

// ─── Registry of spec components, keyed by effective id ────────────────

/** Internal map type — narrower than the public `SpecComponent` (no
 *  `.props` phantom needed for slot lookups). */
type StoredSpecFC = FC<PartialComponentProps & Record<string, unknown>>
const componentById = new Map<string, StoredSpecFC>()

/**
 * Per-pass scratch for the descendant fold. Built once from the fold
 * base (the canonical prior-commit snapshots for the route) and reused
 * across every `computeDescendantFold` call in the pass.
 *
 *  - `index` maps each ancestor id to the `(descId, snap)` pairs whose
 *    `parentPath` includes it, so a fold is O(its descendants) instead
 *    of O(tree); a leaf with no descendants is O(1) (absent key → "").
 *  - `contributions` memoizes `descendantContribution(descId)`: the
 *    contribution depends only on `(descId, snap, current request)`,
 *    never on which ancestor folds it (the function reads no ancestor
 *    state), so it's computed once and reused by every ancestor.
 */
interface FoldScratch {
  base: Map<string, PartialSnapshot>
  index: Map<string, Array<readonly [string, PartialSnapshot]>>
  contributions: Map<string, string>
}

/**
 * Get (or build) the per-pass fold scratch. Keyed on the fold base map
 * identity: `getFoldBaseSnapshots` returns the same map object for the
 * whole pass, so when it changes (a re-enter under a different
 * store/route) the scratch rebuilds. Outside a registry context the
 * scratch can't be cached on the ctx, so it's rebuilt per call — that
 * path (HMR / prerender) isn't the hot live-tick loop.
 */
function foldScratch(): FoldScratch {
  const base = getFoldBaseSnapshots()
  const ctx = getActiveRegistry()
  const cached = ctx?.foldScratch as FoldScratch | undefined
  if (cached && cached.base === base) return cached

  const index = new Map<string, Array<readonly [string, PartialSnapshot]>>()
  for (const [descId, snap] of base) {
    for (const ancestorId of snap.parentPath) {
      if (ancestorId === descId) continue
      let bucket = index.get(ancestorId)
      if (!bucket) {
        bucket = []
        index.set(ancestorId, bucket)
      }
      bucket.push([descId, snap] as const)
    }
  }
  const scratch: FoldScratch = { base, index, contributions: new Map() }
  if (ctx) ctx.foldScratch = scratch
  return scratch
}

/**
 * Compute the descendant-fp fold for a spec.
 *
 * Walks the previous-render snapshots for descendants of `ancestorId`
 * (snapshots whose `parentPath` includes the ancestor) and resolves
 * each descendant's stored deps against the CURRENT request — without
 * actually re-rendering the descendant. This makes the ancestor's
 * fingerprint move whenever any descendant's deps would have moved,
 * so fp-skipping the ancestor never serves a stale subtree.
 *
 * The stored manifest schema (snapshot + spec catalog) is resolved at
 * the parent's render time rather than via lagged stored values.
 * Returns a string suffix to fold into the parent's hash — empty
 * string when there are no descendants.
 *
 * The descendant set and each descendant's contribution come from
 * per-pass scratch (`foldScratch`), so the cost is O(this ancestor's
 * descendants) with each contribution evaluated once per pass — not a
 * full route-snapshot rebuild + scan per call.
 */
function computeDescendantFold(ancestorId: string): string {
  const scratch = foldScratch()
  const bucket = scratch.index.get(ancestorId)
  if (!bucket || bucket.length === 0) return ""

  const parts: string[] = []
  for (const [descId, snap] of bucket) {
    let contribution = scratch.contributions.get(descId)
    if (contribution === undefined) {
      contribution = descendantContribution(descId, snap)
      scratch.contributions.set(descId, contribution)
    }
    parts.push(contribution)
  }
  // Order shouldn't matter for fingerprint stability, but sorting
  // keeps it deterministic across registry iteration order changes.
  parts.sort()
  return `|desc=${hash(parts.join(","))}`
}

/**
 * Compute one descendant's contribution to its ancestor's fp.
 * Re-evaluates the descendant's match + stored deps against the current
 * request so URL/cookie/header/CMS changes flow through to the
 * ancestor's fp without lag. Falls back to the snapshot's stored
 * `varyKey` when the catalog entry isn't available (e.g. the spec
 * module hasn't loaded yet on the current process).
 */
function descendantContribution(descId: string, snap: PartialSnapshot): string {
  // Slot-block instances register their snapshot with a per-instance
  // render id (the entry id, e.g. `composed-hero-2`), but the spec
  // catalog has them under their `type` (e.g. `hero`). Resolve by
  // `snap.type` directly — `type` is the spec catalog key for both
  // page specs and slot blocks now that the id/id conflation is
  // gone.
  const spec = snap.type ? getSpecById(snap.type) : undefined
  // No live spec → fall back to last-known varyKey. Prevents the
  // fold from becoming all-stable when the registry is warm but the
  // catalog is still hydrating; lag of one render in this corner.
  if (!spec) return `${descId}:${snap.varyKey ?? ""}${invalidationKeyFromSnap(snap)}`

  // Honor the descendant's framePath when re-reading its deps. A
  // descendant rendered under a frame chain (e.g. MenuTabPartial under
  // ["menu","tab"]) reads the frame's URL at render time; the fold
  // must use the same frame-resolved request so a nested-frame nav
  // that only moves the inner frame's URL actually shifts the
  // descendant's contribution and, through it, the outer wrapper's
  // fp. Without this the outer wrapper fp-skips and the cached tab
  // body persists across nested-frame moves.
  const request = snap.framePath.length > 0 ? resolveFrameRequest(snap.framePath) : getRequest()
  // Tracked-read deps the descendant recorded on its own render
  // (`cookie()`/`searchParam()` via server-hooks), re-read against the
  // current request — the store-and-reread fold that lets an
  // ancestor's fp move when a descendant's request reads change. Empty
  // for any descendant that records no tracked reads.
  const depsKey = evalDepKeys(snap.deps, request)
  let params: Record<string, string> = {}
  if (spec.match) {
    const verdict = spec.match.evaluate(request)
    if (!verdict.matched) return `${descId}:nomatch${invalidationKeyFromSnap(snap)}`
    params = verdict.params
  }

  // Match params + bound-cell args form the constraint surface for
  // invalidation matching. Bound args come from the snapshot's
  // `constraintArgs` (populated during the live render from BOTH
  // schema-resolved cells and prop-resolved BoundCells). Without
  // folding bound args, partition-scoped `cell:<id>?<args>` signals
  // can't match descendants that bind cells (e.g.
  // <CartLine item={cartItemCell.with({uid})}/> or a parton with
  // `schema: () => ({cart: cartCell})`).
  const constraints = { ...params, ...(snap.constraintArgs ?? {}) }
  const inv = invalidationKeyFor(snap.labels, constraints)
  return `${descId}:${stableStringify(params)}|${stableStringify(snap.props ?? null)}${inv}${depsKey}`
}

/**
 * Query the invalidation registry for the descendant's labels +
 * constraint-matched inputs and produce a `|inv=N` suffix when
 * any entry has fired. Folded into descendant contributions so an
 * ancestor's fp moves whenever a descendant's invalidation does —
 * without this, an ancestor's `varyKey`-only fold stays stable when
 * only a descendant's `|inv=N` shifted, the ancestor fp-skips, and
 * the descendant's fresh content is starved on subsequent segments
 * of a streaming response.
 */
function invalidationKeyFor(
  labels: readonly string[],
  varyInputs: Record<string, unknown> | null,
): string {
  const ts = queryMatchingTs(labels, varyInputs)
  return ts > 0 ? `|inv=${ts}` : ""
}

function invalidationKeyFromSnap(snap: PartialSnapshot): string {
  let parsed: Record<string, unknown> | null = null
  if (snap.varyKey) {
    try {
      parsed = JSON.parse(snap.varyKey) as Record<string, unknown>
    } catch {
      parsed = null
    }
  }
  return invalidationKeyFor(snap.labels, parsed)
}

/**
 * Every distinct match gate any spec was constructed with. Populated
 * as a side effect of `parton(..., { match: ... })` via
 * `registerMatch`. The URL-pattern halves feed
 * `getRegisteredMatchPatterns()` (the 404-fallback helper) and
 * `computeRouteKey` (the matched-set hash input); predicate and
 * request-record fields gate specs but never split route buckets —
 * the same rule search patterns already follow.
 */
const registeredMatches: CompiledMatch[] = []

/** Signatures of every registered match — the dedup gate for
 *  `registerMatch`. */
const registeredMatchSignatures = new Set<string>()

/**
 * Register a spec's compiled match, deduplicated by signature. HMR
 * re-executes a spec module and runs the constructor again with the
 * same gate; appending a duplicate would change the matched-signature
 * list `computeRouteKey` hashes, shifting every affected routeKey
 * across the edit and orphaning the registry's per-routeKey hints.
 * Predicates sign by source text, so an edited predicate body counts
 * as a new gate (and correctly shifts route keys).
 */
function registerMatch(compiled: CompiledMatch): void {
  if (registeredMatchSignatures.has(compiled.signature)) return
  registeredMatchSignatures.add(compiled.signature)
  registeredMatches.push(compiled)
  // Adding a gate invalidates the routeKey cache — a URL whose
  // matched-set previously excluded this pattern may now include it.
  routeKeyCache.clear()
}

/** Snapshot of every registered gate's URL-pattern half. Predicate-only
 *  gates carry no URL structure and are excluded — they can't name a
 *  page for the 404 fallback nor extract params for actions. */
export function getRegisteredMatchPatterns(): readonly URLPattern[] {
  const out: URLPattern[] = []
  for (const m of registeredMatches) {
    if (m.urlPattern) out.push(m.urlPattern)
  }
  return out
}

/**
 * Compute a routeKey from a URL: a stable hash of WHICH registered
 * URLPatterns match the URL's BASE — scheme + host + pathname, with
 * search and hash stripped BEFORE matching. Two URLs that share a
 * base collapse to one routeKey, so the variant-hint table scales
 * with pattern combinations (a small finite space) instead of
 * distinct pathnames. 50k product URLs that all match `/p/:slug`
 * share one hint entry instead of evicting each other from the LRU;
 * spam traffic to junk URLs that all match the same pattern can't
 * displace real hot routes.
 *
 * Search and hash are request dimensions WITHIN a page — tracked reads,
 * matchKeys, and fingerprints carry them — not part of the page's
 * addressable identity. A pattern that constrains them (`match:
 * { search: "*q=:query" }`) gates its SPEC's rendering against the
 * full URL as always, but never splits its page's registry bucket:
 * a search overlay's `?q=` refetch must find the snapshots, hints,
 * and fold base the page's earlier renders committed, and the
 * fp-trailer must keep the client's warm fps in lockstep across
 * those refetches. Matching the base also makes the routeKey a pure
 * function of the URL — never of request arrival order.
 *
 * Returns `__no-pattern` when nothing matches — those requests don't
 * commit to the registry anyway (`notFound()` throws past the commit),
 * so the sentinel just keeps lookups deterministic on the read side.
 */
/** URL base → routeKey cache. Sound by construction: the matched set
 *  is computed from the base, which is the cache key. Per-segment
 *  streaming responses change only the `?cached=` query each tick;
 *  keying by base lets one streaming request's N segments share one
 *  routeKey computation instead of N. Invalidated by pattern
 *  registration so a new pattern can shift the matched-set for
 *  previously-seen bases. */
const routeKeyCache = new Map<string, string>()
const ROUTE_KEY_CACHE_MAX = 2048

/** Slice a URL down to its base — everything before `?` or `#` —
 *  without paying for `new URL()` on the hot path. */
function extractUrlBase(url: string): string {
  const schemeIdx = url.indexOf("//")
  const pathStart = schemeIdx >= 0 ? url.indexOf("/", schemeIdx + 2) : 0
  const from = pathStart < 0 ? 0 : pathStart
  let end = url.length
  const qIdx = url.indexOf("?", from)
  if (qIdx >= 0 && qIdx < end) end = qIdx
  const hashIdx = url.indexOf("#", from)
  if (hashIdx >= 0 && hashIdx < end) end = hashIdx
  return url.slice(0, end)
}

export function computeRouteKey(url: string): string {
  const base = extractUrlBase(url)
  const cached = routeKeyCache.get(base)
  if (cached !== undefined) return cached
  const matched: string[] = []
  for (const m of registeredMatches) {
    if (m.urlPattern && m.urlPattern.exec(base) !== null) {
      matched.push(m.signature)
    }
  }
  let result: string
  if (matched.length === 0) {
    result = "__no-pattern"
  } else {
    matched.sort()
    result = hash(matched.join(""))
  }
  // Simple FIFO bound. The streaming case repeats one base so the
  // cap is mostly defensive against pathological URL diversity.
  if (routeKeyCache.size >= ROUTE_KEY_CACHE_MAX) {
    const oldest = routeKeyCache.keys().next().value
    if (oldest !== undefined) routeKeyCache.delete(oldest)
  }
  routeKeyCache.set(base, result)
  return result
}

/** Clear the routeKey cache. Used by HMR / test helpers; the framework
 *  itself only clears on pattern registration. */
export function _clearRouteKeyCache(): void {
  routeKeyCache.clear()
}

/** Test-only: wipe the registered-pattern set (and with it the
 *  routeKey cache). Production never unregisters a pattern. */
export function _resetMatchPatterns(): void {
  registeredMatches.length = 0
  registeredMatchSignatures.clear()
  routeKeyCache.clear()
}

// ─── The constructor ──────────────────────────────────────────────────

interface InternalSpec<V> {
  /** Spec's catalog id (default render-time identity when no
   *  per-instance `__instanceId` override is supplied). Derived from
   *  `selector` or auto-named from `Render.name`. */
  id: string
  /** Spec catalog type tag (snapshot.type, used to find the spec
   *  Component in cache-mode refetch when the rendered id differs
   *  from spec.id via an `__instanceId` override). Equal to `id`. */
  type: string
  parsed: ParsedSelector
  options: InternalSpecConfig<V>
  /** Compiled URLPattern for `options.match`, or `undefined` when
   *  the spec has no match. Compiled once at constructor time so
   *  every render-phase `exec` is cheap. */
  match?: CompiledMatch
  Render: (props: V & RenderArgs) => ReactNode
  /** True iff the author explicitly declared at least one of
   *  `selector`, `schema`, or `match`. Non-addressable specs (none of
   *  the three) live entirely inside their parent's render — they
   *  have no external refetch handle, so the per-spec fp cycle is
   *  redundant for them. The render path uses this to gate the
   *  `partialFingerprint` prop on `<PartialErrorBoundary>` and the
   *  `emittedFp` snapshot field; the parent's descendant fold still
   *  covers them for fp-skip safety. Auto-derived selectors (from
   *  `Render.name`) don't count — they're an internal catalog-id
   *  fallback, not an author-declared addressing surface. */
  addressable: boolean
}

/** Constant matchKey for specs with no match-bearing ancestor on the
 *  current URL (root-level specs without match, or descendants of
 *  literal-match specs). 16-char hex hash of `stableStringify({})`. */
const ROOT_MATCH_KEY = hash(stableStringify({}))

/**
 * Resolve the variant identity for a spec rendering this request.
 *
 *  - Spec has its OWN `match` with named params → hash those params.
 *    `/pokemon/1` and `/pokemon/2` get distinct keys.
 *  - Spec has no own named params → walk `parent.path` outer-to-inner
 *    (in reverse: nearest first) and find the closest ancestor in the
 *    catalog whose match produces named params on the current
 *    URL. Hash those. Descendants of `/pokemon/:id` (Hero, Stats, …)
 *    share that variant identity even though their own bodies have no
 *    match.
 *  - No match-bearing ancestor on the URL → `ROOT_MATCH_KEY`. Specs
 *    in this branch share a single cache slot; fp-driven refreshes
 *    update content in place (`/cache-demo?flavor=A` ↔ `?flavor=B`).
 *
 * Self-contained: only reads from the spec catalog plus the current
 * request URL, so partial-refetch (which reconstructs the spec
 * component with `parent.path` from the snapshot) gets the same
 * matchKey as the originating streaming render.
 */
export function deriveMatchKey(
  ownMatch: CompiledMatch | undefined,
  ownParams: Record<string, string>,
  parentPath: readonly string[],
  url?: string,
): string {
  if (ownMatch && Object.keys(ownParams).length > 0) {
    return hash(stableStringify(ownParams))
  }
  const requestUrl = url ?? getRequest().url
  for (let i = parentPath.length - 1; i >= 0; i--) {
    const ancestor = getSpecById(parentPath[i])
    if (!ancestor?.match) continue
    const ancestorParams = ancestor.match.extractParams(requestUrl)
    if (ancestorParams === null || Object.keys(ancestorParams).length === 0) continue
    return hash(stableStringify(ancestorParams))
  }
  return ROOT_MATCH_KEY
}

/** A parton is cullable when it recorded a `visible:` tracked read — its
 *  fp folds its viewport state (server-hooks `visible()`), so the client
 *  wraps it in a viewport observer and self-refetches it as it enters or
 *  leaves view. Derived from the parton's own deps (or the prior snapshot's
 *  on a skip/defer, where Render didn't run this pass). */
function hasVisibleDep(deps: ReadonlySet<string> | undefined): boolean {
  if (!deps) return false
  for (const d of deps) if (d.startsWith("visible:")) return true
  return false
}

/**
 * The `<i data-partial>` marker the client's merge layer resolves
 * against its cache. Two kinds share the shape:
 *
 *   - a HOLE (`confirm` absent) — a position the client MAY fill from
 *     cache: parked-keepalive variants, a cull pair's off slot, and
 *     ordinary fp-skips (heartbeat segments, navigations);
 *   - a CULLING CONFIRMATION (`confirm: true`) — a cull-capable
 *     spec's fp-skip verdict computed against a MEASURED visible set
 *     (a `?__cullFlip=1` reload target, a live connection's lane or
 *     segment — anything whose `visible()` read is not the
 *     pre-measurement `undefined`): the fingerprint of the state
 *     being served matched the client's advertisement, so the
 *     client's copy of THAT state is provably current.
 *
 * The distinction rides the wire as `data-partial-confirm` because
 * one consumer needs it exactly: the cull-park drop-on-drift decision
 * (`contentSlotConfirmed` in the commit walk). A restored parked
 * fiber is confirmed by its flip's placeholder — race-free, in the
 * same commit pipeline that would otherwise deliver the replacing
 * bytes. An UNMEASURED skip must not carry it — a verdict at the
 * pre-measurement state says nothing about the state a parked fiber
 * holds.
 */
function placeholderFor(id: string, matchKey: string, confirm?: boolean): ReactElement {
  return (
    <i
      key={`${id}|${matchKey}`}
      hidden
      data-partial
      data-partial-id={id}
      data-partial-match={matchKey}
      data-partial-confirm={confirm || undefined}
    />
  )
}

/**
 * The two-slot pair a cullable keepalive parton renders as — one
 * `<CullSlot>` per state, ALWAYS both present (see `cull-slot.tsx`):
 * the content slot backs the in-view body (client cache variant
 * `base`), the skeleton slot the culled body (variant
 * `culledKey(base)`). The pair's shape is identical across every
 * emission (fresh, fp-skip, match-miss park), so a culling flip is an
 * Activity MODE change inside a stable structure — the off state's
 * subtree parks instead of unmounting.
 *
 * `activeBody` is this render's emitted body (the keyed PEB wrapper,
 * or the fp-skip placeholder), routed into the slot `culled` names;
 * `null` for a parked variant, where both slots are cache-backed. The
 * off slot ALWAYS emits its placeholder — even when the client has
 * nothing cached under that variant yet. The pair mounts inside the
 * page's persisted template (or an ancestor's cached wrapper), and a
 * later flip's bytes can only reach the mounted tree through a
 * placeholder hole: an empty off slot would have nowhere to
 * substitute the state's first render when it arrives. An unbacked
 * placeholder renders to nothing.
 */
function cullPairSlots(
  id: string,
  base: string,
  activeBody: ReactNode | null,
  culled: boolean,
): ReactNode {
  const cullMk = culledKey(base)
  const contentChild =
    activeBody != null && !culled ? activeBody : placeholderFor(id, base)
  const skeletonChild =
    activeBody != null && culled ? activeBody : placeholderFor(id, cullMk)
  return (
    <>
      <CullSlot key="c" id={id} matchKey={base} slot="content" culled={culled}>
        {contentChild}
      </CullSlot>
      <CullSlot key="s" id={id} matchKey={base} slot="skeleton" culled={culled}>
        {skeletonChild}
      </CullSlot>
    </>
  )
}

/** Distinct BASE matchKeys in a cached-variant set — a cull-pair
 *  parton's `~cull` twins collapse onto their base. */
function cachedBases(matchKeys: ReadonlySet<string>): string[] {
  const bases: string[] = []
  const seen = new Set<string>()
  for (const mk of matchKeys) {
    const b = baseKey(mk)
    if (seen.has(b)) continue
    seen.add(b)
    bases.push(b)
  }
  return bases
}

/**
 * Parked emission for a keepalive spec whose `match` says it
 * shouldn't render on this request, but the client has it cached
 * (declared via `?cached=id:matchKey:fp`). Returns one
 * `<Activity mode="hidden" key={matchKey}>` per cached matchKey,
 * each wrapping a placeholder the client's cache merge resolves to
 * the cached subtree for that variant. Mode flips, fiber persists,
 * state survives.
 *
 * Cull-pair partons (a cullable spec — prior dep record has a
 * `visible:` read — or a cached `~cull` twin) park PAIR-shaped: the
 * same two-slot structure the active emission uses, both slots
 * placeholders under the outer hidden Activity, so a route-away and
 * back reconciles onto the same fibers.
 *
 * Returns `null` when keepalive is opted out or when the client has
 * no cached variants for this id — falls back to the classic
 * "render nothing on match-miss" behavior.
 */
function emitParkedKeepalive(
  id: string,
  keepalive: boolean,
  state: PartialRequestState | undefined,
): ReactNode {
  if (!keepalive) return null
  const matchKeys = state?.cachedMatchKeys.get(id)
  if (!matchKeys || matchKeys.size === 0) return null
  const paired =
    hasVisibleDep(lookupPartial(id)?.deps) || [...matchKeys].some(isCulledKey)
  const parkedBody = (mk: string): ReactNode =>
    paired ? cullPairSlots(id, mk, null, false) : placeholderFor(id, mk)
  const bases = paired ? cachedBases(matchKeys) : [...matchKeys]
  // Single cached variant — emit one Activity without a key so React
  // reconciles by position across active ↔ parked transitions. Same
  // shape as `emitWithVariantSiblings`'s single-variant branch.
  if (bases.length === 1) {
    return <Activity mode="hidden">{parkedBody(bases[0])}</Activity>
  }
  return (
    <>
      {bases.map((mk) => (
        <Activity key={mk} mode="hidden">
          {parkedBody(mk)}
        </Activity>
      ))}
    </>
  )
}

/**
 * Wrap an emitted visible body in a keyed `<Activity>` and append
 * hidden Activity siblings for each other matchKey the client has
 * cached for this id. The visible Activity is keyed by its own
 * matchKey too — React requires unique keys among siblings, and a
 * stable matchKey-keyed Activity reconciles cleanly across renders
 * (same variant → same key → same fiber → state preserved).
 *
 * `cull` marks a cull-pair parton: the body (and every hidden
 * sibling) is wrapped in the two-slot pair (`cullPairSlots`), with
 * `cull.culled` routing this render's body into the content or
 * skeleton slot. Activity keys stay BASE matchKeys — the `~cull`
 * twin never surfaces at the variant level.
 *
 * When `state` is null (e.g. test fixtures without PartialRoot) or
 * the client has no other cached matchKeys, returns a single
 * `<Activity mode="visible">` with no hidden siblings — identical
 * shape to today's emission for the single-variant case.
 */
function emitWithVariantSiblings(
  id: string,
  matchKey: string,
  visibleBody: ReactNode,
  state: PartialRequestState | null | undefined,
  cull?: { culled: boolean },
): ReactNode {
  const cached = state?.cachedMatchKeys.get(id)
  const body = cull ? cullPairSlots(id, matchKey, visibleBody, cull.culled) : visibleBody
  const others: string[] = []
  if (cached) {
    for (const mk of cull ? cachedBases(cached) : cached) {
      if (mk !== matchKey) others.push(mk)
    }
  }
  // No other cached variants — emit a single Activity without a key
  // so React reconciles by position against the prior render. Adding
  // a key here would shift the structure on first cross-variant nav
  // (when a hidden sibling appears) and remount the body, resetting
  // local state.
  if (others.length === 0) {
    return <Activity mode="visible">{body}</Activity>
  }
  // Multi-variant: keys required for sibling reconciliation.
  return (
    <>
      <Activity key={matchKey} mode="visible">
        {body}
      </Activity>
      {others.map((mk) => (
        <Activity key={mk} mode="hidden">
          {cull ? cullPairSlots(id, mk, null, false) : placeholderFor(id, mk)}
        </Activity>
      ))}
    </>
  )
}

/**
 * Resolve the render-time identity for a placement of `spec`.
 *
 *  - If the caller passed `__instanceId` (typically slot wiring in
 *    the CMS layer), that becomes this placement's effective id.
 *  - Otherwise the spec's own catalog id is used.
 *
 * The first label is replaced with the override; the spec's other
 * labels stay as fan-out targets for refetch.
 */
function effectiveIdForInstance(
  spec: InternalSpec<unknown>,
  override: string | undefined,
): {
  id: string
  parsed: ParsedSelector
} {
  if (override == null || override === spec.id) {
    return { id: spec.id, parsed: spec.parsed }
  }
  // Per-instance placement: prepend the override as the new
  // effective id, but KEEP the spec's original labels (including the
  // catalog id at slot 0) as fan-out targets. Without this, a
  // multi-instance partial like `LivePrice` (selector `"price"`)
  // loses the "price" class label on per-instance refetch — and the
  // next `?partials=price` request finds nothing.
  const labels = [override, ...spec.parsed.labels.filter((l) => l !== override)]
  return {
    id: override,
    parsed: { labels },
  }
}

function createSpecComponent<V>(
  spec: InternalSpec<V>,
): FC<PartialComponentProps & Record<string, unknown>> {
  // Async: schema/props resolution can `await` the loader on
  // storage-cold cells (gqlCell + localCell with `load`). Storage-warm
  // paths still settle in a microtask (await of a resolved value), so
  // overhead is one Promise tick on hot reads — sync-equivalent in
  // practice.
  const renderSpec: FC<PartialComponentProps & Record<string, unknown>> = async (props) => {
    const {
      __parent: __injectedParent,
      __instanceId: instanceIdOverride,
      children: outerChildren,
      ...extraProps
    } = props as PartialComponentProps & {
      __instanceId?: string
      __parent?: PartialCtx
      children?: ReactNode
    } & Record<string, unknown>
    // Parent comes from server context (the ambient parton, threaded
    // through the parton ALS frame — see server-context.ts), NOT a prop.
    // `__parent` overrides it for isolated renders that are their own
    // render root: a cache hole, a `<RemoteFrame>`, an addressable
    // refetch (`partialFromSnapshot`), where there is no ambient parton.
    const parent = __injectedParent ?? getServerContext(ParentContext)
    const opts = spec.options
    // Render-time identity (the `id` keying snapshots, wire, cache
    // lookup) is:
    //
    //   1. `__instanceId` if provided (slot wiring in cms-runtime
    //      sets this to the slot entry's id);
    //   2. otherwise `spec.id` plus a per-instance hash of any JSX
    //      call-site props — so multiple placements with different
    //      props (e.g. `<LivePrice sku="A"/>` and `<LivePrice
    //      sku="B"/>`) each get a distinct id, instead of all
    //      collapsing onto the spec's catalog id and fighting for
    //      one registry slot;
    //   3. otherwise just `spec.id` (singleton / no-prop placement).
    //
    // The auto-derivation step keeps the snapshot store one entry
    // per actual on-page placement without forcing authors to thread
    // an explicit instance-id prop through every site.
    // Priority: `__instanceId` from slot wiring → auto-derive from
    // extraProps hash → undefined (singleton).
    const autoInstanceKey =
      instanceIdOverride === undefined && Object.keys(extraProps).length > 0
        ? hash(stableStringify(extraProps))
        : undefined
    const effectiveInstanceId =
      instanceIdOverride ?? (autoInstanceKey ? `${spec.id}:${autoInstanceKey}` : undefined)
    const { id, parsed } = effectiveIdForInstance(
      spec as InternalSpec<unknown>,
      effectiveInstanceId,
    )
    // Server-hooks called within this parton's render read its own
    // identity from the rendering task (`getCurrentParton`); `tag()` and
    // tracked reads (`cookie()`, `searchParam()`) accumulate into these
    // Sets, which the wrapper folds into the fp below. The task is
    // stamped just after the frame phase, once the frame-resolved request
    // these hooks read from is known. See current-parton.ts.
    const selfTags = new Set<string>()
    const selfDeps = new Set<string>()
    // Keepalive defaults to true. The flag governs both the active
    // emission (wrap body in `<Activity mode="visible">`) and the
    // parked emission on match-miss (emit
    // `<Activity mode="hidden">` + placeholder when the client has
    // this id cached). The shared Activity wrapper is what lets React
    // preserve the inner Suspense subtree's fiber identity across
    // active ↔ parked transitions — mode flips, fiber stays.
    const keepalive = opts.keepalive !== false
    const requestState = getPartialState()
    // ── Frame phase ──
    // Specs inherit the frame chain from their parent (a `<Frame>`
    // ancestor extends it). The spec itself never opens a new frame.
    // Both `match` and every tracked read resolve against this
    // (frame-resolved) request: a framed spec routes and keys on its
    // frame's URL, not the page's.
    const ourFrameChain = parent.frameChain
    const ourRequest = ourFrameChain.length > 0 ? resolveFrameRequest(ourFrameChain) : getRequest()

    // ── Match phase ──
    // `match` gates rendering against the (frame-resolved) request URL.
    // For an unframed spec that's the page URL; inside a `<Frame>` it's
    // the frame's URL — so a spec with `match: "/cart/open"` placed in a
    // cart frame routes on the frame.
    let params: Record<string, string> = {}
    if (spec.match) {
      const verdict = spec.match.evaluate(ourRequest)
      if (!verdict.matched) return emitParkedKeepalive(id, keepalive, requestState)
      params = verdict.params
    }
    // Stamp the self-context now that the frame-resolved request + match
    // params are known — server-hooks (`cookie()` / `searchParam()` /
    // `param()`, `tag()`, inline `localCell`) read them off it. See
    // current-parton.ts.
    const self: CurrentParton = {
      id,
      tags: selfTags,
      deps: selfDeps,
      request: ourRequest,
      params,
      phase: "schema",
      wakeHints: {},
    }
    _setCurrentParton(self)
    // matchKey identifies the rendered variant for client-side
    // Activity keying AND nested-substitution lookups. The rule is:
    //   - A spec with its OWN named match params hashes them — so
    //     `/pokemon/1` and `/pokemon/2` get distinct keys.
    //   - A spec WITHOUT named match params walks parent.path to
    //     find the closest ancestor whose match has named
    //     params on the current (frame-resolved) URL, and inherits
    //     that hash — so descendants of `/pokemon/:id` (Hero, Stats,
    //     …) share the URL-derived variant identity even though their
    //     own bodies have no match.
    //   - No match-bearing ancestor on the current URL → a constant
    //     key (`/cache-demo?flavor=A` ↔ `?flavor=B` share a slot;
    //     content updates in place via tracked reads/fp).
    //
    // Walking ancestors at render time (rather than threading
    // `parent.matchKey` through PartialCtx) keeps partial-refetch
    // working: the catalog lookup uses `parent.path` from the
    // reconstructed snapshot, no extra state to thread.
    const matchKey = deriveMatchKey(spec.match, params, parent.path, ourRequest.url)

    // ── Request-derived surface ──
    // Match params are the only pre-declared request dimension — they
    // fold below and auto-flow into Render's prop bag. Everything else
    // request-shaped, the schema/body READS via tracked hooks; the
    // reads record onto `selfDeps` and fold via store-and-reread.
    // Call-site JSX props are a separate fp axis (their hash is in the
    // effective id and `propsKey`).
    const session = createSessionReadSurface()
    const ourUrl = new URL(ourRequest.url)
    const time = buildTimeScope()
    const varyResult: Record<string, unknown> = { ...params }

    // ── Schema phase ──
    // Resolve declared deps (cell handles + scoped cell descriptors)
    // against the request scope (module cells) or the parton's own
    // match params (scoped cells). Each cell becomes a ResolvedCell<T>
    // for Render's prop bag; the cell's `cell:<id>` label stamps onto
    // this spec so `refreshSelector` — and via it the fp-fold against
    // `queryMatchingTs` — fires when the cell mutates.
    //
    // Scoped cells (declared via the `{cell}` factory inside the
    // schema callback): partition derived from the parton's match-param
    // output (`varyResult`), narrowed by the descriptor's own `vary`
    // if provided. Wire id auto-derives as `<partonId>/<schemaKey>`.
    // The resolved cell's `set` is bound to `__scopedCellWrite` with
    // partition baked, so client invocations land on the right
    // partition regardless of URL changes between render and call.
    //
    // Module cells (imported handles): partition derived from the
    // cell's own partition callback against the request scope.
    const cellLabels: string[] = []
    /** Bound args from any cell resolution (schema OR props). Merged
     *  with the match params into the parton's effective constraint surface for
     *  invalidation matching — a `cell:<id>?itemId=X` selector only
     *  matches placements whose effective constraints include
     *  `itemId=X`. */
    const boundArgsMerged: Record<string, unknown> = {}
    /** Components contributing to schemaKeyHash: cell-id × partition ×
     *  value. Sorted before hashing. */
    const resolutionParts: string[] = []
    let schemaKeyHash = ""
    const cellScope: CellPartitionScope = {
      url: ourUrl,
      pathname: ourUrl.pathname,
      search: searchParamsToRecord(ourUrl.searchParams),
      cookies: parseCookies(ourRequest),
      headers: headersToRecord(ourRequest.headers),
      params,
      session,
      time,
    }
    // ── Props cell-resolution phase ──
    // Walk top-level extraProps for Cell handles or BoundCell
    // descriptors. Resolve each one in place: storage read (running
    // loader on miss), build ResolvedCell, replace the prop. Stamp
    // `cell:<id>` on the parton's labels and merge args into the
    // effective constraint surface — so a partition-scoped invalidation
    // (`cell:<id>?key=value`) only refetches placements whose bound
    // args match.
    //
    // Only top-level props are scanned. Nested cells inside object
    // props aren't resolved (keeps the rule simple; if you want a cell
    // visible to the framework, pass it as a top-level prop).
    const resolvedExtraProps: Record<string, unknown> = {}
    for (const key of Object.keys(extraProps)) {
      const val = extraProps[key]
      if (isBoundCell(val)) {
        const bound = val as BoundCell<unknown>
        const cellHandle = getCellById(bound.cellId)
        if (!cellHandle) {
          throw new Error(`prop "${key}": bound cell "${bound.cellId}" not in registry`)
        }
        const args = bound.args
        const partitionKey = hash(stableStringify(args))
        const value = await resolveCellValue(cellHandle, args)
        const resolved = buildResolvedCell(cellHandle, value, args)
        resolvedExtraProps[key] = resolved
        cellLabels.push(`cell:${cellHandle.id}`)
        Object.assign(boundArgsMerged, args)
        resolutionParts.push(`${cellHandle.id}:${partitionKey}:${stableStringify(value)}`)
      } else if (isModuleCell(val)) {
        const c = val as CellInterface<unknown>
        const args = c.partition(cellScope)
        const partitionKey = hash(stableStringify(args))
        const value = await resolveCellValue(c, args)
        const resolved = buildResolvedCell(c, value)
        resolvedExtraProps[key] = resolved
        cellLabels.push(`cell:${c.id}`)
        Object.assign(boundArgsMerged, args)
        resolutionParts.push(`${c.id}:${partitionKey}:${stableStringify(value)}`)
      } else {
        resolvedExtraProps[key] = val
      }
    }

    if (resolutionParts.length > 0) {
      resolutionParts.sort()
      schemaKeyHash = `|schema=${hash(resolutionParts.join("|"))}`
    }
    // Fold `tag(name)` registrations (schema-phase server-hook) into the
    // label set alongside cell labels, so they participate in the fp's
    // queryMatchingTs fold and in selector-targeted refetch. Empty for
    // any spec that never calls tag() — byte-identical to before.
    const tagLabels = selfTags.size > 0 ? [...selfTags] : []
    const expandedLabels =
      cellLabels.length > 0 || tagLabels.length > 0
        ? [...parsed.labels, ...cellLabels, ...tagLabels]
        : parsed.labels

    // ── Fingerprint ──
    // The spec's "own" fp captures only what THIS spec depends on:
    // match params, resolved cells, call-site props, tracked reads,
    // frame URL. The full fp folds in transitive descendant deps so an
    // ancestor's fp moves whenever a descendant's would, keeping
    // fp-skip conservative — fp-skipping a wrapper while a
    // descendant's deps changed would otherwise serve a stale subtree.
    // The fold re-reads each descendant's stored dep keys against the
    // CURRENT request so URL changes are reflected at ancestor fp time
    // without lag.
    const ambientFrameKey =
      ourFrameChain.length > 0 ? `|inFrame=${ourFrameChain.join(".")}:${ourRequest.url}` : ""
    const propsKey =
      Object.keys(extraProps).length > 0 ? `|props=${stableStringify(extraProps)}` : ""
    const varyKey = stableStringify(varyResult)
    // Fold matchKey into the structural fp so content-independent
    // specs (no own match — e.g. a layout `<LazySpacer>`)
    // still get distinct fps across variants of a match-bearing
    // ancestor. Without this, lazy-spacer at `/pokemon/1` and
    // `/pokemon/2` share an fp, the server fp-skips on the second
    // visit, and the placeholder it emits points at `matchKey=mk-id-2`
    // — which the client's variant-keyed cache pool has no entry
    // under, so substitution misses and the `<i hidden>` placeholder
    // collapses the layout instead of substituting in a spacer.
    // Fold in the latest `refreshSelector` ts that matches any of
    // this spec's labels AND whose constraints (if any) are a subset
    // of constraint inputs. Server-side `getServerNavigation().reload({selector})`
    // bumps the registry; partials carrying matching labels see their
    // fp shift on the next render, mismatching the client's cached fp,
    // and emit fresh content. No registry entries → 0 → no
    // contribution; same fp as before the registry existed.
    // Constraint surface for selector-constrained invalidation:
    // merge match params with bound args from any resolved cells
    // (schema OR props). `cell:<id>?key=value` selectors match
    // partons whose merged constraints contain the key=value pair —
    // so partition-scoped writes only refetch matching placements.
    const effectiveConstraints: Record<string, unknown> | null =
      Object.keys(varyResult).length === 0 && Object.keys(boundArgsMerged).length === 0
        ? null
        : { ...varyResult, ...boundArgsMerged }
    const invalidationTs = queryMatchingTs(expandedLabels, effectiveConstraints)
    const invalidationKey = invalidationTs > 0 ? `|inv=${invalidationTs}` : ""
    // ── Culled state (cull-to-park) ──
    // A cullable keepalive parton's culled render is a VARIANT of its
    // in-view one (see cull-key.ts): distinct wire matchKey, distinct
    // client cache slot, distinct per-state snapshot — so the two
    // states park side by side on the client and each state's dep
    // record folds its own fingerprint. Cullability comes from the
    // prior dep record (the body's branches share the `visible()`
    // read — the read IS what makes the spec cullable), off whichever
    // state's snapshot the route hint holds. Wrappers (outerChildren)
    // never split: their output is their children.
    const hasOuterChildren = outerChildren != null && outerChildren !== false
    const visibleValue = readVisible(ourUrl.searchParams, id)
    const cullCapable =
      keepalive && !hasOuterChildren && hasVisibleDep(lookupPartial(id)?.deps)
    const culled = cullCapable && visibleValue === false
    // Store-and-reread for tracked reads: `cookie()` / `searchParam()`
    // record their keys DURING Render, after this fp is computed — so
    // fold the PRIOR render's recorded keys, re-read against the current
    // request. A changed cookie/search value shifts the fp; a spec that
    // never calls a tracked hook has no prior deps and folds nothing
    // (byte-identical). First render of a variant: no prior snapshot →
    // cold (no fp-skip relies on it), and the keys it records make every
    // subsequent render fp-accurate. Cull-pair specs fold the record of
    // the STATE this render is entering, so the fp lines up with the
    // client's advertised same-state fingerprint.
    const priorSnap = lookupPartial(id, cullCapable ? culled : undefined)
    // Fold this render's dep keys, re-read at the current request. Tracked
    // reads done in the SCHEMA phase are already in `selfDeps` (schema runs
    // before this fp) → they fold into the CURRENT fp with no cold-lag,
    // which is what lets a `cache:`+tracked spec key its byte-cache
    // correctly from render 1. Render-BODY reads land in `selfDeps` only
    // after this fp, so they ride the PRIOR snapshot's set (store-and-
    // reread). The union covers both; a spec with no tracked reads has an
    // empty set → "" (byte-identical).
    const foldDeps = new Set<string>(selfDeps)
    if (priorSnap?.deps) for (const k of priorSnap.deps) foldDeps.add(k)
    const ownFpSource = (deps: string) =>
      `${id}|matchKey=${matchKey}|vary=${varyKey}${schemaKeyHash}${propsKey}${invalidationKey}${deps}`
    const depsKey = evalDepKeys(foldDeps, ourRequest)
    const ownStructuralFp = hash(ownFpSource(depsKey))
    const descendantFold = computeDescendantFold(id)
    const structuralFp = hash(`${ownStructuralFp}${descendantFold}`)
    const fp = hash(`${ownStructuralFp}${ambientFrameKey}${descendantFold}`)

    // Non-addressable specs (no author-declared selector/schema/match)
    // don't ship an fp on the wire — they have no external refetch
    // handle, so the per-spec fp cycle (boundary prop + trailer entry
    // + client-side registration + next-nav `?cached=` triple) is
    // redundant. The parent's descendant fold still covers their deps
    // for fp-skip safety, and snapshots still record their varyKey so
    // ancestors compute correct fold contributions. Only the wire
    // identity is collapsed; structural identity is preserved.
    //
    // Spread, don't pass `undefined`: Flight serializes
    // `prop={undefined}` on a client component as the `"$undefined"`
    // sentinel (real bytes on the wire), whereas an omitted prop
    // emits nothing. `fpProp` is `{}` for non-addressable specs,
    // dropping the key entirely from the serialized prop bag.
    const fpProp: { partialFingerprint?: string } = spec.addressable
      ? { partialFingerprint: fp }
      : {}
    // Server-internal: PartialBoundary's `emittedFp` never crosses
    // the wire (PartialBoundary is a server component whose only job
    // is to call `registerPartial`; only its `children` reach the
    // client). Passing `undefined` here is free, and
    // `computeFpUpdates` in fp-trailer.ts already skips
    // `!snap.emittedFp` — so non-addressable specs are absent from
    // the trailer too.
    const snapshotFp = spec.addressable ? fp : undefined

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
    const state = requestState ?? null

    const isExplicit = state?.explicitIds.has(id) ?? false
    const cachedFps = state?.cachedFingerprints.get(id)
    const fingerprintMatches = cachedFps != null && cachedFps.has(fp)
    // Cold-record gate: a spec's tracked reads only reach the fp via
    // the snapshot's dep record (store-and-reread). With no prior
    // snapshot for this route's variant, the fp above folded NO deps —
    // it can collide with a dep-less fp the client cached under
    // DIFFERENT read values (server restart between visits, or a first
    // visit to a new route bucket), and skipping on that match would
    // serve stale bytes. The read set is unknowable before the body
    // runs, so the skip is only allowed when the committed record
    // proves it's safe: some variant of this id has rendered and every
    // committed variant recorded an empty read set (an empty read set
    // is a fixed point — reads are conditioned only on tracked inputs,
    // so nothing can make a future render start reading). Otherwise
    // decline and render: the cold path over-fetches, never staleness.
    const coldRecordMissing =
      priorSnap == null && committedDepsEvidence(id) !== "depless"
    // TTL gate: a snapshot past its declared freshness boundary
    // (the `expires()` hook) must not be served from
    // the client's cache even when the fp matches — the boundary IS the
    // declaration that identical inputs stop being fresh at that time.
    const snapshotExpiresAt = priorSnap ? effectiveExpiresAt(priorSnap) : undefined
    const snapshotExpired = snapshotExpiresAt !== undefined && snapshotExpiresAt <= Date.now()
    // An explicit `?partials=` target must re-render — EXCEPT on a
    // culling flip (`?__cullFlip=1`, minted only by the visibility
    // controller): its targets are revalidations, and an fp match
    // means the client's parked same-state copy is current — the
    // placeholder below is the restore-with-zero-bytes confirmation.
    const explicitForces = isExplicit && !(state?.cullFlip ?? false)
    const shouldSkip =
      opts.fpSkip !== false &&
      state != null &&
      !explicitForces &&
      fingerprintMatches &&
      !hasOuterChildren &&
      !coldRecordMissing &&
      !snapshotExpired

    if (state) {
      // No uniqueness checks. Selectors are flat labels with fan-out
      // semantics — multiple placements of the same spec share their
      // labels and refetch together. seenIds stays as a debug-only
      // record of what rendered this request.
      state.seenIds.add(id)
    }

    // Scope this parton's descendants: the returned body is wrapped in
    // `<ParentContext>` (below), so child partons inherit
    // `childCtx` as their ambient parent.
    const childCtx = _childContext(parent, id)
    // Render receives: extra JSX-prop pass-through, match params,
    // resolved schema + actions, framework-managed (children).
    //
    // `__instanceId` is also forwarded — partial.tsx already used it
    // to derive the effective id, but a Render that wraps another
    // Render (e.g. the CMS block wrapper in `runtime/cms-block.ts`)
    // needs to see it too so it can route its own per-instance work
    // (CMS content key resolution, etc.). Plain Renders just ignore
    // the prop.
    const renderProps = {
      ...resolvedExtraProps,
      ...(varyResult as object),
      children: outerChildren,
      ...(effectiveInstanceId !== undefined ? { __instanceId: effectiveInstanceId } : {}),
    } as V & RenderArgs
    const fallback = opts.fallback ?? null

    if (shouldSkip) {
      // Wrap the placeholder in `<Activity mode="visible">` so the
      // React tree shape matches the active fresh emission — Activity
      // > Suspense subtree. Without this wrapper here, a same-route
      // refetch that ends up fp-skipped would produce a different
      // tree shape than the prior fresh render and React would
      // remount the inner Suspense subtree, losing client state.
      //
      // Multi-variant: emitWithVariantSiblings adds hidden Activity
      // siblings for each other matchKey the client has cached for
      // this id, so navigating between variants of the same spec
      // parks the prior variant rather than dropping its fiber.
      //
      // Cull-pair specs skip with the placeholder in the slot of the
      // state the fp confirmed (the fp can only match same-state — the
      // `visible:` dep folds a distinct token per state), keeping the
      // pair's shape identical to the fresh emission.
      const placeholder = placeholderFor(
        id,
        culled ? culledKey(matchKey) : matchKey,
        cullCapable && visibleValue !== undefined,
      )
      const skipBody: ReactNode = keepalive
        ? emitWithVariantSiblings(id, matchKey, placeholder, state, cullCapable ? { culled } : undefined)
        : placeholder
      return (
        <PartialBoundary
          id={id}
          type={spec.type}
          parentPath={parent.path}
          labels={expandedLabels}
          framePath={ourFrameChain}
          parentFrameChain={parent.frameChain}
          cache={opts.cache}
          fallback={fallback}
          props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
          constraintArgs={Object.keys(boundArgsMerged).length > 0 ? boundArgsMerged : undefined}
          varyKey={varyKey}
          deps={priorSnap?.deps}
          matchKey={matchKey}
          schemaKey={schemaKeyHash || undefined}
          emittedFp={snapshotFp}
          wakeHints={priorSnap?.wakeHints}
          culled={culled || undefined}
        >
          {skipBody}
        </PartialBoundary>
      )
    }

    if (opts.defer && !isExplicit) {
      const defer = opts.defer
      const dormant =
        defer === true
          ? fallback
          : isValidElement(defer)
            ? cloneElement(defer as ReactElement<ActivatorProps>, { partialId: id }, fallback)
            : fallback
      let deferBody: ReactNode = (
        <PartialErrorBoundary
          key={id}
          partialId={id}
          {...fpProp}
          partialMatchKey={culled ? culledKey(matchKey) : matchKey}
          cullable={hasVisibleDep(priorSnap?.deps) ? {} : undefined}
        >
          {dormant}
        </PartialErrorBoundary>
      )
      if (keepalive)
        deferBody = emitWithVariantSiblings(
          id,
          matchKey,
          deferBody,
          state,
          cullCapable ? { culled } : undefined,
        )
      return (
        <PartialBoundary
          id={id}
          type={spec.type}
          parentPath={parent.path}
          labels={expandedLabels}
          framePath={ourFrameChain}
          parentFrameChain={parent.frameChain}
          cache={opts.cache}
          fallback={fallback}
          props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
          constraintArgs={Object.keys(boundArgsMerged).length > 0 ? boundArgsMerged : undefined}
          varyKey={varyKey}
          deps={priorSnap?.deps}
          matchKey={matchKey}
          schemaKey={schemaKeyHash || undefined}
          emittedFp={snapshotFp}
          wakeHints={priorSnap?.wakeHints}
          culled={culled || undefined}
        >
          {deferBody}
        </PartialBoundary>
      )
    }

    self.phase = "render"
    // Settlement scope for this parton's subtree — opened before `Render`
    // runs so `_onPartonSettled` calls from inside it (sync prefix or
    // post-`await`, both continue this frame) attach here. Handed to the
    // `ParentContext` provider below, whose marker seeds it into the
    // outlined subtree task; the Flight patch refcounts every task under it
    // and fires the scope's callbacks when the subtree fully settles.
    const settleScope = _openPartonSettleScope()
    // Settle-time trailer emission: when a response stream registered a
    // sink (wrapStreamWithFpTrailer's incremental mode), notify it the
    // moment this parton's subtree settles — its own snapshot and every
    // descendant's are final then, so its warm fp can ship mid-stream
    // instead of waiting for slower siblings. The registration attaches
    // to the scope just opened (the wrapper's frame now holds it); the
    // sink is read at fire time from the request context, so renders
    // whose response has no sink (lanes, SSR) no-op.
    if (_getSettleTrailerSink()) {
      _onPartonSettled(() => _getSettleTrailerSink()?.(id))
    }
    let body: ReactNode = spec.Render(renderProps)
    // Cullable if the render read `visible()` — the client observes its
    // viewport intersection and self-refetches it on enter/leave. The
    // boundary prop carries the parton's observer options (or `{}`), so its
    // presence is the cullable flag and its value is the runway config.
    const cullable = hasVisibleDep(selfDeps) ? (self.visibleOptions ?? {}) : undefined
    // Pair emission can additionally learn cullability from THIS render's
    // sync-prefix reads (`selfDeps`) — so the very first render of a
    // cullable spec already carries the two-slot structure, and the first
    // client measurement's refetch reconciles into it instead of
    // reshaping the tree (which would remount the fresh body). The wire
    // matchKey routes this body into the slot of the state it rendered.
    const cullPair = cullCapable || (keepalive && !hasOuterChildren && cullable !== undefined)
    const culledEmit = cullPair && visibleValue === false
    const wireMatchKey = culledEmit ? culledKey(matchKey) : matchKey

    if (opts.cache !== undefined) {
      // Store-time key: recompute the structural fp with the LIVE
      // tracked-read set once the body has rendered, so no cache entry
      // is ever keyed dep-less. The pre-render `structuralFp` (which
      // folds the PRIOR record) stays the lookup key — a lookup either
      // hits a deps-complete entry or misses into a fresh render, so
      // the cold path over-fetches, never serves stale bytes.
      const cacheWriteFingerprint = () =>
        hash(`${hash(ownFpSource(evalDepKeys(selfDeps, ourRequest)))}${descendantFold}`)
      body = (
        <Cache
          id={id}
          fingerprint={structuralFp}
          writeFingerprint={cacheWriteFingerprint}
          options={opts.cache}
          varyResult={varyResult}
        >
          {body}
        </Cache>
      )
    }

    if (fallback != null) {
      // With fallback: outer Suspense carries the key (wrapper
      // detection: keyed Suspense). Inner PartialErrorBoundary
      // carries partialId/fingerprint/matchKey for fp registration.
      body = (
        <Suspense
          key={id}
          fallback={
            <PartialErrorBoundary
              partialId={id}
              {...fpProp}
              partialMatchKey={wireMatchKey}
              cullable={cullable}
            >
              {fallback}
            </PartialErrorBoundary>
          }
        >
          <PartialErrorBoundary
            partialId={id}
            {...fpProp}
            partialMatchKey={wireMatchKey}
            cullable={cullable}
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
          {...fpProp}
          partialMatchKey={wireMatchKey}
          cullable={cullable}
        >
          {body}
        </PartialErrorBoundary>
      )
    }

    // Outermost wrap is `<Activity mode="visible">` keyed by matchKey
    // so the React tree shape matches the parked emission
    // (`<Activity mode="hidden">` siblings substituted on the client).
    // Same shape across active ↔ parked means the inner Suspense/PEB
    // fiber persists across the transition — state survives the
    // navigate-away-and-back round-trip. emitWithVariantSiblings adds
    // hidden Activity siblings for each other matchKey the client has
    // cached, so cross-variant navigation parks the prior variant
    // rather than dropping its fiber.
    if (keepalive)
      body = emitWithVariantSiblings(
        id,
        matchKey,
        body,
        state,
        cullPair ? { culled: culledEmit } : undefined,
      )

    return (
      <ParentContext value={childCtx} _settle={settleScope}>
        <PartialBoundary
          id={id}
          type={spec.type}
          parentPath={parent.path}
          labels={expandedLabels}
          framePath={ourFrameChain}
          parentFrameChain={parent.frameChain}
          cache={opts.cache}
          fallback={fallback}
          props={Object.keys(extraProps).length > 0 ? extraProps : undefined}
          constraintArgs={Object.keys(boundArgsMerged).length > 0 ? boundArgsMerged : undefined}
          varyKey={varyKey}
          deps={selfDeps}
          matchKey={matchKey}
          schemaKey={schemaKeyHash || undefined}
          emittedFp={snapshotFp}
          wakeHints={self.wakeHints}
          culled={culledEmit || undefined}
        >
          {body}
        </PartialBoundary>
      </ParentContext>
    )
  }
  // Per-parton error containment. Schema/props cell resolution and the
  // synchronous Render call run in `renderSpec`, OUTSIDE the per-partial
  // PartialErrorBoundary (which only wraps the already-resolved body). An
  // uncaught throw there would escape every boundary and crash the whole
  // page. Contain it as this partial's error card in place — except
  // framework controls (notFound / redirect / NavigationError), which
  // carry the `__framework` brand and must bubble to the RSC entry / host
  // boundary exactly as before.
  const Component: FC<PartialComponentProps & Record<string, unknown>> = async (props) => {
    try {
      return await renderSpec(props)
    } catch (err) {
      if ((err as { __framework?: string }).__framework) throw err
      const message = err instanceof Error ? err.message : String(err)
      return (
        <PartialErrorCard
          partialId={spec.id}
          message={import.meta.env.DEV ? message : undefined}
        />
      )
    }
  }
  Component.displayName = `Partial(${spec.id})`
  return Component
}

// ─── Public constructor ───────────────────────────────────────────────

/**
 * Build the spec component from a Render function + options. Shared
 * between the single-step (`partial(Render, opts)`) and two-step
 * (`partial(opts)(Render)`) call paths.
 *
 * Returns a `SpecComponent` with the `.props` phantom statically
 * typed to `V & RenderArgs`. The phantom has no runtime value;
 * `typeof Spec.props` resolves from the static type.
 */
function buildSpecComponent<V extends object, Extra = Record<string, unknown>>(
  Render: (props: V & RenderArgs) => ReactNode,
  options: InternalSpecConfig<V>,
): SpecComponent<Extra, Prettify<V & RenderArgs>> {
  const match = options.match ? compileMatch(options.match) : undefined
  if (match) registerMatch(match)

  // Selector parsing: flat labels, no unique/shared distinction. The
  // spec catalog id (`spec.id`) is the FIRST label. Auto-derives from
  // `Render.name` when no selector is given (`AppNavRender` →
  // `"app-nav"`).
  const selectorInput = options.selector ?? autoSelector(Render)
  const parsed = parseSelector(selectorInput)
  const id = parsed.labels[0]
  const type = id

  // Author-declared addressability: any one of selector / schema /
  // match. Auto-derived selectors (the `?? autoSelector(Render)`
  // fallback above) don't count — they only exist to give the catalog
  // a unique id. A spec with none of the three is a structural child
  // of its parent and cannot be the target of selective refetch,
  // session/tag invalidation, or URL-driven variant carve-out.
  const addressable = options.selector !== undefined || options.match !== undefined

  const spec: InternalSpec<V> = {
    id,
    type,
    parsed,
    options,
    match,
    Render,
    addressable,
  }

  const baseComponent = createSpecComponent(spec)
  componentById.set(id, baseComponent)

  registerSpec({
    id,
    labels: parsed.labels,
    Component: baseComponent as unknown as FC<SpecComponentProps>,
    match,
    displayName:
      (Render as { displayName?: string; name?: string }).displayName ?? Render.name ?? "anon",
    addressable,
    capabilityType: options.capabilityType,
  })

  // Attach `.props` as a phantom field. The runtime value is
  // `undefined`; the type declares it as `V & RenderArgs` so
  // `typeof Spec.props` resolves cleanly.
  return baseComponent as unknown as SpecComponent<Extra, Prettify<V & RenderArgs>>
}

function buildPartialFromOptions<V extends object>(
  Render: (props: V & RenderArgs) => ReactNode,
  opts: PartialOptions<V>,
): SpecComponent<object, Prettify<V & RenderArgs>> {
  return buildSpecComponent(Render, opts as InternalSpecConfig<V>)
}

/**
 * Internal export used by the CMS layer (`runtime/cms-block.ts`)
 * to construct a partial from a pre-composed Render function. The CMS
 * `block()` wrapper builds a CMS-aware Render around the user's
 * callback and feeds it through here.
 */
export function _buildPartial<V extends object>(
  Render: (props: V & RenderArgs) => ReactNode,
  opts: PartialOptions<V>,
): SpecComponent<object, Prettify<V & RenderArgs>> {
  return buildPartialFromOptions(Render, opts)
}

/**
 * Construct a placeable spec component from a Render function plus
 * an options object (or a `match` shorthand).
 *
 * Type inference splits the Render function's props into three:
 *   1. framework-managed (`parent`, `children`) — always injected
 *      by the framework.
 *   2. framework-derived (`V`) — auto-inferred via `InferV<Opts>`:
 *      match params (`ParseRoute`) + resolved schema + actions.
 *   3. call-site pass-through (`Extra`) — anything left over.
 *      Inferred from `Render`'s prop type minus the previous two.
 *
 * `Extra` is what the JSX call site has to supply (e.g.
 * `<HeroSpec id={pokemonId} />`). When the URL pattern + schema
 * already cover the entire surface, `Extra` is empty and the call
 * site is just `<HeroSpec />`.
 *
 * The returned spec carries a phantom `.props` type — `typeof
 * Spec.props` resolves to the prop bag the framework supplies to
 * Render (framework-derived + RenderArgs), without re-typing.
 */
export function parton<
  const Opts extends string | PartialOptions<object> = PartialOptions<object>,
  V extends object = InferV<Opts>,
  R extends V & RenderArgs = V & RenderArgs,
>(
  Render: (props: R) => ReactNode,
  matchOrOpts?: Opts,
): SpecComponent<SpecExtraProps<R, V>, Prettify<V & RenderArgs>>
/**
 * Two-step form: `parton(opts)` returns a builder. The builder is
 * callable — pass the Render to finish — and exposes `.props` as a
 * phantom for forward-reference inference:
 *
 *     const HeroBuilder = parton({ match: "/p/:id" })
 *     function HeroRender(p: typeof HeroBuilder.props) { … }
 *     const Hero = HeroBuilder(HeroRender)
 *
 * Use this when you want to derive Render's props type before the
 * Render function exists (which the single-step form can't do —
 * `const S = parton(R, opts); function R(p: typeof S.props)` hits
 * a circular initializer).
 */
export function parton<const Opts extends PartialOptions<object> = PartialOptions<object>>(
  opts: Opts,
): PartialBuilder<Opts>
export function parton(arg1: unknown, arg2?: unknown): unknown {
  // Two-step: a single non-function argument is the options object.
  // Returns a callable builder that builds the spec when invoked
  // with a Render.
  if (typeof arg1 !== "function") {
    const options = (arg1 ?? {}) as PartialOptions<object>
    const builder = (Render: (props: object & RenderArgs) => ReactNode) =>
      buildPartialFromOptions(Render, options)
    // `.props` is type-only; the runtime value is undefined.
    return builder
  }
  // Single-step: arg1 is Render, arg2 is options-or-match-shorthand.
  const Render = arg1 as (props: object & RenderArgs) => ReactNode
  const options =
    typeof arg2 === "string"
      ? ({ match: arg2 } as PartialOptions<object>)
      : ((arg2 ?? {}) as PartialOptions<object>)
  return buildPartialFromOptions(Render, options)
}

// ─── PartialRoot ──────────────────────────────────────────────────────

interface PartialRootProps {
  children: ReactNode
}

/**
 * Parse `?cached=id:matchKey:fp,…` into two maps the request state
 * consults:
 *   - `cachedFingerprints: Map<id, Set<fp>>` — drives fp-skip decisions
 *     (server's computed fp ∈ set ⇒ emit placeholder).
 *   - `cachedMatchKeys: Map<id, Set<matchKey>>` — drives hidden Activity
 *     sibling emission so cross-variant navigation preserves prior
 *     variant fibers (`/pokemon/1` ↔ `/pokemon/2`).
 *
 * Both halves come from the same wire token. matchKey is a 16-char
 * hex hash (URL-safe, no colons) so the three-segment split is
 * unambiguous regardless of the id's content.
 */
function parseCachedTokens(raw: string | null): {
  fingerprints: Map<string, Set<string>>
  matchKeys: Map<string, Set<string>>
} {
  const fingerprints = new Map<string, Set<string>>()
  const matchKeys = new Map<string, Set<string>>()
  if (!raw) return { fingerprints, matchKeys }
  for (const token of raw.split(",").map((s) => s.trim())) {
    if (!token) continue
    const fpIdx = token.lastIndexOf(":")
    if (fpIdx <= 0) continue
    const fp = token.slice(fpIdx + 1)
    const rest = token.slice(0, fpIdx)
    const mkIdx = rest.lastIndexOf(":")
    // Two-token legacy `id:fp` is not supported — wire is upgraded
    // in lockstep with the client. A missing matchKey segment means
    // the token is malformed; drop it rather than guess.
    if (mkIdx <= 0) continue
    const matchKey = rest.slice(mkIdx + 1)
    const id = rest.slice(0, mkIdx)
    let fpSet = fingerprints.get(id)
    if (!fpSet) {
      fpSet = new Set()
      fingerprints.set(id, fpSet)
    }
    fpSet.add(fp)
    let mkSet = matchKeys.get(id)
    if (!mkSet) {
      mkSet = new Set()
      matchKeys.set(id, mkSet)
    }
    mkSet.add(matchKey)
  }
  return { fingerprints, matchKeys }
}

function parseCsvTokens(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function resolveSelectorToIds(partialsParam: string | null): Set<string> | null {
  const wanted = parseCsvTokens(partialsParam)
  if (wanted.length === 0) return null

  const snapshots = getRouteSnapshots()
  if (!snapshots) return null

  const ids = new Set<string>()
  // Direct id match first — `?partials=hero` resolves to the snapshot
  // registered under id "hero" without walking labels.
  for (const name of wanted) {
    if (snapshots.has(name)) ids.add(name)
  }
  // Then label match — any snapshot whose labels include a wanted
  // token. Fan-out: one wanted label can resolve to many ids.
  for (const [id, snap] of snapshots) {
    if (ids.has(id)) continue
    for (const label of snap.labels) {
      if (wanted.includes(label)) {
        ids.add(id)
        break
      }
    }
  }
  return ids.size > 0 ? ids : null
}

export function partialFromSnapshot(id: string, snap: PartialSnapshot): ReactNode {
  const parent: PartialCtx = {
    path: snap.parentPath,
    frameChain: snap.parentFrameChain,
  }

  // Remote-sourced snapshot: route the refetch back to the
  // remote endpoint via a fresh `<RemoteFrame>`. The remote
  // re-renders, ships a new trailer with updated snapshots, and
  // the host re-registers with the same `source` stamp + namespace
  // — keeping future refetches routed correctly. The capability
  // from the original placement is carried through so the remote
  // sees the same scoped values it saw on the cold render.
  //
  // `id` may be namespaced (`magento:stocks`); the remote endpoint
  // expects the bare spec id (`stocks`), which lives on
  // `source.remoteId`. Apply the same namespace on the refetch so
  // ids stay stable on the host side across re-renders.
  if (snap.source?.kind === "remote") {
    const namespace = id.includes(":") ? id.slice(0, id.indexOf(":")) : undefined
    return (
      <RemoteFrame
        url={`${snap.source.origin}/__remote/${encodeURIComponent(snap.source.remoteId)}`}
        capability={snap.source.capability as Capability | undefined}
        namespace={namespace}
      />
    )
  }

  // Try direct id lookup first — singleton specs register their
  // Component under spec.id, which is also the snapshot id.
  let Component = componentById.get(id)
  if (!Component && snap.type) {
    // Per-instance placement (id !== spec.id) — look up the spec
    // Component by `type` (= spec catalog id). Slot-placed blocks
    // and auto-derived multi-instance specs land here.
    const spec = getSpecById(snap.type)
    if (spec) {
      Component = spec.Component as unknown as FC<PartialComponentProps & Record<string, unknown>>
    }
  }
  if (!Component) return null
  // Replay the call-site props captured during the streaming render
  // (e.g. `<Slow flavor={…}>`). Request-dependent inputs flow through
  // tracked reads / `match` / cells, which re-resolve when this snapshot's
  // spec re-renders here.
  const props = (snap.props ?? {}) as Record<string, unknown>
  // ALWAYS pass the snapshot's id as `__instanceId`. createSpecComponent
  // will use it to set effectiveInstanceId, suppressing the auto-derive
  // step that would otherwise re-hash extraProps and shift the rendered
  // id mid-flight (e.g. when activator-supplied props arrive after the
  // initial cold render).
  // Isolated render (cache hole / refetch): there's no ambient parton,
  // so inject the snapshot's parent via `__parent`. The ALS frame threads
  // it onward to this parton's descendants.
  return <Component __parent={parent} __instanceId={id} {...props} />
}

export async function PartialRoot({ children }: PartialRootProps): Promise<ReactNode> {
  const requestUrl = new URL(getRequest().url)
  const partialsParam = requestUrl.searchParams.get("partials")
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

  // Page URL seeded into the payload for descendant client components'
  // SSR / pre-hydration paint (see `PageUrlContext`). Two economies:
  //   - On a client-driven `.rsc` refetch the value is never read — the
  //     live Navigation API is the source of truth once `window.navigation`
  //     exists, which it always does on any path that issued the refetch.
  //     So omit it (`null`) and save the whole row.
  //   - On an SSR document, strip framework-internal params first. They're
  //     already consumed above (`partials`/`cached`/`__frame`/…) and must
  //     never echo back into the payload — the `?cached=` list alone runs
  //     to kilobytes and grows with the page.
  const isRscRender = getRequest().headers.get(HEADER_RSC_RENDER) === "1"
  const pageUrl = isRscRender ? null : stripFrameworkParams(getRequest().url)

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

  const combinedRequestedIds = resolveSelectorToIds(partialsParam)
  const hasGlobalFilter = partialsParam != null
  const isPartialRefetch = hasGlobalFilter || populateCache

  const explicitIds = new Set<string>()
  if (combinedRequestedIds) for (const id of combinedRequestedIds) explicitIds.add(id)
  if (partialsParam) for (const name of parseCsvTokens(partialsParam)) explicitIds.add(name)

  // Cached-fp / matchKey maps are carried in-memory across segments of a
  // single request — see `_setCachedOverride` in runtime/context.ts.
  // First render parses `?cached=` and installs the carrier; subsequent
  // segments find the carrier already populated (the driver appends
  // newly-emitted tuples directly to those Maps between segments).
  // Without this, every segment paid `new URL(...) + URLSearchParams +
  // url.toString() + new Request(...)` to round-trip the cached state
  // through the URL, which dominated CPU under load.
  let cachedFps: Map<string, Set<string>>
  let cachedMks: Map<string, Set<string>>
  const existingOverride = _getCachedOverride()
  if (existingOverride) {
    cachedFps = existingOverride.fingerprints
    cachedMks = existingOverride.matchKeys
  } else {
    const parsed = parseCachedTokens(cachedParam)
    cachedFps = parsed.fingerprints
    cachedMks = parsed.matchKeys
    _setCachedOverride({ fingerprints: cachedFps, matchKeys: cachedMks })
  }
  const state: PartialRequestState = {
    requestedIds: populateCache ? null : combinedRequestedIds,
    isPartialRefetch: isPartialRefetch && !populateCache,
    populateCache,
    cachedFingerprints: cachedFps,
    cachedMatchKeys: cachedMks,
    explicitIds,
    cullFlip: requestUrl.searchParams.get("__cullFlip") === "1",
    seenIds: new Set(),
  }

  const requestedNames = parseCsvTokens(partialsParam)
  let registryMiss = state.isPartialRefetch && hasGlobalFilter && !combinedRequestedIds
  if (state.isPartialRefetch && !registryMiss && requestedNames.length > 0) {
    const snapshots = getRouteSnapshots()
    for (const name of requestedNames) {
      if (snapshots?.has(name)) continue
      let foundAsLabel = false
      if (snapshots) {
        for (const snap of snapshots.values()) {
          if (snap.labels.includes(name)) {
            foundAsLabel = true
            break
          }
        }
      }
      if (!foundAsLabel) {
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
    // Seed the page URL for descendant client components so
    // `useNavigation()` resolves it on the SSR paint (no browser
    // Navigation API yet) — making the hook isomorphic with zero
    // app-side wiring. Ignored after hydration, when the live browser
    // handle takes over. Frame scope gets the equivalent from `<Frame>`.
    return (
      <PageUrlProvider url={pageUrl}>
        <PartialsClient mode="streaming">{children}</PartialsClient>
      </PageUrlProvider>
    )
  }

  // Already in cache-mode ctx from the pre-enter above.
  enterPartialState(state)

  const activeIds = [...(state.requestedIds ?? [])]
  const wrappedChildren = activeIds
    .map((id) => {
      const snap = lookupPartial(id)
      if (!snap) return null
      return partialFromSnapshot(id, snap)
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  // Wrap in `<PageUrlProvider>` exactly like the streaming branch above.
  // The payload's ROOT element type must be identical across modes: when a
  // page holds two live connections (the chat overlay's frame long-poll
  // commits in cache mode while the heartbeat's `?streaming=1` commits in
  // streaming mode), their segments land on the same React root as
  // alternating `BrowserRoot` payloads. If one root were `<PageUrlProvider>`
  // and the other a bare `<PartialsClient>`, React would unmount and
  // remount the whole subtree on every seam — `page-shell` and everything
  // under it torn down and recreated ~60×/s (the inspect-overlay flicker).
  // Matching wrappers lets React reconcile the two payloads in place.
  return (
    <PageUrlProvider url={pageUrl}>
      {React.createElement(PartialsClient, { mode: "cache" }, ...wrappedChildren)}
    </PageUrlProvider>
  )
}

export function getSpecComponentById(
  id: string,
): SpecComponent<Record<string, unknown>> | undefined {
  return componentById.get(id) as SpecComponent<Record<string, unknown>> | undefined
}

export function lookupSpecComponentByType(
  type: string,
): SpecComponent<Record<string, unknown>> | undefined {
  const spec = getSpecById(type)
  return spec?.Component as SpecComponent<Record<string, unknown>> | undefined
}
