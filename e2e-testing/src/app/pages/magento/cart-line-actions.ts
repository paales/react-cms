"use server"

/**
 * Cart line mutations — exercise partition-scoped invalidation.
 *
 * Each mutation hits Magento, then writes the updated entity back into
 * its specific cell partition. `cartItemCell.with({uid}).set(...)`
 * fires `cell:magento.cart-item?uid=X` — only the matching
 * `<CartLine uid="X">` placement re-renders. Other placements (other
 * lines) stay put.
 *
 * Cart-level state (item list, grand total) is updated via
 * `cartCell.with({cartId}).set(...)` so deletes / additions reshape
 * the parent and the matching CartLine disappears from the tree.
 */

import { readCookie } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { cartBadgeCell } from "./cart-badge-cell.ts"
import {
  cartCell,
  cartItemCell,
  hydrateCartFromResponse,
  type CartItemValue,
  type CartValue,
  type FullCartItem,
} from "./cart-cells.ts"

const UpdateCartItemsMutation = graphql(`
  mutation UpdateCartItems($cartId: String!, $uid: ID!, $quantity: Float!) {
    updateCartItems(
      input: { cart_id: $cartId, cart_items: [{ cart_item_uid: $uid, quantity: $quantity }] }
    ) {
      cart {
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
  }
`)

const RemoveCartItemMutation = graphql(`
  mutation RemoveCartItem($cartId: String!, $uid: ID!) {
    removeItemFromCart(input: { cart_id: $cartId, cart_item_uid: $uid }) {
      cart {
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
  }
`)

export async function updateLineQty(uid: string, quantity: number): Promise<void> {
  const cartId = readCookie("cart_id")
  if (!cartId) throw new Error("no active cart")

  const r = await client.request(UpdateCartItemsMutation, { cartId, uid, quantity })
  const updated = r.updateCartItems?.cart
  if (!updated) throw new Error("updateCartItems returned null")

  // Find the updated line in the mutation response.
  const items = (updated.items ?? []).filter((i): i is NonNullable<typeof i> => i != null)
  const updatedLine = items.find((i) => i.uid === uid)
  // Total quantity could change either way (qty change OR line
  // removed). Push the new total to the badge cell so any header
  // showing the badge updates without refetching.
  const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0)
  await cartBadgeCell.with({ cartId }).set({ total_quantity: totalQuantity })

  if (!updatedLine) {
    // Magento removed the line (qty went to 0). Bump cart so parent
    // refetches with the shorter item list.
    const remaining = items.map((i) => i.uid)
    const grand = updated.prices?.grand_total?.value ?? 0
    const currency = updated.prices?.grand_total?.currency ?? "USD"
    const next: CartValue = { itemUids: remaining, grandTotal: grand, currency }
    await cartCell.with({ cartId }).set(next)
    return
  }

  // Only the matching line cell mutates. The cart parton's items list
  // didn't change shape, so the cart parton's fp stays put — only the
  // <CartLine uid={uid}> placement refetches.
  const lineValue: CartItemValue = {
    uid: updatedLine.uid,
    quantity: updatedLine.quantity,
    name: updatedLine.product?.name ?? "(unknown)",
    sku: updatedLine.product?.sku ?? "",
    rowTotal: updatedLine.prices?.row_total?.value ?? 0,
    currency: updatedLine.prices?.row_total?.currency ?? "USD",
  }
  await cartItemCell.with({ uid }).set(lineValue)

  // Grand total is on the cart cell. Update it functionally without
  // touching the item list — that way the cart parton's fp shifts (so
  // the totals UI refetches) but per-line placements that didn't
  // change stay still.
  await cartCell.with({ cartId }).update((current) => {
    if (!current) return current
    return {
      ...current,
      grandTotal: updated.prices?.grand_total?.value ?? current.grandTotal,
      currency: updated.prices?.grand_total?.currency ?? current.currency,
    }
  })
}

export async function removeFromCart(uid: string): Promise<void> {
  const cartId = readCookie("cart_id")
  if (!cartId) throw new Error("no active cart")

  const r = await client.request(RemoveCartItemMutation, { cartId, uid })
  const updated = r.removeItemFromCart?.cart
  if (!updated) throw new Error("removeItemFromCart returned null")

  const remainingItems = (updated.items ?? []).filter(
    (i): i is FullCartItem => i != null,
  )
  // Total quantity for the badge.
  const remainingTotalQty = remainingItems.reduce((sum, i) => sum + i.quantity, 0)
  await cartBadgeCell.with({ cartId }).set({ total_quantity: remainingTotalQty })

  // Hydrate all remaining items + push the new aggregate. Same
  // normalisation as cartCell.load; this is what makes the action's
  // response render see the full set of remaining items in storage —
  // without it, OTHER lines render as null because their per-line
  // cells were never written in this request's scope.
  const next = hydrateCartFromResponse(updated)
  if (next) await cartCell.with({ cartId }).set(next)

  // Free the removed line's storage slot.
  cartItemCell.with({ uid }).hydrate(null)
}
