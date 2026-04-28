import { describe, expect, it } from "vitest"

const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

async function executeMutation<T>(query: string): Promise<T> {
  const response = await fetch(MAGENTO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })
  const json = (await response.json()) as { data: T; errors?: any[] }
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e: any) => e.message).join(", ")}`)
  }
  return json.data
}

describe("Magento mutations (cart flow)", { timeout: 30000 }, () => {
  it("creates an empty cart", async () => {
    const data = await executeMutation<{ createEmptyCart: string }>(`mutation { createEmptyCart }`)
    expect(data.createEmptyCart).toBeTruthy()
    expect(typeof data.createEmptyCart).toBe("string")
  })

  it("cart lifecycle: create → add → query", async () => {
    // Step 1: Create cart
    const { createEmptyCart: cartId } = await executeMutation<{
      createEmptyCart: string
    }>(`mutation { createEmptyCart }`)
    expect(cartId).toBeTruthy()

    // Step 2: Add product to cart (demo API, product availability may vary)
    const addResult = await executeMutation<{
      addProductsToCart: {
        cart: { items: Array<{ quantity: number; product: { sku: string } }> }
      }
    }>(`
			mutation {
				addProductsToCart(
					cartId: "${cartId}"
					cartItems: [{ sku: "GC-1-SOCK-462222", quantity: 2 }]
				) {
					cart {
						items {
							quantity
							product { sku }
						}
					}
				}
			}
		`)
    // Verify the mutation response has the expected shape
    expect(addResult.addProductsToCart.cart).toBeDefined()
    expect(Array.isArray(addResult.addProductsToCart.cart.items)).toBe(true)

    // Step 3: Query the cart (simulate partial re-fetch after mutation)
    const cartQuery = await executeMutation<{
      cart: { prices: { grand_total: { value: number; currency: string } } }
    }>(`
			query {
				cart(cart_id: "${cartId}") {
					prices {
						grand_total { value currency }
					}
				}
			}
		`)
    expect(cartQuery.cart.prices.grand_total).toBeDefined()
    expect(cartQuery.cart.prices.grand_total.currency).toBe("USD")
  })
})
