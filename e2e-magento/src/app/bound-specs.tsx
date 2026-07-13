/**
 * Bound-cells embeddable page — the inward half of state across the
 * boundary. The spec DECLARES its requirements (`cells`); the host
 * binds RESOLVED cells at its call site and the projected values
 * cross with the embed request. This page never sees a host session
 * or a cell handle — `getBoundCells()` yields plain values, filtered
 * to the declaration.
 *
 * Requirement enforcement is load-bearing: an embed render without
 * the required `cart` binding throws before the body runs (the host
 * surfaces it at its own boundary); `locale` is optional and the body
 * branches on absence. A standalone browser visit of this page
 * enforces nothing and reads `{}` — it stays browsable by itself.
 */

import { getBoundCells, parton, type RenderArgs } from "@parton/framework"

interface CartShape {
  total: number
  items: number
}

export const MagentoCartNote = parton(
  async function MagentoCartNoteRender(_: RenderArgs) {
    const bound = getBoundCells()
    const cart = (bound.cart ?? null) as CartShape | null
    const locale = typeof bound.locale === "string" ? bound.locale : "en"
    return (
      <div data-testid="cart-note" data-locale={locale}>
        {cart === null ? (
          <p data-testid="cart-note-standalone">
            Standalone visit — no host bound a cart. Embed this page with{" "}
            <code>cells=&#123;&#123; cart &#125;&#125;</code>.
          </p>
        ) : (
          <p>
            [{locale}] Host cart: <span data-testid="cart-note-items">{cart.items}</span> items,
            total <span data-testid="cart-note-total">{cart.total}</span>
          </p>
        )}
      </div>
    )
  },
  {
    selector: "cart-note",
    match: "/remote/cart-note",
    cells: { cart: { required: true }, locale: {} },
  },
)
