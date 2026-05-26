"use server"

import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { readCookie, setCookie } from "@parton/framework"
import { cartBadgeCell } from "./cart-badge-cell.ts"
import {
  cartCell,
  cartItemCell,
  toCartItemValue,
  type CartValue,
  type FullCartItem,
} from "./cart-cells.ts"

const CreateEmptyCart = graphql(`
  mutation CreateEmptyCart {
    createEmptyCart
  }
`)

/**
 * AddToCart returns the FULL post-mutation cart shape — the same
 * fields cartCell's loader fetches — so the action can populate all
 * three downstream cells (badge, cart, per-line) from a single
 * upstream call. No follow-up cart query, no invalidation-driven
 * refetch.
 */
const AddToCart = graphql(`
  mutation AddToCart($cartId: String!, $sku: String!, $quantity: Float!) {
    addProductsToCart(cartId: $cartId, cartItems: [{ sku: $sku, quantity: $quantity }]) {
      cart {
        id
        total_quantity
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
      user_errors {
        code
        message
      }
    }
  }
`)

export async function getOrCreateCart(): Promise<string> {
  const existing = readCookie("cart_id")
  if (existing) return existing
  const data = await client.request(CreateEmptyCart)
  const cartId = data.createEmptyCart
  if (!cartId) throw new Error("createEmptyCart returned null")
  setCookie("cart_id", cartId)
  return cartId
}

export async function addToCart(sku: string, quantity: number): Promise<void> {
  const cartId = await getOrCreateCart()
  const data = await client.request(AddToCart, { cartId, sku, quantity })
  const result = data.addProductsToCart
  if (!result) throw new Error("addProductsToCart returned null")
  const errors = result.user_errors.filter((e) => e != null)
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; "))
  }
  const updated = result.cart
  if (!updated) throw new Error("addProductsToCart returned cart=null")

  const items = (updated.items ?? []).filter((i): i is FullCartItem => i != null)
  const itemUids = items.map((i) => i.uid)
  const grandTotal = updated.prices?.grand_total?.value ?? 0
  const currency = updated.prices?.grand_total?.currency ?? "USD"

  // Hydrate per-line cells without firing partition signals — the
  // CartLine placements aren't rendered on /magento, so a signal
  // per-item would be noise. They'll resolve from warm storage next
  // time /cart is visited.
  for (const item of items) {
    cartItemCell.with({ uid: item.uid }).hydrate(toCartItemValue(item))
  }

  // Write the cart aggregate — fires `cell:magento.cart?cartId=X`,
  // refreshing any /cart placement currently rendering.
  const next: CartValue = { itemUids, grandTotal, currency }
  await cartCell.with({ cartId }).set(next)

  // Push the updated total into the badge cell — fires
  // `cell:magento.cart-badge?cartId=X`, refreshing the header on any
  // magento page.
  await cartBadgeCell.with({ cartId }).set({
    total_quantity: updated.total_quantity ?? 0,
  })
}

export async function getCartId(): Promise<string | undefined> {
  try {
    return readCookie("cart_id")
  } catch {
    return undefined
  }
}
