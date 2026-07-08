/**
 * /forms-demo — session-partitioned cells + a plain server function.
 *
 * The cells live at module scope (`forms-demo-state.ts`), partitioned
 * per session; the render calls `ensureSessionId()` first to mint the
 * `__frame_sid` cookie so each visitor has a stable, non-empty
 * `session.id` and the cells land in their OWN persistent partition.
 * `session()` folds the session into the parton's fingerprint, so it
 * re-renders when the session changes.
 *
 * `saveCard` (`forms-demo-actions.ts`) is a plain `"use server"`
 * function: it imports the cells, writes them inside `atomic()` — one
 * driver wake for the batch, and the simulated-failure throw discards
 * every write. Inputs bind either directly to a cell (notes —
 * per-keystroke writes via `useCell.input({mode: 'onChange'})`) or
 * local-then-submit (cardName / cardCvc — `useCell.input({mode:
 * 'onSubmit'})` seeds `defaultValue`; the submit handler passes the
 * drafts to `saveCard`).
 */

import { ensureSessionId, parton, session, type RenderArgs } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { FormsDemoForm } from "../components/forms-demo-form.tsx"
import { saveCard } from "./forms-demo-actions.ts"
import * as cells from "./forms-demo-state.ts"

export const FormsDemoPage = parton(
  async function FormsDemoRender(_: RenderArgs) {
    // Establish a session BEFORE the cells resolve. Every cell here
    // partitions on `session.id`; minting the `__frame_sid` cookie up
    // front gives each visitor a stable, non-empty id, so the cells
    // route to their OWN persistent partition (an unresolved, empty
    // `session.id` would be routed to per-request ephemeral storage and
    // never persist). Session-minting is app policy — the framework
    // only provides the capability and the safe-by-default routing.
    ensureSessionId()
    // Fold the session into the fp so the parton re-renders when the
    // session changes (the cells partition by it).
    session()
    const cardName = await cells.cardName.resolve()
    const cardCvc = await cells.cardCvc.resolve()
    const notes = await cells.notes.resolve()
    const saves = await cells.saves.resolve()
    const failChance = await cells.failChance.resolve()
    return (
      <main className="py-4 space-y-4">
        <title>Forms demo — cells + a plain server function</title>
        <h1 className="text-2xl font-semibold">Forms — cells + a plain server function</h1>
        <p className="text-sm text-muted-foreground">
          Module cells resolved in the parton's <code>Render</code> via <code>cell.resolve()</code>.{" "}
          <code>notes</code> is bound directly via{" "}
          <code>useCell.input({"{mode: 'onChange'}"})</code> — every keystroke writes through the
          cell batcher. Card fields are local until submit:{" "}
          <code>useCell.input({"{mode: 'onSubmit'}"})</code> seeds <code>defaultValue</code> from
          the cell, the input owns the draft locally, and <code>saveCard</code> commits inside{" "}
          <code>atomic()</code>. <code>failChance</code> toggles a simulated failure path — on
          throw, the whole batch rolls back.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Card form (server-function commit)</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <FormsDemoForm
              cardName={cardName}
              cardCvc={cardCvc}
              notes={notes}
              saves={saves}
              failChance={failChance}
              save={saveCard}
            />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/forms-demo" },
)
