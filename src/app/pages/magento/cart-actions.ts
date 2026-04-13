"use server";

import { client } from "../../magento-data.ts";
import { getCookie, setCookie } from "../../../framework/context.ts";

/**
 * Server action: get or create a cart.
 * Reads cart_id from cookie; creates a new cart if none exists.
 * Persists the cart ID in a cookie for subsequent requests.
 */
export async function getOrCreateCart(): Promise<string> {
  const existing = getCookie("cart_id");
  if (existing) return existing;

  const data = await client.request<{ createEmptyCart: string }>(
    `mutation { createEmptyCart }`,
  );
  const cartId = data.createEmptyCart;
  setCookie("cart_id", cartId);
  return cartId;
}

/**
 * Server action: add a product to cart.
 * Ensures a cart exists (cookie-backed), then adds the item.
 */
export async function addToCart(
  sku: string,
  quantity: number,
): Promise<{ invalidate: { tags: string[] } }> {
  const cartId = await getOrCreateCart();

  await client.request(
    `mutation AddToCart($cartId: String!, $sku: String!, $quantity: Float!) {
      addProductsToCart(
        cartId: $cartId
        cartItems: [{ sku: $sku, quantity: $quantity }]
      ) {
        cart {
          total_quantity
        }
      }
    }`,
    { cartId, sku, quantity },
  );
  return { invalidate: { tags: ["cart"] } };
}

/**
 * Read the cart ID from the cookie (for server components).
 */
export async function getCartId(): Promise<string | undefined> {
  try {
    return getCookie("cart_id");
  } catch {
    return undefined;
  }
}
