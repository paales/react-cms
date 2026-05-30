/**
 * /magento/cart — cell-backed cart with line-item granularity.
 *
 * Demonstrates the bound-cell + partition-scoped invalidation model:
 *
 *   - MagentoCartPage derives `cartId` from the cookie (`vary`) and
 *     binds `cartCell.with({ cartId })` as a prop to CartContents.
 *
 *   - CartContents reads the cart cell. Its value is the query result
 *     with the `...CartLine` spread rewritten to per-line BoundCells, so
 *     `cart.value.cart.items` is an array of forwardable cells —
 *     `<CartLine item={line} />`, no manual `.with({ uid })`. The prop
 *     resolution stamps `cell:magento.cart-item?uid=X` onto each line's
 *     invalidation surface.
 *
 *   - Mutations (updateLineQty / removeFromCart) value-key-write the
 *     changed line (`cartItemCell.set(line)`) and invalidate the cart
 *     cell for totals; only matching placements refetch, unaffected
 *     CartLine placements keep their fp and skip the wire.
 */

import {
  parton,
  type CellValue,
  type PartialCtx,
  type PartonProps,
  type ResolvedCell,
} from "@parton/framework"
import { Card } from "@parton/copies/components/ui/card"
import { cartCell, cartItemCell } from "./cart-cells.ts"
import { CartLineControls } from "./cart-line-controls.tsx"

const CartLine = parton(
  function CartLineRender({
    item,
  }: PartonProps<{ item: ResolvedCell<CellValue<typeof cartItemCell>> }>) {
    const line = item.value
    if (!line) {
      return (
        <div
          data-testid="cart-line-empty"
          className="rounded border p-3 text-sm text-muted-foreground"
        >
          (no data)
        </div>
      )
    }
    const name = line.product?.name ?? "(unknown)"
    const sku = line.product?.sku ?? ""
    const rowTotal = line.prices?.row_total?.value ?? 0
    const currency = line.prices?.row_total?.currency ?? "USD"
    return (
      <Card className="p-4" data-testid={`cart-line-${line.uid}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className="font-medium" data-testid={`cart-line-name-${line.uid}`}>
              {name}
            </div>
            <div className="text-xs text-muted-foreground">
              <code>{sku}</code>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono tabular-nums" data-testid={`cart-line-total-${line.uid}`}>
              {currency} {rowTotal.toFixed(2)}
            </div>
            <div
              className="text-xs text-muted-foreground"
              data-testid={`cart-line-qty-${line.uid}`}
            >
              qty {line.quantity}
            </div>
          </div>
          <CartLineControls uid={line.uid} quantity={line.quantity} />
        </div>
      </Card>
    )
  },
  // No selector: the auto-id from `CartLineRender` ("cart-line") is the
  // same, and refetch is driven by the per-line `cell:magento.cart-item`
  // label (stamped by the prop binding), not a selector reload.
)

const CartContents = parton(
  function CartContentsRender({
    cart,
    parent,
  }: PartonProps<{ cart: ResolvedCell<CellValue<typeof cartCell>> }>) {
    const c = cart.value?.cart
    // `items` are per-line BoundCells (the query result→cells rewrite) —
    // forward each straight to <CartLine>, no manual `.with({uid})`.
    const lines = (c?.items ?? []).filter((l): l is NonNullable<typeof l> => l != null)
    if (lines.length === 0) {
      return (
        <div
          data-testid="cart-empty"
          className="rounded border p-6 text-center text-muted-foreground"
        >
          Your cart is empty.
        </div>
      )
    }
    const currency = c?.prices?.grand_total?.currency ?? "USD"
    const grandTotal = c?.prices?.grand_total?.value ?? 0
    return (
      <div className="space-y-4">
        <div className="space-y-3" data-testid="cart-lines">
          {lines.map((line) => (
            <CartLine key={String(line.args.uid)} parent={parent} item={line} />
          ))}
        </div>
        <Card className="flex items-center justify-between p-4" data-testid="cart-totals">
          <span className="font-medium">Grand total</span>
          <span className="font-mono tabular-nums" data-testid="cart-grand-total">
            {currency} {grandTotal.toFixed(2)}
          </span>
        </Card>
      </div>
    )
  },
  // No selector: auto-id "cart-contents"; it refetches via its
  // `cell:magento.cart` label, not a selector reload.
)

export const MagentoCartPage = parton(
  function MagentoCartRender({ cartId, parent }: PartonProps<{ cartId: string }>) {
    return (
      <main className="py-4 space-y-4">
        <title>Magento cart — cell demo</title>
        <h1 className="text-2xl font-semibold">Cart</h1>
        <p className="text-sm text-muted-foreground">
          Cart-backed cells with per-line partitioning. Update qty or remove a line — only the
          matching line refetches; other lines keep their fp. The cart totals refetch on every
          change.
        </p>
        <CartContents parent={parent as PartialCtx} cart={cartCell.with({ cartId })} />
      </main>
    )
  },
  {
    match: "/magento/cart",
    // cart_id cookie → the cell's `.with({ cartId })` input param.
    vary: ({ cookies }) => ({ cartId: cookies.cart_id ?? "" }),
  },
)
