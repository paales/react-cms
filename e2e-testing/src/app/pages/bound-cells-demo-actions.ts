"use server"

/**
 * /bound-cells-demo actions — a host-side write to the bound cell.
 * The demo page's parton resolved `hostCart` in its body (the read IS
 * the dependency), so this write re-renders that parton, which
 * re-embeds the remote page with a freshly projected cart.
 */

import { hostCart, type HostCart } from "./bound-cells-demo-state.ts"

export async function addToHostCart(): Promise<void> {
  await hostCart.update((current: HostCart) => ({
    total: current.total + 10,
    items: current.items + 1,
  }))
}
