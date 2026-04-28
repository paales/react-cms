/**
 * "Composed" container — has its own `body` slot of demo blocks.
 * Demonstrates that a slot child can itself host slots (recursive
 * composition).
 */
import { Children } from "../../lib"

export function PageComposedBlock() {
  return (
    <section data-testid="cms-demo-composed-section">
      <h2 className="mt-8 mb-3 text-lg font-semibold">Composed from a slot</h2>
      <div data-testid="cms-demo-composed-slot">
        <Children name="body" allow=".demo-block" />
      </div>
    </section>
  )
}
