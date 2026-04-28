/**
 * Multi-slot container — has both a `body` and a `sidebar` slot.
 * Used to demonstrate the editor's slot-intermediary tree rendering
 * for parents with more than one slot.
 */
import { Children } from "../../lib"

export function PageMultiSlotBlock() {
  return (
    <section
      className="mt-8 grid gap-4 md:grid-cols-[1fr_280px]"
      data-testid="cms-demo-multi-slot-section"
    >
      <div data-testid="cms-demo-multi-slot-body">
        <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Body</h3>
        <Children name="body" allow=".demo-block" />
      </div>
      <aside data-testid="cms-demo-multi-slot-sidebar">
        <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Sidebar</h3>
        <Children name="sidebar" allow=".demo-block" />
      </aside>
    </section>
  )
}
