"use server"

import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { readCookie, setCookie } from "@parton/framework"
import { cartBadgeCell } from "./cart-badge-cell.ts"
import { cartCell } from "./cart-cells.ts"

const CreateEmptyCart = graphql(`
  mutation CreateEmptyCart {
    createEmptyCart
  }
`)

const AddToCart = graphql(`
  mutation AddToCart($cartId: String!, $sku: String!, $quantity: Float!) {
    addProductsToCart(cartId: $cartId, cartItems: [{ sku: $sku, quantity: $quantity }]) {
      cart {
        total_quantity
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
  // Push the updated total directly into the badge cell. Any tab
  // showing the badge for this cartId sees the new value on its
  // next render — no upstream re-fetch.
  await cartBadgeCell.with({ cartId }).set({
    total_quantity: result.cart?.total_quantity ?? 0,
  })
  // Cart-line list shape may have changed (new line added or qty bump
  // on an existing). The /cart page's cartCell needs to reload from
  // upstream to pick up the new lines + totals — invalidate it.
  await cartCell.with({ cartId }).invalidate()
}

export async function getCartId(): Promise<string | undefined> {
  try {
    return readCookie("cart_id")
  } catch {
    return undefined
  }
}
