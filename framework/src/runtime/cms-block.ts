/**
 * `block(...)` constructor — CMS-aware wrapper around `parton(...)`.
 * Lives here, in the CMS layer, so `partial.tsx` stays CMS-free.
 *
 * A block:
 *   - Resolves its CMS content row at render time. The row id is
 *     `__instanceId ?? spec.id` (slot wiring sets `__instanceId`
 *     to the slot entry's id; direct-JSX singletons read from the
 *     row matching the spec's catalog id).
 *   - Calls the author's `schema({cms})` with a read surface bound
 *     to that row, merges the result into the props passed to the
 *     author's Render.
 *   - Records the row as a `cms:<contentKey>` tracked dependency, so
 *     the partial's fingerprint re-reads the content hash on every
 *     fold and moves on CMS edits.
 *   - Registers as a slot block (`registerSlotBlockMeta`) so the
 *     editor catalog manifest can enumerate it and slot lookups
 *     can resolve `entry.type` to this Component.
 */

import { createElement, type ReactNode } from "react"
import {
  _buildPartial,
  type PartialOptions,
  type RenderArgs,
  type SpecComponent,
  type SpecExtraProps,
} from "../lib/partial.tsx"
import { getCurrentParton } from "../lib/current-parton.ts"
import { createCmsReadSurface, registerSlotBlockMeta, type CmsReadSurface } from "./cms-runtime.ts"
import { getRequest } from "./context.ts"

/** Scope passed into `schema` callbacks. CMS reads live here;
 *  request dimensions are tracked-hook reads. */
export interface SchemaScope {
  cms: CmsReadSurface
}

/** Options for `block(R, opts)` — a slot-placeable
 *  CMS-driven spec with a declared `schema`. Internally produces a
 *  partial; same fingerprint / cache / refetch path.
 *
 *  Omits PartialOptions.schema so block's CMS-shaped schema
 *  (`(scope) => S`) is the block's own surface — the one declared
 *  schema in the framework; it runs inside the cms-block wrapper's
 *  Render. */
export type BlockOptions<V, S> = PartialOptions<V> & {
  /** CMS field reads + child slots. Runs at render time with a real
   *  `cms` surface; the result is merged into Render's prop bag
   *  alongside the match params. The editor's catalog prerender invokes it
   *  with a tracking surface to discover content fields + child slot
   *  declarations. */
  schema?: (scope: SchemaScope) => S
}

const STRIP_SUFFIXES = ["Render", "Page", "Block", "Partial", "Component"]

function autoDerivedId(Render: (...args: never[]) => unknown): string {
  const raw = (Render as { displayName?: string; name?: string }).displayName ?? Render.name ?? ""
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

/**
 * Block spec id. Inspects the RAW selector string for a leading `#`
 * token — if present, that token IS the spec id (singleton case:
 * `#app-nav` → id `"app-nav"`, the CMS storage row the block reads
 * from). Otherwise the id auto-derives from `Render.name`, matching
 * the slot entry `type` field in `content.json` for multi-instance
 * blocks (`HeroRender` → `"hero"`).
 *
 * `.classes` and unprefixed labels in the selector are purely refetch
 * labels — they don't influence the spec id.
 */
function deriveSpecId(Render: (...args: never[]) => unknown, selector: unknown): string {
  const tokens =
    typeof selector === "string"
      ? selector.trim().split(/\s+/)
      : Array.isArray(selector)
        ? selector.map(String)
        : []
  for (const tok of tokens) {
    const trimmed = tok.trim()
    if (trimmed.startsWith("#") && trimmed.length > 1) return trimmed.slice(1)
  }
  return autoDerivedId(Render)
}

export function block<
  V extends object = object,
  S extends object = object,
  R extends V & S & RenderArgs = V & S & RenderArgs,
>(
  Render: (props: R) => ReactNode,
  opts: BlockOptions<V, S> = {} as BlockOptions<V, S>,
): SpecComponent<SpecExtraProps<R, V & S>, R> {
  const specId = deriveSpecId(Render as (...args: never[]) => unknown, opts.selector)

  // Wrap the author's Render with a CMS-aware front-end. partial.tsx
  // sees this wrapper as its `Render` and knows nothing about CMS;
  // the wrapper resolves the per-instance content row, invokes the
  // schema, and forwards the merged props to the author's Render.
  function BlockRender(props: V & RenderArgs & { __instanceId?: string }): ReactNode {
    const { __instanceId, children, ...rest } = props as V &
      RenderArgs & {
        __instanceId?: string
      } & Record<string, unknown>
    const contentKey = __instanceId ?? specId
    // Record the content row as a tracked dependency (`cms:<key>` —
    // evaluated by the dep kind cms-runtime registers): every fp fold
    // re-reads the row's CURRENT hash, so a CMS edit moves the fp —
    // both for schema edits (fields the schema reads) and for
    // slot-subtree edits (which schema doesn't directly observe but
    // the hash's `contributionForNode` folds in). The key is
    // per-instance (`__instanceId ?? spec.id`): keying on `specId`
    // would give every multi-instance placement the same
    // contribution, so cascade-resolution changes (`/cms-demo/alpha`
    // → `/cms-demo/beta`) wouldn't move the fp and the spec would
    // fp-skip with stale cached content.
    getCurrentParton()?.deps.add(`cms:${contentKey}`)
    const cms = createCmsReadSurface(contentKey, getRequest())
    let schemaResult: S | object = {}
    if (opts.schema) {
      try {
        schemaResult = opts.schema({ cms }) as S
      } catch {
        schemaResult = {} as S
      }
    }
    return (Render as (p: V & S & RenderArgs) => ReactNode)({
      ...(rest as unknown as V),
      ...(schemaResult as S),
      children,
    })
  }

  // Build the selector passed to `_buildPartial` so that the first
  // label is always the block's `specId` (which the partial layer
  // will then use as the catalog id). User's class labels follow.
  // Without prepending, the partial layer would auto-derive id from
  // the wrapper's name (`BlockRender`) or take the user's first label
  // (which for `selector: ".page-block"` is `.page-block` — not
  // what `content.json` keys against).
  const rawTokens =
    typeof opts.selector === "string"
      ? opts.selector.trim().split(/\s+/).filter(Boolean)
      : Array.isArray(opts.selector)
        ? opts.selector
            .map(String)
            .map((t) => t.trim())
            .filter(Boolean)
        : []
  const userLabels = rawTokens
    .map((t) => (t.startsWith("#") || t.startsWith(".") ? t.slice(1) : t))
    .filter((t) => t.length > 0)
  const allLabels = [specId, ...userLabels.filter((l) => l !== specId)]
  const partialOptions: PartialOptions<V & S> = {
    match: opts.match,
    cache: opts.cache,
    defer: opts.defer,
    fallback: opts.fallback,
    keepalive: opts.keepalive,
    selector: allLabels,
  }

  const spec = _buildPartial(BlockRender as never, partialOptions)

  registerSlotBlockMeta({
    id: specId,
    schema: opts.schema as ((scope: SchemaScope) => unknown) | undefined,
  })

  return spec as unknown as SpecComponent<SpecExtraProps<R, V & S>, R>
}

// Re-export `createElement` to make sure tree-shaking doesn't drop
// the JSX runtime in modules that only import from this file.
void createElement
