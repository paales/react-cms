import { parton, PartialRoot, type RenderArgs } from "@parton/framework"
import { bumpCounter } from "./counter-actions.ts"
import { counter } from "./counter-state.ts"
import { BumpButton } from "./bump-button.tsx"

/**
 * The one subtree the scenarios watch. Resolving the counter records
 * the `cell:mp.counter` dep, so a write — local, or arriving as a
 * bridge doorbell from the other process — wakes this viewer's held
 * connection and lanes exactly this parton.
 */
const CounterView = parton(async function CounterViewRender(_: RenderArgs) {
  const state = await counter.resolve()
  return (
    <section>
      <h1>Multi-process counter</h1>
      <p data-testid="counter">Count: {state.value}</p>
      <BumpButton bump={bumpCounter} />
    </section>
  )
}, "/")

export function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>parton — multi-process harness</title>
      </head>
      <body>
        <PartialRoot>
          <CounterView />
        </PartialRoot>
      </body>
    </html>
  )
}
