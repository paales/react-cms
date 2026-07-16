"use client"

/**
 * Client counter over a whole `ResolvedCell` — the shape that carries
 * the cell's `set` across a `<RemoteFrame>` embed splice. The button
 * calls `cell.set(...)` DIRECTLY (not through `useCell`), the exact
 * surface that used to smuggle a bound server-action ref through the
 * splice and stall the host render. The displayed value is the
 * server-authoritative `cell.value`, so it updates when the write's
 * focused re-embed lands.
 */

import type { ResolvedCell } from "@parton/framework"

const hydrated = (el: HTMLElement | null): void => el?.setAttribute("data-hydrated", "")

export function EmbedCellCounter({ cell }: { cell: ResolvedCell<number> }) {
  return (
    <div className="flex items-center gap-3" data-testid="embed-cell-counter">
      <span>
        count: <span data-testid="embed-cell-value">{cell.value}</span>
      </span>
      <button
        ref={hydrated}
        type="button"
        onClick={() => void cell.set(cell.value + 1)}
        data-testid="embed-cell-inc"
        className="rounded-md border px-3 py-1 text-sm cursor-pointer"
      >
        increment
      </button>
    </div>
  )
}
