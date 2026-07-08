"use server"

/**
 * Forms-demo save — a plain server function. The card fields flow in
 * as args and write their cells explicitly; `saves` records the
 * submission. Everything commits inside `atomic()`: one driver wake
 * for the batch, and the simulated-failure throw discards every write
 * (the cells' per-session partitions re-derive from THIS request, so
 * each session commits into its own slot).
 */

import { atomic } from "@parton/framework"
import { cardCvc, cardName, failChance, saves } from "./forms-demo-state.ts"

export async function saveCard(args: { cardName?: string; cardCvc?: string }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400))
  await atomic(async () => {
    if (failChance.peek() > 0 && Math.random() < failChance.peek()) {
      throw new Error("Simulated save failure — transaction rolled back")
    }
    if (args.cardName !== undefined) await cardName.set(args.cardName)
    if (args.cardCvc !== undefined) await cardCvc.set(args.cardCvc)
    await saves.set(
      JSON.stringify({
        cardName: args.cardName ?? "",
        cardCvc: args.cardCvc ?? "",
        at: Date.now(),
      }),
    )
  })
}
