/**
 * /cursors — multiplayer cursors on the `deferred` cell primitive.
 *
 * Every viewer streams its own pointer up via `moveCursor` (a write to
 * the `deferred` `cursorsCell`, so no re-render on the POST) and sees
 * every other viewer's cursor come down over its open heartbeat stream.
 * Up on a one-shot POST, down on the shared stream — the asymmetry the
 * `deferred` flag is built for.
 *
 * See [`../components/cursor-layer.tsx`] for the client side and
 * [`./cursors-actions.ts`] for the merge.
 */

import { parton, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { CursorLayer } from "../components/cursor-layer.tsx"
import { cursorsCell, type CursorMap } from "./cursors-state.ts"

const CursorPresence = parton(
  function CursorPresenceRender({ cursors }: { cursors: ResolvedCell<CursorMap> } & RenderArgs) {
    return <CursorLayer cursors={cursors} />
  },
  {
    selector: "cursor-presence",
    schema: () => ({ cursors: cursorsCell }),
  },
)

export const CursorsPage = parton(
  function CursorsRender({ parent }: RenderArgs) {
    return (
      <main className="py-4 space-y-4">
        <title>Multiplayer cursors</title>
        <h1 className="text-2xl font-semibold">Multiplayer cursors</h1>
        <p className="text-sm text-muted-foreground">
          Each viewer's pointer is a <code>deferred</code> cell write — it
          goes up on a one-shot POST that carries no re-render, and comes
          back down to every other viewer over the open heartbeat stream.
          Open this page in a second tab to see it.
        </p>
        <CursorPresence parent={parent} />
      </main>
    )
  },
  { match: "/cursors" },
)
