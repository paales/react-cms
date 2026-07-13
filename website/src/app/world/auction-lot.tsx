import type { RenderArgs, ResolvedCell } from "@parton/framework"
import { parton } from "@parton/framework"
import { AUCTION_DISTRICT } from "./constants.ts"
import { lotBidCell, LOT_PX, LOTS_PER_EDGE, type LotBid } from "./auction.ts"
import { BidButton } from "./bid-button.tsx"

/**
 * One auction lot — its own parton, placed by the district OVERLAY
 * LAYER (`<AuctionDistrict>`, rendered by the world page), never
 * inside a chunk body. The layer placement is what makes the bid lane
 * work as multiplayer state:
 *
 *  - The lot reads only its bound bid cell (`lotBidCell.with({lot})`,
 *    resolved as a prop) — no session, no cookies, no viewport — so N
 *    viewers watching one lot are served by ONE broadcast render
 *    fanned to all of them, and a bid refetches exactly the matching
 *    `lot` partition's placements.
 *  - Its parent is the page parton (sync body, lanes only on
 *    navigation), so a bid's fresh bytes land on the lot's own lane
 *    with no beating parent lane above it — the chunks' pulse lanes
 *    churn underneath without touching the cards.
 *  - The layer sits at PLANE coordinates, so all `?chunk=` geometries
 *    share the one set of lots.
 */
export const AuctionLot = parton(
  function AuctionLotRender({ lot, bid }: { lot: string; bid: ResolvedCell<LotBid> } & RenderArgs) {
    // The render-count observable: validate-bidding.mjs counts these
    // lines per amount to prove a bid fans to every watcher as ONE
    // broadcast render, not one render per connection. A log is a side
    // effect, not an output — the tracking invariant holds.
    console.log(`[world] lot ${lot} render amount=${bid.value.amount}`)
    return (
      <div className="card card--lot" data-testid={`lot-${lot}`}>
        <h1 className="card__title">LOT {lot}</h1>
        <div className="lot__amount" data-testid={`lot-${lot}-amount`}>
          {bid.value.amount}
        </div>
        <p className="lot__bids" data-testid={`lot-${lot}-bids`}>
          {bid.value.bids} bids
        </p>
        <BidButton lot={lot} />
        <p className="card__hint">one number, every viewer — concurrent bids compose</p>
      </div>
    )
  },
  { selector: "#auction-lot" },
)

/**
 * The district layer — a plain component (no define-time work) the
 * world page renders alongside the quad roots: an absolutely
 * positioned box over the district's plane region holding one lot
 * parton per 512px lot cell. `pointer-events` stays off on the layer
 * itself so the ground between cards still pans; each card re-enables
 * it (styles.css).
 */
export function AuctionDistrict() {
  const lots: React.ReactNode[] = []
  for (let row = 0; row < LOTS_PER_EDGE; row++) {
    for (let col = 0; col < LOTS_PER_EDGE; col++) {
      const lot = `${col},${row}`
      lots.push(
        <div
          key={lot}
          className="lot-box"
          style={{ left: col * LOT_PX, top: row * LOT_PX, width: LOT_PX, height: LOT_PX }}
        >
          <AuctionLot lot={lot} bid={lotBidCell.with({ lot })} />
        </div>,
      )
    }
  }
  return (
    <div
      className="auction-layer"
      style={{
        left: AUCTION_DISTRICT.x0,
        top: AUCTION_DISTRICT.y0,
        width: AUCTION_DISTRICT.x1 - AUCTION_DISTRICT.x0,
        height: AUCTION_DISTRICT.y1 - AUCTION_DISTRICT.y0,
      }}
    >
      {lots}
    </div>
  )
}
