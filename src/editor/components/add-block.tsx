/**
 * `+ Block` dropdown for the CMS editor's slot-add row.
 *
 * The slot-add row used to render one inline `+ <type>` button per
 * registered block type that satisfied the slot's `allow` selector.
 * When a slot accepts every registered block (the wildcard case for
 * a Group's `items`), the inline list grew to a wrapped block of 8+
 * buttons that crowded the tree. This component collapses those
 * into a single `+ Block` button that opens a dropdown listing the
 * same block types.
 *
 * Implemented with a native `<details>` element instead of a JS
 * popover library so the component is renderable as a server
 * component — no client hydration boundary, no random-id mismatch
 * between server and client (base-ui's dropdown emits a fresh
 * `id="base-ui-…"` on every mount which de-syncs server vs. client
 * and leaves nearby React subtrees in a partially-hydrated state,
 * breaking adjacent server-action form submissions).
 *
 * Each menu item is a `<form>` whose action is a bound server
 * action; submitting closes the popup automatically because the
 * page navigates / refetches.
 */

import type { ReactNode } from "react"

interface AddBlockOption {
  type: string
  /**
   * Pre-bound server action — `addBlockToSlot.bind(null,
   * parentCmsId, slotName, type)` from the server. Bound functions
   * pass through RSC's serialization layer unchanged so the form's
   * `action` prop fires the right server action when submitted.
   */
  action: () => Promise<unknown>
}

export function CmsEditAddBlock({
  parentCmsId,
  slotName,
  options,
}: {
  parentCmsId: string
  slotName: string
  options: ReadonlyArray<AddBlockOption>
}): ReactNode {
  if (options.length === 0) return null
  return (
    <details className="relative inline-block">
      <summary
        className="inline-flex h-6 cursor-pointer items-center rounded px-1.5 text-[0.7rem] text-muted-foreground hover:bg-muted hover:text-foreground list-none [&::-webkit-details-marker]:hidden marker:hidden"
        data-testid={`cms-edit-slot-add-trigger-${parentCmsId}-${slotName}`}
      >
        + Block
      </summary>
      <div
        className="absolute left-0 top-full z-30 mt-1 flex min-w-44 flex-col rounded-md border bg-popover p-1 shadow-md ring-1 ring-foreground/10"
        role="menu"
      >
        {options.map((opt) => (
          <form
            key={opt.type}
            action={opt.action as unknown as (formData: FormData) => void}
            className="contents"
          >
            <button
              type="submit"
              className="rounded px-2 py-1 text-left text-sm text-popover-foreground hover:bg-foreground/10"
              data-testid={`cms-edit-slot-add-${parentCmsId}-${slotName}-${opt.type}`}
              role="menuitem"
            >
              + {opt.type}
            </button>
          </form>
        ))}
      </div>
    </details>
  )
}
