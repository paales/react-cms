"use client"

/**
 * The browse scroller's culled reservation — `BrowseGrid`'s `shell`:
 * at leaf counts, a product-count-shaped pulse grid in the same
 * layout the Render uses (so a slice streams in over the shape it
 * culls out to); for deeper regions, one server-estimated block.
 */

import type { ScrollerShellProps } from "@parton/framework/client"
import { CARD_ROW_PX, GRID, PAGE_SIZE } from "./browse-constants.ts"

export function BrowseShell({ n, h }: ScrollerShellProps) {
  if (n > PAGE_SIZE) {
    return (
      <div style={{ height: h }} className="animate-pulse rounded-xl bg-muted/20" aria-hidden />
    )
  }
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          style={{ height: CARD_ROW_PX - 12 }}
          className="animate-pulse rounded-xl bg-muted/40"
        />
      ))}
    </div>
  )
}
