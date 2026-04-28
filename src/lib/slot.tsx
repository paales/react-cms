/**
 * Slot primitives — `<Children>` and `<Child>`.
 *
 * A slot declares a named opening in a CMS-aware Partial's content
 * where CMS-contributed blocks plug in. At render time:
 *
 *   1. The slot records itself into the ambient CMS scope's
 *      `childSlots` map so the future editor knows "this Partial
 *      accepts blocks here, constrained by this `allow` selector."
 *   2. It looks up the host node (`scope.cmsId`) in the store and
 *      reads its `slots[name]` array.
 *   3. For each entry, it resolves the `type` tag through the block
 *      registry (`getBlockSpec`) and renders the block's component
 *      inside a `<Partial cmsId={entry.id}>` wrapper. The Partial's
 *      selector is `[#<cmsId>, ...spec.tags]` — a unique `#`-token
 *      per instance plus the block's registered shared tokens.
 *
 * The `allow` prop is metadata for the editor today; the runtime
 * doesn't enforce it. If an author's store contains a block the slot
 * wouldn't accept, it still renders — the editor is where that
 * invariant gets policed.
 *
 * Slots are recursive: a block's own content can declare more
 * `<Children>` against its own node's `slots`, composing arbitrarily
 * deep. The existing dynamic-Partial registry + cache-mode refetch
 * machinery handles nested Partials produced inside `.map()`-style
 * loops as first-class, so there's no special case here.
 *
 * Outside a CMS scope (a slot rendered inside a Partial without
 * `cmsId`) the slot silently renders nothing — the primitive is
 * CMS-scope-gated, same as the content accessors.
 *
 * See `docs/cms.md` § Slot accessors.
 */

import React, { type ReactNode } from "react"
import { Partial } from "./partial-component.tsx"
import { capturePartialContext } from "./partial-context.ts"
import { getCurrentCmsScope, getRequest } from "../framework/context.ts"
import { getBlockSpec, lookupCmsNode, type CmsNode } from "../framework/cms-runtime.ts"

export interface ChildrenProps {
  /** Slot key — matches `node.slots[name]` in the store. */
  name: string
  /**
   * Selector grammar constraining which block types the editor should
   * allow into this slot. Not enforced at runtime; surfaced to the
   * editor via the CMS scope's `childSlots` metadata.
   */
  allow: string
}

export interface ChildProps {
  name: string
  allow: string
}

/**
 * Brand used to identify slot components from outside. The catalog
 * prerender walks the JSX tree to find slot declarations and call
 * them so they side-effect into `scope.childSlots` — but importing
 * `Children` / `Child` directly into the prerender pulls in
 * `partial-component.tsx`, which the node-tier vitest project can't
 * resolve. The prerender keys off this brand symbol instead.
 */
export const SLOT_KIND_BRAND = Symbol.for("cms.slotKind")
export type SlotKind = "multi" | "single"

interface SlotComponent {
  (props: ChildrenProps | ChildProps): ReactNode
  [SLOT_KIND_BRAND]?: SlotKind
}

/**
 * Multi-entry slot — renders every block in `node.slots[name]` in the
 * order stored. Each block is wrapped in its own `<Partial>` so it
 * participates in the fingerprint-skip / invalidation graph like any
 * other Partial.
 */
export const Children: SlotComponent = function Children({
  name,
  allow,
}: ChildrenProps): ReactNode {
  const scope = getCurrentCmsScope()
  if (!scope) return null
  scope.childSlots.set(name, { multi: true, allow })

  const node = lookupCmsNode(scope.cmsId, getRequest())
  const entries = node?.slots?.[name] ?? []
  if (entries.length === 0) return null

  return renderSlotEntries(entries)
}
Children[SLOT_KIND_BRAND] = "multi"

/**
 * Singleton slot — renders at most one block. If the store has more
 * than one entry (author mistake, migration), only the first is
 * rendered; the editor is responsible for preventing accumulation.
 */
export const Child: SlotComponent = function Child({ name, allow }: ChildProps): ReactNode {
  const scope = getCurrentCmsScope()
  if (!scope) return null
  scope.childSlots.set(name, { multi: false, allow })

  const node = lookupCmsNode(scope.cmsId, getRequest())
  const entries = node?.slots?.[name] ?? []
  const entry = entries[0]
  if (!entry) return null

  return renderSlotEntries([entry])
}
Child[SLOT_KIND_BRAND] = "single"

function renderSlotEntries(entries: readonly CmsNode[]): ReactNode {
  const parent = capturePartialContext()
  return entries.map((entry) => {
    const type = entry.type
    if (!type) return null
    const spec = getBlockSpec(type)
    if (!spec) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[cms] slot entry "${entry.id}" has type "${type}" which is not registered. ` +
            `Register with registerBlock("${type}", …) or remove the entry from content.json.`,
        )
      }
      return null
    }
    const Component = spec.component
    // Selector: `#<cmsId>` unique-token + the block's registered
    // class-tokens. The `#`-token ensures uniqueness across the page
    // (the Partial runtime enforces `#`-token page-wide uniqueness;
    // `cmsId`s are author-controlled so they're already unique within
    // the store).
    const selector = [`#${entry.id}` as `#${string}`, ...spec.tags]
    // Fragment-wrap so the array's `key` lives on a transparent
    // wrapper instead of the Partial. `<Partial key={entry.id}>`
    // would composite with the Partial's inner `<Suspense key={id}>`
    // on the Flight wire (`"id,id"`) and the client would reconcile
    // it as a different identity than the plain `"id"` emitted in
    // other render paths — breaking client state inside the block.
    // Same trick as `cache.tsx::reinjectDynamic`.
    return (
      <React.Fragment key={entry.id}>
        <Partial parent={parent} selector={selector} cmsId={entry.id}>
          <Component />
        </Partial>
      </React.Fragment>
    )
  })
}
