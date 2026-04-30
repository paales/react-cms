"use server"

import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { readCookie, setCookie } from "@react-cms/framework/framework/context.ts"

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

export async function getCartId(): Promise<string | undefined> {
  try {
    return readCookie("cart_id")
  } catch {
    return undefined
  }
}
