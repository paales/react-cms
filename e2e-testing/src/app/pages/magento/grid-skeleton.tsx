"use client"

/**
 * A culled catalog page — `BrowsePage`'s `cull.skeleton`: the
 * product-count-shaped pulse grid, rendered client-side. Also reused
 * as `PageProducts`' Suspense fallback, so a page streams in over the
 * same shape it culls out to.
 */

import { GRID, PAGE_SIZE } from "./browse-constants.ts"

export function GridSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: PAGE_SIZE }, (_, i) => (
        <div key={i} className="h-full animate-pulse rounded-xl bg-muted/40" />
      ))}
    </div>
  )
}
