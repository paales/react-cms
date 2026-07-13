import { localCell } from "@parton/framework"

/**
 * The auction district's shared state — the composed-write demo
 * (`docs/reference/cells.md` § Composed write). One module-scope cell,
 * partitioned per lot id at the use site (`lotBidCell.with({ lot })`),
 * holds each lot's current high bid. Every bid goes through
 * `update(fn)` (see ./auction-actions.ts), so two viewers bidding in
 * the same tick COMPOSE — both increments land — where a
 * read-modify-write around `set` would clobber one.
 *
 * The cell is deliberately broadcast-safe: default persistent
 * process-global storage and NO `partition` callback (the lot identity
 * is explicit args, never request scope), so a lot parton reading it
 * carries no per-viewer dep and N watchers of one lot ride ONE
 * broadcast lane (`framework/src/lib/broadcast.ts`).
 *
 * Lost updates are arithmetically detectable: every accepted bid adds
 * exactly `BID_STEP` to `amount` and 1 to `bids`, so after N accepted
 * bids `amount === seed + N × BID_STEP` and `bids === N` — the exact
 * equalities `website/validate-bidding.mjs` asserts under a 50-bid
 * two-browser storm.
 */

/** Lots per district edge — the district is LOTS_PER_EDGE² lot boxes. */
export const LOTS_PER_EDGE = 2

/** One lot box's edge in plane pixels. */
export const LOT_PX = 512

/** One bid's increment. */
export const BID_STEP = 5

/** A fresh lot's starting amount. */
export const LOT_SEED = 100

export interface LotBid {
  /** Current high bid — `LOT_SEED + bids × BID_STEP` by construction. */
  amount: number
  /** Accepted bid count. */
  bids: number
}

export const lotBidCell = localCell({
  id: "auction-lot",
  shape: "opaque",
  initial: { amount: LOT_SEED, bids: 0 } as LotBid,
})
