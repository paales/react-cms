/**
 * Cart badge cell — per-cartId total quantity, loaded from Magento.
 *
 * Lives separately from `cartCell` (which loads the full cart shape
 * for the /cart page). The badge only needs `total_quantity` and is
 * placed in the header on every magento page — keeping it as its own
 * tiny cell avoids over-fetching the full cart on pages where only
 * the badge is visible.
 *
 * Mutations (addToCart, updateCartItems, removeFromCart) write this
 * cell explicitly after their upstream call returns the new total,
 * so connected viewers' badges update without re-fetching upstream.
 */

import { gqlCell } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const CartBadgeQuery = graphql(`
  query CartBadge($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`)

export type CartBadgeData = NonNullable<ResultOf<typeof CartBadgeQuery>["cart"]>

export const cartBadgeCell = gqlCell({
  id: "magento.cart-badge",
  client,
  doc: CartBadgeQuery,
})
