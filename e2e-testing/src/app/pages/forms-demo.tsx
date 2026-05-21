/**
 * /forms-demo — scoped cells + transactional actions.
 *
 * Cells declared inline inside the parton's `schema({cell})`. The
 * `save` action commits args atomically. Inputs in the form are bound
 * either directly to a cell (notes — per-keystroke writes via
 * `useCell.input({mode: 'onChange'})`) or via local-then-submit
 * (cardName / cardCvc — `useCell.input({mode: 'onSubmit'})` exposes
 * the cell's value as defaultValue, write happens only on form
 * submit through the action).
 *
 * The save handler:
 *  - Stages a `saves` JSON snapshot of what was just committed.
 *  - Throws `~failChance` of the time to demonstrate transactional
 *    rollback. On throw: NO writes commit (storage is staged in a
 *    pending map, dropped on throw), the client's optimistic UI
 *    rewinds to the prior server value.
 *
 * Two-step builder pattern: `parton(opts)` returns a `Builder`; the
 * Render function can use `typeof Builder.props` as a forward
 * reference for its prop type — TypeScript propagates the schema's
 * resolved cell types + the action's `ResolvedAction` shape into
 * Render's destructure without the author having to retype anything.
 */

import { parton } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { FormsDemoForm } from "../components/forms-demo-form.tsx"

const FormsDemoBuilder = parton({
  match: "/forms-demo",
  // Partition every scoped cell by the user's session id so each
  // session sees its own draft, notes, save history, and failure
  // setting. The schema cells inherit this partition automatically
  // (no per-cell `vary` needed — the framework partitions on the
  // parton's vary output by default). A second tab on the same
  // session shares the slot; a private-browsing tab gets its own.
  vary: ({ session }) => ({ sid: session.id }),
  schema: ({ cell }) => ({
    cardName: cell.string({ initial: "" }),
    cardCvc: cell.string({ initial: "" }),
    /** Live-bound textarea — per-keystroke writes via `useCell.input`. */
    notes: cell.string({ initial: "" }),
    /** JSON snapshot of the most recent successful save. */
    saves: cell.string({ initial: "" }),
    /** Failure-simulation probability, 0–1. */
    failChance: cell.number({ initial: 0 }),
  }),
  actions: {
    save: async ({ saves, failChance }, args: { cardName?: string; cardCvc?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (failChance.value > 0 && Math.random() < failChance.value) {
        throw new Error("Simulated save failure — transaction rolled back")
      }
      await saves.set(
        JSON.stringify({
          cardName: args.cardName ?? "",
          cardCvc: args.cardCvc ?? "",
          at: Date.now(),
        }),
      )
    },
  },
})

export const FormsDemoPage = FormsDemoBuilder(function FormsDemoRender({
  cardName,
  cardCvc,
  notes,
  saves,
  failChance,
  save,
}) {
  return (
    <main className="py-4 space-y-4">
      <title>Forms demo — scoped cells + actions</title>
      <h1 className="text-2xl font-semibold">Forms — scoped cells + actions</h1>
      <p className="text-sm text-muted-foreground">
        Cells declared inline in the parton's <code>schema</code>.<code>notes</code> is bound
        directly via <code>useCell.input({"{mode: 'onChange'}"})</code> — every keystroke writes
        through the cell batcher. Card fields are local until submit:{" "}
        <code>useCell.input({"{mode: 'onSubmit'}"})</code> seeds <code>defaultValue</code> from the
        cell, the input owns the draft locally, and the <code>save</code> action commits atomically.{" "}
        <code>failChance</code> toggles a simulated failure path — on throw, the entire transaction
        rolls back and the client's optimistic view rewinds.
      </p>

      <Card className="p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">Card form (action-bound commit)</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <FormsDemoForm
            cardName={cardName}
            cardCvc={cardCvc}
            notes={notes}
            saves={saves}
            failChance={failChance}
            save={save}
          />
        </CardContent>
      </Card>
    </main>
  )
})
