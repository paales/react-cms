/**
 * Magento products-grid cell.
 *
 * Replaces the inline `client.request(ProductsQuery, ...)` +
 * `cache: {maxAge: 12}` pattern. Storage caches per pageSize args;
 * refresh is explicit via `magentoProductsCell.with({pageSize}).
 * invalidate()` (e.g. from a "Refresh products" button) rather than
 * a TTL on the parton.
 *
 * Trade-off: data won't auto-refresh, but for a product grid where
 * prices/availability change on Magento's schedule, explicit refresh
 * triggers via the existing RefreshAllPricesButton are clearer than
 * an invisible 12s TTL.
 */

import { gqlCell } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const ProductsQuery = graphql(`
  query Products($pageSize: Int!) {
    products(filter: {}, pageSize: $pageSize) {
      items {
        id
        name
        sku
        small_image {
          url
          label
        }
        price_range {
          minimum_price {
            regular_price {
              value
              currency
            }
          }
        }
      }
    }
  }
`)

export type ProductsResult = ResultOf<typeof ProductsQuery>

export const magentoProductsCell = gqlCell({
  id: "magento.products",
  client,
  doc: ProductsQuery,
})
