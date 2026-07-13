"use client"

import { placeBid } from "./auction-actions.ts"

/**
 * The bid control — fire-and-forget: each click is one `placeBid`
 * POST, never disabled and never coalesced, because overlapping bids
 * are the point (the server's `cell.update` composes them). The new
 * amount comes back server-authoritative — the bidder's on the POST
 * response, everyone else's over the live stream — so the button
 * carries no local state.
 */
export function BidButton({ lot }: { lot: string }) {
  return (
    <button className="lot__bid" onClick={() => void placeBid(lot)}>
      BID +5
    </button>
  )
}
