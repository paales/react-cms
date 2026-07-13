/**
 * /bound-cells-demo — bound cells: the inward state contract.
 *
 * The host resolves its own cart cell IN THE PARTON BODY (the read IS
 * the dependency) and binds it at the RemoteFrame call site — the
 * projected values cross with the embed request; the remote sees
 * values, never the cell, the session, or the storage. A host-side
 * write moves this parton's fp (the recorded `cell:host.cart` dep),
 * re-runs the body, and the re-embed projects the fresh cart.
 *
 * The second section embeds the SAME page with NO binding: the
 * remote's declared `cells: { cart: { required: true } }` fails that
 * render explicitly on the producer, and the failure surfaces at this
 * host parton's boundary (the per-partial error card) — the page
 * around it keeps working.
 */

import { parton, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { MagentoCartNote } from "../../remote/magento"
import { BoundCellsControls } from "../components/bound-cells-controls.tsx"
import { addToHostCart } from "./bound-cells-demo-actions.ts"
import { hostCart } from "./bound-cells-demo-state.ts"

export const BoundCellsDemoPage = parton(
  async function BoundCellsDemoRender(_: RenderArgs) {
    const cart = await hostCart.resolve()
    return (
      <main className="py-4 space-y-4">
        <title>Bound cells demo</title>
        <header>
          <h1 className="text-2xl font-semibold">Bound cells demo</h1>
          <p className="text-sm text-muted-foreground">
            The embed below receives this page's cart cell as projected VALUES — bound explicitly at
            the call site, re-projected on every host-side write.
          </p>
        </header>
        <section data-testid="bound-cells-host" className="space-y-2">
          <div className="text-sm">
            Host cart: <span data-testid="bound-cells-host-items">{cart.value.items}</span> items,
            total <span data-testid="bound-cells-host-total">{cart.value.total}</span>
          </div>
          <BoundCellsControls add={addToHostCart} />
        </section>
        <section data-testid="bound-cells-embed" className="rounded-md border p-3">
          <Suspense fallback={<p data-testid="bound-cells-embed-fallback">Loading embed…</p>}>
            <MagentoCartNote cells={{ cart }} />
          </Suspense>
        </section>
      </main>
    )
  },
  { match: "/bound-cells-demo", selector: "#bound-cells-demo" },
)

/** The missing-required-binding section — its own parton so the
 *  producer-side failure lands in ITS error boundary, never the happy
 *  section's. */
export const BoundCellsMissingSection = parton(
  async function BoundCellsMissingRender(_: RenderArgs) {
    return (
      <section data-testid="bound-cells-missing" className="rounded-md border p-3">
        <Suspense fallback={<p>Loading unbound embed…</p>}>
          {/* Deliberately NO `cells` — the remote requires `cart`. */}
          <MagentoCartNote />
        </Suspense>
      </section>
    )
  },
  { match: "/bound-cells-demo", selector: "#bound-cells-missing" },
)
