/**
 * Dev-time block catalog prerender.
 *
 * Runs each registered block component in a stub CMS scope so the
 * editor can introspect its accessor reads ahead of time:
 *
 *   - Content fields (`getText`, `getEnum`, …) populate `contentFields`.
 *   - Entity references (`getReference`) populate `references`.
 *   - Slot declarations (`<Children>` / `<Child>`) populate `childSlots`.
 *
 * The resulting manifest powers the editor's block palette, form
 * field generation, and allow-constraint filtering for drop zones.
 *
 * Limitation — v1: reads that happen AFTER the first `await` in an
 * async block body are not captured. The prerender awaits the
 * component's return value, but an async block that does
 * `await fetchData()` may reject (no real data), and we don't
 * try-catch past the first await. For simple sync blocks (the
 * common case) this limitation doesn't apply. The hoisting
 * discipline (read accessors before any await) already makes this
 * the expected shape.
 */

import { isValidElement, type ReactNode } from "react"
import {
  createCmsScope,
  getBlockSpec,
  listBlockTypes,
  type ContentFieldKind,
  type SlotSpec,
} from "./cms-runtime.ts"
import { _runWithPrerenderCmsScope, runWithRequestAsync } from "./context.ts"

// Brand symbol stamped on `Children` / `Child` slot components in
// `src/lib/slot.tsx`. We can't import the components directly here
// — `slot.tsx` transits through `partial-component.tsx` and the
// node-tier vitest project doesn't load that. Re-deriving the brand
// from the same well-known string avoids the dep cycle.
const SLOT_KIND_BRAND = Symbol.for("cms.slotKind")

export interface BlockManifest {
  readonly type: string
  readonly tags: readonly `.${string}`[]
  readonly contentFields: Record<string, ContentFieldKind>
  readonly references: Record<string, string>
  readonly childSlots: Record<string, SlotSpec>
}

const PRERENDER_REQUEST = new Request("http://localhost/__prerender/")

export async function prerenderBlock(type: string): Promise<BlockManifest | null> {
  const spec = getBlockSpec(type)
  if (!spec) return null
  const scopeId = `__prerender:${type}`

  const scope = createCmsScope(scopeId, scopeId)
  await runWithRequestAsync(PRERENDER_REQUEST, async () => {
    await _runWithPrerenderCmsScope(scope, async () => {
      try {
        const out = spec.component()
        // Async blocks: await the top-level promise so a pre-await
        // accessor read that happens inside a microtask still lands
        // in the scope. Failures are swallowed — the manifest is
        // advisory.
        const resolved = out instanceof Promise ? await out : out
        // Slot declarations live INSIDE the returned JSX —
        // `<Children name="items" allow=".group-item">` is an
        // element, not a side-effecting call, so the prerender's
        // single-call to `spec.component()` doesn't populate
        // `childSlots` on its own. Walk the returned tree and
        // explicitly invoke `Children` / `Child` so they side-effect
        // into the scope. We don't recurse into other function
        // components — those would re-enter render (potentially
        // touching state we don't want during prerender). Slot
        // declarations are conventionally at the top level of a
        // block's body, which is what the walk reaches.
        invokeSlotDeclarations(resolved)
      } catch {
        // Sync render errors (component throws before returning) —
        // accessor reads up to the throw still populated the scope.
      }
    })
  })

  return {
    type,
    tags: spec.tags,
    contentFields: Object.fromEntries(scope.contentFields),
    references: Object.fromEntries(scope.references),
    childSlots: Object.fromEntries(scope.childSlots),
  }
}

/**
 * Recursively walk a JSX tree and invoke any `<Children>` /
 * `<Child>` element we find. Calling the function side-effects
 * `scope.childSlots` so the manifest captures slot declarations
 * — the prerender pass otherwise stops at the top-level
 * `spec.component()` call and never enters the rendered tree.
 *
 * Walks DOM elements + Fragment children + arrays. Stops at other
 * function components (we don't re-enter render).
 */
function invokeSlotDeclarations(node: ReactNode): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (const child of node) invokeSlotDeclarations(child)
    return
  }
  if (!isValidElement(node)) return
  if (
    typeof node.type === "function" &&
    (node.type as { [SLOT_KIND_BRAND]?: string })[SLOT_KIND_BRAND] != null
  ) {
    try {
      // Calling the function records the slot into the ambient
      // CMS scope (set up by `_runWithPrerenderCmsScope` above).
      // The return value is discarded — we only care about the
      // side-effect.
      ;(node.type as (props: Record<string, unknown>) => unknown)(
        node.props as Record<string, unknown>,
      )
    } catch {
      // Children may throw if the runtime store doesn't have the
      // expected node shape — harmless during prerender, just skip.
    }
    return
  }
  // Plain DOM element / fragment: recurse into its children.
  const children = (node.props as { children?: ReactNode }).children
  if (children !== undefined) invokeSlotDeclarations(children)
}

export async function buildCatalogManifest(): Promise<Record<string, BlockManifest>> {
  const out: Record<string, BlockManifest> = {}
  for (const type of listBlockTypes()) {
    const manifest = await prerenderBlock(type)
    if (manifest) out[type] = manifest
  }
  return out
}

let cached: Promise<Record<string, BlockManifest>> | null = null

/**
 * Lazy-built manifest for every registered block type. The first
 * caller kicks off the prerender; subsequent callers await the same
 * promise. HMR invalidation drops the cache so an edit to a block
 * component rebuilds on the next request.
 */
export function getCatalogManifest(): Promise<Record<string, BlockManifest>> {
  if (!cached) cached = buildCatalogManifest()
  return cached
}

export function _invalidateCatalogManifest(): void {
  cached = null
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => {
    cached = null
  })
  import.meta.hot.on("vite:beforeFullReload", () => {
    cached = null
  })
}
