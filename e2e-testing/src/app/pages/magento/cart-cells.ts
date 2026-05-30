/**
 * Cart cells — both built on the new cell surface:
 *
 *   cartCell      — gqlCell from the `magentoQuery` builder. Loaded per
 *                   `.with({ cartId })` (input params flow through `.with`,
 *                   like the pokemon cells); its loader auto-hydrates the
 *                   per-line cells from the `...CartLine` spread. Stores
 *                   the RAW query result — the view derives its aggregate
 *                   (uid list + totals) in `cart-page.tsx`.
 *
 *   cartItemCell  — fragmentCell typed by + keyed off `CartLineFragment`.
 *                   Populated by auto-hydration and value-keyed
 *                   `cartItemCell.set(line)`. Keyed by `uid` — Magento's
 *                   CartItem has no `id`.
 *
 * Neither cell touches disk (gqlCell / fragmentCell are request-scoped).
 */

import { gqlCellBuilder, fragmentCell } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const magentoQuery = gqlCellBuilder({ client, graphql, prefix: "magento" })

/** The per-line shape. `@_unmask` keeps gql.tada from masking the spread
 *  (so query/mutation result items carry the fields directly, and resolve
 *  cleanly even though `CartItemInterface` is abstract). Spread into the
 *  cart query AND every cart mutation so one upstream call hydrates the
 *  line cells. */
export const CartLineFragment = graphql(`
  fragment CartLine on CartItemInterface @_unmask {
    uid
    quantity
    product {
      name
      sku
    }
    prices {
      row_total {
        value
        currency
      }
    }
  }
`)

/** The line value the cell stores — inferred from the fragment. */
export type CartLineValue = ResultOf<typeof CartLineFragment>

/** Per-line fragment cell — value type + `key` param both inferred from
 *  `CartLineFragment`. Hydrated by the cart query's `...CartLine` spread
 *  (auto-hydration) and written per-partition by mutations via
 *  `cartItemCell.set(line)` (keyed by uid). */
export const cartItemCell = fragmentCell(CartLineFragment, {
  key: (d) => ({ uid: d.uid }),
})

/**
 * The cart query — built via the `magentoQuery` builder, partitioned by
 * `.with({ cartId })`. Its loader auto-hydrates the per-line `cartItemCell`
 * partitions from the `...CartLine` spread. id auto-derives to
 * `magento.cart`.
 */
export const cartCell = magentoQuery(
  `
    query Cart($cartId: String!) {
      cart(cart_id: $cartId) {
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
    }
  `,
  [CartLineFragment],
)

/** The raw cart query result the cell stores. The view derives its
 *  aggregate (see `cartAggregate` in `cart-page.tsx`). */
export type CartData = NonNullable<typeof cartCell.defaultValue>
