/**
 * /streaming-demo — exercises the segmented-Flight server primitives.
 *
 * Three live demonstrations:
 *
 *  1. `<LiveTick>` — `markConnectionLive()` + a server-side ticker
 *     that fires `refreshSelector("streaming-demo-tick")` once per
 *     second. The segment driver re-renders on each tick; the
 *     client receives a new segment and `setPayload` updates the
 *     DOM. `Tick #N` advancing every second is the visible proof
 *     that the connection is staying open across many segments on
 *     one HTTP response.
 *
 *  2. `<BumpCounter>` — vary reads scope state. A server action
 *     bumps the counter and calls
 *     `getServerNavigation().reload({selector: "bump-counter"})`.
 *     The invalidation registry's ts shifts the partial's fp so
 *     the action's response render emits fresh content. Demonstrates
 *     `.reload(selector)` replacing the legacy
 *     `return { invalidate: {selector} }` shape.
 *
 *  3. `<PushUrlButton>` — fires a server action that calls
 *     `getServerNavigation().navigate("?seq=N")`. The response
 *     trailer carries a `url`-tagged entry; the client applies it
 *     via `history.replaceState`. URL bar updates without
 *     re-triggering the navigation handler.
 */

import { markConnectionLive, parton, type RenderArgs } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import {
  BumpButton,
  LiveTickAutostart,
  PushUrlButton,
} from "../components/streaming-demo-buttons.tsx"
import {
  ensureTicker,
  getScopeState,
  readDemoBumps,
} from "./streaming-demo-state.ts"

export { clearStreamingDemoState as _clearStreamingDemoState } from "./streaming-demo-state.ts"

// ── Live tick partial — markConnectionLive + scheduled refreshSelector ──

const LiveTick = parton(
  function LiveTickRender({ tick }: { tick: number } & RenderArgs) {
    return (
      <div className="font-mono text-sm" data-testid="streaming-demo-tick">
        Tick #{tick} · server time {new Date().toLocaleTimeString()}
      </div>
    )
  },
  {
    selector: "streaming-demo-tick",
    vary: ({ headers }) => {
      const scope = headers["x-test-scope"] ?? "default"
      // Schedule the next tick from inside vary so it runs once per
      // segment render. `markConnectionLive` keeps the connection
      // open after this segment closes so the scheduled bump wakes
      // the driver into another render.
      ensureTicker(scope)
      markConnectionLive()
      return { tick: getScopeState(scope).tick }
    },
  },
)

// ── Bump counter — `.reload({selector})` driving fp invalidation ──────

const BumpCounter = parton(
  function BumpCounterRender({ bumps }: { bumps: number } & RenderArgs) {
    return (
      <div className="font-mono text-sm" data-testid="streaming-demo-bumps">
        Bumps: {bumps}
      </div>
    )
  },
  {
    selector: "bump-counter",
    vary: ({ headers }) => ({
      bumps: readDemoBumps(headers["x-test-scope"] ?? "default"),
    }),
  },
)

// ── Page ──────────────────────────────────────────────────────────────

export const StreamingDemoPage = parton(
  function StreamingDemoRender({ parent }: RenderArgs) {
    return (
      <main className="py-4 space-y-4">
        <title>Streaming primitives demo</title>
        <h1 className="text-2xl font-semibold">Streaming primitives</h1>
        <p className="text-sm text-muted-foreground">
          Three live demonstrations of the segmented-Flight server
          primitives. Open the network panel to watch chunks land
          in one rolling HTTP response.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              1. <code>markConnectionLive()</code> — live tick
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-2 text-xs text-muted-foreground">
              Server-side ticker fires <code>refreshSelector</code>
              every second; the segment driver wakes, re-renders, and
              emits a new segment on the same connection.
            </p>
            <LiveTick parent={parent} />
            <LiveTickAutostart />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              2. <code>{"getServerNavigation().reload({selector})"}</code> — bump
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <p className="text-xs text-muted-foreground">
              The Bump button fires a server action that mutates
              scope state and calls{" "}
              <code>{'getServerNavigation().reload({selector: "bump-counter"})'}</code>
              . The action's response render sees the bumped fp and
              emits fresh content.
            </p>
            <BumpCounter parent={parent} />
            <BumpButton />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              3. <code>getServerNavigation().navigate(url)</code> — server-pushed URL
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <p className="text-xs text-muted-foreground">
              The Push URL button fires a server action that calls{" "}
              <code>{"getServerNavigation().navigate(`?seq=${N}`)"}</code>
              . The response trailer carries a <code>url</code> entry
              that the client applies via{" "}
              <code>history.replaceState</code>.
            </p>
            <PushUrlButton />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/streaming-demo" },
)
