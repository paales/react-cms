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

// The slice cell the scroller's `load` resolves: ORDER + totals +
// AGGREGATIONS. Composing `browseCardCell` rewrites each spread site
// to the card cell's BoundCell, so the leaf Render forwards items
// straight into card partons. The aggregations ride the same result —
// any parton can join the query by resolving the same partition (the
// FilterBar does exactly that), so the facets cost no extra fetch
// where the partitions align and one cached query where they don't.
/** The filterable attribute codes — mirrors the schema's
 *  `ProductAttributeFilterInput` fields (equal + range types). The
 *  URL's `?f=` pairs validate against this closed vocabulary before
 *  they reach the query: an unknown code would fail GraphQL input
 *  validation (breaking the whole slice), and an open vocabulary
 *  would let arbitrary URLs mint unbounded cell partitions, each a
 *  backend query. */
export const FILTERABLE_CODES = new Set([
  "activity",
  "brand",
  "category_gear",
  "category_id",
  "category_uid",
  "category_url_path",
  "climate",
  "collar",
  "color",
  "colors",
  "compatible_phones",
  "dominant_color",
  "eco_collection",
  "engine",
  "erin_recommends",
  "features_bags",
  "format",
  "gender",
  "material",
  "new",
  "pattern",
  "performance_fabric",
  "price",
  "print_art",
  "print_holiday",
  "print_labels",
  "print_landmarks",
  "print_landscape",
  "print_mood",
  "print_type",
  "sale",
  "size",
  "sku",
  "sleeve",
  "special_price",
  "strap_bags",
  "style_bags",
  "style_bottom",
  "style_general",
  "url_key",
])

export const browseProductsCell = magentoCatalog.query(
  `#graphql
  query BrowseProducts($pageSize: Int!, $currentPage: Int!, $filter: ProductAttributeFilterInput) {
    products(filter: $filter, pageSize: $pageSize, currentPage: $currentPage) {
      total_count
      aggregations {
        attribute_code
        label
        options {
          label
          value
          count
        }
      }
      items {
        ...BrowseCardFields
      }
    }
  }
`,
  [browseCardCell],
)
