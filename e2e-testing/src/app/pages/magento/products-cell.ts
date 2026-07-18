/**
 * Magento products-grid cell.
 *
 * Storage caches per pageSize args; refresh is explicit via
 * `magentoProductsCell.with({pageSize}).invalidate()` (e.g. from a
 * "Refresh products" button) rather than a TTL on the parton.
 *
 * Built via the `magentoCatalog` cell builder (record/replay client) —
 * the raw `graphql()` call is hidden. Consumers type off the cell via
 * `CellValue<typeof magentoProductsCell>`.
 */

import { magentoCatalog } from "../../magento.ts"

// id auto-derives to "magento.products" (operation name + prefix).
// `currentPage` partitions the cache per page, so an infinite-scroll
// page-parton can bind `.with({pageSize, currentPage})` and fetch only
// its own slice. `total_count` lets a scroller cap its page pool.
export const magentoProductsCell = magentoCatalog.query(`
  query Products($pageSize: Int!, $currentPage: Int!) {
    products(filter: {}, pageSize: $pageSize, currentPage: $currentPage) {
      total_count
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

// ─── Browse scroller cells — order/content split ───────────────────────
//
// The per-card ENTITY cell: content keyed by `uid`, hydrated from the
// slice query's spread sites. A card parton bound to it re-renders on
// `cell:magento.browse-card-fields?uid=X` wherever the product
// appears — per-item invalidation across every collection.
export const browseCardCell = magentoCatalog.fragment(
  `#graphql
  fragment BrowseCardFields on ProductInterface {
    uid
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
`,
  { key: (d) => ({ uid: d.uid }) },
)

// The slice cell the scroller's `range` resolves: ORDER + totals.
// Composing `browseCardCell` rewrites each spread site to the card
// cell's BoundCell, so the leaf Render forwards items straight into
// card partons.
export const browseProductsCell = magentoCatalog.query(
  `#graphql
  query BrowseProducts($pageSize: Int!, $currentPage: Int!) {
    products(filter: {}, pageSize: $pageSize, currentPage: $currentPage) {
      total_count
      items {
        ...BrowseCardFields
      }
    }
  }
`,
  [browseCardCell],
)
