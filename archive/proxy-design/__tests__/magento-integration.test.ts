import { describe, expect, it } from "vitest"
import { resolve } from "../resolve.ts"
import { fetchSchema, type SchemaGraph } from "../schema.ts"

const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

async function executeMagentoQuery<T>(query: string): Promise<T> {
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

let schema: SchemaGraph
const getSchema = async () => (schema ??= await fetchSchema(MAGENTO_ENDPOINT))

describe("Magento integration (GraphCommerce)", { timeout: 30000 }, () => {
  it("fetches products via query root proxy", async () => {
    const result = await resolve(getSchema, executeMagentoQuery, (q, { query }) => {
      const productList = q.products({ search: "sock", pageSize: 2 }).items
      return {
        items: productList.map((p: any) => ({
          name: p.name.value,
          sku: p.sku.value,
        })),
        query,
      }
    })
    const { items, query } = result as any
    expect(items).toHaveLength(2)
    expect(items[0].name).toBeTruthy()
    expect(items[0].sku).toBeTruthy()
    expect(query).toContain("products")
    expect(query).toContain("items")
    expect(query).toContain("name")
    expect(query).toContain("sku")
  })

  it("fetches nested product fields (price via .$value)", async () => {
    const result = await resolve(getSchema, executeMagentoQuery, (q) => {
      const productList = q.products({ search: "sock", pageSize: 1 }).items
      return productList.map((p: any) => ({
        name: p.name.value,
        price: p.price_range.minimum_price.regular_price.value.$value,
        currency: p.price_range.minimum_price.regular_price.currency.value,
      }))
    })
    const items = result as any[]
    expect(items).toHaveLength(1)
    expect(typeof items[0].price).toBe("number")
    expect(items[0].currency).toBeTruthy()
  })
})
