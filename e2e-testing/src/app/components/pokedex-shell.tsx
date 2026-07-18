"use client"

/**
 * The pokedex scroller's culled reservation — per-card pulse blocks in
 * the card grid's own layout at leaf counts, one estimated block for
 * deeper regions.
 */

import type { ScrollerShellProps } from "@parton/framework/client"

const LEAF = 24

export function PokedexShell({ n, h }: ScrollerShellProps) {
  if (n > LEAF) {
    return (
      <div style={{ height: h }} className="animate-pulse rounded-xl bg-muted/20" aria-hidden />
    )
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="h-[220px] animate-pulse rounded-xl bg-muted/40" />
      ))}
    </div>
  )
}
