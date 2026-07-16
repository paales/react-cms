"use client"

/**
 * Fixture for rsc-project tests: a client component that receives a
 * whole `ResolvedCell` as a prop — the shape that carries the cell's
 * bound `set` server-action reference across the wire. Used to
 * reproduce the embed-splice re-encode behaviour (a decoded bound
 * server reference re-encoded into the host's own Flight render). The
 * component renders the resolved value; the load-bearing part is the
 * `cell` prop existing at all.
 */

import type { ResolvedCell } from "../../lib/cell.ts"

export function ClientCellConsumer({ cell }: { cell: ResolvedCell<unknown> }) {
  return <div data-testid="client-cell-consumer">value:{String(cell.value)}</div>
}
