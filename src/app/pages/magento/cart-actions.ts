"use server"

import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { getCookie, setCookie } from "../../../framework/context.ts"

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

/**
 * Server action: get or create a cart.
 * Reads cart_id from cookie; creates a new cart if none exists.
 * Persists the cart ID in a cookie for subsequent requests.
 */
export async function getOrCreateCart(): Promise<string> {
  const existing = getCookie("cart_id")
  if (existing) return existing

  const data = await client.request(CreateEmptyCart)
  const cartId = data.createEmptyCart
  if (!cartId) throw new Error("createEmptyCart returned null")
  setCookie("cart_id", cartId)
  return cartId
}

/**
 * Server action: add a product to cart.
 * Ensures a cart exists (cookie-backed), then adds the item.
 */
export async function addToCart(
  sku: string,
  quantity: number,
): Promise<{ revalidate: { selector: string } }> {
  const cartId = await getOrCreateCart()

  const data = await client.request(AddToCart, { cartId, sku, quantity })

  const result = data.addProductsToCart
  if (!result) throw new Error("addProductsToCart returned null")
  const errors = result.user_errors.filter((e) => e != null)
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; "))
  }

  return { revalidate: { selector: ".cart" } }
}

/**
 * Read the cart ID from the cookie (for server components).
 */
export async function getCartId(): Promise<string | undefined> {
  try {
    return getCookie("cart_id")
  } catch {
    return undefined
  }
}
