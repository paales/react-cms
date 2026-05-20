/**
 * /streaming-demo — exercises the framework's live-update primitives.
 *
 * Three live demonstrations:
 *
 *  1. `<LiveTick>` — pure time-vary partial. Its `vary` reads
 *     `time` from scope, buckets it by second, and declares
 *     `expiresAt: time.nextSecond`. The framework's `<LivePageHeartbeat>`
 *     holds a streaming connection open; the segment driver wakes
 *     at each second boundary, vary recomputes, the fp moves, and
 *     a fresh segment ships. No cell, no setInterval, no autostart.
 *
 *  2. `<BumpCounter>` — `bumps` cell read via schema. The Bump
 *     button (rendered inside the same parton) calls
 *     `bumps.set(bumps.value + 1)` via the cell's Flight-serialized
 *     server-action ref. The action's response refetches
 *     `cell:demo.bumps`, which the cell layer auto-stamps onto this
 *     parton's labels.
 *
 *  3. `<PushUrlButton>` — fires a server action that calls
 *     `getServerNavigation().navigate("?seq=N")`. URL pushed via
 *     trailer; unrelated to cells.
 */

import { parton, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import {
  BumpButton,
  PushUrlButton,
  StreamingDemoReady,
} from "../components/streaming-demo-buttons.tsx"
import { bumps } from "./streaming-demo-state.ts"

// ── Live tick partial — time-vary, no cell ──────────────────────────

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
    vary: ({ time }) => ({
      tick: Math.floor(time.now / 1000),
      expiresAt: time.nextSecond,
    }),
  },
)

// ── Bump counter + button — cell-backed, button inline ──────────────

const BumpCounter = parton(
  function BumpCounterRender({ bumps }: { bumps: ResolvedCell<number> } & RenderArgs) {
    return (
      <div className="flex flex-col gap-3">
        <div className="font-mono text-sm" data-testid="streaming-demo-bumps">
          Bumps: {bumps.value}
        </div>
        <BumpButton bumps={bumps} />
      </div>
    )
  },
  {
    selector: "bump-counter",
    schema: () => ({ bumps }),
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
              1. live tick (time-vary, framework heartbeat)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-2 text-xs text-muted-foreground">
              <code>vary</code> reads <code>time.nextSecond</code> as
              its <code>expiresAt</code>. The framework's heartbeat
              holds the page's RSC connection open; the segment
              driver wakes at each second boundary and re-renders,
              shipping the next tick as a new segment.
            </p>
            <LiveTick parent={parent} />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              2. <code>cell.set()</code> — client-mutated counter
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-2 text-xs text-muted-foreground">
              Bump button calls <code>bumps.set(bumps.value + 1)</code>{" "}
              through the cell's Flight-serialized server-action ref.
              The action's response refetches{" "}
              <code>cell:demo.bumps</code>, which the cell layer
              auto-stamps onto this parton's labels.
            </p>
            <BumpCounter parent={parent} />
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

        <StreamingDemoReady />
      </main>
    )
  },
  { match: "/streaming-demo" },
)
