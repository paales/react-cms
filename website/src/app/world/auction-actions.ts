"use server"

/**
 * Place a bid — the auction district's up-channel, and the reason the
 * district exists: a real caller of `cell.update(fn)`.
 *
 * The reducer derives the next value from the current one, and it runs
 * inside the write path's synchronous section — no await between the
 * read and the write — so overlapping bids on the same lot serialize
 * on the event loop and COMPOSE: fifty concurrent bidders land fifty
 * increments. A `set(peek() + BID_STEP)` here would reopen the
 * read→write gap and lose bids under exactly the concurrency the
 * district invites.
 *
 * The write fires `cell:auction-lot?lot=<lot>`: the bidder's POST
 * response re-renders its lot card, every other watcher catches up
 * over its held live connection — one broadcast render fanned to all
 * of them (the lot body is viewer-independent).
 */

import { BID_STEP, lotBidCell } from "./auction.ts"

export async function placeBid(lot: string): Promise<void> {
  await lotBidCell.with({ lot }).update((current) => ({
    amount: current.amount + BID_STEP,
    bids: current.bids + 1,
  }))
}
