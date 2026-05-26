/**
 * Cart-shape cells — proves the bound-cell / partition-scoped model:
 *
 *   cartCell  — full cart shape (itemIds + totals). Loaded once per
 *               cartId. The load function hydrates child cartItemCell
 *               partitions from the nested query result.
 *
 *   cartItemCell — one slot per cart line, partitioned by line uid.
 *                  Read via `cartItemCell.with({uid}).` Authors place
 *                  individual CartLine partons bound to specific
 *                  partitions; mutations target single partitions and
 *                  only matching placements refetch.
 *
 * The point: with 200 lines and one qty update, only the matching
 * <CartLine> placement re-renders. No full cart refetch.
 */

import { localCell } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const CartWithItemsQuery = graphql(`
  query CartWithItems($cartId: String!) {
    cart(cart_id: $cartId) {
      id
      items {
        uid
        quantity
        product {
          name
          sku
        }
        prices {
          row_total {
            value
            currency
          }
        }
      }
      prices {
        grand_total {
          value
          currency
        }
      }
    }
  }
`)

type FullCart = NonNullable<ResultOf<typeof CartWithItemsQuery>["cart"]>
export type FullCartItem = NonNullable<NonNullable<FullCart["items"]>[number]>

export type CartItemValue = {
  uid: string
  quantity: number
  name: string
  sku: string
  rowTotal: number
  currency: string
}

export type CartValue = {
  itemUids: string[]
  grandTotal: number
  currency: string
}

export function toCartItemValue(it: FullCartItem): CartItemValue {
  return {
    uid: it.uid,
    quantity: it.quantity,
    name: it.product?.name ?? "(unknown)",
    sku: it.product?.sku ?? "",
    rowTotal: it.prices?.row_total?.value ?? 0,
    currency: it.prices?.row_total?.currency ?? "USD",
  }
}

/** Per-line cell. Partition is the Magento line uid; bound via
 *  `cartItemCell.with({uid})` at placement sites. No `vary` —
 *  partition comes entirely from `.with()`. */
export const cartItemCell = localCell<"opaque", CartItemValue | null>({
  id: "magento.cart-item",
  shape: "opaque",
  initial: null,
})

/** Cart aggregate cell. Vary on the cart cookie so each user has
 *  their own partition. The loader fetches the full cart once and
 *  hydrates every child `cartItemCell` partition — no per-line
 *  upstream call.
 *
 *  Returns just the itemUids + grand total. CartLine placements read
 *  the per-line data from `cartItemCell.with({uid})`. */
export const cartCell = localCell<"opaque", CartValue | null>({
  id: "magento.cart",
  shape: "opaque",
  vary: ({ cookies }) => ({ cartId: cookies.cart_id ?? "" }),
  initial: null,
  load: async ({ cartId }) => {
    if (!cartId || typeof cartId !== "string") return null
    const data = await client.request(CartWithItemsQuery, { cartId })
    const cart = data.cart
    if (!cart) return null
    const items = (cart.items ?? []).filter((i): i is FullCartItem => i != null)
    // Hydrate per-line cells WITHOUT firing partition signals — these
    // placements haven't rendered yet on a cold cart load, so a signal
    // would just be noise.
    const itemUids: string[] = []
    for (const it of items) {
      cartItemCell.with({ uid: it.uid }).hydrate(toCartItemValue(it))
      itemUids.push(it.uid)
    }
    return {
      itemUids,
      grandTotal: cart.prices?.grand_total?.value ?? 0,
      currency: cart.prices?.grand_total?.currency ?? "USD",
    }
  },
})
