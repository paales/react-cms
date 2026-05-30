"use server"

import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { hydrateFragmentsFromResult, readCookie, setCookie } from "@parton/framework"
import { cartBadgeCell } from "./cart-badge-cell.ts"
import { cartCell, CartLineFragment } from "./cart-cells.ts"

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
const AddToCart = graphql(
  `
    mutation AddToCart($cartId: String!, $sku: String!, $quantity: Float!) {
      addProductsToCart(cartId: $cartId, cartItems: [{ sku: $sku, quantity: $quantity }]) {
        cart {
          id
          total_quantity
          items {
            uid
            ...CartLine
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
  `,
  [CartLineFragment],
)

export async function getOrCreateCart(): Promise<string> {
  const existing = readCookie("cart_id")
  if (existing) return existing
  const data = await client.request(CreateEmptyCart)
  const cartId = data.createEmptyCart
  if (!cartId) throw new Error("createEmptyCart returned null")
  setCookie("cart_id", cartId)
  return cartId
}

export async function addToCart(sku: string, quantity: number): Promise<string[]> {
  const cartId = await getOrCreateCart()
  const data = await client.request(AddToCart, { cartId, sku, quantity })
  const result = data.addProductsToCart
  if (!result) throw new Error("addProductsToCart returned null")
  const errors = result.user_errors.filter((e) => e != null)
  if (errors.length > 0) {
    // Magento user_errors (e.g. "you need to choose options" on a
    // configurable product) are an expected outcome, not a server
    // fault — return them as data for the caller to render. Throwing
    // would surface as an HTTP 500 on the action POST.
    return errors.map((e) => e.message)
  }
  const updated = result.cart
  if (!updated) throw new Error("addProductsToCart returned cart=null")

  // Hydrate per-line cells from the `...CartLine` spread without firing
  // partition signals — the CartLine placements aren't rendered on
  // /magento, so a signal per-item would be noise. They resolve from
  // warm storage next time /cart is visited.
  hydrateFragmentsFromResult(AddToCart, data)

  // Write the raw cart into the cart cell — fires `cell:magento.cart?cartId=X`,
  // refreshing any /cart placement currently rendering.
  await cartCell.with({ cartId }).set({ cart: updated })

  // Push the updated total into the badge cell — fires
  // `cell:magento.cart-badge?cartId=X`, refreshing the header on any
  // magento page.
  await cartBadgeCell.with({ cartId }).set({
    total_quantity: updated.total_quantity ?? 0,
  })

  return []
}

export async function getCartId(): Promise<string | undefined> {
  try {
    return readCookie("cart_id")
  } catch {
    return undefined
  }
}
